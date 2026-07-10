// Block: Group Management
// CRUD, membership, join requests, admin operations
// Depends on: auth, security, shared/db

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { generateInviteCode, checkRateLimit } from '../security/index.js';
import { removeConsumer } from '../relay/index.js';
import type { Group, GroupMember, JoinRequest, User } from '../../shared/types.js';

// ─── WebSocket notification helpers ───
const userSockets = new Map<string, Set<{ readyState: number; send: (d: string) => void }>>();

export function registerUserSocket(userId: string, ws: { readyState: number; send: (d: string) => void }) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId)!.add(ws);
}

export function unregisterUserSocket(userId: string, ws: { readyState: number; send: (d: string) => void }) {
  userSockets.get(userId)?.delete(ws);
  if (userSockets.get(userId)?.size === 0) userSockets.delete(userId);
}

export function notifyUser(userId: string, event: unknown) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  const data = JSON.stringify(event);
  for (const ws of sockets) {
    try { if (ws.readyState === 1) ws.send(data); } catch { /* closed */ }
  }
}

export function notifyGroup(groupId: string, event: unknown, excludeUserId?: string) {
  const db = getDb();
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId) as { user_id: string }[];
  for (const m of members) {
    if (m.user_id !== excludeUserId) notifyUser(m.user_id, event);
  }
}

