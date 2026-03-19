#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license "oc-starter-revoked" "starter" "testdevice1234" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "true"
write_backends

OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" "test query" 2>&1 || true)
assert_contains "$OUTPUT" "revoked" "revoked license rejected"

teardown_test_env
summary
