// Block: Group Management
// CRUD, membership, join requests, admin operations.
// Depends on: auth, security, relay, shared/{db,realtime,validation,result,types}.
//
// This block OWNS all group-domain business logic (create, join, respond,
// leave, membership check). Both the REST routes (below) and the MCP tools
// (blocks/mcp/universal.ts) import these functions — so the two layers can
// never drift on rate-limiting, validation, or notification delivery.
//
// The join/approve/reject notifications go through the shared realtime
// registry (shared/realtime.ts) for local sockets AND through NATS
// (publishToUser) for cross-instance delivery.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { generateInviteCode } from '../security/crypto.js';
import { removeConsumer, publishToUser } from '../relay/index.js';
import { registerUserSocket, unregisterUserSocket, notifyUser, notifyGroup } from '../../shared/realtime.js';
import { parse, createGroupSchema, joinGroupSchema, respondJoinSchema } from '../../shared/validation.js';
import { ok, err, type OpResult } from '../../shared/result.js';
import type { Group, RelayEvent } from '../../shared/types.js';

// Re-export for backward compat (messages block imports these from here)
export { registerUserSocket, unregisterUserSocket, notifyUser, notifyGroup };

// ─── Domain: Membership check ───
export function isGroupMember(userId: string, groupId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
}

// ─── Domain: Create Group ───
export interface CreateGroupInput {
  name: string;
  description?: string;
  group_type?: 'team' | 'project' | 'open';
}

export function createNewGroup(userId: string, input: CreateGroupInput): OpResult<{ id: string; invite_code: string }> {
  const db = getDb();

  const rl = checkRateLimit(`group:create:${userId}`, 3600_000, 10);
  if (!rl.allowed) return err('RATE_LIMITED', 'Too many groups created', 429);

  const groupId = nanoid();
  const inviteCode = generateInviteCode();
  const groupType = input.group_type || 'team';

  db.prepare('INSERT INTO groups (id, name, description, invite_code, admin_id, group_type) VALUES (?,?,?,?,?,?)')
    .run(groupId, input.name, input.description ?? null, inviteCode, userId, groupType);
  db.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?,?,?,?)')
    .run(nanoid(), groupId, userId, 'admin');

  return ok({ id: groupId, invite_code: inviteCode });
}

// ─── Domain: Request to Join Group ───
export function requestJoinGroup(userId: string, inviteCode: string): OpResult<{ request_id: string; group_id: string }> {
  const db = getDb();

  const rl = checkRateLimit(`join:${userId}`, 300_000, 10);
  if (!rl.allowed) return err('RATE_LIMITED', 'Too many join attempts', 429);

  const group = db.prepare('SELECT id, name, admin_id FROM groups WHERE invite_code = ?').get(inviteCode) as { id: string; name: string; admin_id: string } | undefined;
  if (!group) return err('INVALID_INVITE_CODE', 'Invalid invite code', 404);

  const existing = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, userId);
  if (existing) return err('ALREADY_MEMBER', 'Already a member', 409);

  // The join_requests table has UNIQUE(group_id, user_id) with no status
  // distinction. A bare INSERT used to fail with SQLITE_CONSTRAINT_UNIQUE if a
  // previous request row existed — even after the user left the group (the old
  // 'approved'/'rejected' row stayed), locking them out forever with a
  // misleading 'REQUEST_PENDING' error. Upsert instead: re-activate any
  // existing row to 'pending' (the admin gets a fresh notification), or insert
  // a new one. This makes join → approve → leave → rejoin work.
  const requestId = nanoid();
  const info = db.prepare(
    `INSERT INTO join_requests (id, group_id, user_id, status) VALUES (?,?,?,?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET status='pending', created_at=datetime('now')`
  ).run(requestId, group.id, userId, 'pending');

  // If the upsert updated an existing row (changes=1 but it was an UPDATE, not
  // INSERT), reuse the existing id so the admin's notification references a
  // real request. We detect "was an update" by checking if our generated id
  // was actually inserted.
  let actualRequestId = requestId;
  if (info.changes > 0) {
    const row = db.prepare('SELECT id FROM join_requests WHERE group_id = ? AND user_id = ?').get(group.id, userId) as { id: string } | undefined;
    if (row) actualRequestId = row.id;
  }

  notifyUserEverywhere(group.admin_id, {
    type: 'join_request',
    payload: { request_id: actualRequestId, group_id: group.id, group_name: group.name },
    timestamp: new Date().toISOString(),
  });

  return ok({ request_id: actualRequestId, group_id: group.id });
}

