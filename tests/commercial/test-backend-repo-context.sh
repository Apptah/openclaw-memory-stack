#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

STUB_PORT=9208
source "$(dirname "$0")/stub-server.sh" "$STUB_PORT"
trap "kill $STUB_PID 2>/dev/null || true" EXIT

setup_test_env
write_license
write_backends

REPO=$(create_test_repo)
write_repo_config "$REPO" "ready" "bm25_ready" "myproject-abc1"

cd "$REPO"
# This will fail because qmd isn't really running, but we can check it gets past license
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" --backend qmd search "test" 2>&1 || true)
# Should not show "Not initialized" or "License not found"
assert_not_contains "$OUTPUT" "Not initialized" "repo context found"
assert_not_contains "$OUTPUT" "License not found" "license check passed"

teardown_test_env
rm -rf "$REPO"
summary
