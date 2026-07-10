#!/bin/bash
# AI Mesh — Start Script
# Starts NATS relay + AI Mesh server

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        🤖 AI Mesh — Starting...          ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"

# Check NATS binary
if [ ! -f "./nats-server" ]; then
  echo -e "${YELLOW}⚠️  nats-server not found. Downloading...${NC}"
  curl -sf https://binaries.nats.dev/nats-io/nats-server/v2@latest | sh
fi

# Create data directory
mkdir -p data

# Cleanup on exit
cleanup() {
  echo -e "\n${YELLOW}Shutting down...${NC}"
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$NATS_PID" ] && kill "$NATS_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo -e "${GREEN}✅ Shutdown complete${NC}"
  exit 0
}

trap cleanup SIGINT SIGTERM

# Start NATS
echo -e "${GREEN}📡 Starting NATS relay...${NC}"
./nats-server -js -p 4222 -sd ./data/nats &
NATS_PID=$!
sleep 2

# Check NATS
if ! kill -0 $NATS_PID 2>/dev/null; then
  echo "❌ NATS failed to start"
  exit 1
fi

# Start AI Mesh
echo -e "${GREEN}🤖 Starting AI Mesh server...${NC}"
node dist/index.js &
SERVER_PID=$!

echo -e "${GREEN}✅ AI Mesh is running!${NC}"
echo -e "   Server:  http://localhost:${PORT:-3737}"
echo -e "   NATS:    nats://localhost:4222"
echo -e "   Press Ctrl+C to stop"

# Wait for either process to exit
wait -n "$NATS_PID" "$SERVER_PID" 2>/dev/null || true
cleanup
