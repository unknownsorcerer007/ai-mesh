// Core: Health Check Aggregator
// Each block registers its own health check
// /health endpoint aggregates all block statuses

export type BlockStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface BlockHealth {
  status: BlockStatus;
  message?: string;
  latencyMs?: number;
  lastCheck: string;
  meta?: Record<string, unknown>;
}

export interface SystemHealth {
  status: BlockStatus;
  version: string;
  uptime: number;
  blocks: Record<string, BlockHealth>;
  timestamp: string;
}

// ─── Health Registry ───
const healthChecks = new Map<string, () => Promise<BlockHealth>>();

export function registerHealthCheck(blockName: string, check: () => Promise<BlockHealth>) {
  healthChecks.set(blockName, check);
}

export function unregisterHealthCheck(blockName: string) {
  healthChecks.delete(blockName);
}

// ─── Run All Health Checks ───
export async function getSystemHealth(): Promise<SystemHealth> {
  const blocks: Record<string, BlockHealth> = {};
  let worstStatus: BlockStatus = 'healthy';

  const checks = Array.from(healthChecks.entries());
  const results = await Promise.allSettled(
    checks.map(async ([name, check]) => {
      const start = Date.now();
      try {
        const health = await check();
        health.latencyMs = Date.now() - start;
        health.lastCheck = new Date().toISOString();
        return { name, health };
      } catch (err) {
        return {
          name,
          health: {
            status: 'unhealthy' as BlockStatus,
            message: err instanceof Error ? err.message : 'Health check failed',
            latencyMs: Date.now() - start,
            lastCheck: new Date().toISOString(),
          },
        };
      }
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { name, health } = result.value;
      blocks[name] = health;
      if (health.status === 'unhealthy') worstStatus = 'unhealthy';
      else if (health.status === 'degraded' && worstStatus === 'healthy') worstStatus = 'degraded';
    }
  }

  return {
    status: worstStatus,
    version: '1.0.0',
    uptime: process.uptime(),
    blocks,
    timestamp: new Date().toISOString(),
  };
}
