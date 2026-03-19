#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

STUB_PORT=9207
source "$(dirname "$0")/stub-server.sh" "$STUB_PORT"
trap "kill $STUB_PID 2>/dev/null || true" EXIT

# First webhook
OUTPUT=$(curl -sf -X POST "http://localhost:$STUB_PORT/api/webhook" \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_123","type":"checkout.session.completed"}' 2>&1)
assert_not_contains "$OUTPUT" "duplicate" "first webhook processed"

# Replay same event
OUTPUT=$(curl -sf -X POST "http://localhost:$STUB_PORT/api/webhook" \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_123","type":"checkout.session.completed"}' 2>&1)
assert_contains "$OUTPUT" "duplicate" "replay detected"

summary
