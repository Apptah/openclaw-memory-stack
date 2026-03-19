#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

STUB_PORT=9206
source "$(dirname "$0")/stub-server.sh" "$STUB_PORT"
trap "kill $STUB_PID 2>/dev/null || true" EXIT

setup_test_env

EIGHT_DAYS_AGO=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)-timedelta(days=8)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
write_license "oc-starter-revoked" "starter" "testdevice1234" "$EIGHT_DAYS_AGO"
write_backends

REPO=$(create_test_repo)
write_repo_config "$REPO"

cd "$REPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" "test" 2>&1 || true)
assert_contains "$OUTPUT" "revoked" "revoked key fails on re-verify"

teardown_test_env
rm -rf "$REPO"
summary
