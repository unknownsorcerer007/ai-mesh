// MCP Local Message Store
// Messages saved on the USER's device — server stores nothing.
// Each MCP agent gets its own local JSONL files per group.
//
// Security fixes vs original:
//  - groupId is validated against ^[\w-]+$ before being used in ANY file path.
//    The original used `join(BASE_DIR, \`${groupId}.jsonl\`)` with no validation,
//    so a groupId like '../../../tmp/evil' could write/truncate files anywhere
//    the process had access to.
//  - File operations are async (appendFile, not appendFileSync) so the event
//    loop isn't blocked on every message save.
//  - Files are created with mode 0o600 and dirs with 0o700 — the default 0o644
//    let other local users read the message history.
//  - The index file is written atomically (write-temp-then-rename) so a crash
//    mid-write can't corrupt it.

import { appendFile, appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rename, unlink, writeFile } from 'node:fs';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const appendFileAsync = promisify(appendFile);
const writeFileAsync = promisify(writeFile);
const renameAsync = promisify(rename);
const unlinkAsync = promisify(unlink);

const BASE_DIR = resolve(homedir(), '.ai-mesh', 'messages');
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// Strict groupId validation — blocks path traversal and weird filenames.
// nanoid() (the default) matches this; manual IDs must too.
const GROUP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function ensureDir() {
  if (!existsSync(BASE_DIR)) {
    mkdirSync(BASE_DIR, { recursive: true, mode: DIR_MODE });
  }
}

function assertGroupId(groupId: string): void {
  if (!GROUP_ID_RE.test(groupId)) {
    throw new Error(`Invalid group id: ${JSON.stringify(groupId)}`);
  }
}

function getGroupFile(groupId: string): string {
  assertGroupId(groupId);
  ensureDir();
  return join(BASE_DIR, `${groupId}.jsonl`);
}

function getIndexFile(groupId: string): string {
  assertGroupId(groupId);
  ensureDir();
  return join(BASE_DIR, `${groupId}.index.json`);
}

// ─── Store type ───
export interface StoredMessage {
  id: string;
  group_id: string;
  sender_id: string;
  sender_username: string;
  sender_ai?: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  stored_at: string;
}

// ─── Save a message to local file ───
export async function saveMessage(msg: StoredMessage): Promise<void> {
  const file = getGroupFile(msg.group_id);
  const entry = JSON.stringify(msg) + '\n';
  await appendFileAsync(file, entry, { mode: FILE_MODE });
  await updateIndex(msg.group_id, msg);
}

// ─── Save multiple messages at once ───
export async function saveMessages(messages: StoredMessage[]): Promise<void> {
  if (messages.length === 0) return;
  ensureDir();
  const byGroup = new Map<string, StoredMessage[]>();
  for (const msg of messages) {
    // Validate every groupId before touching the filesystem.
    assertGroupId(msg.group_id);
    if (!byGroup.has(msg.group_id)) byGroup.set(msg.group_id, []);
    byGroup.get(msg.group_id)!.push(msg);
  }
  for (const [groupId, msgs] of byGroup) {
    const file = getGroupFile(groupId);
    // Dedup: read existing IDs and skip duplicates
    const existingIds = new Set<string>();
    if (existsSync(file)) {
      const content = readFileSync(file, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try { existingIds.add((JSON.parse(line) as StoredMessage).id); } catch {}
      }
    }
    const newMsgs = msgs.filter(m => !existingIds.has(m.id));
    if (newMsgs.length === 0) continue;
    const lines = newMsgs.map(m => JSON.stringify(m)).join('\n') + '\n';
    await appendFileAsync(file, lines, { mode: FILE_MODE });
    await updateIndex(groupId, newMsgs[newMsgs.length - 1]);
  }
}

// ─── Read messages for a group ───
// Reads the whole file (JSONL). For very large histories this is O(n) in RAM;
// for production scale we'd move to a real embedded DB, but for the MCP
// local-store use case (single agent, single machine) this is acceptable.
export function readMessages(groupId: string, limit?: number, before?: string): StoredMessage[] {
  const file = getGroupFile(groupId);
  if (!existsSync(file)) return [];

  const content = readFileSync(file, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  let messages: StoredMessage[] = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line) as StoredMessage); } catch { /* skip malformed */ }
  }

  if (before) messages = messages.filter(m => m.timestamp < before);
  if (limit) messages = messages.slice(-limit);
  return messages;
}

