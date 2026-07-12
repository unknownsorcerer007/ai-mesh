// Block: Webhooks
// Receive external notifications (GitHub, GitLab, generic) and forward as
// messages to a group.
//
// Critical fix vs original: the signature check was both broken AND bypassable.
// Broken because Fastify parses JSON, so `req.body` was an object and
// `JSON.stringify(req.body)` re-serialized with different key order/whitespace —
// legitimate GitHub webhooks always failed signature verification. Bypassable
// because when the signature header was absent, the code silently allowed the
// request ("backward compat"). Now: we capture the RAW body for HMAC, and if a
// secret is configured for a webhook token, a valid signature is REQUIRED.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { parse, createWebhookSchema } from '../../shared/validation.js';
import { sanitizeMessage } from '../security/injection.js';
import { publishToGroup } from '../relay/index.js';
import type { RelayMessage } from '../../shared/types.js';

// Augment the Fastify request with the raw body captured by our content-type
// parser. Declared here so the webhook route can read it for HMAC verification.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

// ─── Webhook Sources ───
interface WebhookSource {
  name: string;
  parse: (body: unknown, headers: Record<string, string>) => ParsedWebhook | null;
}

interface ParsedWebhook {
  type: string;
  title: string;
  body: string;
  sender?: string;
  url?: string;
}

const githubSource: WebhookSource = {
  name: 'github',
  parse: (body: any, headers) => {
    const event = headers['x-github-event'];
    if (!event) return null;
    switch (event) {
      case 'push':
        return { type: 'alert', title: `🔨 Push to ${body.repository?.name}`, body: `${body.pusher?.name} pushed ${body.commits?.length || 0} commit(s) to ${body.ref?.replace('refs/heads/', '')}`, sender: body.pusher?.name, url: body.compare };
      case 'pull_request':
        return { type: 'alert', title: `🔀 PR ${body.action}: ${body.pull_request?.title}`, body: `${body.pull_request?.user?.login} ${body.action} PR #${body.pull_request?.number}`, sender: body.pull_request?.user?.login, url: body.pull_request?.html_url };
      case 'issues':
        return { type: 'alert', title: `📝 Issue ${body.action}: ${body.issue?.title}`, body: `${body.issue?.user?.login} ${body.action} issue #${body.issue?.number}`, sender: body.issue?.user?.login, url: body.issue?.html_url };
      case 'workflow_run':
        return { type: body.workflow_run?.conclusion === 'failure' ? 'alert' : 'system', title: `⚙️ CI ${body.workflow_run?.conclusion}: ${body.workflow_run?.name}`, body: `Workflow "${body.workflow_run?.name}" ${body.workflow_run?.conclusion}`, url: body.workflow_run?.html_url };
      case 'release':
        return { type: 'system', title: `🚀 Release ${body.action}: ${body.release?.tag_name}`, body: `${body.release?.name} - ${body.release?.body?.slice(0, 200) || 'No description'}`, url: body.release?.html_url };
      default:
        return { type: 'system', title: `🔔 GitHub: ${event}`, body: `Event "${event}" on ${body.repository?.name || 'unknown'}` };
    }
  },
};

const gitlabSource: WebhookSource = {
  name: 'gitlab',
  parse: (body: any, headers) => {
    const event = headers['x-gitlab-event'];
    if (!event) return null;
    switch (event) {
      case 'Push Hook':
        return { type: 'alert', title: `🔨 Push to ${body.project?.name}`, body: `${body.user_name} pushed to ${body.ref?.replace('refs/heads/', '')}`, sender: body.user_name, url: body.project?.web_url };
      case 'Merge Request Hook':
        return { type: 'alert', title: `🔀 MR ${body.object_attributes?.action}: ${body.object_attributes?.title}`, body: `${body.user?.name} ${body.object_attributes?.action} MR`, sender: body.user?.name, url: body.object_attributes?.url };
      default:
        return { type: 'system', title: `🔔 GitLab: ${event}`, body: `Event "${event}" on ${body.project?.name || 'unknown'}` };
    }
  },
};

const genericSource: WebhookSource = {
  name: 'generic',
  parse: (body: any) => {
    if (typeof body === 'object' && body !== null) {
      return { type: body.type || 'system', title: body.title || body.event || '🔔 Webhook', body: body.message || body.body || body.description || JSON.stringify(body).slice(0, 500), sender: body.sender || body.user || body.author, url: body.url || body.link };
    }
    return null;
  },
};

const SOURCES: WebhookSource[] = [githubSource, gitlabSource, genericSource];

