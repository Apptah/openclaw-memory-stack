#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

STUB_PORT=9204
source "$(dirname "$0")/stub-server.sh" "$STUB_PORT"
trap "kill $STUB_PID 2>/dev/null || true" EXIT

# Reset a device
OUTPUT=$(curl -sf -X POST "http://localhost:$STUB_PORT/api/reset-device" \
  -H "Content-Type: application/json" \
  -d '{"key":"oc-starter-test123","email":"test@example.com","device_id":"testdevice1234"}' 2>&1)
assert_contains "$OUTPUT" '"valid": true' "device reset succeeds"

# Now activate a new device in the freed slot
OUTPUT=$(curl -sf -X POST "http://localhost:$STUB_PORT/api/activate" \
  -H "Content-Type: application/json" \
  -d '{"key":"oc-starter-test123","device_id":"newdevice","device_name":"New"}' 2>&1)
assert_contains "$OUTPUT" '"valid": true' "new device activates after reset"

summary
