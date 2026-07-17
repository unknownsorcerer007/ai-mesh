// Core: Error Types and Handling
// Standardized errors across all blocks
// Each error has a code, message, and optional metadata

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.meta && { meta: this.meta }),
    };
  }
}

// ─── Auth Errors ───
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', message, 403);
  }
}

// ─── Validation Errors ───
export class ValidationError extends AppError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 400, meta);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', `${resource} not found${id ? `: ${id}` : ''}`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

// ─── Rate Limit Errors ───
export class RateLimitError extends AppError {
  constructor(limit: number, windowMs: number) {
    super('RATE_LIMITED', `Rate limit exceeded: ${limit} requests per ${windowMs / 1000}s`, 429);
  }
}

// ─── Infrastructure Errors ───
export class RelayError extends AppError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super('RELAY_ERROR', message, 502, meta);
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super('DATABASE_ERROR', message, 500, meta);
  }
}

// ─── Security Errors ───
export class InjectionError extends AppError {
  constructor(reason: string) {
    super('INJECTION_BLOCKED', reason, 400);
  }
}

// ─── Error Handler for Fastify ───
import type { FastifyInstance } from 'fastify';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _request, reply) => {
    // Known app error
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ ...error.toJSON(), requestId: (reply as any).requestId });
    }

    // Fastify validation error
    if ('validation' in error) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: error.message,
        requestId: (reply as any).requestId,
      });
    }

    // Unknown error — don't leak internals in production
    const statusCode = error.statusCode || 500;
    return reply.code(statusCode).send({
      error: 'INTERNAL_ERROR',
      message: statusCode >= 500 && process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : error.message,
      requestId: (reply as any).requestId,
    });
  });
}
