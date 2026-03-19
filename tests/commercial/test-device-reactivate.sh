#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

STUB_PORT=9202
source "$(dirname "$0")/stub-server.sh" "$STUB_PORT"
trap "kill $STUB_PID 2>/dev/null || true" EXIT

# Same device_id should succeed without consuming a slot
OUTPUT=$(curl -sf -X POST "http://localhost:$STUB_PORT/api/activate" \
  -H "Content-Type: application/json" \
  -d '{"key":"oc-starter-test123","device_id":"testdevice1234","device_name":"Test"}' 2>&1)
assert_contains "$OUTPUT" '"valid": true' "reactivation succeeds"

summary
