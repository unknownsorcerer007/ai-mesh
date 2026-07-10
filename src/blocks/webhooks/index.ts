// Block: Webhooks
// Receive external notifications (GitHub, Jira, CI/CD, etc.)
// Forward them as messages to a group
// Zero AI — just HTTP → message routing

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import type { RelayMessage } from '../../shared/types.js';

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

// GitHub webhook parser
const githubSource: WebhookSource = {
  name: 'github',
  parse: (body: any, headers) => {
    const event = headers['x-github-event'];
    if (!event) return null;

    switch (event) {
      case 'push':
        return {
          type: 'alert',
          title: `🔨 Push to ${body.repository?.name}`,
          body: `${body.pusher?.name} pushed ${body.commits?.length || 0} commit(s) to ${body.ref?.replace('refs/heads/', '')}`,
          sender: body.pusher?.name,
          url: body.compare,
        };
      case 'pull_request':
        return {
          type: 'alert',
          title: `🔀 PR ${body.action}: ${body.pull_request?.title}`,
          body: `${body.pull_request?.user?.login} ${body.action} PR #${body.pull_request?.number}`,
          sender: body.pull_request?.user?.login,
          url: body.pull_request?.html_url,
        };
      case 'issues':
        return {
          type: 'alert',
          title: `📝 Issue ${body.action}: ${body.issue?.title}`,
          body: `${body.issue?.user?.login} ${body.action} issue #${body.issue?.number}`,
          sender: body.issue?.user?.login,
          url: body.issue?.html_url,
        };
      case 'workflow_run':
        return {
          type: body.workflow_run?.conclusion === 'failure' ? 'alert' : 'system',
          title: `⚙️ CI ${body.workflow_run?.conclusion}: ${body.workflow_run?.name}`,
          body: `Workflow "${body.workflow_run?.name}" ${body.workflow_run?.conclusion}`,
          url: body.workflow_run?.html_url,
        };
      case 'release':
        return {
          type: 'system',
          title: `🚀 Release ${body.action}: ${body.release?.tag_name}`,
          body: `${body.release?.name} - ${body.release?.body?.slice(0, 200) || 'No description'}`,
          url: body.release?.html_url,
        };
      default:
        return {
          type: 'system',
          title: `🔔 GitHub: ${event}`,
          body: `Event "${event}" on ${body.repository?.name || 'unknown'}`,
        };
    }
  },
};

// GitLab webhook parser
const gitlabSource: WebhookSource = {
  name: 'gitlab',
  parse: (body: any, headers) => {
    const event = headers['x-gitlab-event'];
    if (!event) return null;

    switch (event) {
      case 'Push Hook':
        return {
          type: 'alert',
          title: `🔨 Push to ${body.project?.name}`,
          body: `${body.user_name} pushed to ${body.ref?.replace('refs/heads/', '')}`,
          sender: body.user_name,
          url: body.project?.web_url,
        };
      case 'Merge Request Hook':
        return {
          type: 'alert',
          title: `🔀 MR ${body.object_attributes?.action}: ${body.object_attributes?.title}`,
          body: `${body.user?.name} ${body.object_attributes?.action} MR`,
          sender: body.user?.name,
          url: body.object_attributes?.url,
        };
      default:
        return {
          type: 'system',
          title: `🔔 GitLab: ${event}`,
          body: `Event "${event}" on ${body.project?.name || 'unknown'}`,
        };
    }
  },
};

// Generic webhook parser (any JSON)
const genericSource: WebhookSource = {
  name: 'generic',
  parse: (body: any) => {
    if (typeof body === 'object' && body !== null) {
      return {
        type: body.type || 'system',
        title: body.title || body.event || '🔔 Webhook',
        body: body.message || body.body || body.description || JSON.stringify(body).slice(0, 500),
        sender: body.sender || body.user || body.author,
        url: body.url || body.link,
      };
    }
    return null;
  },
};

const SOURCES: WebhookSource[] = [githubSource, gitlabSource, genericSource];

