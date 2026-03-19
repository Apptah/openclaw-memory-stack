#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env

# License 8 days old but NOT revoked, NOT expired past grace
EIGHT_DAYS_AGO=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)-timedelta(days=8)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
write_license "oc-starter-test123" "starter" "testdevice1234" "$EIGHT_DAYS_AGO"
write_backends
# Point to unreachable server — init should NOT call verify
export OPENCLAW_VERIFY_URL="http://localhost:1/api/verify"

REPO=$(create_test_repo)
cd "$REPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" init 2>&1 || true)
# Should succeed since init uses require_installed (not require_licensed)
assert_not_contains "$OUTPUT" "verification required" "init does not trigger re-verify"
assert_contains "$OUTPUT" "Initializ\|already initialized" "init proceeds without verify"

teardown_test_env
rm -rf "$REPO"
summary
