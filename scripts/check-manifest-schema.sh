#!/usr/bin/env bash
# check-manifest-schema.sh
# Validates manifest.json against the canonical locked schema per VRT-146a spec.
# Top-level keys + key value constraints. CI-blocking.
set -euo pipefail

MANIFEST="${1:-manifest.json}"

if [ ! -f "$MANIFEST" ]; then
  echo "[manifest-schema] FAIL: $MANIFEST not found"
  exit 1
fi

# Required top-level keys (exact set; no additions, no renames).
# VRT-165 added `transports` as a forward-looking informational field
# describing the dual transport surface (Streamable HTTP + legacy SSE).
# The pre-existing `transport: "http+sse"` string is retained as a legacy
# alias for marketplace consumers that read the older single-field form.
REQUIRED_KEYS=(
  "name"
  "version"
  "description"
  "publisher"
  "publisher_url"
  "server_url"
  "transport"
  "transports"
  "mcp_spec_version"
  "auth"
  "tools"
  "marketing_categories"
  "license"
  "support_url"
  "privacy_policy_url"
)

for key in "${REQUIRED_KEYS[@]}"; do
  if ! jq -e "has(\"$key\")" "$MANIFEST" >/dev/null; then
    echo "[manifest-schema] FAIL: missing required top-level key: $key"
    exit 1
  fi
done

# Reject unexpected top-level keys.
ACTUAL_KEYS=$(jq -r 'keys | .[]' "$MANIFEST" | sort)
EXPECTED_KEYS=$(printf '%s\n' "${REQUIRED_KEYS[@]}" | sort)
EXTRA=$(comm -23 <(echo "$ACTUAL_KEYS") <(echo "$EXPECTED_KEYS"))
if [ -n "$EXTRA" ]; then
  echo "[manifest-schema] FAIL: unexpected top-level keys: $EXTRA"
  exit 1
fi

# Value constraints.
TRANSPORT=$(jq -r '.transport' "$MANIFEST")
if [ "$TRANSPORT" != "http+sse" ]; then
  echo "[manifest-schema] FAIL: transport must be 'http+sse', got '$TRANSPORT'"
  exit 1
fi

# VRT-165: transports array describes the two real transport surfaces.
# Exactly two entries: one streamable-http (POST /mcp) and one sse
# (GET/POST /sse). Each entry has type and url. The streamable-http URL
# must equal server_url for marketplace-consumer parity.
if ! jq -e '.transports | type == "array" and length == 2' "$MANIFEST" >/dev/null; then
  echo "[manifest-schema] FAIL: transports must be a 2-element array"
  exit 1
fi
STREAMABLE_URL=$(jq -r '.transports[] | select(.type == "streamable-http") | .url' "$MANIFEST")
SSE_URL=$(jq -r '.transports[] | select(.type == "sse") | .url' "$MANIFEST")
if [ -z "$STREAMABLE_URL" ] || [ -z "$SSE_URL" ]; then
  echo "[manifest-schema] FAIL: transports must contain one streamable-http entry and one sse entry"
  exit 1
fi
SERVER_URL_FOR_TRANSPORTS=$(jq -r '.server_url' "$MANIFEST")
if [ "$STREAMABLE_URL" != "$SERVER_URL_FOR_TRANSPORTS" ]; then
  echo "[manifest-schema] FAIL: transports streamable-http url ($STREAMABLE_URL) must equal server_url ($SERVER_URL_FOR_TRANSPORTS)"
  exit 1
fi
# Pin the sse url to the production /sse origin so a future edit cannot point
# the legacy bridge at localhost or a non-verityskills domain.
if [ "$SSE_URL" != "https://mcp.verityskills.com/sse" ]; then
  echo "[manifest-schema] FAIL: transports sse url must be 'https://mcp.verityskills.com/sse', got '$SSE_URL'"
  exit 1
fi

AUTH_TYPE=$(jq -r '.auth.type' "$MANIFEST")
if [ "$AUTH_TYPE" != "bearer" ]; then
  echo "[manifest-schema] FAIL: auth.type must be 'bearer', got '$AUTH_TYPE'"
  exit 1
fi

# auth.anonymous_tools must be a JSON array. It may be empty: every tool now
# backs an authenticated upstream operation, so the anonymous list is
# expected to be []. Any entry, if present, must be one of the advertised
# tool names. The previous "must include coordination-heat" assertion was
# removed when coordination-heat moved to an authenticated subject scorer;
# the manifest snapshot test enforces anonymous_tools <-> requiresAuth parity.
if ! jq -e '.auth.anonymous_tools | type == "array"' "$MANIFEST" >/dev/null; then
  echo "[manifest-schema] FAIL: auth.anonymous_tools must be a JSON array"
  exit 1
fi
UNKNOWN_ANON=$(jq -r '
  (.tools | map(.name)) as $names
  | (.auth.anonymous_tools // [])
  | map(select(. as $a | ($names | index($a)) | not))
  | join(",")
' "$MANIFEST")
if [ -n "$UNKNOWN_ANON" ]; then
  echo "[manifest-schema] FAIL: auth.anonymous_tools has unknown tool name(s): $UNKNOWN_ANON"
  exit 1
fi

TOOLS_COUNT=$(jq -r '.tools | length' "$MANIFEST")
if [ "$TOOLS_COUNT" != "7" ]; then
  echo "[manifest-schema] FAIL: tools array must have exactly 7 entries, got $TOOLS_COUNT"
  exit 1
fi

# Every tool entry must have name, description, requires_auth.
for i in 0 1 2 3 4 5 6; do
  for field in name description requires_auth; do
    if ! jq -e ".tools[$i] | has(\"$field\")" "$MANIFEST" >/dev/null; then
      echo "[manifest-schema] FAIL: tools[$i] missing field: $field"
      exit 1
    fi
  done
done

# Server URL pinned to production custom domain.
SERVER_URL=$(jq -r '.server_url' "$MANIFEST")
if [ "$SERVER_URL" != "https://mcp.verityskills.com/mcp" ]; then
  echo "[manifest-schema] FAIL: server_url must be 'https://mcp.verityskills.com/mcp', got '$SERVER_URL'"
  exit 1
fi

# MCP spec version is the canonical revision the Worker advertises in initialize.
# Keep this in sync with src/mcp.ts initialize.protocolVersion (Phase 2).
SPEC_VERSION=$(jq -r '.mcp_spec_version' "$MANIFEST")
if [ -z "$SPEC_VERSION" ]; then
  echo "[manifest-schema] FAIL: mcp_spec_version must be set"
  exit 1
fi

echo "[manifest-schema] OK: manifest.json matches canonical schema (transport=$TRANSPORT, tools=$TOOLS_COUNT, spec=$SPEC_VERSION)"
