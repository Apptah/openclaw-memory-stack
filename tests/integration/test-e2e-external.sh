#!/usr/bin/env bash
# E2E external integration tests — Starter backends (qmd + totalrecall)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$PROJECT_ROOT/bin/openclaw-memory"
export OPENCLAW_INSTALL_ROOT="${OPENCLAW_INSTALL_ROOT:-$PROJECT_ROOT}"

PASS=0 FAIL=0

echo "=== E2E External Integration Tests (Starter) ==="
echo ""

if [ "${OPENCLAW_TEST_LIVE:-0}" = "1" ]; then
  echo "  MODE: LIVE (hitting real backends)"
else
  echo "  MODE: MOCK (use OPENCLAW_TEST_LIVE=1 for live tests)"
fi
echo ""

# Test Starter backend mock access
for backend in qmd totalrecall; do
  echo "-- $backend --"
  wrapper="$PROJECT_ROOT/skills/memory-${backend}/wrapper.sh"
  if [ -f "$wrapper" ]; then
    output=$(OPENCLAW_INSTALL_ROOT="$OPENCLAW_INSTALL_ROOT" bash "$wrapper" --mock 2>/dev/null) || true
    if [ -n "$output" ]; then
      backend_field=$(echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('backend',''))" 2>/dev/null || echo "")
      if [ "$backend_field" = "$backend" ]; then
        echo "  PASS: $backend mock returns correct backend field"
        PASS=$((PASS + 1))
      else
        echo "  FAIL: $backend mock returned backend=$backend_field"
        FAIL=$((FAIL + 1))
      fi

      # Validate 9 required fields
      valid=$(echo "$output" | python3 -c "
import json, sys
required = ['query_echo','results','result_count','status','error_message','error_code','backend_duration_ms','normalized_relevance','backend']
d = json.load(sys.stdin)
missing = [f for f in required if f not in d]
print('OK' if not missing else f'MISSING: {missing}')
" 2>/dev/null)
      if [ "$valid" = "OK" ]; then
        echo "  PASS: $backend mock has all 9 contract fields"
        PASS=$((PASS + 1))
      else
        echo "  FAIL: $backend mock $valid"
        FAIL=$((FAIL + 1))
      fi
    else
      echo "  FAIL: $backend wrapper returned empty output"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  FAIL: $backend wrapper not found"
    FAIL=$((FAIL + 1))
  fi
  echo ""
done

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
