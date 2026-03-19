#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

# Verify router-config.json exists and contains starter backends
CONFIG="$PROJECT_ROOT/skills/memory-router/router-config.json"
if [ ! -f "$CONFIG" ]; then
  fail "router-config.json not found"
  summary
fi

# Starter backends (qmd, totalrecall) must be present
CONTENT=$(cat "$CONFIG")
assert_contains "$CONTENT" "qmd" "router config includes qmd"
assert_contains "$CONTENT" "totalrecall" "router config includes totalrecall"

summary
