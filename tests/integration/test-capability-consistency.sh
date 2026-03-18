#!/usr/bin/env bash
# Integration test: verify capability.json consistency across all backends
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0 FAIL=0
SUPPORTED_VERSION=1

echo "Testing capability.json consistency..."
echo ""

for skill_dir in "$PROJECT_ROOT/skills/memory-"*; do
  [ -d "$skill_dir" ] || continue
  bname=$(basename "$skill_dir" | sed 's/memory-//')
  [ "$bname" = "router" ] && continue

  cap_file="$skill_dir/capability.json"

  # Check existence
  if [ ! -f "$cap_file" ]; then
    printf "  FAIL  %-15s %s\n" "$bname" "capability.json missing"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Validate schema
  result=$(python3 -c "
import json, sys

with open('$cap_file') as f:
    d = json.load(f)

errors = []

# Check capability_version
v = d.get('capability_version')
if v is None:
    errors.append('missing capability_version')
elif v > $SUPPORTED_VERSION:
    errors.append(f'unsupported version: {v} (max: $SUPPORTED_VERSION)')

# Check required fields
for field in ['backend', 'supported_modes', 'requires_credentials', 'requires_external_service', 'cold_start_ms', 'probe', 'install_hint']:
    if field not in d:
        errors.append(f'missing field: {field}')

# Check supported_modes not empty
modes = d.get('supported_modes', [])
if not modes:
    errors.append('supported_modes is empty')

# Check probe has l1/l2/l3
probe = d.get('probe', {})
for level in ['l1_install', 'l2_runtime', 'l3_functional']:
    if level not in probe:
        errors.append(f'missing probe.{level}')

# Check l3_functional doesn't contain write keywords (safety net)
l3 = probe.get('l3_functional', '')
write_keywords = ['store', 'write', 'add', 'create', 'insert', 'delete', 'remove', 'drop']
for kw in write_keywords:
    if kw in l3.lower() and 'read' not in l3.lower():
        errors.append(f'l3_functional may write: contains \"{kw}\"')

# Check backend name matches directory
if d.get('backend') != '$bname':
    errors.append(f'backend field \"{d.get(\"backend\")}\" != directory name \"$bname\"')

if errors:
    print('FAIL: ' + '; '.join(errors))
else:
    print('PASS')
" 2>/dev/null || echo "FAIL: JSON parse error")

  if [[ "$result" == "PASS" ]]; then
    printf "  PASS  %-15s\n" "$bname"
    PASS=$((PASS + 1))
  else
    printf "  FAIL  %-15s %s\n" "$bname" "${result#FAIL: }"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
