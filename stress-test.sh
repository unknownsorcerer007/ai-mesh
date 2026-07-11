#!/bin/bash
# AI Mesh — Stress Test Script
BASE="https://ai-mesh-app-production.up.railway.app"
TOTAL=500
CONCURRENCY=50

echo "╔══════════════════════════════════════════╗"
echo "║     AI Mesh Stress Test                  ║"
echo "╠══════════════════════════════════════════╣"
echo "║  Target: $BASE"
echo "║  Requests: $TOTAL"
echo "║  Concurrency: $CONCURRENCY"
echo "╚══════════════════════════════════════════╝"
echo ""

# Test 1: Health endpoint
echo "─── Test 1: Health Endpoint ($TOTAL requests) ───"
START=$(date +%s%N)
PIDS=()
for i in $(seq 1 $TOTAL); do
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/health" >> /tmp/stress-health.txt 2>/dev/null &
  PIDS+=($!)
  if [ ${#PIDS[@]} -ge $CONCURRENCY ]; then
    for pid in "${PIDS[@]}"; do wait $pid 2>/dev/null; done
    PIDS=()
  fi
done
for pid in "${PIDS[@]}"; do wait $pid 2>/dev/null; done
END=$(date +%s%N)

OK=$(grep -c "200" /tmp/stress-health.txt 2>/dev/null || echo 0)
FAIL=$((TOTAL - OK))
ELAPSED=$(( (END - START) / 1000000 ))
RPS=$((TOTAL * 1000 / (ELAPSED > 0 ? ELAPSED : 1)))

echo "  ✅ Success: $OK / $TOTAL"
echo "  ❌ Failed: $FAIL"
echo "  ⏱️  Time: ${ELAPSED}ms"
echo "  🚀 Throughput: $RPS req/sec"
echo ""
rm -f /tmp/stress-health.txt

# Test 2: Auth protection (should all return 401)
echo "─── Test 2: Auth Protection (100 requests) ───"
START=$(date +%s%N)
PIDS=()
for i in $(seq 1 100); do
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/groups" >> /tmp/stress-auth.txt 2>/dev/null &
  PIDS+=($!)
  if [ ${#PIDS[@]} -ge 20 ]; then
    for pid in "${PIDS[@]}"; do wait $pid 2>/dev/null; done
    PIDS=()
  fi
done
for pid in "${PIDS[@]}"; do wait $pid 2>/dev/null; done
END=$(date +%s%N)

AUTH401=$(grep -c "401" /tmp/stress-auth.txt 2>/dev/null || echo 0)
ELAPSED=$(( (END - START) / 1000000 ))

echo "  ✅ Correct 401 responses: $AUTH401 / 100"
echo "  ⏱️  Time: ${ELAPSED}ms"
echo ""
rm -f /tmp/stress-auth.txt

# Test 3: Invalid inputs (should all return 400/404/413/415)
echo "─── Test 3: Invalid Input Handling (100 requests) ───"
PIDS=()
CODES=()
for i in $(seq 1 25); do
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/webhook/fake" -X POST -H "Content-Type: application/json" -d '{}' >> /tmp/stress-invalid.txt 2>/dev/null &
  PIDS+=($!)
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/messages" -X POST -H "Content-Type: text/xml" -d '<x/>' >> /tmp/stress-invalid.txt 2>/dev/null &
  PIDS+=($!)
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/messages" -X POST -H "Content-Type: application/json" -d 'bad json' >> /tmp/stress-invalid.txt 2>/dev/null &
  PIDS+=($!)
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/nonexistent-route" >> /tmp/stress-invalid.txt 2>/dev/null &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait $pid 2>/dev/null; done

TOTAL_INVALID=$(wc -l < /tmp/stress-invalid.txt 2>/dev/null || echo 0)
ERROR_CODES=$(grep -cE "40[0-9]|41[0-9]|50[0-9]" /tmp/stress-invalid.txt 2>/dev/null || echo 0)

echo "  ✅ Error responses (4xx/5xx): $ERROR_CODES / $TOTAL_INVALID"
echo "  📊 Status code distribution:"
sort /tmp/stress-invalid.txt 2>/dev/null | uniq -c | sort -rn | head -5
echo ""
rm -f /tmp/stress-invalid.txt

# Test 4: WebSocket connection test
echo "─── Test 4: WebSocket Connection ───"
WS_URL="wss://ai-mesh-app-production.up.railway.app/ws"
python3 -c "
import websocket, json, time
try:
    ws = websocket.create_connection('$WS_URL', timeout=5)
    # First message must be auth
    ws.send(json.dumps({'type': 'auth', 'token': 'invalid-token'}))
    result = ws.recv()
    print(f'  WS Response: {result[:200]}')
    ws.close()
except Exception as e:
    print(f'  WS Error: {e}')
" 2>&1
echo ""

# Test 5: Concurrent API calls (mixed)
echo "─── Test 5: Mixed Concurrent Load (200 requests) ───"
START=$(date +%s%N)
PIDS=()
for i in $(seq 1 50); do
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/health" >> /tmp/stress-mixed.txt 2>/dev/null &
  PIDS+=($!)
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api" >> /tmp/stress-mixed.txt 2>/dev/null &
  PIDS+=($!)
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/groups" >> /tmp/stress-mixed.txt 2>/dev/null &
  PIDS+=($!)
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/auth/me" >> /tmp/stress-mixed.txt 2>/dev/null &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait $pid 2>/dev/null; done
END=$(date +%s%N)

TOTAL_MIXED=$(wc -l < /tmp/stress-mixed.txt 2>/dev/null || echo 0)
ELAPSED=$(( (END - START) / 1000000 ))
RPS=$((TOTAL_MIXED * 1000 / (ELAPSED > 0 ? ELAPSED : 1)))

echo "  📊 Total: $TOTAL_MIXED requests in ${ELAPSED}ms"
echo "  🚀 Throughput: $RPS req/sec"
echo "  📊 Status distribution:"
sort /tmp/stress-mixed.txt 2>/dev/null | uniq -c | sort -rn
echo ""
rm -f /tmp/stress-mixed.txt

echo "══════════════════════════════════════════"
echo "     Stress Test Complete ✅"
echo "══════════════════════════════════════════"
