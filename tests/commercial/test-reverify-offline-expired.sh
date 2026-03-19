#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env

# Set last_verified to 11 days ago
ELEVEN_DAYS_AGO=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)-timedelta(days=11)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
write_license "oc-starter-test123" "starter" "testdevice1234" "$ELEVEN_DAYS_AGO"
write_backends
export OPENCLAW_VERIFY_URL="http://localhost:1/api/verify"  # unreachable

REPO=$(create_test_repo)
write_repo_config "$REPO"

cd "$REPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" "test" 2>&1 || true)
EXIT_CODE=$?
assert_contains "$OUTPUT" "verification required\|connect to the internet\|License expired" "offline expired blocks access"

teardown_test_env
rm -rf "$REPO"
summary
