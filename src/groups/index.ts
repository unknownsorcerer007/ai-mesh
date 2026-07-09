import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import db from '../db/index.js';
import { authenticate } from '../auth/github.js';
import { generateInviteCode, checkRateLimit } from '../security/index.js';
import type { Group, GroupMember, JoinRequest, User } from '../types/index.js';

export function registerGroupRoutes(app: FastifyInstance) {

  // ─── Create Group ───
  app.post('/groups', async (req: FastifyRequest<{ Body: { name: string; description?: string; group_type?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { name, description, group_type } = req.body;
    if (!name || name.length < 1 || name.length > 100) {
      return reply.code(400).send({ error: 'Group name required (1-100 chars)' });
    }

    const rate = checkRateLimit(`group:create:${userId}`, 3600_000, 10); // 10 groups/hour
    if (!rate.allowed) return reply.code(429).send({ error: 'Rate limit: too many groups created' });

    const groupId = nanoid();
    const inviteCode = generateInviteCode();

    db.prepare(`
      INSERT INTO groups (id, name, description, invite_code, admin_id, group_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(groupId, name, description || null, inviteCode, userId, group_type || 'team');

    // Add creator as admin
    db.prepare(`
      INSERT INTO group_members (id, group_id, user_id, role)
      VALUES (?, ?, ?, 'admin')
    `).run(nanoid(), groupId, userId);

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
    return reply.code(201).send(group);
  });

  // ─── Get My Groups ───
  app.get('/groups', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const groups = db.prepare(`
      SELECT g.*, gm.role,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
      FROM groups g
      JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
      ORDER BY g.created_at DESC
    `).all(userId) as any[];

    return reply.send(groups);
  });

  // ─── Get Group Details ───
  app.get('/groups/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(req.params.id, userId);
    if (!member) return reply.code(403).send({ error: 'Not a member of this group' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
    const members = db.prepare(`
      SELECT u.id, u.username, u.hash_id, gm.role, gm.joined_at
      FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?
    `).all(req.params.id);

    return reply.send({ ...group, members });
  });

  // ─── Join Group (request to join) ───
  app.post('/groups/join', async (req: FastifyRequest<{ Body: { invite_code: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { invite_code } = req.body;
    if (!invite_code) return reply.code(400).send({ error: 'Invite code required' });

    const group = db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(invite_code) as Group | undefined;
    if (!group) return reply.code(404).send({ error: 'Invalid invite code' });

    // Already a member?
    const existing = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(group.id, userId);
    if (existing) return reply.code(409).send({ error: 'Already a member' });

    // Already has pending request?
    const pendingReq = db.prepare("SELECT * FROM join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'")
      .get(group.id, userId);
    if (pendingReq) return reply.code(409).send({ error: 'Join request already pending' });

    // Create join request (requires admin approval)
    const requestId = nanoid();
    db.prepare(`
      INSERT INTO join_requests (id, group_id, user_id, status)
      VALUES (?, ?, ?, 'pending')
    `).run(requestId, group.id, userId);

    // Notify group admin via WebSocket
    notifyUser(group.admin_id, {
      type: 'join_request',
      payload: { request_id: requestId, group_id: group.id, group_name: group.name },
      timestamp: new Date().toISOString(),
    });

    return reply.send({
      status: 'pending',
      message: 'Join request sent. Waiting for admin approval.',
      request_id: requestId,
    });
  });

  // ─── Approve/Reject Join Request ───
  app.post('/groups/join/respond', async (req: FastifyRequest<{ Body: { request_id: string; approve: boolean } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { request_id, approve } = req.body;
    if (!request_id) return reply.code(400).send({ error: 'Request ID required' });

    const joinReq = db.prepare('SELECT * FROM join_requests WHERE id = ?').get(request_id) as JoinRequest | undefined;
    if (!joinReq || joinReq.status !== 'pending') {
      return reply.code(404).send({ error: 'Request not found or already handled' });
    }

    // Only admin can approve
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(joinReq.group_id) as Group;
    if (group.admin_id !== userId) {
      return reply.code(403).send({ error: 'Only group admin can approve join requests' });
    }

    if (approve) {
      db.prepare("UPDATE join_requests SET status = 'approved' WHERE id = ?").run(request_id);
      db.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?, ?, ?, ?)')
        .run(nanoid(), joinReq.group_id, joinReq.user_id, 'member');

      // Notify the user they were approved
      notifyUser(joinReq.user_id, {
        type: 'member_joined',
        payload: { group_id: joinReq.group_id, status: 'approved' },
        timestamp: new Date().toISOString(),
      });

      return reply.send({ status: 'approved' });
    } else {
      db.prepare("UPDATE join_requests SET status = 'rejected' WHERE id = ?").run(request_id);
      notifyUser(joinReq.user_id, {
        type: 'member_joined',
        payload: { group_id: joinReq.group_id, status: 'rejected' },
        timestamp: new Date().toISOString(),
      });
      return reply.send({ status: 'rejected' });
    }
  });

  // ─── Pending Join Requests (for admin) ───
  app.get('/groups/:id/requests', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as Group | undefined;
    if (!group || group.admin_id !== userId) {
      return reply.code(403).send({ error: 'Only admin can view join requests' });
    }

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
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as Group | undefined;
    if (!group) return reply.code(404).send({ error: 'Group not found' });
    if (group.admin_id === userId) return reply.code(400).send({ error: 'Admin cannot leave. Delete the group instead.' });

    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .run(req.params.id, userId);

    return reply.send({ status: 'left' });
  });

  // ─── Remove Member (admin only) ───
  app.delete('/groups/:id/members/:userId', async (req: FastifyRequest<{ Params: { id: string; userId: string } }>, reply) => {
    const adminId = authenticate(req);
    if (!adminId) return reply.code(401).send({ error: 'Unauthorized' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as Group | undefined;
    if (!group || group.admin_id !== adminId) {
      return reply.code(403).send({ error: 'Only admin can remove members' });
    }
    if (req.params.userId === adminId) {
      return reply.code(400).send({ error: 'Cannot remove yourself' });
    }

    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .run(req.params.id, req.params.userId);

    return reply.send({ status: 'removed' });
  });
}

// ─── WebSocket notification helper ───
// Imported from ws module at runtime
const userSockets = new Map<string, Set<any>>();

export function registerUserSocket(userId: string, ws: any) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId)!.add(ws);
}

export function unregisterUserSocket(userId: string, ws: any) {
  userSockets.get(userId)?.delete(ws);
  if (userSockets.get(userId)?.size === 0) userSockets.delete(userId);
}

export function notifyUser(userId: string, event: unknown) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  const data = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(data);
  }
}

export function notifyGroup(groupId: string, event: unknown, excludeUserId?: string) {
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId) as { user_id: string }[];
  for (const m of members) {
    if (m.user_id !== excludeUserId) notifyUser(m.user_id, event);
  }
}
