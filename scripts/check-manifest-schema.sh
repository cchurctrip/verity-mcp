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
REQUIRED_KEYS=(
  "name"
  "version"
  "description"
  "publisher"
  "publisher_url"
  "server_url"
  "transport"
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

AUTH_TYPE=$(jq -r '.auth.type' "$MANIFEST")
if [ "$AUTH_TYPE" != "bearer" ]; then
  echo "[manifest-schema] FAIL: auth.type must be 'bearer', got '$AUTH_TYPE'"
  exit 1
fi

ANON_TOOLS=$(jq -r '.auth.anonymous_tools | tojson' "$MANIFEST")
if ! echo "$ANON_TOOLS" | grep -q "coordination-heat"; then
  echo "[manifest-schema] FAIL: auth.anonymous_tools must include 'coordination-heat', got $ANON_TOOLS"
  exit 1
fi

TOOLS_COUNT=$(jq -r '.tools | length' "$MANIFEST")
if [ "$TOOLS_COUNT" != "6" ]; then
  echo "[manifest-schema] FAIL: tools array must have exactly 6 entries, got $TOOLS_COUNT"
  exit 1
fi

# Every tool entry must have name, description, requires_auth.
for i in 0 1 2 3 4 5; do
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
