#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env

# Expired license + offline
ELEVEN_DAYS_AGO=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)-timedelta(days=11)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
write_license "oc-starter-test123" "starter" "testdevice1234" "$ELEVEN_DAYS_AGO"
write_backends
export OPENCLAW_VERIFY_URL="http://localhost:1/api/verify"

# --help and --version should still work
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" --help 2>&1)
assert_contains "$OUTPUT" "OpenClaw Memory Stack" "help works when expired"

OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" --version 2>&1)
assert_contains "$OUTPUT" "0.1.0" "version works when expired"

teardown_test_env
summary
