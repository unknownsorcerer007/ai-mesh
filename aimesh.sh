#!/bin/bash
# AI Mesh CLI wrapper
# Usage: bash aimesh.sh <command> [args...]
#
# Security: JSON bodies and URL params are built with jq so user input can't
# break out of the JSON string or the URL. The original used string
# interpolation, which allowed JSON injection (e.g. a message containing `"`
# could forge extra fields) and command injection in the search path (a query
# containing `'` could execute arbitrary Python).

set -euo pipefail

BASE="${AI_MESH_SERVER:-https://ai-mesh-app-production.up.railway.app}"
TOKEN_FILE="$HOME/.aimesh-token"

# Get or refresh token
get_token() {
  if [ -f "$TOKEN_FILE" ] && [ "$(find "$TOKEN_FILE" -mmin -300 2>/dev/null)" ]; then
    cat "$TOKEN_FILE"
    return
  fi
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "ERROR: Set GH_TOKEN env var to a GitHub PAT" >&2
    exit 1
  fi
  # Build JSON with jq so GH_TOKEN is properly escaped even if it contains quotes.
  BODY=$(jq -nc --arg pat "$GH_TOKEN" '{pat: $pat}')
  TOKEN=$(curl -sf -X POST -H "Content-Type: application/json" -d "$BODY" "$BASE/auth/pat" | jq -r '.token // empty')
  if [ -z "$TOKEN" ]; then
    echo "ERROR: Login failed" >&2
    exit 1
  fi
  # Save token 0600 — other local users must not read it.
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "$TOKEN"
}

TOKEN=$(get_token)
AUTH="Authorization: Bearer $TOKEN"

case "${1:-help}" in
  me)
    curl -sf -H "$AUTH" "$BASE/auth/me"
    ;;
  groups)
    curl -sf -H "$AUTH" "$BASE/groups"
    ;;
  create-group)
    BODY=$(jq -nc --arg name "${2:?usage: create-group <name>}" '{name: $name}')
    curl -sf -X POST -H "Content-Type: application/json" -H "$AUTH" -d "$BODY" "$BASE/groups"
    ;;
  send)
    GROUP_ID="${2:?usage: send <group_id> <message>}"
    MSG="${3:?usage: send <group_id> <message>}"
    BODY=$(jq -nc --arg gid "$GROUP_ID" --arg msg "$MSG" '{group_id: $gid, message: $msg, type: "text"}')
    curl -sf -X POST -H "Content-Type: application/json" -H "$AUTH" -d "$BODY" "$BASE/messages"
    ;;
  history)
    curl -sf -H "$AUTH" "$BASE/messages/${2:?usage: history <group_id>}"
    ;;
  inbox)
    curl -sf -H "$AUTH" "$BASE/messages/inbox"
    ;;
  search)
    Q="${2:?usage: search <query>}"
    # URL-encode via jq, not Python string interpolation (which was injectable).
    ENC=$(jq -rn --arg q "$Q" '$q|@uri')
    curl -sf -H "$AUTH" "$BASE/search?q=$ENC"
    ;;
  approve)
    ID="${2:?usage: approve <approval_id>}"
    BODY=$(jq -nc --arg id "$ID" '{approval_id: $id, approve: true}')
    curl -sf -X POST -H "Content-Type: application/json" -H "$AUTH" -d "$BODY" "$BASE/approval/respond"
    ;;
  reject)
    ID="${2:?usage: reject <approval_id> [reason]}"
    REASON="${3:-}"
    BODY=$(jq -nc --arg id "$ID" --arg reason "$REASON" '{approval_id: $id, approve: false, reason: $reason}')
    curl -sf -X POST -H "Content-Type: application/json" -H "$AUTH" -d "$BODY" "$BASE/approval/respond"
    ;;
  pending)
    curl -sf -H "$AUTH" "$BASE/approval/pending"
    ;;
  health)
    curl -sf "$BASE/health"
    ;;
  *)
    cat <<'USAGE'
AI Mesh CLI

Commands:
  me                    Show current user
  groups                List groups
  create-group <name>   Create group
  send <group_id> <msg> Send message
  history <group_id>    Group history
  inbox                 Check inbox
  search <query>        Search messages
  pending               Pending approvals
  approve <id>          Approve action
  reject <id> [reason]  Reject action
  health                Server health

Env:
  AI_MESH_SERVER        Server URL (default: https://ai-mesh-app-production.up.railway.app)
  GH_TOKEN              GitHub PAT (for auto-login)
USAGE
    ;;
esac
