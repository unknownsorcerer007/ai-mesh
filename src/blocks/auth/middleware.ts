// Auth: Middleware — extract user from token

import type { FastifyRequest } from 'fastify';
import { verifyToken } from '../security/index.js';
import { getConfig } from '../../core/config.js';

export function authenticate(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const config = getConfig();
  return verifyToken(token, config.session.secret, config.session.tokenTtlMs);
}
