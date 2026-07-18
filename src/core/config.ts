// Core: Configuration Management
// Single source of truth for all config
// Validates on startup — fails fast if config is invalid

import { randomBytes } from 'node:crypto';

export interface AppConfig {
  server: {
    port: number;
    host: string;
    nodeEnv: 'development' | 'production' | 'test';
    corsOrigin: string[];
    uiUrl: string; // Trusted redirect target for OAuth callbacks — never derived from Host header
  };
  github: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
  };
  session: {
    secret: string;
    tokenTtlMs: number;
  };
  nats: {
    url: string;
  };
  database: {
    path: string;
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  messages: {
    maxHoldAge: number;
    maxHoldPerUser: number;
    maxBytes: number;
  };
}

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required env: ${key}`);
  }
  return val;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Invalid env ${key}: expected number, got "${raw}"`);
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === 'true' || raw === '1';
}
// NOTE: envBool is retained for future use; current config reads only env/envInt.

let config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (config) return config;

  const nodeEnv = (process.env.NODE_ENV || 'development') as AppConfig['server']['nodeEnv'];

  // Auto-detect UI_URL for Railway/Render/Vercel deployments.
  // These platforms set RAILWAY_STATIC_URL, RENDER_EXTERNAL_URL, or
  // VERCEL_URL automatically. We use them as fallback so users don't
  // have to set UI_URL manually.
  let uiUrl = process.env.UI_URL || '';
  if (!uiUrl) {
    // Railway
    if (process.env.RAILWAY_STATIC_URL) {
      uiUrl = process.env.RAILWAY_STATIC_URL;
    }
    // Render
    else if (process.env.RENDER_EXTERNAL_URL) {
      uiUrl = process.env.RENDER_EXTERNAL_URL;
    }
    // Vercel
    else if (process.env.VERCEL_URL) {
      uiUrl = `https://${process.env.VERCEL_URL}`;
    }
    // Fly.io
    else if (process.env.FLY_APP_NAME) {
      uiUrl = `https://${process.env.FLY_APP_NAME}.fly.dev`;
    }
    // Local fallback
    else {
      const port = process.env.PORT || '3737';
      uiUrl = `http://localhost:${port}`;
    }
  }

  // Auto-generate SESSION_SECRET if not set.
  // In production, a random 32-byte hex secret is generated on every start.
  // This means tokens are invalidated on restart — acceptable for a chat
  // platform where users reconnect automatically. For sticky sessions across
  // restarts, set SESSION_SECRET explicitly.
  let sessionSecret = process.env.SESSION_SECRET || '';
  if (!sessionSecret || sessionSecret === 'dev-secret-change-me') {
    if (nodeEnv === 'production') {
      sessionSecret = randomBytes(32).toString('hex');
      console.warn('[config] SESSION_SECRET not set — auto-generated (tokens expire on restart). Set SESSION_SECRET env var for persistent tokens.');
    } else {
      sessionSecret = 'dev-secret-change-me';
    }
  }

  config = {
    server: {
      port: envInt('PORT', 3737),
      host: env('HOST', '0.0.0.0'),
      nodeEnv,
      corsOrigin: (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
      uiUrl,
    },
    github: {
      clientId: env('GITHUB_CLIENT_ID', ''),
      clientSecret: env('GITHUB_CLIENT_SECRET', ''),
      callbackUrl: env('GITHUB_CALLBACK_URL', 'http://localhost:3737/auth/github/callback'),
    },
    session: {
      secret: sessionSecret,
      tokenTtlMs: envInt('TOKEN_TTL_MS', 7 * 24 * 60 * 60 * 1000), // 7 days
    },
    nats: {
      url: env('NATS_URL', 'nats://localhost:4222'),
    },
    database: {
      path: env('DB_PATH', './data/ai-mesh.db'),
    },
    rateLimit: {
      windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60000),
      maxRequests: envInt('RATE_LIMIT_MAX', 120),
    },
    messages: {
      maxHoldAge: envInt('MESSAGE_HOLD_MS', 7 * 24 * 60 * 60 * 1000), // 7 days
      maxHoldPerUser: envInt('MESSAGE_HOLD_MAX', 500),
      maxBytes: envInt('MESSAGE_MAX_BYTES', 16384), // 16KB
    },
  };

  // ─── Config validation ───
  // SESSION_SECRET: auto-generated above if missing. Only warn in dev.
  if (nodeEnv !== 'production' && config.session.secret === 'dev-secret-change-me') {
    console.warn('[config] Using default SESSION_SECRET. Set SESSION_SECRET env var for security.');
  }
  if (nodeEnv === 'production') {
    if (config.session.secret.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 chars in production (use: openssl rand -hex 32)');
    }
    // GitHub OAuth is optional — username/password auth works without it.
    if (!config.github.clientId || !config.github.clientSecret) {
      console.warn('[config] GitHub OAuth not configured. Users can register with username/password. To enable GitHub login, set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.');
    }
    // UI_URL must be an absolute URL with http(s)
    try {
      const u = new URL(config.server.uiUrl);
      if (u.hash) throw new Error('UI_URL must not contain a hash fragment');
    } catch {
      throw new Error(`UI_URL is invalid (got "${config.server.uiUrl}") — must be an absolute URL like https://app.example.com`);
    }
  }

  return config;
}

// For testing — reset config
export function resetConfig() {
  config = null;
}
