#!/usr/bin/env bash
# multi-client-probe.sh: live-deploy verification harness.
#
# 12 probes total against the live Worker:
#   - Probes 1 to 9: VRT-165 transport matrix (Cursor + Claude Desktop +
#     ChatGPT Desktop + Gemini + Comet GET/POST /sse).
#   - Probes 10 to 12: VRT-166 OAuth 2.1 surface (discovery, /oauth/token
#     authorization_code rejection shape, vto_ bearer rejection on /mcp).
#
# Run as the final step of `npm run deploy` so a deploy that breaks any
# transport or OAuth surface fails at deploy time, not at first user call.
#
# Usage:
#   ./scripts/multi-client-probe.sh https://mcp.verityskills.com
#
# The 9 transport probes require the VERITY_MCP_TEST_KEY env var (the live
# integration-test API key). Without it those 9 are skipped. The 3 OAuth
# probes always run because the OAuth discovery + token endpoints are
# public and the bearer probe asserts rejection (no real token needed).
#
# Exit codes:
#   0: every run probe passed (transport probes may be skipped without the key)
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

echo "Multi-client probe vs $BASE_URL"
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

# ================================================================
# VRT-166 OAuth 2.1 surface probes (run unconditionally; public endpoints)
# ================================================================

# Probe 10: discovery endpoints conformant per RFC 8414 + RFC 9728.
# Verifies registration_endpoint is PRESENT (issue #25: RFC 7591 DCR
# bridge for Cursor 1.x), code_challenge_methods_supported is exactly
# ["S256"], scopes_supported includes "mcp:invoke".
echo "Probe 10/12: OAuth discovery (RFC 8414 + 9728)"
AS_DOC=$(curl -sS -m 10 "$BASE_URL/.well-known/oauth-authorization-server" || true)
PR_DOC=$(curl -sS -m 10 "$BASE_URL/.well-known/oauth-protected-resource" || true)
AS_REG=$(printf '%s' "$AS_DOC" | jq -r '.registration_endpoint // empty' 2>/dev/null || echo "parse_error")
AS_PKCE=$(printf '%s' "$AS_DOC" | jq -c '.code_challenge_methods_supported // empty' 2>/dev/null || echo "")
AS_SCOPES=$(printf '%s' "$AS_DOC" | jq -c '.scopes_supported // empty' 2>/dev/null || echo "")
PR_RES=$(printf '%s' "$PR_DOC" | jq -r '.resource // empty' 2>/dev/null || echo "")
if [ "$AS_REG" = "$BASE_URL/oauth/register" ] \
   && [ "$AS_PKCE" = '["S256"]' ] \
   && printf '%s' "$AS_SCOPES" | grep -q 'mcp:invoke' \
   && [ "$PR_RES" = "$BASE_URL" ]; then
  pass "discovery: registration_endpoint advertised, S256-only, mcp:invoke present, resource matches"
else
  fail "discovery" "reg=$AS_REG pkce=$AS_PKCE scopes=$AS_SCOPES pr_resource=$PR_RES"
fi

# Probe 10c: path-scoped metadata URLs (MCP 2025-06-18 §2.3 / RFC 9728 §3.1).
# Cursor 1.x and Claude Code 0.x query the path-scoped form first; without
# this route the MCP-spec-conformant client tombstones after 5 consecutive
# 404s. Both forms must return identical documents.
echo "Probe 10c/12: path-scoped well-known URLs (MCP 2025-06-18)"
PR_SCOPED_STATUS=$(curl -sS -m 10 -o /tmp/pr-scoped.json -w '%{http_code}' \
  "$BASE_URL/.well-known/oauth-protected-resource/mcp" || true)
AS_SCOPED_STATUS=$(curl -sS -m 10 -o /tmp/as-scoped.json -w '%{http_code}' \
  "$BASE_URL/.well-known/oauth-authorization-server/mcp" || true)
PR_SCOPED_RES=$(jq -r '.resource // empty' /tmp/pr-scoped.json 2>/dev/null || echo "")
AS_SCOPED_REG=$(jq -r '.registration_endpoint // empty' /tmp/as-scoped.json 2>/dev/null || echo "")
if [ "$PR_SCOPED_STATUS" = "200" ] \
   && [ "$AS_SCOPED_STATUS" = "200" ] \
   && [ "$PR_SCOPED_RES" = "$BASE_URL" ] \
   && [ "$AS_SCOPED_REG" = "$BASE_URL/oauth/register" ]; then
  pass "path-scoped: PR/mcp + AS/mcp both 200, same resource + registration_endpoint values"
else
  fail "path-scoped" "pr=$PR_SCOPED_STATUS as=$AS_SCOPED_STATUS pr_res=$PR_SCOPED_RES as_reg=$AS_SCOPED_REG"
fi
rm -f /tmp/pr-scoped.json /tmp/as-scoped.json

# Probe 10b: POST /oauth/register answers the RFC 7591 DCR shape with the
# Cursor allowlist client_id (issue #25). The endpoint is idempotent and
# safe to call from a probe; no DB writes happen.
echo "Probe 10b/12: /oauth/register (RFC 7591 DCR bridge)"
REG_RESP=$(curl -sS -m 10 -X POST "$BASE_URL/oauth/register" \
  -H 'content-type: application/json' \
  -d '{"client_name":"Cursor","redirect_uris":["http://localhost:0/oauth/callback"]}' \
  || true)
