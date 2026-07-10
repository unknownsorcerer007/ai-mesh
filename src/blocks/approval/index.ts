// Block: Approval Queue (Human-in-the-Loop)
// Critical actions need human approval before execution
// Eliminates prompt injection risk — human sees everything

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import type { RelayMessage } from '../../shared/types.js';

// ─── In-memory approval queue ───
const approvals = new Map<string, {
  id: string;
  group_id: string;
  requester_id: string;
  requester_name: string;
  action: string;
  details: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  resolved_at?: string;
  resolved_by?: string;
  reason?: string;
}>();

export function registerApprovalRoutes(app: FastifyInstance) {
  const db = getDb();

  registerHealthCheck('approval', async (): Promise<BlockHealth> => {
    let pending = 0;
    for (const [, a] of approvals) {
      if (a.status === 'pending') pending++;
    }
    return { status: 'healthy', message: `${pending} pending approvals`, lastCheck: '' };
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

    // Verify membership
    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(group_id, userId) as any;
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as any;

    const approvalId = nanoid();
    const now = new Date().toISOString();

    const approval = {
      id: approvalId,
      group_id,
      requester_id: userId,
      requester_name: user.username,
      action,
      details: details || '',
      status: 'pending' as const,
      created_at: now,
    };

    approvals.set(approvalId, approval);

    // Notify group about pending approval
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

    const approval = approvals.get(approval_id);
    if (!approval || approval.status !== 'pending') {
      return reply.code(404).send({ error: 'APPROVAL_NOT_FOUND' });
    }

    // Verify the responder is in the same group
    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(approval.group_id, userId) as any;
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const responder = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as any;

    // Update approval
    approval.status = approve ? 'approved' : 'rejected';
    approval.resolved_at = new Date().toISOString();
    approval.resolved_by = responder.username;
    approval.reason = reason;

    // Notify group
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
        timestamp: new Date().toISOString(),
      });
    } catch { /* NATS may be down */ }

    return reply.send({
      id: approval_id,
      status: approval.status,
      resolved_by: responder.username,
    });
  });

  // ─── Get Pending Approvals ───
  app.get('/approval/pending', async (req: FastifyRequest<{ Querystring: { group_id?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const pending: any[] = [];
    for (const [, a] of approvals) {
      if (a.status !== 'pending') continue;
      if (req.query.group_id && a.group_id !== req.query.group_id) continue;

      // Verify membership
      const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
        .get(a.group_id, userId);
      if (member) pending.push(a);
    }

    return reply.send({ approvals: pending, count: pending.length });
  });

  // ─── Get Approval History ───
  app.get('/approval/history', async (req: FastifyRequest<{ Querystring: { group_id?: string; limit?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const history: any[] = [];

    for (const [, a] of approvals) {
      if (a.status === 'pending') continue;
      if (req.query.group_id && a.group_id !== req.query.group_id) continue;

      const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
        .get(a.group_id, userId);
      if (member) history.push(a);
    }

    history.sort((a, b) => (b.resolved_at || '').localeCompare(a.resolved_at || ''));
    return reply.send({ approvals: history.slice(0, limit), count: Math.min(history.length, limit) });
  });

  // ─── MCP Tool: Submit for Approval ───
  // This is called by MCP agents when they want to do something risky
  app.post('/approval/mcp-submit', async (req: FastifyRequest<{ Body: {
    token: string;
    group_id: string;
    action: string;
    details?: string;
  } }>, reply) => {
    // MCP agents authenticate via token in body (not header)
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

    approvals.set(approvalId, {
      id: approvalId,
      group_id,
      requester_id: userId,
      requester_name: user.username,
      action,
      details: details || '',
      status: 'pending',
      created_at: now,
    });

    // Notify group
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
  return approvals.get(approvalId)?.status || null;
}

export function getApproval(approvalId: string) {
  return approvals.get(approvalId) || null;
}
