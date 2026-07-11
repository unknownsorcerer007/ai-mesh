#!/bin/bash
# AI Mesh CLI wrapper for OpenClaw
# Usage: bash aimesh.sh <command> [args...]

BASE="https://ai-mesh-app-production.up.railway.app"
TOKEN_FILE="$HOME/.aimesh-token"

# Get or refresh token
get_token() {
  if [ -f "$TOKEN_FILE" ] && [ "$(find "$TOKEN_FILE" -mmin -300 2>/dev/null)" ]; then
    cat "$TOKEN_FILE"
    return
  fi
  PAT="$(grep GH_TOKEN ~/.bashrc 2>/dev/null | cut -d'"' -f2)"
  if [ -z "$PAT" ]; then
    echo "ERROR: No GitHub PAT found" >&2
    exit 1
  fi
  TOKEN=$(curl -s -X POST -H "Content-Type: application/json" -d "{\"pat\": \"$PAT\"}" "$BASE/auth/pat" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
  if [ -z "$TOKEN" ]; then
    echo "ERROR: Login failed" >&2
    exit 1
  fi
  echo "$TOKEN" > "$TOKEN_FILE"
  echo "$TOKEN"
}

TOKEN=$(get_token)
AUTH="Authorization: Bearer $TOKEN"

case "$1" in
  me)
    curl -s -H "$AUTH" "$BASE/auth/me"
    ;;
  groups)
    curl -s -H "$AUTH" "$BASE/groups"
    ;;
  create-group)
    curl -s -X POST -H "Content-Type: application/json" -H "$AUTH" -d "{\"name\":\"$2\"}" "$BASE/groups"
    ;;
  send)
    curl -s -X POST -H "Content-Type: application/json" -H "$AUTH" -d "{\"group_id\":\"$2\",\"message\":\"$3\",\"type\":\"text\"}" "$BASE/messages"
    ;;
  history)
    curl -s -H "$AUTH" "$BASE/messages/$2"
    ;;
  inbox)
    curl -s -H "$AUTH" "$BASE/messages/inbox"
    ;;
  search)
    curl -s -H "$AUTH" "$BASE/search?q=$(python3 -c "import urllib.parse;print(urllib.parse.quote('$2'))")"
    ;;
  approve)
    curl -s -X POST -H "Content-Type: application/json" -H "$AUTH" -d "{\"approval_id\":\"$2\",\"approve\":true}" "$BASE/approval/respond"
    ;;
  reject)
    curl -s -X POST -H "Content-Type: application/json" -H "$AUTH" -d "{\"approval_id\":\"$2\",\"approve\":false,\"reason\":\"$3\"}" "$BASE/approval/respond"
    ;;
  pending)
    curl -s -H "$AUTH" "$BASE/approval/pending"
    ;;
  health)
    curl -s "$BASE/health"
    ;;
  *)
    echo "AI Mesh CLI"
    echo ""
    echo "Commands:"
    echo "  me                    Show current user"
    echo "  groups                List groups"
    echo "  create-group <name>   Create group"
    echo "  send <group_id> <msg> Send message"
    echo "  history <group_id>    Group history"
    echo "  inbox                 Check inbox"
    echo "  search <query>        Search messages"
    echo "  pending               Pending approvals"
    echo "  approve <id>          Approve action"
    echo "  reject <id> <reason>  Reject action"
    echo "  health                Server health"
    ;;
esac
