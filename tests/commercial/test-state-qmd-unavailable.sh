#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends "ready" "unavailable"  # qmd runtime unavailable

REPO=$(create_test_repo)
write_repo_config "$REPO" "ready" "skipped" ""

source "$OPENCLAW_INSTALL_ROOT/lib/license.sh"
cd "$REPO"
EFFECTIVE=$(merge_backends "$REPO/.openclaw-memory.json")

if [ -f "$EFFECTIVE" ] && command -v python3 &>/dev/null; then
  QMD_IN=$(python3 -c "import json; d=json.load(open('$EFFECTIVE')); print('qmd' in d['backends'])")
  assert_eq "False" "$QMD_IN" "qmd not in effective when unavailable"
  rm -f "$EFFECTIVE"
fi

teardown_test_env
rm -rf "$REPO"
summary
