#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
# No license.json written

OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" "test query" 2>&1 || true)
assert_contains "$OUTPUT" "License not found" "rejects when no license"
assert_contains "$OUTPUT" "install.sh" "suggests install.sh"

teardown_test_env
summary
