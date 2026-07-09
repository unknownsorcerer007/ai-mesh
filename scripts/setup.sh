#!/bin/bash
# AI Mesh — One-click Setup Script
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     🤖 AI Mesh — Setup                   ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"

# Check Node.js
if ! command -v node &>/dev/null; then
  echo -e "${YELLOW}❌ Node.js not found. Install Node.js 20+ first.${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "${YELLOW}❌ Node.js 20+ required. Current: $(node -v)${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Node.js $(node -v)${NC}"

# Install dependencies
echo -e "${GREEN}📦 Installing dependencies...${NC}"
npm install

# Download NATS server
if [ ! -f "./nats-server" ]; then
  echo -e "${GREEN}📡 Downloading NATS server...${NC}"
  curl -sf https://binaries.nats.dev/nats-io/nats-server/v2@latest | sh
fi

echo -e "${GREEN}✅ NATS server ready${NC}"

# Build
echo -e "${GREEN}🔨 Building...${NC}"
npm run build

# Setup .env
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo -e "${YELLOW}📝 Created .env — edit it with your GitHub OAuth credentials${NC}"
fi

# Create data directory
mkdir -p data

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     ✅ Setup Complete!                    ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                          ║${NC}"
echo -e "${GREEN}║  Start:    ./start.sh                    ║${NC}"
echo -e "${GREEN}║  Dev:      npm run dev                   ║${NC}"
echo -e "${GREEN}║  MCP:      npm run mcp                   ║${NC}"
echo -e "${GREEN}║  Docker:   docker compose up -d           ║${NC}"
echo -e "${GREEN}║                                          ║${NC}"
echo -e "${GREEN}║  Edit .env with your GitHub OAuth creds  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
