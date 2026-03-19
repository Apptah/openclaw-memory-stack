#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

STUB_PORT=9210
source "$(dirname "$0")/stub-server.sh" "$STUB_PORT"
trap "kill $STUB_PID 2>/dev/null || true" EXIT

setup_test_env
write_license
write_backends "ready" "unavailable"

REPO=$(create_test_repo)
write_repo_config "$REPO" "ready" "skipped" ""

cd "$REPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" --backend qmd search "test" 2>&1 || true)
assert_contains "$OUTPUT" "not available" "unavailable backend rejected"

teardown_test_env
rm -rf "$REPO"
summary
