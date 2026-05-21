#!/usr/bin/env bash
# multi-client-probe.sh: VRT-165 live-deploy verification harness.
#
# Probes the four target MCP client transport surfaces against the live
# Worker. Exits 0 only when 9 of 9 probes pass. Run as the final step of
# `npm run deploy` so a deploy that breaks any transport surfaces fails
# at deploy time, not at first user call.
#
# Usage:
#   ./scripts/multi-client-probe.sh https://mcp.verityskills.com
#
# Requires the VERITY_MCP_TEST_KEY env var (the live integration-test
# API key). Without it the script skips with exit 0 so a non-secret
# context (a fork PR, a non-secret CI run) does not break.
#
# Exit codes:
#   0: 9 of 9 probes pass (or skipped cleanly without the secret)
#   1: a probe failed; the failing probe is named on stderr
#   2: a required CLI tool is missing (jq, curl)

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required. Install via 'brew install jq' on macOS." >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "FAIL: curl is required." >&2
  exit 2
fi

BASE_URL="${1:-https://mcp.verityskills.com}"
TEST_KEY="${VERITY_MCP_TEST_KEY:-}"

if [ -z "$TEST_KEY" ]; then
  echo "SKIP: VERITY_MCP_TEST_KEY not set. multi-client-probe needs the live test key."
  echo "      Export it locally to run probes; CI without the secret skips cleanly."
  exit 0
fi

echo "VRT-165 multi-client probe vs $BASE_URL"
echo "================================================================"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  printf '  PASS  %s\n' "$1"
  PASS_COUNT=$((PASS_COUNT + 1))
}
fail() {
  printf '  FAIL  %s\n' "$1" >&2
  printf '         %s\n' "$2" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

# Helper: POST initialize through /mcp with an optional Accept header.
# initialize has no side effects and runs in microseconds.
init_body='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# Probe 1: Cursor no Accept header => application/json
echo "Probe 1/9: Cursor no Accept header"
RES=$(curl -sS -m 10 -D - -o /tmp/vrt165_p1.body "$BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $TEST_KEY" \
  -d "$init_body" || true)
CTYPE=$(printf '%s' "$RES" | grep -i '^content-type:' | head -1 | tr -d '\r' | awk '{print tolower($2)}')
case "$CTYPE" in
  application/json*) pass "Cursor no Accept routes to application/json" ;;
  *) fail "Cursor no Accept routes to application/json" "got content-type=$CTYPE" ;;
esac

# Probe 2: Cursor Accept: */* => application/json
echo "Probe 2/9: Cursor Accept: */*"
RES=$(curl -sS -m 10 -D - -o /tmp/vrt165_p2.body "$BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $TEST_KEY" \
  -H "Accept: */*" \
  -d "$init_body" || true)
CTYPE=$(printf '%s' "$RES" | grep -i '^content-type:' | head -1 | tr -d '\r' | awk '{print tolower($2)}')
case "$CTYPE" in
  application/json*) pass "Cursor */* routes to application/json" ;;
  *) fail "Cursor */* routes to application/json" "got content-type=$CTYPE" ;;
esac

# Probe 3: Cursor Accept: application/json => application/json
echo "Probe 3/9: Cursor Accept: application/json"
RES=$(curl -sS -m 10 -D - -o /tmp/vrt165_p3.body "$BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $TEST_KEY" \
  -H "Accept: application/json" \
  -d "$init_body" || true)
CTYPE=$(printf '%s' "$RES" | grep -i '^content-type:' | head -1 | tr -d '\r' | awk '{print tolower($2)}')
case "$CTYPE" in
  application/json*) pass "Cursor application/json routes to application/json" ;;
  *) fail "Cursor application/json routes to application/json" "got content-type=$CTYPE" ;;
esac

# Probe 4: Claude Desktop (proxy default Accept: */*) => application/json
echo "Probe 4/9: Claude Desktop proxy (Accept: */*)"
RES=$(curl -sS -m 10 -D - -o /tmp/vrt165_p4.body "$BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $TEST_KEY" \
  -H "Accept: */*" \
  -d "$init_body" || true)
CTYPE=$(printf '%s' "$RES" | grep -i '^content-type:' | head -1 | tr -d '\r' | awk '{print tolower($2)}')
case "$CTYPE" in
  application/json*) pass "Claude Desktop proxy routes to application/json" ;;
  *) fail "Claude Desktop proxy routes to application/json" "got content-type=$CTYPE" ;;
esac

# Probe 5: ChatGPT Desktop Streamable HTTP (Accept: text/event-stream)
echo "Probe 5/9: ChatGPT Desktop Accept: text/event-stream"
SSE=$(curl -sS -m 10 -D /tmp/vrt165_p5.headers "$BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $TEST_KEY" \
  -H "Accept: text/event-stream" \
  -d "$init_body" || true)
