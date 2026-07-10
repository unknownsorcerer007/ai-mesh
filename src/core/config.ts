// Core: Configuration Management
// Single source of truth for all config
// Validates on startup — fails fast if config is invalid

export interface AppConfig {
  server: {
    port: number;
    host: string;
    nodeEnv: 'development' | 'production' | 'test';
    corsOrigin: string[];
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

let config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (config) return config;

  const nodeEnv = (process.env.NODE_ENV || 'development') as AppConfig['server']['nodeEnv'];

  config = {
    server: {
      port: envInt('PORT', 3737),
      host: env('HOST', '0.0.0.0'),
      nodeEnv,
      corsOrigin: (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
    },
    github: {
      clientId: env('GITHUB_CLIENT_ID', ''),
      clientSecret: env('GITHUB_CLIENT_SECRET', ''),
      callbackUrl: env('GITHUB_CALLBACK_URL', 'http://localhost:3737/auth/github/callback'),
    },
    session: {
      secret: env('SESSION_SECRET', 'dev-secret-change-me'),
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
    },
  };

  // Validate critical config in production
  if (nodeEnv === 'production') {
    if (config.session.secret === 'dev-secret-change-me') {
      throw new Error('SESSION_SECRET must be set in production');
    }
    if (!config.github.clientId || !config.github.clientSecret) {
      console.warn('[config] GitHub OAuth not configured — auth will not work');
    }
  }

  return config;
}

// For testing — reset config
export function resetConfig() {
  config = null;
}
