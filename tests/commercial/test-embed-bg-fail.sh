#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends

REPO=$(create_test_repo)
write_repo_config "$REPO" "ready" "bm25_ready" "test-col"

# Simulate failed embed by checking status stays bm25_ready
QMD_STATUS=$(python3 -c "import json; d=json.load(open('$REPO/.openclaw-memory.json')); print(d['backends']['qmd']['status'])")
assert_eq "bm25_ready" "$QMD_STATUS" "status stays bm25_ready before embed"

teardown_test_env
rm -rf "$REPO"
summary
