#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

STUB_PORT=9203
source "$(dirname "$0")/stub-server.sh" "$STUB_PORT"
trap "kill $STUB_PID 2>/dev/null || true" EXIT

OUTPUT=$(curl -sf "http://localhost:$STUB_PORT/api/verify?key=oc-starter-test123&device_id=wrongdevice" 2>&1)
assert_contains "$OUTPUT" "device_not_activated" "wrong device rejected"

summary