export function registerGroupRoutes(app: FastifyInstance) {
  const db = getDb();

  // Health check
  registerHealthCheck('groups', async (): Promise<BlockHealth> => {
    try {
      db.prepare('SELECT COUNT(*) FROM groups').get();
      return { status: 'healthy', lastCheck: '' };
    } catch (err) {
      return { status: 'unhealthy', message: String(err), lastCheck: '' };
    }
  });

  // ─── Create Group ───
  app.post('/groups', async (req: FastifyRequest<{ Body: { name: string; description?: string; group_type?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { name, description, group_type } = req.body;
    if (!name || name.length < 1 || name.length > 100) {
      return reply.code(400).send({ error: 'INVALID_NAME', message: 'Group name required (1-100 chars)' });
    }

    const rate = checkRateLimit(`group:create:${userId}`, 3600_000, 10);
    if (!rate.allowed) return reply.code(429).send({ error: 'RATE_LIMITED' });

    const groupId = nanoid();
    const inviteCode = generateInviteCode();

    db.prepare('INSERT INTO groups (id, name, description, invite_code, admin_id, group_type) VALUES (?,?,?,?,?,?)')
      .run(groupId, name, description || null, inviteCode, userId, group_type || 'team');
    db.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?,?,?,?)')
      .run(nanoid(), groupId, userId, 'admin');

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
    return reply.code(201).send(group);
  });

  // ─── Get My Groups ───
  app.get('/groups', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const groups = db.prepare(`
      SELECT g.*, gm.role,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
      FROM groups g
      JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
      ORDER BY g.created_at DESC
    `).all(userId);

    return reply.send(groups);
  });

  // ─── Get Group Details ───
  app.get('/groups/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(req.params.id, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    const members = db.prepare(`
      SELECT u.id, u.username, u.hash_id, gm.role, gm.joined_at
      FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?
    `).all(req.params.id);

    return reply.send({ ...(group as any), members });
  });

  // ─── Join Group (with rate limiting) ───

  // ─── Approve/Reject Join Request ───
  app.post('/groups/join/respond', async (req: FastifyRequest<{ Body: { request_id: string; approve: boolean } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { request_id, approve } = req.body;
    if (!request_id) return reply.code(400).send({ error: 'REQUEST_ID_REQUIRED' });

    const joinReq = db.prepare('SELECT * FROM join_requests WHERE id = ?').get(request_id) as JoinRequest | undefined;
    if (!joinReq || joinReq.status !== 'pending') return reply.code(404).send({ error: 'REQUEST_NOT_FOUND' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(joinReq.group_id) as Group;
    if (group.admin_id !== userId) return reply.code(403).send({ error: 'ADMIN_ONLY' });

    if (approve) {
      db.prepare("UPDATE join_requests SET status = 'approved' WHERE id = ?").run(request_id);
      db.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?,?,?,?)')
        .run(nanoid(), joinReq.group_id, joinReq.user_id, 'member');
      notifyUser(joinReq.user_id, { type: 'member_joined', payload: { group_id: joinReq.group_id, status: 'approved' }, timestamp: new Date().toISOString() });
      return reply.send({ status: 'approved' });
    } else {
      db.prepare("UPDATE join_requests SET status = 'rejected' WHERE id = ?").run(request_id);
      notifyUser(joinReq.user_id, { type: 'member_joined', payload: { group_id: joinReq.group_id, status: 'rejected' }, timestamp: new Date().toISOString() });
      return reply.send({ status: 'rejected' });
    }
  });

  // ─── Pending Requests ───
  app.get('/groups/:id/requests', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as Group | undefined;
    if (!group || group.admin_id !== userId) return reply.code(403).send({ error: 'ADMIN_ONLY' });

    const requests = db.prepare(`
      SELECT jr.*, u.username, u.hash_id
      FROM join_requests jr JOIN users u ON u.id = jr.user_id
      WHERE jr.group_id = ? AND jr.status = 'pending'
      ORDER BY jr.created_at ASC
    `).all(req.params.id);

    return reply.send(requests);
  });

  // ─── Leave Group ───
  app.delete('/groups/:id/leave', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as Group | undefined;
    if (!group) return reply.code(404).send({ error: 'GROUP_NOT_FOUND' });
    if (group.admin_id === userId) return reply.code(400).send({ error: 'ADMIN_CANNOT_LEAVE' });

    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, userId);

    // Fix: Clean up NATS consumer when user leaves
    try { await removeConsumer(req.params.id, userId); } catch { /* NATS may be down */ }

    return reply.send({ status: 'left' });
  });

  // ─── Remove Member ───
  app.delete('/groups/:id/members/:userId', async (req: FastifyRequest<{ Params: { id: string; userId: string } }>, reply) => {
    const adminId = authenticate(req);
    if (!adminId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as Group | undefined;
    if (!group || group.admin_id !== adminId) return reply.code(403).send({ error: 'ADMIN_ONLY' });
    if (req.params.userId === adminId) return reply.code(400).send({ error: 'CANNOT_REMOVE_SELF' });

    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, req.params.userId);

    // Fix: Clean up NATS consumer when member removed
    try { await removeConsumer(req.params.id, req.params.userId); } catch { /* NATS may be down */ }

    return reply.send({ status: 'removed' });
  });

  // ─── Delete Group (admin only) ───
  app.delete('/groups/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as Group | undefined;
    if (!group) return reply.code(404).send({ error: 'GROUP_NOT_FOUND' });
    if (group.admin_id !== userId) return reply.code(403).send({ error: 'ADMIN_ONLY' });

    // Delete group (CASCADE will clean up members, join_requests)
    db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);

    return reply.send({ status: 'deleted' });
  });

  // ─── Invite Code Rate Limit (per-IP) ───
  app.post('/groups/join', async (req: FastifyRequest<{ Body: { invite_code: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    // Fix: Rate limit per-user for invite code attempts
    const rate = checkRateLimit(`join:${userId}`, 300_000, 10); // 10 attempts per 5 min
    if (!rate.allowed) return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many join attempts' });

    const { invite_code } = req.body;
    if (!invite_code) return reply.code(400).send({ error: 'INVITE_CODE_REQUIRED' });

    const group = db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(invite_code) as Group | undefined;
    if (!group) return reply.code(404).send({ error: 'INVALID_INVITE_CODE' });

    const existing = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, userId);
    if (existing) return reply.code(409).send({ error: 'ALREADY_MEMBER' });

    // Fix: Use DB UNIQUE constraint to prevent race condition
    const requestId = nanoid();
    try {
      db.prepare('INSERT INTO join_requests (id, group_id, user_id, status) VALUES (?,?,?,?)')
        .run(requestId, group.id, userId, 'pending');
    } catch (err: any) {
      if (err.message?.includes('UNIQUE') || err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return reply.code(409).send({ error: 'REQUEST_PENDING' });
      }
      throw err;
    }

    notifyUser(group.admin_id, {
      type: 'join_request',
      payload: { request_id: requestId, group_id: group.id, group_name: group.name },
      timestamp: new Date().toISOString(),
    });

    return reply.send({ status: 'pending', request_id: requestId });
  });
}