REG_CLIENT_ID=$(printf '%s' "$REG_RESP" | jq -r '.client_id // empty' 2>/dev/null || echo "")
REG_AUTH_METHOD=$(printf '%s' "$REG_RESP" | jq -r '.token_endpoint_auth_method // empty' 2>/dev/null || echo "")
REG_SCOPE=$(printf '%s' "$REG_RESP" | jq -r '.scope // empty' 2>/dev/null || echo "")
if [ "$REG_CLIENT_ID" = "cursor" ] \
   && [ "$REG_AUTH_METHOD" = "none" ] \
   && [ "$REG_SCOPE" = "mcp:invoke" ]; then
  pass "DCR: client_name=Cursor -> client_id=cursor, public client, mcp:invoke scope"
else
  fail "DCR" "client_id=$REG_CLIENT_ID auth_method=$REG_AUTH_METHOD scope=$REG_SCOPE"
fi

# Probe 11: /oauth/token authorization_code path rejects an unknown code
# with RFC 6749 §5.2 error shape (invalid_grant + error_description).
# A fake hex code passes shape validation (form parse, required fields,
# canonical resource) and reaches the Supabase lookup, which finds no row.
# This proves the endpoint is wired AND the Supabase service-role query
# succeeded (a misconfigured deploy would 503 oauth_misconfigured here).
echo "Probe 11/12: /oauth/token rejects unknown authorization code"
TOKEN_RES=$(curl -sS -m 10 -i -X POST "$BASE_URL/oauth/token" \
  -H "content-type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=probefake$(date +%s)&code_verifier=verifierverifierverifierverifierverifier&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&resource=https%3A%2F%2Fmcp.verityskills.com&client_id=claude_desktop" \
  || true)
TOKEN_STATUS=$(printf '%s' "$TOKEN_RES" | head -1 | awk '{print $2}')
TOKEN_BODY=$(printf '%s' "$TOKEN_RES" | awk 'BEGIN{b=0} /^\r?$/{b=1;next} b{print}')
TOKEN_ERR=$(printf '%s' "$TOKEN_BODY" | jq -r '.error // empty' 2>/dev/null || echo "")
if [ "$TOKEN_STATUS" = "400" ] && [ "$TOKEN_ERR" = "invalid_grant" ]; then
  pass "/oauth/token unknown code: 400 + invalid_grant (Supabase query succeeded, no row)"
else
  fail "/oauth/token unknown code" "status=$TOKEN_STATUS error=$TOKEN_ERR body=${TOKEN_BODY:0:200}"
fi

# Probe 12: tools/call with fake vto_ Bearer rejects (auth.ts vto_ branch
# resolves the bearer against mcp_oauth_tokens, finds no row, returns
# oauth_token_invalid). Uses tools/call (not initialize, which is the
# transport handshake and runs unauthenticated). Asserts the vto_ branch
# is wired AND that the response carries the WWW-Authenticate header on
# the 401 path per RFC 6750. Token-passthrough ban (parent spec line 387)
# is enforced structurally upstream (no curl probe can verify it
# end-to-end without intercepting the upstream fetch); the integration
# test at tests/oauth-integration.test.ts:119 is the load-bearing pin.
echo "Probe 12/12: /mcp tools/call rejects fake vto_ Bearer"
call_body='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"morning-brief","arguments":{}}}'
MCP_RES=$(curl -sS -m 10 -i -X POST "$BASE_URL/mcp" \
  -H "content-type: application/json" \
  -H "Authorization: Bearer vto_probefake$(date +%s)" \
  -d "$call_body" || true)
MCP_STATUS=$(printf '%s' "$MCP_RES" | head -1 | awk '{print $2}')
# `|| true` tail on the grep pipeline: under set -euo pipefail a missing
# WWW-Authenticate header would otherwise abort the script via grep's
# non-zero exit, masking the actual probe failure path below.
MCP_WWWAUTH=$(printf '%s' "$MCP_RES" | { grep -i '^www-authenticate:' || true; } | head -1 | tr -d '\r')
MCP_BODY=$(printf '%s' "$MCP_RES" | awk 'BEGIN{b=0} /^\r?$/{b=1;next} b{print}')
MCP_ERR_CODE=$(printf '%s' "$MCP_BODY" | jq -r '.error.data.code // empty' 2>/dev/null || echo "")
if [ "$MCP_STATUS" = "401" ] && [ -n "$MCP_WWWAUTH" ]; then
  pass "/mcp tools/call fake vto_: 401 + WWW-Authenticate per RFC 6750"
elif [ -n "$MCP_ERR_CODE" ] && printf '%s' "$MCP_ERR_CODE" | grep -qiE 'oauth|token|unauthor'; then
  pass "/mcp tools/call fake vto_: JSON-RPC error envelope ($MCP_ERR_CODE)"
else
  fail "/mcp tools/call fake vto_" "status=$MCP_STATUS www-auth=$MCP_WWWAUTH err_code=$MCP_ERR_CODE body=${MCP_BODY:0:200}"
fi

# ================================================================
# VRT-165 transport probes (require VERITY_MCP_TEST_KEY)
# ================================================================

if [ -z "$TEST_KEY" ]; then
  echo
  echo "SKIP: probes 1-9 (transport matrix) require VERITY_MCP_TEST_KEY."
  echo "      Export it locally to run them; CI without the secret skips cleanly."
  echo "================================================================"
  echo "Result: $PASS_COUNT passed, $FAIL_COUNT failed (9 transport probes skipped)"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
  fi
  exit 0
fi

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
