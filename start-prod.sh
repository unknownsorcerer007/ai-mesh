#!/bin/bash
# AI Mesh — Production start script
# Runs NATS + Node.js server in single container

set -e

# Cleanup on exit
cleanup() {
  echo "Shutting down..."
  if [ -n "$NATS_PID" ]; then
    kill "$NATS_PID" 2>/dev/null || true
    wait "$NATS_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  echo "Shutdown complete"
  exit 0
}

trap cleanup SIGTERM SIGINT

echo "🤖 AI Mesh — Starting..."

# Start NATS in background
echo "📡 Starting NATS relay..."
nats-server -js -p 4222 -sd /app/data/nats &
NATS_PID=$!
sleep 2

# Check NATS
if ! kill -0 "$NATS_PID" 2>/dev/null; then
  echo "❌ NATS failed to start"
  exit 1
fi
echo "✅ NATS running on :4222"

# Start Node.js server
echo "🚀 Starting AI Mesh server..."
node dist/index.js &
SERVER_PID=$!

# Wait for either process to exit
wait -n "$NATS_PID" "$SERVER_PID" 2>/dev/null || true
cleanup
