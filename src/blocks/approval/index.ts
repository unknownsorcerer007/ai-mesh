// Block: Approval Queue (Human-in-the-Loop)
// Critical actions need human approval before execution
// SQLite-backed — survives restarts

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import type { RelayMessage } from '../../shared/types.js';

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
  app.post('/approval/submit', async (req: FastifyRequest<{ Body: {
    group_id: string;
    action: string;
    details?: string;
  } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { group_id, action, details } = req.body;
    if (!group_id || !action) return reply.code(400).send({ error: 'GROUP_ID_AND_ACTION_REQUIRED' });

    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(group_id, userId) as any;
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as any;
    const approvalId = nanoid();
    const now = new Date().toISOString();

    db.prepare('INSERT INTO approvals (id, group_id, requester_id, requester_name, action, details, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(approvalId, group_id, userId, user.username, action, details || '', 'pending', now);

    try {
      const { publishToGroup } = await import('../relay/index.js');
      publishToGroup(group_id, {
        id: nanoid(),
        group_id,
        sender_id: 'system',
        sender_username: 'Approval System',
        sender_ai: 'approval',
        type: 'alert',
        content: `⏳ PENDING APPROVAL\n\nAction: ${action}\nRequested by: ${user.username}\nDetails: ${details || 'None'}\n\nApproval ID: ${approvalId}\n\nUse /approval/respond to approve or reject.`,
        timestamp: now,
      });
    } catch { /* NATS may be down */ }

    return reply.send({
      id: approvalId,
      status: 'pending',
      message: 'Waiting for human approval',
    });
  });

  // ─── Respond to Approval (Human) ───
  app.post('/approval/respond', async (req: FastifyRequest<{ Body: {
    approval_id: string;
    approve: boolean;
    reason?: string;
  } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { approval_id, approve, reason } = req.body;
    if (!approval_id) return reply.code(400).send({ error: 'APPROVAL_ID_REQUIRED' });

    const approval = db.prepare('SELECT * FROM approvals WHERE id = ? AND status = ?').get(approval_id, 'pending') as any;
    if (!approval) return reply.code(404).send({ error: 'APPROVAL_NOT_FOUND' });

    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(approval.group_id, userId) as any;
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const responder = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as any;
    const now = new Date().toISOString();

    db.prepare("UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, reason = ? WHERE id = ?")
      .run(approve ? 'approved' : 'rejected', now, responder.username, reason || null, approval_id);

    try {
      const { publishToGroup } = await import('../relay/index.js');
      const icon = approve ? '✅' : '❌';
      const status = approve ? 'APPROVED' : 'REJECTED';
      publishToGroup(approval.group_id, {
        id: nanoid(),
        group_id: approval.group_id,
        sender_id: 'system',
        sender_username: 'Approval System',
        sender_ai: 'approval',
        type: approve ? 'system' : 'alert',
        content: `${icon} ${status}\n\nAction: ${approval.action}\nRequested by: ${approval.requester_name}\nResolved by: ${responder.username}${reason ? `\nReason: ${reason}` : ''}`,
        timestamp: now,
      });
    } catch { /* NATS may be down */ }

    return reply.send({
      id: approval_id,
      status: approve ? 'approved' : 'rejected',
      resolved_by: responder.username,
    });
  });

  // ─── Get Pending Approvals ───
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
    const params: string[] = [];

    if (req.query.group_id) {
      if (!allowedGroups.includes(req.query.group_id)) return reply.code(403).send({ error: 'NOT_A_MEMBER' });
      query += ' AND group_id = ?';
      params.push(req.query.group_id);
    } else {
      query += ` AND group_id IN (${allowedGroups.map(() => '?').join(',')})`;
      params.push(...allowedGroups);
    }

    query += ' ORDER BY resolved_at DESC LIMIT ?';
    params.push(String(limit));

    const approvals = db.prepare(query).all(...params);

    return reply.send({ approvals, count: approvals.length });
  });

  // ─── MCP Tool: Submit for Approval ───
  app.post('/approval/mcp-submit', async (req: FastifyRequest<{ Body: {
    token: string;
    group_id: string;
    action: string;
    details?: string;
  } }>, reply) => {
    const { verifyToken } = await import('../security/index.js');
    const config = await import('../../core/config.js').then(m => m.getConfig());
    const userId = verifyToken(req.body.token, config.session.secret, config.session.tokenTtlMs);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { group_id, action, details } = req.body;
    if (!group_id || !action) return reply.code(400).send({ error: 'GROUP_ID_AND_ACTION_REQUIRED' });

    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(group_id, userId) as any;
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as any;
    const approvalId = nanoid();
    const now = new Date().toISOString();

    db.prepare('INSERT INTO approvals (id, group_id, requester_id, requester_name, action, details, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(approvalId, group_id, userId, user.username, action, details || '', 'pending', now);

    try {
      const { publishToGroup } = await import('../relay/index.js');
      publishToGroup(group_id, {
        id: nanoid(),
        group_id,
        sender_id: 'system',
        sender_username: 'Approval System',
        sender_ai: 'approval',
        type: 'alert',
        content: `⏳ PENDING APPROVAL\n\nAction: ${action}\nRequested by: ${user.username}\nDetails: ${details || 'None'}\n\nApproval ID: ${approvalId}`,
        timestamp: now,
      });
    } catch { /* NATS may be down */ }

    return reply.send({ id: approvalId, status: 'pending' });
  });
}

// ─── Check if approval is approved ───
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
