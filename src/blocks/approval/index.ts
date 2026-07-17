// Block: Approval Queue (Human-in-the-Loop) — Production-grade HITL
//
// State machine:
//   pending → approved → executed
//   pending → rejected
//   pending → canceled (by requester or admin)
//   pending → expired (auto after expires_at, default 7 days)
//
// All state transitions are atomic (UPDATE ... WHERE status = 'pending') to
// prevent TOCTOU races where two admins respond concurrently.
//
// Audit trail: every transition records who/when/why in dedicated columns.
// Sanitization: getApproval/getApprovals sanitize action/details/reason/result
// before returning, so attacker-controlled text never reaches an AI context
// window unprocessed.
//
// Expiry: pending approvals past expires_at are auto-marked 'expired' by a
// periodic cleanup timer. Terminal-state approvals older than 90 days are
// deleted to bound table growth.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { sanitizeMessage } from '../security/injection.js';
import { publishToGroup, publishToUser } from '../relay/index.js';
import { notifyUser, isGroupMember } from '../groups/index.js';
import { ok, err, type OpResult } from '../../shared/result.js';
import { parse, submitApprovalSchema, respondApprovalSchema } from '../../shared/validation.js';
import type { RelayEvent } from '../../shared/types.js';

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;     // 1 hour
const RETENTION_DAYS = 90;                       // delete terminal-state rows older than this

export const ACTION_TYPES = ['read', 'write', 'delete', 'deploy', 'exec', 'config', 'other'] as const;
export const SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'expired', 'canceled', 'executed'] as const;

export type ActionType = typeof ACTION_TYPES[number];
export type Severity = typeof SEVERITY_LEVELS[number];
export type ApprovalState = typeof APPROVAL_STATES[number];

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function notifyUserEverywhere(userId: string, event: RelayEvent) {
  notifyUser(userId, event);
  try { publishToUser(userId, event); } catch { /* NATS down */ }
}

function isGroupAdmin(userId: string, groupId: string): boolean {
  const row = getDb().prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId) as { role: string } | undefined;
  return row?.role === 'admin';
}

// Sanitize a single approval row for external return. The DB stores raw
// action/details/reason/result for audit integrity; this function strips
// control chars and caps length before any external surface (REST response,
// MCP tool result, getApproval() consumer).
function sanitizeApprovalRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    action: row.action ? sanitizeMessage(String(row.action)) : row.action,
    details: row.details ? sanitizeMessage(String(row.details)) : row.details,
    reason: row.reason ? sanitizeMessage(String(row.reason)) : row.reason,
    execution_result: row.execution_result ? sanitizeMessage(String(row.execution_result)) : row.execution_result,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Domain: Submit Action for Approval
// ═══════════════════════════════════════════════════════════════════════

export interface SubmitApprovalInput {
  group_id: string;
  action: string;
  details?: string;
  action_type?: ActionType;
  severity?: Severity;
}

export function submitApproval(userId: string, input: SubmitApprovalInput): OpResult<{ id: string }> {
  const db = getDb();

  if (!isGroupMember(userId, input.group_id)) return err('NOT_A_MEMBER', 'Not a member of this group', 403);

  const usernameRow = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  if (!usernameRow) return err('USER_NOT_FOUND', 'User not found', 404);
  const username = usernameRow.username;

  const rl = checkRateLimit(`approval:${userId}`, 3600_000, 50);
  if (!rl.allowed) return err('RATE_LIMITED', 'Too many approval requests', 429);

  const approvalId = nanoid();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();
  const details = input.details ?? '';
  const actionType = input.action_type ?? 'other';
  const severity = input.severity ?? 'medium';

  db.prepare(
    `INSERT INTO approvals (id, group_id, requester_id, requester_name, action, details, status, created_at, action_type, severity, expires_at)
     VALUES (?,?,?,?,?,?,?, ?,?,?,?)`
  ).run(approvalId, input.group_id, userId, username, input.action, details, 'pending', now, actionType, severity, expiresAt);

  // Sanitize user-controlled fields before they enter message content.
  const safeAction = sanitizeMessage(input.action);
  const safeDetails = sanitizeMessage(details);

  publishToGroup(input.group_id, {
    id: nanoid(),
    group_id: input.group_id,
    sender_id: 'system',
    sender_username: 'Approval System',
    sender_ai: 'approval',
    type: 'alert',
    content: `⏳ PENDING APPROVAL [${severity}/${actionType}]\n\nAction: ${safeAction}\nRequested by: ${username}\nDetails: ${safeDetails || 'None'}\nExpires: ${expiresAt}\nApproval ID: ${approvalId}`,
    timestamp: now,
  });

  return ok({ id: approvalId });
}

