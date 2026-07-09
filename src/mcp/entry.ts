#!/usr/bin/env node
// Pulse MCP Server — Universal entry point
// Supports: stdio (local), http (remote)
//
// Usage:
//   node entry.js              # stdio mode (default, for local AI tools)
//   node entry.js --http 3738  # HTTP/SSE mode (for remote AI tools)

import { startStdio, startHttp } from './universal.js';

const args = process.argv.slice(2);

if (args.includes('--http')) {
  const portIdx = args.indexOf('--http');
  const port = Number(args[portIdx + 1]) || 3738;
  startHttp(port).catch(console.error);
} else {
  startStdio().catch(console.error);
}