CTYPE=$(grep -i '^content-type:' /tmp/vrt165_p5.headers | head -1 | tr -d '\r' | awk '{print tolower($2)}')
if [[ "$CTYPE" == "text/event-stream"* ]] && \
   grep -q '^event: message' <<< "$SSE" && \
   ! grep -q 'event: done' <<< "$SSE"; then
  pass "ChatGPT Streamable HTTP: SSE-framed single envelope, no event: done"
else
  fail "ChatGPT Streamable HTTP" "content-type=$CTYPE, body=$SSE"
fi

# Probe 6: ChatGPT Desktop Accept: application/json, text/event-stream (spec-canonical)
echo "Probe 6/9: ChatGPT Desktop spec-canonical Accept"
SSE=$(curl -sS -m 10 -D /tmp/vrt165_p6.headers "$BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $TEST_KEY" \
  -H "Accept: application/json, text/event-stream" \
  -d "$init_body" || true)
CTYPE=$(grep -i '^content-type:' /tmp/vrt165_p6.headers | head -1 | tr -d '\r' | awk '{print tolower($2)}')
if [[ "$CTYPE" == "text/event-stream"* ]]; then
  pass "ChatGPT spec-canonical Accept routes to SSE"
else
  fail "ChatGPT spec-canonical Accept routes to SSE" "got content-type=$CTYPE"
fi

# Probe 7: Gemini Streamable HTTP (NOT legacy SSE per Gate-2 R4)
echo "Probe 7/9: Gemini Streamable HTTP"
SSE=$(curl -sS -m 10 -D /tmp/vrt165_p7.headers "$BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $TEST_KEY" \
  -H "Accept: text/event-stream;q=0.9, application/json" \
  -d "$init_body" || true)
CTYPE=$(grep -i '^content-type:' /tmp/vrt165_p7.headers | head -1 | tr -d '\r' | awk '{print tolower($2)}')
if [[ "$CTYPE" == "text/event-stream"* ]] && grep -q '^event: message' <<< "$SSE"; then
  pass "Gemini Streamable HTTP returns SSE-framed envelope"
else
  fail "Gemini Streamable HTTP" "content-type=$CTYPE"
fi

# Probe 8: Comet GET /sse handshake (initial event: endpoint with absolute URL)
echo "Probe 8/9: Comet GET /sse handshake"
# Use -N to disable buffering + --max-time 3 to bail out before keep-alive.
# The initial endpoint frame lands sub-second on a healthy deploy.
ENDPOINT_FRAME=$(curl -sS -N --max-time 3 -D /tmp/vrt165_p8.headers \
  -H "Authorization: Bearer $TEST_KEY" \
  "$BASE_URL/sse" 2>/dev/null | head -c 256 || true)
CTYPE=$(grep -i '^content-type:' /tmp/vrt165_p8.headers | head -1 | tr -d '\r' | awk '{print tolower($2)}')
if [[ "$CTYPE" == "text/event-stream"* ]] && \
   grep -q '^event: endpoint' <<< "$ENDPOINT_FRAME" && \
   grep -q "^data: $BASE_URL/sse" <<< "$ENDPOINT_FRAME"; then
  pass "Comet GET /sse: event: endpoint with absolute URL"
else
  fail "Comet GET /sse handshake" "content-type=$CTYPE, frame=$ENDPOINT_FRAME"
fi

# Probe 9: Comet POST /sse fallback (no open same-isolate GET stream)
echo "Probe 9/9: Comet POST /sse cross-isolate fallback"
RES=$(curl -sS -m 10 -D /tmp/vrt165_p9.headers -o /tmp/vrt165_p9.body "$BASE_URL/sse" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer $TEST_KEY" \
  -d "$init_body" || true)
STATUS=$(head -1 /tmp/vrt165_p9.headers | awk '{print $2}')
# Either 202 (relay landed) OR 200 with envelope inline.
if [ "$STATUS" = "202" ]; then
  pass "Comet POST /sse: 202 relay landed"
elif [ "$STATUS" = "200" ]; then
  CTYPE=$(grep -i '^content-type:' /tmp/vrt165_p9.headers | head -1 | tr -d '\r' | awk '{print tolower($2)}')
  PROTOCOL=$(jq -r '.result.protocolVersion // empty' /tmp/vrt165_p9.body 2>/dev/null || echo "")
  if [[ "$CTYPE" == "application/json"* ]] && [ "$PROTOCOL" = "2025-03-26" ]; then
    pass "Comet POST /sse: 200 + application/json fallback (MCP 2024-11-05 6.2.2)"
  else
    fail "Comet POST /sse fallback" "status=$STATUS, content-type=$CTYPE, protocol=$PROTOCOL"
  fi
else
  fail "Comet POST /sse" "expected status 200 or 202, got $STATUS"
fi

echo "================================================================"
echo "Result: $PASS_COUNT passed, $FAIL_COUNT failed"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