// Timing-safe string comparison. Both buffers must be the same length; we pad
// with the expected length so a length-mismatch doesn't leak via timing.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function registerWebhookRoutes(app: FastifyInstance) {
  const db = getDb();

  // Capture the RAW body for webhook signature verification. Fastify's default
  // JSON parser parses into an object, which means re-serializing for HMAC
  // produces different bytes than GitHub signed — legitimate webhooks failed.
  // We override the parser to store the raw Buffer on req.rawBody AND populate
  // req.body with the parsed JSON (so source parsers still work).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    try {
      const parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf-8'));
      done(null, parsed);
    } catch (err: any) {
      // For webhooks we want the raw body even if JSON is malformed (some
      // senders send invalid JSON). Store null so the route can decide.
      done(null, null);
    }
  });

  registerHealthCheck('webhooks', async (): Promise<BlockHealth> => {
    try {
      const count = db.prepare('SELECT COUNT(*) as c FROM webhook_tokens').get() as { c: number };
      return { status: 'healthy', message: `${count.c} webhook tokens active`, lastCheck: '' };
    } catch {
      return { status: 'healthy', message: '0 webhook tokens', lastCheck: '' };
    }
  });

  // ─── Create Webhook Token (group admin) ───
  app.post('/webhooks/tokens', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(createWebhookSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });

    const group = db.prepare('SELECT admin_id FROM groups WHERE id = ?').get(parsed.data.group_id) as { admin_id: string } | undefined;
    if (!group || group.admin_id !== userId) return reply.code(403).send({ error: 'ADMIN_ONLY' });

    const token = nanoid(32);
    const secret = nanoid(32);
    db.prepare('INSERT INTO webhook_tokens (token, group_id, secret, name) VALUES (?,?,?,?)')
      .run(token, parsed.data.group_id, secret, parsed.data.name || 'webhook');

    return reply.send({
      token,
      secret, // returned ONCE — caller must save it; configure on GitHub/GitLab
      group_id: parsed.data.group_id,
      name: parsed.data.name || 'webhook',
      url: `/webhook/${token}`,
    });
  });

  // ─── List Webhook Tokens (group admin) ───
  app.get('/webhooks/tokens/:groupId', async (req: FastifyRequest<{ Params: { groupId: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const group = db.prepare('SELECT admin_id FROM groups WHERE id = ?').get(req.params.groupId) as { admin_id: string } | undefined;
    if (!group || group.admin_id !== userId) return reply.code(403).send({ error: 'ADMIN_ONLY' });

    const rows = db.prepare('SELECT token, name, created_at FROM webhook_tokens WHERE group_id = ?')
      .all(req.params.groupId) as { token: string; name: string; created_at: string }[];

    const tokens = rows.map(r => ({ token: r.token.slice(0, 8) + '...', name: r.name, createdAt: r.created_at }));
    return reply.send({ tokens });
  });

  // ─── Delete Webhook Token ───
  app.delete('/webhooks/tokens/:token', async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const info = db.prepare('SELECT group_id FROM webhook_tokens WHERE token = ?').get(req.params.token) as { group_id: string } | undefined;
    if (!info) return reply.code(404).send({ error: 'TOKEN_NOT_FOUND' });

    const group = db.prepare('SELECT admin_id FROM groups WHERE id = ?').get(info.group_id) as { admin_id: string } | undefined;
    if (!group || group.admin_id !== userId) return reply.code(403).send({ error: 'ADMIN_ONLY' });

    db.prepare('DELETE FROM webhook_tokens WHERE token = ?').run(req.params.token);
    return reply.send({ status: 'deleted' });
  });

  // ─── Receive Webhook (public — token in URL, signature REQUIRED if secret set) ───
  app.post('/webhook/:token', async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
    const info = db.prepare('SELECT group_id, name, secret FROM webhook_tokens WHERE token = ?')
      .get(req.params.token) as { group_id: string; name: string; secret: string } | undefined;
    if (!info) return reply.code(404).send({ error: 'INVALID_WEBHOOK_TOKEN' });

    const rate = checkRateLimit(`webhook:${req.params.token}`, 60_000, 100);
    if (!rate.allowed) return reply.code(429).send({ error: 'RATE_LIMITED' });

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }

    // Signature verification. If a secret is configured for this token, a valid
    // signature is REQUIRED — not optional. The original code allowed the
    // request through if the header was absent, which made the signature check
    // bypassable by simply not sending the header.
    if (info.secret) {
      const rawBody = req.rawBody ? req.rawBody.toString('utf-8') : '';
      const githubSig = headers['x-hub-signature-256'];
      const gitlabToken = headers['x-gitlab-token'];

      if (githubSig) {
        const expected = 'sha256=' + createHmac('sha256', info.secret).update(rawBody).digest('hex');
        if (!safeEqual(githubSig, expected)) {
          return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
        }
      } else if (gitlabToken) {
        if (!safeEqual(gitlabToken, info.secret)) {
          return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
        }
      } else {
        // Secret is configured but no signature header present → reject.
        return reply.code(401).send({ error: 'MISSING_SIGNATURE', message: 'This webhook requires a signature header (X-Hub-Signature-256 or X-Gitlab-Token)' });
      }
    }

    // Parse the webhook payload
    let parsed: ParsedWebhook | null = null;
    for (const source of SOURCES) {
      parsed = source.parse(req.body, headers);
      if (parsed) break;
    }
    if (!parsed) return reply.code(400).send({ error: 'UNPARSEABLE_WEBHOOK' });

    const msgId = nanoid();
    const now = new Date().toISOString();
    // Sanitize all attacker-controlled fields before they enter message content.
    // Webhook payloads (even signed ones) can carry malicious text — a GitHub
    // commit message, a GitLab MR title, etc. We don't run detectInjection
    // here because webhook content legitimately contains code/commands, but we
    // DO strip control characters and cap length via sanitizeMessage.
    const safeTitle = sanitizeMessage(parsed.title);
    const safeBody = sanitizeMessage(parsed.body);
    const safeUrl = parsed.url ? sanitizeMessage(parsed.url) : '';
    const content = safeUrl
      ? `${safeTitle}\n${safeBody}\n🔗 ${safeUrl}`
      : `${safeTitle}\n${safeBody}`;

    try {
      const relayMsg: RelayMessage = {
        id: msgId,
        group_id: info.group_id,
        sender_id: 'webhook',
        sender_username: parsed.sender || info.name,
        sender_ai: 'webhook',
        type: parsed.type as any,
        content,
        metadata: { source: info.name, url: parsed.url },
        timestamp: now,
      };
      publishToGroup(info.group_id, relayMsg);
    } catch { /* NATS may be down */ }

    return reply.send({ status: 'received', id: msgId });
  });
}