// ═══════════════════════════════════════════════════════════════════════
// Domain: Respond to Approval (admin only, no self-approval)
// Race-safe: atomic UPDATE with WHERE status='pending' prevents TOCTOU.
// ═══════════════════════════════════════════════════════════════════════

export function respondToApproval(
  userId: string,
  approvalId: string,
  approve: boolean,
  reason?: string,
): OpResult<{ resolved_by: string }> {
  const db = getDb();

  // Read first to check authorization (self-approval, admin) before transitioning
  const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
    | { group_id: string; action: string; requester_id: string; requester_name: string; status: string }
    | undefined;
  if (!approval) return err('APPROVAL_NOT_FOUND', 'Approval not found', 404);
  if (approval.status !== 'pending') {
    return err('ALREADY_RESOLVED', `Approval already in state: ${approval.status}`, 409);
  }

  // Self-approval guard
  if (approval.requester_id === userId) return err('CANNOT_SELF_APPROVE', 'Cannot approve your own request', 403);

  // Admin-only
  if (!isGroupAdmin(userId, approval.group_id)) return err('ADMIN_ONLY', 'Only admins can resolve approvals', 403);

  const responderRow = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  if (!responderRow) return err('USER_NOT_FOUND', 'User not found', 404);
  const responder = responderRow.username;

  // ATOMIC transition: only succeeds if still pending AND not expired.
  // Two concurrent admins can't both resolve — only the first UPDATE affects a row.
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, reason = ?
     WHERE id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`,
  ).run(approve ? 'approved' : 'rejected', now, responder, reason ?? null, approvalId, now);

  if (result.changes === 0) {
    // Lost the race — someone else resolved it between our SELECT and UPDATE
    return err('ALREADY_RESOLVED', 'Approval was resolved concurrently', 409);
  }

  const safeAction = sanitizeMessage(approval.action);
  const safeReason = reason ? sanitizeMessage(reason) : '';

  publishToGroup(approval.group_id, {
    id: nanoid(),
    group_id: approval.group_id,
    sender_id: 'system',
    sender_username: 'Approval System',
    sender_ai: 'approval',
    type: approve ? 'system' : 'alert',
    content: `${approve ? '✅ APPROVED' : '❌ REJECTED'}\n\nAction: ${safeAction}\nRequested by: ${approval.requester_name}\nResolved by: ${responder}${safeReason ? `\nReason: ${safeReason}` : ''}`,
    timestamp: now,
  });

  notifyUserEverywhere(approval.requester_id, {
    type: 'notification',
    payload: { approval_id: approvalId, status: approve ? 'approved' : 'rejected', resolved_by: responder },
    timestamp: now,
  });

  return ok({ resolved_by: responder });
}

// ═══════════════════════════════════════════════════════════════════════
// Domain: Cancel Approval (requester or admin)
// Allowed from 'pending' or 'approved' (before execution).
// ═══════════════════════════════════════════════════════════════════════

export function cancelApproval(userId: string, approvalId: string): OpResult<true> {
  const db = getDb();

  const approval = db.prepare('SELECT requester_id, group_id, status FROM approvals WHERE id = ?').get(approvalId) as
    | { requester_id: string; group_id: string; status: string }
    | undefined;
  if (!approval) return err('APPROVAL_NOT_FOUND', 'Approval not found', 404);

  if (approval.status !== 'pending' && approval.status !== 'approved') {
    return err('NOT_CANCELLABLE', `Cannot cancel approval in state: ${approval.status}`, 409);
  }

  // Requester can cancel their own; admin can cancel any in their group
  const isAdmin = isGroupAdmin(userId, approval.group_id);
  if (approval.requester_id !== userId && !isAdmin) {
    return err('FORBIDDEN', 'Only requester or group admin can cancel', 403);
  }

  const now = new Date().toISOString();
  // ATOMIC: only cancels if still in a cancellable state
  const result = db.prepare(
    `UPDATE approvals SET status = 'canceled', canceled_at = ?, canceled_by = ?
     WHERE id = ? AND status IN ('pending', 'approved')`,
  ).run(now, userId, approvalId);

  if (result.changes === 0) {
    return err('RACE', 'Approval was modified concurrently', 409);
  }

  notifyUserEverywhere(approval.requester_id, {
    type: 'notification',
    payload: { approval_id: approvalId, status: 'canceled', canceled_by: userId },
    timestamp: now,
  });

  return ok(true);
}

// ═══════════════════════════════════════════════════════════════════════
// Domain: Mark Approval as Executed (admin only, after external action done)
//
// AI Mesh itself doesn't "execute" actions — it blesses them. After an admin
// approves, the requesting AI polls checkApprovalStatus() and sees 'approved',
// then performs its external action. The admin (or AI via a separate call)
// marks the approval as 'executed' with a result note, completing the audit
// trail: pending → approved → executed.
// ═══════════════════════════════════════════════════════════════════════

export function markExecuted(userId: string, approvalId: string, executionResult: string): OpResult<true> {
  const db = getDb();

  const approval = db.prepare('SELECT group_id, status, requester_id FROM approvals WHERE id = ?').get(approvalId) as
    | { group_id: string; status: string; requester_id: string }
    | undefined;
  if (!approval) return err('APPROVAL_NOT_FOUND', 'Approval not found', 404);

  if (approval.status !== 'approved') {
    return err('NOT_APPROVED', `Cannot execute approval in state: ${approval.status}`, 409);
  }

  // Admin of the group, OR the original requester (who performed the action)
  const isAdmin = isGroupAdmin(userId, approval.group_id);
  if (!isAdmin && approval.requester_id !== userId) {
    return err('FORBIDDEN', 'Only admin or requester can mark as executed', 403);
  }

  const now = new Date().toISOString();
  const safeResult = sanitizeMessage(executionResult);
  const result = db.prepare(
    `UPDATE approvals SET status = 'executed', executed_at = ?, execution_result = ?
     WHERE id = ? AND status = 'approved'`,
  ).run(now, safeResult, approvalId);

  if (result.changes === 0) {
    return err('RACE', 'Approval was modified concurrently', 409);
  }

  // Notify group: action was executed
  publishToGroup(approval.group_id, {
    id: nanoid(),
    group_id: approval.group_id,
    sender_id: 'system',
    sender_username: 'Approval System',
    sender_ai: 'approval',
    type: 'system',
    content: `✅ EXECUTED\n\nApproval ID: ${approvalId}\nResult: ${safeResult}`,
    timestamp: now,
  });

  return ok(true);
}

// ═══════════════════════════════════════════════════════════════════════
// Domain: Get Approval Status (for AI polling)
// Returns sanitized approval row. Callers check `.status` to decide next step.
// ═══════════════════════════════════════════════════════════════════════

export function getApprovalStatus(approvalId: string): ApprovalState | null {
  try {
    const row = getDb().prepare('SELECT status FROM approvals WHERE id = ?').get(approvalId) as { status: string } | undefined;
    return (row?.status as ApprovalState) || null;
  } catch {
    return null;
  }
}

export function getApproval(approvalId: string): Record<string, unknown> | null {
  try {
    const row = getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    // M4 fix: sanitize user-controlled fields before returning
    return sanitizeApprovalRow(row);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Expiry Cleanup — auto-expire pending approvals past their TTL
// ═══════════════════════════════════════════════════════════════════════

let cleanupScheduled = false;
export function scheduleApprovalCleanup() {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  const timer = setInterval(() => {
    try {
      const db = getDb();
      const now = new Date().toISOString();
      // Auto-expire: pending approvals past their expires_at
      const expired = db.prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(now);
      if (expired.changes > 0) {
        // ponytail: log to stderr for server visibility; no new dep
        process.stderr.write(`[approval] auto-expired ${expired.changes} pending approvals\n`);
      }
      // Retention: delete terminal-state approvals older than RETENTION_DAYS
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
      db.prepare(
        `DELETE FROM approvals WHERE status IN ('rejected', 'expired', 'canceled', 'executed') AND created_at < ?`,
      ).run(cutoff);
    } catch { /* db may not be ready */ }
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
  // Run once shortly after startup
  setTimeout(() => {
    try {
      const db = getDb();
      const now = new Date().toISOString();
      db.prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(now);
    } catch { /* db may not be ready */ }
  }, 10_000).unref();
}

// ═══════════════════════════════════════════════════════════════════════
// REST Routes
// ═══════════════════════════════════════════════════════════════════════

export function registerApprovalRoutes(app: FastifyInstance) {
  const db = getDb();

  registerHealthCheck('approval', async (): Promise<BlockHealth> => {
    try {
      const row = db.prepare("SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'").get() as { c: number };
      return { status: 'healthy', message: `${row.c} pending approvals`, lastCheck: '' };
    } catch {
      return { status: 'healthy', message: '0 pending approvals', lastCheck: '' };
    }
  });

  // Schedule expiry cleanup on first route registration
  scheduleApprovalCleanup();

  // ─── Submit Action for Approval ───
  app.post('/approval/submit', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(submitApprovalSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });

    const result = submitApproval(userId, parsed.data);
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.send({ id: result.data.id, status: 'pending', message: 'Waiting for human approval' });
  });

  // ─── Respond to Approval (admin only, no self-approval, race-safe) ───
  app.post('/approval/respond', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(respondApprovalSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });

    const result = respondToApproval(userId, parsed.data.approval_id, parsed.data.approve, parsed.data.reason);
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.send({
      id: parsed.data.approval_id,
      status: parsed.data.approve ? 'approved' : 'rejected',
      resolved_by: result.data.resolved_by,
    });
  });

  // ─── Cancel Approval (requester or admin) ───
  app.post('/approval/cancel', async (req: FastifyRequest<{ Body: { approval_id: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { approval_id } = req.body ?? {};
    if (!approval_id || typeof approval_id !== 'string') {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'approval_id is required' });
    }

    const result = cancelApproval(userId, approval_id);
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.send({ id: approval_id, status: 'canceled' });
  });

  // ─── Mark Approval as Executed (admin or requester) ───
  app.post('/approval/execute', async (req: FastifyRequest<{ Body: { approval_id: string; result: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { approval_id, result: executionResult } = req.body ?? {};
    if (!approval_id || typeof approval_id !== 'string') {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'approval_id is required' });
    }
    if (!executionResult || typeof executionResult !== 'string') {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'result is required' });
    }

    const result = markExecuted(userId, approval_id, executionResult);
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.send({ id: approval_id, status: 'executed' });
  });

  // ─── Get Single Approval (sanitized) ───
  app.get('/approval/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const approval = getApproval(req.params.id);
    if (!approval) return reply.code(404).send({ error: 'APPROVAL_NOT_FOUND' });

    // Authorization: must be member of the approval's group
    if (!isGroupMember(userId, approval.group_id as string)) {
      return reply.code(403).send({ error: 'NOT_A_MEMBER' });
    }

    return reply.send({ approval });
  });

  // ─── Get Pending Approvals (scoped to user's groups) ───
  app.get('/approval/pending', async (req: FastifyRequest<{ Querystring: { group_id?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const userGroups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    const allowedGroups = userGroups.map(g => g.group_id);

    if (allowedGroups.length === 0) return reply.send({ approvals: [], count: 0 });

    let query = "SELECT * FROM approvals WHERE status = 'pending'";
    const params: string[] = [];

    if (req.query.group_id) {
      if (!allowedGroups.includes(req.query.group_id)) return reply.code(403).send({ error: 'NOT_A_MEMBER' });
      query += ' AND group_id = ?';
      params.push(req.query.group_id);
    } else {
      query += ` AND group_id IN (${allowedGroups.map(() => '?').join(',')})`;
      params.push(...allowedGroups);
    }

    query += ' ORDER BY created_at ASC';
    const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

    return reply.send({
      approvals: rows.map(sanitizeApprovalRow),
      count: rows.length,
    });
  });

  // ─── Get Approval History ───
  app.get('/approval/history', async (req: FastifyRequest<{ Querystring: { group_id?: string; limit?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const userGroups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    const allowedGroups = userGroups.map(g => g.group_id);

    if (allowedGroups.length === 0) return reply.send({ approvals: [], count: 0 });

    let query = "SELECT * FROM approvals WHERE status != 'pending'";
    const params: (string | number)[] = [];

    if (req.query.group_id) {
      if (!allowedGroups.includes(req.query.group_id)) return reply.code(403).send({ error: 'NOT_A_MEMBER' });
      query += ' AND group_id = ?';
      params.push(req.query.group_id);
    } else {
      query += ` AND group_id IN (${allowedGroups.map(() => '?').join(',')})`;
      params.push(...allowedGroups);
    }

    query += ' ORDER BY COALESCE(resolved_at, canceled_at, created_at) DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

    return reply.send({
      approvals: rows.map(sanitizeApprovalRow),
      count: rows.length,
    });
  });

  // M-fix: deleted /approval/mcp-submit — MCP tool uses `connect` token,
  // same as every other tool. The body-token pattern was inconsistent and
  // leaked tokens in proxy logs. MCP submit_approval tool is unaffected.
}
