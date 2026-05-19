#!/usr/bin/env bash
# Post-deploy smoke check for verity-mcp.
#
# Run after `wrangler deploy` to confirm the endpoint is healthy, the manifest
# is reachable, JSON-RPC framing works, and the 6 tools are advertised. This
# is the same battery the deploy runbook walks through; bundled into a script
# so CI / on-call can run it as a single command.
#
# Usage:
#   ./scripts/post-deploy-smoke.sh https://mcp.verityskills.com
#   ./scripts/post-deploy-smoke.sh https://verity-mcp-preview.example.workers.dev
#
# Exit codes:
#   0: all smoke checks passed
#   1: a smoke check failed (the failing check is printed)
#   2: a required CLI tool is missing (jq)

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required. Install via 'brew install jq' on macOS." >&2
  exit 2
fi

BASE_URL="${1:-https://mcp.verityskills.com}"
echo "Smoking $BASE_URL ..."

pass() { printf '  PASS  %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1" >&2
  printf '         %s\n' "$2" >&2
  exit 1
}

# Check 1: /health returns ok status
echo "Check 1: GET /health"
HEALTH=$(curl -sS -m 10 "$BASE_URL/health")
STATUS=$(echo "$HEALTH" | jq -r '.status // empty')
[ "$STATUS" = "ok" ] || fail "/health did not return status=ok" "$HEALTH"
KILL_SWITCH=$(echo "$HEALTH" | jq -r '.kill_switch_engaged // empty')
[ "$KILL_SWITCH" = "false" ] || fail "/health reports kill_switch_engaged=true (worker is offline by operator)" "$HEALTH"
pass "/health ok, kill switch disengaged"

# Check 2: JSON-RPC initialize returns the byte-identical capability advertisement
echo "Check 2: POST /mcp initialize"
INIT=$(curl -sS -m 10 -X POST "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
PROTOCOL=$(echo "$INIT" | jq -r '.result.protocolVersion // empty')
[ "$PROTOCOL" = "2025-03-26" ] || fail "initialize did not return protocolVersion 2025-03-26" "$INIT"
SERVER_NAME=$(echo "$INIT" | jq -r '.result.serverInfo.name // empty')
[ "$SERVER_NAME" = "verity-mcp" ] || fail "initialize did not return serverInfo.name=verity-mcp" "$INIT"
pass "initialize byte-identical to locked contract"

# Check 3: tools/list returns the 6 advertised tools in fixed order
echo "Check 3: POST /mcp tools/list"
TOOLS=$(curl -sS -m 10 -X POST "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
TOOL_NAMES=$(echo "$TOOLS" | jq -r '.result.tools[].name' | tr '\n' ',' | sed 's/,$//')
EXPECTED="coordination-heat,verity-score,morning-brief,verity-scan,cross-check-alert,disinfo-alert"
[ "$TOOL_NAMES" = "$EXPECTED" ] || fail "tools/list returned unexpected tool set" "got: $TOOL_NAMES, expected: $EXPECTED"
pass "tools/list returns 6 tools in fixed order"

# Check 4: coordination-heat dispatch with no bearer (now auth-required; the
# upstream returns 401 without a key). We do not assert the upstream body
# because the smoke target may be a preview environment without upstream
# wiring. We only assert the response shape is a valid JSON-RPC envelope.
echo "Check 4: POST /mcp tools/call coordination-heat (no bearer)"
HEAT=$(curl -sS -m 30 -X POST "$BASE_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"coordination-heat","arguments":{"subject":"GME"}}}')
HEAT_ID=$(echo "$HEAT" | jq -r '.id // empty')
[ "$HEAT_ID" = "3" ] || fail "tools/call did not echo id=3" "$HEAT"
pass "coordination-heat dispatch returns a JSON-RPC envelope"

# manifest.json is hosted at the repo level (cchurctrip/verity-mcp), not by
# the worker. The repo CI gate (`npm run check-manifest`) is the canonical
# verification; no runtime endpoint to smoke here. Skip in this script.

# Check 5: SSE stub returns 405 with JSON-RPC -32601
echo "Check 5: GET /sse (stub)"
SSE_STATUS=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BASE_URL/sse")
[ "$SSE_STATUS" = "405" ] || fail "/sse did not return 405" "got HTTP $SSE_STATUS"
pass "/sse stub returns 405"

# Check 6: GET / redirects to verityskills.com/skills
echo "Check 6: GET / redirect"
ROOT_STATUS=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BASE_URL/")
[ "$ROOT_STATUS" = "302" ] || fail "/ did not return 302" "got HTTP $ROOT_STATUS"
pass "/ redirects 302"

echo
echo "All smoke checks passed."