export function registerWebhookRoutes(app: FastifyInstance) {
  const db = getDb();

  registerHealthCheck('webhooks', async (): Promise<BlockHealth> => {
    try {
      const count = db.prepare('SELECT COUNT(*) as c FROM webhook_tokens').get() as { c: number };
      return { status: 'healthy', message: `${count.c} webhook tokens active`, lastCheck: '' };
    } catch {
      return { status: 'healthy', message: '0 webhook tokens', lastCheck: '' };
    }
  });

  // ─── Create Webhook Token (group admin) ───
  app.post('/webhooks/tokens', async (req: FastifyRequest<{ Body: { group_id: string; name?: string } }>, reply) => {
    const { authenticate } = await import('../auth/index.js');
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { group_id, name } = req.body;
    if (!group_id) return reply.code(400).send({ error: 'GROUP_ID_REQUIRED' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(group_id) as any;
    if (!group || group.admin_id !== userId) return reply.code(403).send({ error: 'ADMIN_ONLY' });

    const token = nanoid(32);
    db.prepare('INSERT INTO webhook_tokens (token, group_id, name) VALUES (?,?,?)')
      .run(token, group_id, name || 'webhook');

    return reply.send({
      token,
      group_id,
      name: name || 'webhook',
      url: `/webhook/${token}`,
    });
  });

  // ─── List Webhook Tokens (group admin) ───
  app.get('/webhooks/tokens/:groupId', async (req: FastifyRequest<{ Params: { groupId: string } }>, reply) => {
    const { authenticate } = await import('../auth/index.js');
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId) as any;
    if (!group || group.admin_id !== userId) return reply.code(403).send({ error: 'ADMIN_ONLY' });

    const rows = db.prepare('SELECT token, name, created_at FROM webhook_tokens WHERE group_id = ?')
      .all(req.params.groupId) as any[];

    const tokens = rows.map(r => ({
      token: r.token.slice(0, 8) + '...',
      name: r.name,
      createdAt: r.created_at,
    }));

    return reply.send({ tokens });
  });

  // ─── Delete Webhook Token ───
  app.delete('/webhooks/tokens/:token', async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
    const { authenticate } = await import('../auth/index.js');
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const info = db.prepare('SELECT group_id FROM webhook_tokens WHERE token = ?').get(req.params.token) as any;
    if (!info) return reply.code(404).send({ error: 'TOKEN_NOT_FOUND' });

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(info.group_id) as any;
    if (!group || group.admin_id !== userId) return reply.code(403).send({ error: 'ADMIN_ONLY' });

    db.prepare('DELETE FROM webhook_tokens WHERE token = ?').run(req.params.token);
    return reply.send({ status: 'deleted' });
  });

  // ─── Receive Webhook (public endpoint — no auth, token-based) ───
  app.post('/webhook/:token', async (req: FastifyRequest<{ Params: { token: string }; Body: unknown }>, reply) => {
    const info = db.prepare('SELECT group_id, name FROM webhook_tokens WHERE token = ?')
      .get(req.params.token) as { group_id: string; name: string } | undefined;
    if (!info) return reply.code(404).send({ error: 'INVALID_WEBHOOK_TOKEN' });

    const { checkRateLimit } = await import('../security/index.js');
    const rate = checkRateLimit(`webhook:${req.params.token}`, 60000, 100);
    if (!rate.allowed) return reply.code(429).send({ error: 'RATE_LIMITED' });

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }

    let parsed: ParsedWebhook | null = null;
    for (const source of SOURCES) {
      parsed = source.parse(req.body, headers);
      if (parsed) break;
    }

    if (!parsed) {
      return reply.code(400).send({ error: 'UNPARSEABLE_WEBHOOK' });
    }

    const msgId = nanoid();
    const now = new Date().toISOString();

    const content = parsed.url
      ? `${parsed.title}\n${parsed.body}\n🔗 ${parsed.url}`
      : `${parsed.title}\n${parsed.body}`;

    try {
      const { publishToGroup } = await import('../relay/index.js');
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
