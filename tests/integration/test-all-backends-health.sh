#!/usr/bin/env bash
# Integration test: verify all backends report valid health status
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT"

PASS=0 FAIL=0 WARN=0
BACKENDS=()

# Discover all backends dynamically
for skill_dir in "$PROJECT_ROOT/skills/memory-"*; do
  [ -f "$skill_dir/wrapper.sh" ] || continue
  bname=$(basename "$skill_dir" | sed 's/memory-//')
  [ "$bname" = "router" ] && continue
  BACKENDS+=("$bname")
done

echo "Testing ${#BACKENDS[@]} backends..."
echo ""

for backend in "${BACKENDS[@]}"; do
  wrapper="$PROJECT_ROOT/skills/memory-$backend/wrapper.sh"

  # Run health check
  health=$(bash "$wrapper" health 2>/dev/null) || health='{"status":"error","reason":"wrapper crashed"}'

  # Parse status
  status=$(echo "$health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")
  reason=$(echo "$health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null || echo "")

  # Validate JSON format
  valid_json=$(echo "$health" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    assert 'backend' in d, 'missing backend field'
    assert 'status' in d, 'missing status field'
    assert 'reason' in d, 'missing reason field'
    assert d['status'] in ('ready', 'degraded', 'installed', 'unavailable'), f'invalid status: {d[\"status\"]}'
    print('valid')
except Exception as e:
    print(f'invalid: {e}')
" 2>/dev/null || echo "invalid: parse error")

  if [[ "$valid_json" == "valid" ]]; then
    case "$status" in
      ready|degraded)
        printf "  PASS  %-15s %s\n" "$backend" "$status"
        PASS=$((PASS + 1))
        ;;
      installed|unavailable)
        printf "  WARN  %-15s %s (%s)\n" "$backend" "$status" "$reason"
        WARN=$((WARN + 1))
        ;;
    esac
  else
    printf "  FAIL  %-15s %s\n" "$backend" "$valid_json"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "Results: $PASS passed, $WARN warnings, $FAIL failed (${#BACKENDS[@]} total)"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
