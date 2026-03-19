#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env
write_license
write_backends

REPO=$(create_test_repo)
# Write config with a stale running job (PID 99999 likely doesn't exist)
cat > "$REPO/.openclaw-memory.json" <<EOF
{
  "tier": "starter",
  "version": "0.1.0",
  "initialized_at": "2026-01-01T00:00:00Z",
  "backends": {
    "totalrecall": {"status": "ready", "branch": "openclaw-memory"},
    "qmd": {"status": "bm25_ready", "collection": "test-col",
            "embed_job": {"status": "running", "pid": 99999}}
  }
}
EOF

cd "$REPO"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" embed 2>&1 || true)
# Should NOT say "already running" since PID 99999 is dead
assert_not_contains "$OUTPUT" "already running" "stale job allows override"

teardown_test_env
rm -rf "$REPO"
summary
