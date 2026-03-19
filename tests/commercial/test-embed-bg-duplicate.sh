#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends

REPO=$(create_test_repo)

# Write config with a running job (using current shell PID which is alive)
cat > "$REPO/.openclaw-memory.json" <<EOF
{
  "tier": "starter",
  "version": "0.1.0",
  "initialized_at": "2026-01-01T00:00:00Z",
  "backends": {
    "totalrecall": {"status": "ready", "branch": "openclaw-memory"},
    "qmd": {"status": "bm25_ready", "collection": "test-col",
            "embed_job": {"status": "running", "pid": $$}}
  }
}
EOF

cd "$REPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" embed 2>&1 || true)
assert_contains "$OUTPUT" "already running" "duplicate embed rejected"

teardown_test_env
rm -rf "$REPO"
summary
