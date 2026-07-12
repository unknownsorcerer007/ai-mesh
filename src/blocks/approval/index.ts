// Block: Approval Queue (Human-in-the-Loop)
// Critical actions need human approval before execution.
//
// Uses shared/business-logic.ts for submit + respond, so:
//  - Self-approval is blocked (requester cannot approve their own request).
//  - Only admins can resolve approvals (not any member).
//  - Rate-limited + membership-checked consistently with the MCP path.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { verifyToken } from '../security/index.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { getConfig } from '../../core/config.js';
import { publishToGroup, publishToUser } from '../relay/index.js';
import { notifyUser } from '../groups/index.js';
import { isGroupMember } from '../groups/index.js';
import { ok, err, type OpResult } from '../../shared/result.js';
import { parse, submitApprovalSchema, respondApprovalSchema } from '../../shared/validation.js';
import type { RelayEvent } from '../../shared/types.js';

// ═══════════════════════════════════════════════════════════════════════
// Domain: Approval operations
// This block OWNS approval logic. Both the REST routes (below) and the MCP
// tools (blocks/mcp/universal.ts) call these functions, so they can never
// drift on self-approval guards, admin-only checks, or rate-limiting.
// ═══════════════════════════════════════════════════════════════════════

// Notify a user via BOTH local sockets and NATS (cross-instance).
function notifyUserEverywhere(userId: string, event: RelayEvent) {
  notifyUser(userId, event);
  try { publishToUser(userId, event); } catch { /* NATS down */ }
}

export function submitApproval(userId: string, input: { group_id: string; action: string; details?: string }): OpResult<{ id: string }> {
  const db = getDb();

  if (!isGroupMember(userId, input.group_id)) return err('NOT_A_MEMBER', 'Not a member of this group', 403);

  const usernameRow = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  if (!usernameRow) return err('USER_NOT_FOUND', 'User not found', 404);
  const username = usernameRow.username;

  const rl = checkRateLimit(`approval:${userId}`, 3600_000, 50);
  if (!rl.allowed) return err('RATE_LIMITED', 'Too many approval requests', 429);

  const approvalId = nanoid();
  const now = new Date().toISOString();
  const details = input.details ?? '';

  db.prepare('INSERT INTO approvals (id, group_id, requester_id, requester_name, action, details, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(approvalId, input.group_id, userId, username, input.action, details, 'pending', now);

  publishToGroup(input.group_id, {
    id: nanoid(),
    group_id: input.group_id,
    sender_id: 'system',
    sender_username: 'Approval System',
    sender_ai: 'approval',
    type: 'alert',
    content: `⏳ PENDING APPROVAL\n\nAction: ${input.action}\nRequested by: ${username}\nDetails: ${details || 'None'}\n\nApproval ID: ${approvalId}`,
    timestamp: now,
  });

  return ok({ id: approvalId });
}

export function respondToApproval(userId: string, approvalId: string, approve: boolean, reason?: string): OpResult<{ resolved_by: string }> {
  const db = getDb();

  const approval = db.prepare('SELECT * FROM approvals WHERE id = ? AND status = ?').get(approvalId, 'pending') as { group_id: string; action: string; requester_id: string; requester_name: string } | undefined;
  if (!approval) return err('APPROVAL_NOT_FOUND', 'Pending approval not found', 404);

  // Self-approval guard
  if (approval.requester_id === userId) return err('CANNOT_SELF_APPROVE', 'Cannot approve your own request', 403);

  const member = db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(approval.group_id, userId) as { role: string } | undefined;
  if (!member) return err('NOT_A_MEMBER', 'Not a member of this group', 403);
  if (member.role !== 'admin') return err('ADMIN_ONLY', 'Only admins can resolve approvals', 403);

  const responderRow = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  if (!responderRow) return err('USER_NOT_FOUND', 'User not found', 404);
  const responder = responderRow.username;

  const now = new Date().toISOString();
  db.prepare("UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, reason = ? WHERE id = ?")
    .run(approve ? 'approved' : 'rejected', now, responder, reason ?? null, approvalId);

  publishToGroup(approval.group_id, {
    id: nanoid(),
    group_id: approval.group_id,
    sender_id: 'system',
    sender_username: 'Approval System',
    sender_ai: 'approval',
    type: approve ? 'system' : 'alert',
    content: `${approve ? '✅ APPROVED' : '❌ REJECTED'}\n\nAction: ${approval.action}\nRequested by: ${approval.requester_name}\nResolved by: ${responder}${reason ? `\nReason: ${reason}` : ''}`,
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
// REST Routes — thin wrappers over the domain functions above.
// MCP tools (blocks/mcp/universal.ts) call the SAME domain functions.
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

  // ─── Respond to Approval (admin only, no self-approval) ───
  app.post('/approval/respond', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(respondApprovalSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });

    const result = respondToApproval(userId, parsed.data.approval_id, parsed.data.approve, parsed.data.reason);
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.send({ id: parsed.data.approval_id, status: parsed.data.approve ? 'approved' : 'rejected', resolved_by: result.data.resolved_by });
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
    const approvals = db.prepare(query).all(...params);

    return reply.send({ approvals, count: approvals.length });
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

    query += ' ORDER BY resolved_at DESC LIMIT ?';
    params.push(limit);

    const approvals = db.prepare(query).all(...params);

    return reply.send({ approvals, count: approvals.length });
  });

  // ─── MCP Tool: Submit for Approval (token in body) ───
  // Same self-approval + admin guards apply (routed through shared business-logic).
  app.post('/approval/mcp-submit', async (req: FastifyRequest<{ Body: { token: string; group_id: string; action: string; details?: string } }>, reply) => {
    const config = getConfig();
    const userId = verifyToken(req.body?.token, config.session.secret, config.session.tokenTtlMs);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(submitApprovalSchema, { group_id: req.body?.group_id, action: req.body?.action, details: req.body?.details });
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });

    const result = submitApproval(userId, parsed.data);
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.send({ id: result.data.id, status: 'pending' });
  });
}

// ─── Check if approval is approved (exported for MCP) ───
export function getApprovalStatus(approvalId: string): 'pending' | 'approved' | 'rejected' | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT status FROM approvals WHERE id = ?').get(approvalId) as { status: string } | undefined;
    return (row?.status as any) || null;
  } catch {
    return null;
  }
}

export function getApproval(approvalId: string) {
  try {
    const db = getDb();
    return db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) || null;
  } catch {
    return null;
  }
}
