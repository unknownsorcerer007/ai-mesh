// Shared: Zod request schemas
// Single source of truth for input validation — used by both REST routes and MCP tools
// so the two layers can never drift apart.

import { z } from 'zod';

// ─── Primitives ───
export const groupIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid group id');
export const messageIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid message id');
export const inviteCodeSchema = z.string().min(1).max(128);
export const usernameSchema = z.string().min(3).max(30).regex(/^[a-zA-Z0-9_-]+$/, 'Alphanumeric, underscore, hyphen only');

// Message content: 1..16384 chars after trim. We hard-cap upstream too, but this
// is the contract every message-publishing path enforces.
export const messageContentSchema = z.string().min(1).max(16384);
export const messageTypeSchema = z.enum(['text', 'code', 'alert', 'system']);
export const groupTypeSchema = z.enum(['team', 'project', 'open']);

// Emoji: allow a single grapheme cluster up to 16 code units (covers ZWJ sequences,
// skin tones, flags). We additionally validate presentation in the route layer.
export const emojiSchema = z.string().min(1).max(32);

// ─── Composed schemas ───
export const sendMessageSchema = z.object({
  group_id: groupIdSchema,
  message: messageContentSchema,
  type: messageTypeSchema.optional().default('text'),
  metadata: z.record(z.unknown()).optional(),
  sender_ai: z.string().min(1).max(64).optional(),
});

export const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  group_type: groupTypeSchema.optional().default('team'),
});

export const joinGroupSchema = z.object({
  invite_code: inviteCodeSchema,
});

export const respondJoinSchema = z.object({
  request_id: z.string().min(1).max(64),
  approve: z.boolean(),
});

export const threadReplySchema = z.object({
  group_id: groupIdSchema,
  parent_message_id: messageIdSchema,
  message: messageContentSchema,
  type: messageTypeSchema.optional().default('text'),
  sender_ai: z.string().min(1).max(64).optional(),
});

export const submitApprovalSchema = z.object({
  group_id: groupIdSchema,
  action: z.string().min(1).max(200),
  details: z.string().max(4000).optional(),
});

export const respondApprovalSchema = z.object({
  approval_id: z.string().min(1).max(64),
  approve: z.boolean(),
  reason: z.string().max(2000).optional(),
});

export const reactionSchema = z.object({
  group_id: groupIdSchema,
  message_id: messageIdSchema,
  emoji: emojiSchema,
});

export const changeUsernameSchema = z.object({
  username: usernameSchema,
});

export const createWebhookSchema = z.object({
  group_id: groupIdSchema,
  name: z.string().min(1).max(100).optional(),
});

// Helper: parse + return a typed result, never throws
export function parse<T>(schema: z.ZodSchema<T>, value: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
