#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends

NOREPO=$(mktemp -d)

cd "$NOREPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" init 2>&1 || true)
assert_contains "$OUTPUT" "not a git repository\|Not in a git repo" "rejects non-git dir"

teardown_test_env
rm -rf "$NOREPO"
summary
