#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends "ready" "unavailable"  # qmd runtime unavailable

REPO=$(create_test_repo)
cd "$REPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" init 2>&1 || true)
assert_contains "$OUTPUT" "QMD skipped\|bun not installed" "QMD skipped without bun"

if [ -f "$REPO/.openclaw-memory.json" ] && command -v python3 &>/dev/null; then
  QMD_STATUS=$(python3 -c "import json; d=json.load(open('$REPO/.openclaw-memory.json')); print(d['backends']['qmd']['status'])")
  assert_eq "skipped" "$QMD_STATUS" "qmd status is skipped"
fi

teardown_test_env
rm -rf "$REPO"
summary
