#!/usr/bin/env node
// AI Mesh MCP Server — Entry Point
// Supports: stdio (local), http (remote)
//
// Usage:
//   node entry.js              # stdio mode (default, for local AI tools)
//   node entry.js --http 3738  # HTTP/SSE mode (for remote AI tools)
//   node entry.js --widget     # Show widget banner only

import { startStdio, startHttp } from './universal.js';
import { showWidgetBanner, openUI } from './widget.js';

const args = process.argv.slice(2);

// Show widget banner on startup
showWidgetBanner();

if (args.includes('--http')) {
  const portIdx = args.indexOf('--http');
  const port = Number(args[portIdx + 1]) || 3738;
  startHttp(port).catch(console.error);
} else if (args.includes('--open') || args.includes('--ui')) {
  openUI();
} else {
  startStdio().catch(console.error);
}
