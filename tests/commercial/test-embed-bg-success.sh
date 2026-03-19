#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends

REPO=$(create_test_repo)
write_repo_config "$REPO" "ready" "bm25_ready" "test-col"

# Verify embed reads the correct collection from config
source "$OPENCLAW_INSTALL_ROOT/lib/license.sh"
source "$OPENCLAW_INSTALL_ROOT/lib/platform.sh"

COLLECTION=$(json_nested "$REPO/.openclaw-memory.json" "backends.qmd.collection")
assert_eq "test-col" "$COLLECTION" "reads collection from per-repo config"

teardown_test_env
rm -rf "$REPO"
summary
