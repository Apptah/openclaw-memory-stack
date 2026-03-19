#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends

REPO=$(create_test_repo)
write_repo_config "$REPO"

cd "$REPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" init 2>&1 || true)
assert_contains "$OUTPUT" "already initialized" "detects existing config"

teardown_test_env
rm -rf "$REPO"
summary
