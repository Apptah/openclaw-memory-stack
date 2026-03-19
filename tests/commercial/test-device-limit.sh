#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

# Start stub server
STUB_PORT=9201
source "$(dirname "$0")/stub-server.sh" "$STUB_PORT"
trap "kill $STUB_PID 2>/dev/null || true" EXIT

OUTPUT=$(curl -sf -X POST "http://localhost:$STUB_PORT/api/activate" \
  -H "Content-Type: application/json" \
  -d '{"key":"oc-starter-full3","device_id":"dev4","device_name":"D4"}' 2>&1)
assert_contains "$OUTPUT" "activation_limit_reached" "4th device rejected"

summary
