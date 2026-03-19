#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends

REPO=$(create_test_repo)

cd "$REPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" init 2>&1 || true)
assert_contains "$OUTPUT" "Initializ" "init runs"
assert_file_exists "$REPO/.openclaw-memory.json" "per-repo config created"

# Verify config contents
if command -v python3 &>/dev/null; then
  TR_STATUS=$(python3 -c "import json; d=json.load(open('$REPO/.openclaw-memory.json')); print(d['backends']['totalrecall']['status'])")
  assert_eq "ready" "$TR_STATUS" "totalrecall status is ready"
fi

teardown_test_env
rm -rf "$REPO"
summary
