#!/usr/bin/env node
// AI Mesh MCP Server — stdio transport entry point
// Use this when connecting from OpenClaw, Claude Code, Codex, etc.

import { startMcpServer } from './server.js';

startMcpServer().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
