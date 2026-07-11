#!/bin/bash
# AI Mesh — Live Monitor (runs in loop)
BASE="https://ai-mesh-app-production.up.railway.app"
INTERVAL=300  # 5 minutes
LOG="/home/work/.openclaw/workspace/.openclaw/tmp/ai-mesh/monitor.log"

echo "[$(date)] Monitor started — checking every ${INTERVAL}s" | tee -a "$LOG"

while true; do
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  
  # Health check
  HEALTH=$(curl -s -w "\n%{http_code}" "$BASE/health" 2>/dev/null)
  HTTP_CODE=$(echo "$HEALTH" | tail -1)
  HEALTH_BODY=$(echo "$HEALTH" | head -1)
  
  if [ "$HTTP_CODE" = "200" ]; then
    UPTIME=$(echo "$HEALTH_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('uptime','?'))" 2>/dev/null)
    STATUS="✅ HEALTHY (uptime: ${UPTIME}s)"
  else
    STATUS="❌ DOWN (HTTP $HTTP_CODE)"
  fi
  
  # Response time check
  RESP_TIME=$(curl -s -o /dev/null -w "%{time_total}" "$BASE/health" 2>/dev/null)
  
  # Auth protection check
  AUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/groups" 2>/dev/null)
  if [ "$AUTH" = "401" ]; then
    AUTH_STATUS="✅"
  else
    AUTH_STATUS="❌ (got $AUTH, expected 401)"
  fi
  
  # Security headers check
  HEADERS=$(curl -s -I "$BASE/health" 2>/dev/null)
  HAS_HSTS=$(echo "$HEADERS" | grep -c 'strict-transport-security')
  HAS_XFO=$(echo "$HEADERS" | grep -c 'x-frame-options')
  
  echo "[$TIMESTAMP] $STATUS | Response: ${RESP_TIME}s | Auth: $AUTH_STATUS | HSTS: $HAS_HSTS | XFO: $HAS_XFO" | tee -a "$LOG"
  
  # Alert if down
  if [ "$HTTP_CODE" != "200" ]; then
    echo "[$TIMESTAMP] ⚠️  ALERT: Server is DOWN! HTTP $HTTP_CODE" | tee -a "$LOG"
  fi
  
  sleep $INTERVAL
done
