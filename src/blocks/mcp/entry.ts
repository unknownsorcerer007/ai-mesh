#!/usr/bin/env node
// AI Mesh MCP Server — Entry Point
//
// Modes:
//   node entry.js                          # local stdio (needs NATS + SQLite)
//   node entry.js --remote URL             # remote client (proxies to server)
//   node entry.js --http 3738              # HTTP/SSE server mode
//   AI_MESH_SERVER=https://... node entry.js  # remote (env var)
//
// For most users: set AI_MESH_SERVER and run entry.js — that's it.

import { startStdio, startHttp } from './universal.js';
import { startRemoteStdio } from './remote-client.js';
import { showWidgetBanner, openUI } from './widget.js';

const args = process.argv.slice(2);

// Show widget banner on startup
showWidgetBanner();

// Determine mode
const remoteIdx = args.indexOf('--remote');
const remoteUrl = remoteIdx >= 0 ? args[remoteIdx + 1] : '';
const envRemoteUrl = process.env.AI_MESH_SERVER || '';

if (remoteIdx >= 0 || envRemoteUrl) {
  // ─── Remote client mode (proxies to deployed server) ───
  const url = remoteUrl || envRemoteUrl;
  startRemoteStdio(url).catch(console.error);
} else if (args.includes('--http')) {
  // ─── HTTP/SSE server mode ───
  const portIdx = args.indexOf('--http');
  const port = Number(args[portIdx + 1]) || 3738;
  startHttp(port).catch(console.error);
} else if (args.includes('--open') || args.includes('--ui')) {
  openUI();
} else {
  // ─── Local stdio mode (needs NATS + SQLite) ───
  startStdio().catch(console.error);
}