// ─── Domain: Respond to Join Request (admin only) ───
export function respondToJoinRequest(adminId: string, requestId: string, approve: boolean): OpResult<{ group_id: string; user_id: string }> {
  const db = getDb();

  const joinReq = db.prepare('SELECT * FROM join_requests WHERE id = ?').get(requestId) as { group_id: string; user_id: string; status: string } | undefined;
  if (!joinReq || joinReq.status !== 'pending') return err('REQUEST_NOT_FOUND', 'Pending request not found', 404);

  const group = db.prepare('SELECT admin_id FROM groups WHERE id = ?').get(joinReq.group_id) as { admin_id: string };
  if (group.admin_id !== adminId) return err('ADMIN_ONLY', 'Admin only', 403);

  if (approve) {
    db.prepare("UPDATE join_requests SET status = 'approved' WHERE id = ?").run(requestId);
    db.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?,?,?,?)')
      .run(nanoid(), joinReq.group_id, joinReq.user_id, 'member');
    notifyUserEverywhere(joinReq.user_id, { type: 'member_joined', payload: { group_id: joinReq.group_id, status: 'approved' }, timestamp: new Date().toISOString() });
  } else {
    db.prepare("UPDATE join_requests SET status = 'rejected' WHERE id = ?").run(requestId);
    notifyUserEverywhere(joinReq.user_id, { type: 'join_rejected', payload: { group_id: joinReq.group_id, status: 'rejected' }, timestamp: new Date().toISOString() });
  }

  return ok({ group_id: joinReq.group_id, user_id: joinReq.user_id });
}

// ─── Domain: Leave Group ───
export async function leaveGroup(userId: string, groupId: string): Promise<OpResult<true>> {
  const db = getDb();
  const group = db.prepare('SELECT admin_id FROM groups WHERE id = ?').get(groupId) as { admin_id: string } | undefined;
  if (!group) return err('GROUP_NOT_FOUND', 'Group not found', 404);
  if (group.admin_id === userId) return err('ADMIN_CANNOT_LEAVE', 'Admin cannot leave (transfer or delete instead)', 400);

  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);

  // Clean up NATS consumer (best-effort — relay may be down)
  try { await removeConsumer(groupId, userId); } catch { /* NATS may be down */ }

  return ok(true);
}

// ─── Internal: notify a user via BOTH local sockets and NATS ───
// Local fast path (notifyUser from shared/realtime) + cross-instance path
// (publishToUser from relay). Best-effort on the relay leg — local delivery
// still happens even if NATS is down.
function notifyUserEverywhere(userId: string, event: RelayEvent) {
  notifyUser(userId, event);
  try { publishToUser(userId, event); } catch { /* NATS down — local delivery still happened */ }
}

// Helper: fetch members of a group (used by notifyGroup)
function groupMembersFetcher(groupId: string): Array<{ user_id: string }> {
  return getDb().prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId) as { user_id: string }[];
}

// ═══════════════════════════════════════════════════════════════════════
// REST Routes — thin wrappers over the domain functions above.
// MCP tools (blocks/mcp/universal.ts) call the SAME domain functions.
// ═══════════════════════════════════════════════════════════════════════

export function registerGroupRoutes(app: FastifyInstance) {
  const db = getDb();

  registerHealthCheck('groups', async (): Promise<BlockHealth> => {
    try {
      db.prepare('SELECT COUNT(*) FROM groups').get();
      return { status: 'healthy', lastCheck: '' };
    } catch (err) {
      return { status: 'unhealthy', message: String(err), lastCheck: '' };
    }
  });

  // ─── Create Group ───
  app.post('/groups', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(createGroupSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });

    const result = createNewGroup(userId, parsed.data);
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(result.data.id);
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

  // ─── Approve/Reject Join Request ───
  app.post('/groups/join/respond', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(respondJoinSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });

    const result = respondToJoinRequest(userId, parsed.data.request_id, parsed.data.approve);
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.send({ status: parsed.data.approve ? 'approved' : 'rejected' });
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

    const result = await leaveGroup(userId, req.params.id);
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.send({ status: 'left' });
  });

  // ─── Remove Member (admin only) ───
  app.delete('/groups/:id/members/:userId', async (req: FastifyRequest<{ Params: { id: string; userId: string } }>, reply) => {
    const adminId = authenticate(req);
    if (!adminId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as Group | undefined;
    if (!group || group.admin_id !== adminId) return reply.code(403).send({ error: 'ADMIN_ONLY' });
    if (req.params.userId === adminId) return reply.code(400).send({ error: 'CANNOT_REMOVE_SELF' });

    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, req.params.userId);

    notifyUserEverywhere(req.params.userId, {
      type: 'member_left',
      payload: { group_id: req.params.id, status: 'removed' },
      timestamp: new Date().toISOString(),
    });

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

    notifyGroup(req.params.id, {
      type: 'notification',
      payload: { group_id: req.params.id, status: 'deleted' },
      timestamp: new Date().toISOString(),
    }, undefined, groupMembersFetcher);

    db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);

    return reply.send({ status: 'deleted' });
  });

  // ─── Request to Join (rate-limited) ───
  app.post('/groups/join', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(joinGroupSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });

    const result = requestJoinGroup(userId, parsed.data.invite_code);
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.send({ status: 'pending', request_id: result.data.request_id });
  });
}
