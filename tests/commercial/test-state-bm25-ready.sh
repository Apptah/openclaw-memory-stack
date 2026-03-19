#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends

REPO=$(create_test_repo)
write_repo_config "$REPO" "ready" "bm25_ready" "test-col"

# Verify merge_backends produces correct effective state
source "$OPENCLAW_INSTALL_ROOT/lib/license.sh"
cd "$REPO"
EFFECTIVE=$(merge_backends "$REPO/.openclaw-memory.json")

if [ -f "$EFFECTIVE" ] && command -v python3 &>/dev/null; then
  QMD_EFF=$(python3 -c "import json; d=json.load(open('$EFFECTIVE')); print(d['backends'].get('qmd',{}).get('status',''))")
  assert_eq "bm25_ready" "$QMD_EFF" "bm25_ready passes through to effective"
  rm -f "$EFFECTIVE"
else
  fail "merge_backends failed"
fi

teardown_test_env
rm -rf "$REPO"
summary