// ─── Get all groups that have local messages ───
export function getLocalGroups(): Array<{ group_id: string; message_count: number; last_message_at: string }> {
  ensureDir();
  const groups: Array<{ group_id: string; message_count: number; last_message_at: string }> = [];
  try {
    const files = readdirSync(BASE_DIR).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const groupId = file.replace('.jsonl', '');
      // Skip files whose name doesn't pass our groupId validation — they might
      // be attacker-placed or leftover from a buggy era.
      if (!GROUP_ID_RE.test(groupId)) continue;
      const indexFile = getIndexFile(groupId);
      if (existsSync(indexFile)) {
        try {
          const index = JSON.parse(readFileSync(indexFile, 'utf-8'));
          groups.push({ group_id: groupId, message_count: index.count || 0, last_message_at: index.last_message_at || '' });
        } catch {
          const msgs = readMessages(groupId);
          groups.push({ group_id: groupId, message_count: msgs.length, last_message_at: msgs[msgs.length - 1]?.timestamp || '' });
        }
      } else {
        const msgs = readMessages(groupId);
        groups.push({ group_id: groupId, message_count: msgs.length, last_message_at: msgs[msgs.length - 1]?.timestamp || '' });
      }
    }
  } catch { /* empty dir */ }
  return groups.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
}

// ─── Update index file atomically ───
async function updateIndex(groupId: string, msg: StoredMessage): Promise<void> {
  const indexFile = getIndexFile(groupId);
  let index = { count: 0, last_message_at: '', last_sender: '' };
  if (existsSync(indexFile)) {
    try { index = JSON.parse(readFileSync(indexFile, 'utf-8')); } catch { /* reset */ }
  }
  index.count++;
  index.last_message_at = msg.timestamp;
  index.last_sender = msg.sender_username || msg.sender_ai || 'unknown';

  // Atomic write: temp file + rename. A crash mid-write leaves the old index
  // intact rather than a truncated/empty file.
  const tmpFile = indexFile + '.tmp';
  await writeFileAsync(tmpFile, JSON.stringify(index), { mode: FILE_MODE });
  await renameAsync(tmpFile, indexFile);
}

// ─── Get storage stats ───
export function getStorageStats(): { total_messages: number; groups: number; disk_path: string } {
  const groups = getLocalGroups();
  const total = groups.reduce((sum, g) => sum + g.message_count, 0);
  return { total_messages: total, groups: groups.length, disk_path: BASE_DIR };
}

// ─── Clear messages for a group ───
export async function clearGroup(groupId: string): Promise<boolean> {
  const file = getGroupFile(groupId);
  const indexFile = getIndexFile(groupId);
  if (existsSync(file)) {
    // Truncate atomically: write empty temp, rename over the real file.
    const tmpFile = file + '.tmp';
    await writeFileAsync(tmpFile, '', { mode: FILE_MODE });
    await renameAsync(tmpFile, file);
    if (existsSync(indexFile)) await writeFileAsync(indexFile, JSON.stringify({ count: 0, last_message_at: '' }), { mode: FILE_MODE });
    return true;
  }
  return false;
}

// Synchronous convenience wrappers for code paths that aren't async-aware
// (kept for backward compat with callers that expect the old sync API).
export function saveMessageSync(msg: StoredMessage): void {
  const file = getGroupFile(msg.group_id);
  appendFileSync(file, JSON.stringify(msg) + '\n', { mode: FILE_MODE });
  // Best-effort sync index update
  try {
    const indexFile = getIndexFile(msg.group_id);
    let index = { count: 0, last_message_at: '', last_sender: '' };
    if (existsSync(indexFile)) index = JSON.parse(readFileSync(indexFile, 'utf-8'));
    index.count++;
    index.last_message_at = msg.timestamp;
    index.last_sender = msg.sender_username || msg.sender_ai || 'unknown';
    writeFileSync(indexFile, JSON.stringify(index), { mode: FILE_MODE });
  } catch { /* non-critical */ }
}
