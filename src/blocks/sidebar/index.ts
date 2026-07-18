// Block: Sidebar Launcher
// Start/stop/status the persistent sidebar daemon.
// The daemon runs as a background child process so the user's terminal stays free.
//
// Usage:
//   ai-mesh sidebar          → Start daemon in background
//   ai-mesh sidebar --fg     → Start in foreground (for debugging)
//   ai-mesh sidebar status   → Check if daemon is running
//   ai-mesh sidebar stop     → Stop the daemon

import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const STATE_DIR = resolve(process.env.HOME || '~', '.ai-mesh');
const PID_FILE = resolve(STATE_DIR, 'sidebar.pid');
const LOG_FILE = resolve(STATE_DIR, 'sidebar.log');

function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function getPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0); // Check if alive
    return pid;
  } catch {
    return null;
  }
}

function cleanupPid() {
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
}

// ─── Start Daemon (background) ───
export function startSidebarBackground(): { ok: boolean; message: string; pid?: number } {
  const existing = getPid();
  if (existing) {
    return { ok: false, message: `Already running (PID ${existing}). Stop it first: ai-mesh sidebar stop` };
  }

  ensureDir();

  const daemonPath = resolve(process.cwd(), 'dist/blocks/sidebar/daemon.js');
  if (!existsSync(daemonPath)) {
    return { ok: false, message: `Daemon not found at ${daemonPath}. Run: npm run build` };
  }

  const logFd = require('node:fs').openSync(LOG_FILE, 'a');

  const child = spawn('node', [daemonPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
    cwd: process.cwd(),
  });

  child.unref();

  // Wait briefly to check if it started
  const startTime = Date.now();
  while (Date.now() - startTime < 2000) {
    const pid = getPid();
    if (pid) {
      return { ok: true, message: `Sidebar daemon started (PID ${pid})`, pid };
    }
    // Small sleep
    execSync('sleep 0.2 2>/dev/null || true');
  }

  // Check one more time
  const pid = getPid();
  if (pid) {
    return { ok: true, message: `Sidebar daemon started (PID ${pid})`, pid };
  }

  return { ok: false, message: `Daemon may have failed. Check logs: ${LOG_FILE}` };
}

// ─── Start Daemon (foreground) ───
export function startSidebarForeground(): void {
  const daemonPath = resolve(process.cwd(), 'dist/blocks/sidebar/daemon.js');
  if (!existsSync(daemonPath)) {
    console.error(`Daemon not found at ${daemonPath}. Run: npm run build`);
    process.exit(1);
  }

  const child = spawn('node', [daemonPath], {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  });

  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

// ─── Stop Daemon ───
export function stopSidebar(): { ok: boolean; message: string } {
  const pid = getPid();
  if (!pid) {
    cleanupPid();
    return { ok: true, message: 'No sidebar daemon running' };
  }

  try {
    process.kill(pid, 'SIGTERM');
    // Wait for it to die
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      try { process.kill(pid, 0); } catch { break; }
      execSync('sleep 0.2 2>/dev/null || true');
    }
    cleanupPid();
    return { ok: true, message: `Stopped sidebar daemon (PID ${pid})` };
  } catch (err: any) {
    cleanupPid();
    return { ok: false, message: `Failed to stop: ${err.message}` };
  }
}

// ─── Status ───
export function sidebarStatus(): { running: boolean; pid?: number; state?: any } {
  const pid = getPid();
  if (!pid) return { running: false };

  const stateFile = resolve(STATE_DIR, 'sidebar-state.json');
  let state = null;
  if (existsSync(stateFile)) {
    try { state = JSON.parse(readFileSync(stateFile, 'utf-8')); } catch {}
  }

  return { running: true, pid, state };
}

// ─── CLI Handler ───
export function handleSidebarCommand(args: string[]): void {
  const subcommand = args[0];

  switch (subcommand) {
    case 'stop': {
      const result = stopSidebar();
      console.log(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
      break;
    }

    case 'status': {
      const status = sidebarStatus();
      if (status.running) {
        console.log(`✅ Sidebar daemon running (PID ${status.pid})`);
        if (status.state) {
          console.log(`   User: @${status.state.username || 'unknown'}`);
          console.log(`   Connected: ${status.state.connected ? 'Yes' : 'No'}`);
          console.log(`   Unread: ${status.state.unreadCount || 0}`);
          console.log(`   Groups: ${status.state.groups?.map((g: any) => g.name).join(', ') || 'None'}`);
        }
      } else {
        console.log('❌ Sidebar daemon not running');
        console.log('   Start: ai-mesh sidebar');
      }
      break;
    }

    case '--fg':
    case 'foreground': {
      startSidebarForeground();
      break;
    }

    default: {
      // Default: start in background
      const result = startSidebarBackground();
      if (result.ok) {
        console.log(`✅ ${result.message}`);
        console.log(`   Logs: ${LOG_FILE}`);
        console.log(`   Stop: ai-mesh sidebar stop`);
      } else {
        console.log(`❌ ${result.message}`);
      }
    }
  }
}
