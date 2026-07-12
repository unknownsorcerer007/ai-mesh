// Shared: Realtime WebSocket Registry
//
// SINGLE source of truth for "which user has which open sockets". Was split
// across the groups block (userSockets) and messages block (wsConnections) —
// the two maps were never synced, so notifyUser() in groups iterated an empty
// set and join/approve/reject notifications were silently dropped. Now both
// blocks register/unregister through this module.

export interface ManagedSocket {
  readyState: number;
  send: (data: string) => void;
  close?: (code?: number, reason?: string) => void;
}

const socketsByUser = new Map<string, Set<ManagedSocket>>();

export function registerUserSocket(userId: string, ws: ManagedSocket) {
  let set = socketsByUser.get(userId);
  if (!set) { set = new Set(); socketsByUser.set(userId, set); }
  set.add(ws);
}

export function unregisterUserSocket(userId: string, ws: ManagedSocket) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) socketsByUser.delete(userId);
}

export function isUserOnline(userId: string): boolean {
  const set = socketsByUser.get(userId);
  if (!set) return false;
  for (const ws of set) if (ws.readyState === 1) return true;
  return false;
}

// Deliver to every open socket of a single user. Returns true if at least one
// socket accepted the message.
export function deliverToUser(userId: string, event: unknown): boolean {
  const set = socketsByUser.get(userId);
  if (!set || set.size === 0) return false;
  const data = JSON.stringify(event);
  let delivered = false;
  for (const ws of set) {
    try { if (ws.readyState === 1) { ws.send(data); delivered = true; } } catch { /* closed */ }
  }
  return delivered;
}

// Notify a single user (used by groups for join/approve/reject events).
export function notifyUser(userId: string, event: unknown) {
  deliverToUser(userId, event);
}

// Notify every member of a group except optionally one user.
export function notifyGroup(groupId: string, event: unknown, excludeUserId?: string, membersFetcher?: (gid: string) => Array<{ user_id: string }>) {
  if (!membersFetcher) return;
  const members = membersFetcher(groupId);
  for (const m of members) {
    if (m.user_id !== excludeUserId) notifyUser(m.user_id, event);
  }
}

export function getOnlineSocketCount(userId: string): number {
  const set = socketsByUser.get(userId);
  if (!set) return 0;
  let n = 0;
  for (const ws of set) if (ws.readyState === 1) n++;
  return n;
}
