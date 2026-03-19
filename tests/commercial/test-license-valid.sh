#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license "oc-starter-test123" "starter" "testdevice1234"
write_backends

OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" --version 2>&1)
assert_contains "$OUTPUT" "0.1.0" "version output works"

OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" --help 2>&1)
assert_contains "$OUTPUT" "Backends: qmd, totalrecall" "help lists starter backends"
assert_not_contains "$OUTPUT" "cognee" "help does not list pro backends"

teardown_test_env
summary
