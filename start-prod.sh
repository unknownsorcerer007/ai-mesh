#!/bin/bash
# AI Mesh — Production start script
# If NATS_URL points to an external server, skip local NATS.
# Otherwise start local NATS (single-container mode) with auth if credentials
# are provided.

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

# Check if NATS_URL points to external server
NATS_HOST=$(echo "${NATS_URL:-nats://localhost:4222}" | sed 's|nats://||' | sed 's|.*@||' | cut -d: -f1)

if [ "$NATS_HOST" = "localhost" ] || [ "$NATS_HOST" = "127.0.0.1" ]; then
  # Start local NATS — with auth if NATS_USER/NATS_PASSWORD are set
  echo "📡 Starting local NATS relay..."
  if [ -n "${NATS_USER:-}" ] && [ -n "${NATS_PASSWORD:-}" ]; then
    nats-server -js -p 4222 -user "$NATS_USER" -pass "$NATS_PASSWORD" -sd /app/data/nats &
  else
    echo "⚠️  WARNING: Starting NATS without auth. Set NATS_USER and NATS_PASSWORD in production." >&2
    nats-server -js -p 4222 -sd /app/data/nats &
  fi
  NATS_PID=$!
  sleep 2

  if ! kill -0 "$NATS_PID" 2>/dev/null; then
    echo "❌ NATS failed to start"
    exit 1
  fi
  echo "✅ NATS running on :4222"
else
  echo "📡 Using external NATS: $NATS_URL"
fi

# Start Node.js server
echo "🚀 Starting AI Mesh server..."
node dist/index.js &
SERVER_PID=$!

# Wait for either process to exit
wait -n ${NATS_PID:+$NATS_PID} $SERVER_PID 2>/dev/null || true
cleanup
