#!/bin/bash
# AI Mesh — Production start script
# Runs NATS + Node.js server in single container

set -e

echo "🤖 AI Mesh — Starting..."

# Start NATS in background
echo "📡 Starting NATS relay..."
nats-server -js -p 4222 -sd /app/data/nats &
NATS_PID=$!
sleep 2

# Check NATS
if ! kill -0 $NATS_PID 2>/dev/null; then
  echo "❌ NATS failed to start"
  exit 1
fi
echo "✅ NATS running on :4222"

# Start Node.js server
echo "🚀 Starting AI Mesh server..."
exec node dist/index.js
