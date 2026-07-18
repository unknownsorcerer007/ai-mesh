#!/usr/bin/env node
// AI Mesh CLI — Simple commands
// Usage:
//   ai-mesh open     → Open web UI in browser
//   ai-mesh sidebar  → Start sidebar daemon
//   ai-mesh status   → Show connection status
//   ai-mesh notify   → Show recent notifications

import { openUI, showWidgetBanner } from './widget.js';
import { handleSidebarCommand } from '../sidebar/index.js';

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'open':
  case 'ui':
    console.log('Opening AI Mesh UI...');
    openUI();
    break;

  case 'sidebar':
    handleSidebarCommand(args.slice(1));
    break;

  case 'status':
    showWidgetBanner();
    break;

  case 'notify':
    // Fetch and show notifications
    const serverUrl = process.env.AI_MESH_SERVER || 'http://localhost:3737';
    const token = process.env.AI_MESH_TOKEN;

    if (!token) {
      console.error('Set AI_MESH_TOKEN environment variable');
      process.exit(1);
    }

    fetch(`${serverUrl}/notifications`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => res.json())
      .then((data: any) => {
        if (data.notifications?.length === 0) {
          console.log('No notifications');
        } else {
          console.log(`\n📬 ${data.count} notifications:\n`);
          for (const n of data.notifications) {
            console.log(`  [${n.timestamp}] ${n.title}: ${n.body}`);
          }
        }
      })
      .catch(err => {
        console.error('Failed to fetch notifications:', err.message);
      });
    break;

  default:
    console.log(`
AI Mesh CLI

Commands:
  ai-mesh open      Open web UI in browser
  ai-mesh sidebar   Start sidebar notification daemon
  ai-mesh status    Show connection status
  ai-mesh notify    Show recent notifications

Environment:
  AI_MESH_SERVER    Server URL (default: http://localhost:3737)
  AI_MESH_TOKEN     Auth token (required for notify/sidebar)
    `);
}
