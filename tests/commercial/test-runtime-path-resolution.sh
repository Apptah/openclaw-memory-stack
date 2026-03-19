#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends

# Verify the CLI can source all its libraries
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" --version 2>&1)
assert_eq "openclaw-memory v0.1.0" "$OUTPUT" "CLI version resolves correctly"

OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" --help 2>&1)
assert_contains "$OUTPUT" "openclaw-memory init" "help mentions init command"

teardown_test_env
summary
