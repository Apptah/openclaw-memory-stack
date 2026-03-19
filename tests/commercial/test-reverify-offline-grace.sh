#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env

# Set last_verified to 8 days ago, point to unreachable server
EIGHT_DAYS_AGO=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)-timedelta(days=8)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
write_license "oc-starter-test123" "starter" "testdevice1234" "$EIGHT_DAYS_AGO"
write_backends
export OPENCLAW_VERIFY_URL="http://localhost:1/api/verify"  # unreachable

REPO=$(create_test_repo)
write_repo_config "$REPO"

cd "$REPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" "test" 2>&1 || true)
# 8 days < 10 days grace → should still work
assert_not_contains "$OUTPUT" "verification required" "grace period allows offline use"

teardown_test_env
rm -rf "$REPO"
summary
