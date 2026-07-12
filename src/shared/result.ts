// Shared: Operation Result type
// Pure type + helpers — no imports from any block. Used by every block that
// exposes business operations, so REST and MCP get the same return shape and
// can map it to HTTP status / MCP error text identically.

export type OpResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; status: number };

export function ok<T>(data: T): OpResult<T> { return { ok: true, data }; }
export function err(code: string, message: string, status = 400): OpResult<never> { return { ok: false, code, message, status }; }
