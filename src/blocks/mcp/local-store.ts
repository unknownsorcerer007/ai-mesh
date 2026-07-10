// MCP Local Message Store
// Messages saved on the USER's device — server stores nothing
// Each MCP agent gets its own local JSONL files per group
//
// File structure:
//   ~/.ai-mesh/messages/{group_id}.jsonl      — all messages (append-only)
//   ~/.ai-mesh/messages/{group_id}.index.json  — quick lookup index
//
// User can read old messages anytime from these files.

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const BASE_DIR = resolve(homedir(), '.ai-mesh', 'messages');

// ─── Ensure directory exists ───
function ensureDir() {
  if (!existsSync(BASE_DIR)) {
    mkdirSync(BASE_DIR, { recursive: true });
  }
}

// ─── Get file path for a group ───
function getGroupFile(groupId: string): string {
  ensureDir();
  return join(BASE_DIR, `${groupId}.jsonl`);
}

function getIndexFile(groupId: string): string {
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
  stored_at: string; // when we saved it locally
}

// ─── Save a message to local file ───
export function saveMessage(msg: StoredMessage): void {
  const file = getGroupFile(msg.group_id);
  const entry = JSON.stringify(msg);
  appendFileSync(file, entry + '\n');

  // Update index (for quick group listing)
  updateIndex(msg.group_id, msg);
}

// ─── Save multiple messages at once ───
export function saveMessages(messages: StoredMessage[]): void {
  if (messages.length === 0) return;
  ensureDir();
  // Group by group_id for batch write
  const byGroup = new Map<string, StoredMessage[]>();
  for (const msg of messages) {
    if (!byGroup.has(msg.group_id)) byGroup.set(msg.group_id, []);
    byGroup.get(msg.group_id)!.push(msg);
  }
  for (const [groupId, msgs] of byGroup) {
    const file = getGroupFile(groupId);
    const lines = msgs.map(m => JSON.stringify(m)).join('\n') + '\n';
    appendFileSync(file, lines);
    // Update index with last message
    updateIndex(groupId, msgs[msgs.length - 1]);
  }
}

// ─── Read messages for a group ───
export function readMessages(groupId: string, limit?: number, before?: string): StoredMessage[] {
  const file = getGroupFile(groupId);
  if (!existsSync(file)) return [];

  const content = readFileSync(file, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  let messages: StoredMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as StoredMessage);
    } catch { /* skip malformed lines */ }
  }

  // Filter by `before` timestamp if provided
  if (before) {
    messages = messages.filter(m => m.timestamp < before);
  }

  // Return latest N messages
  if (limit) {
    messages = messages.slice(-limit);
  }

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
      const indexFile = getIndexFile(groupId);
      if (existsSync(indexFile)) {
        try {
          const index = JSON.parse(readFileSync(indexFile, 'utf-8'));
          groups.push({
            group_id: groupId,
            message_count: index.count || 0,
            last_message_at: index.last_message_at || '',
          });
        } catch {
          // Index corrupted, count from file
          const msgs = readMessages(groupId);
          groups.push({
            group_id: groupId,
            message_count: msgs.length,
            last_message_at: msgs[msgs.length - 1]?.timestamp || '',
          });
        }
      } else {
        const msgs = readMessages(groupId);
        groups.push({
          group_id: groupId,
          message_count: msgs.length,
          last_message_at: msgs[msgs.length - 1]?.timestamp || '',
        });
      }
    }
  } catch { /* empty dir */ }

  return groups.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
}

// ─── Update index file ───
function updateIndex(groupId: string, msg: StoredMessage): void {
  const indexFile = getIndexFile(groupId);
  let index = { count: 0, last_message_at: '', last_sender: '' };

  if (existsSync(indexFile)) {
    try {
      index = JSON.parse(readFileSync(indexFile, 'utf-8'));
    } catch { /* reset */ }
  }

  index.count++;
  index.last_message_at = msg.timestamp;
  index.last_sender = msg.sender_username || msg.sender_ai || 'unknown';

  writeFileSync(indexFile, JSON.stringify(index));
}

// ─── Get storage stats ───
export function getStorageStats(): { total_messages: number; groups: number; disk_path: string } {
  const groups = getLocalGroups();
  const total = groups.reduce((sum, g) => sum + g.message_count, 0);
  return {
    total_messages: total,
    groups: groups.length,
    disk_path: BASE_DIR,
  };
}

// ─── Clear messages for a group ───
export function clearGroup(groupId: string): boolean {
  const file = getGroupFile(groupId);
  const indexFile = getIndexFile(groupId);
  if (existsSync(file)) {
    writeFileSync(file, ''); // truncate
    if (existsSync(indexFile)) writeFileSync(indexFile, JSON.stringify({ count: 0, last_message_at: '' }));
    return true;
  }
  return false;
}
