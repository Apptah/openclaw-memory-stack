#!/usr/bin/env bash
# Shared test helpers for commercial tests
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$TESTS_DIR/../.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0

pass() { printf "${GREEN}PASS${NC} %s\n" "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf "${RED}FAIL${NC} %s\n" "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

assert_eq() {
  local expected="$1" actual="$2" msg="${3:-}"
  if [ "$expected" = "$actual" ]; then
    pass "$msg"
  else
    fail "$msg (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if echo "$haystack" | grep -q "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle')"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if ! echo "$haystack" | grep -q "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected NOT to contain '$needle')"
  fi
}

assert_exit_code() {
  local expected="$1" actual="$2" msg="${3:-}"
  assert_eq "$expected" "$actual" "$msg"
}

assert_file_exists() {
  local path="$1" msg="${2:-file exists: $1}"
  if [ -f "$path" ]; then
    pass "$msg"
  else
    fail "$msg"
  fi
}

assert_file_not_exists() {
  local path="$1" msg="${2:-file not exists: $1}"
  if [ ! -f "$path" ]; then
    pass "$msg"
  else
    fail "$msg"
  fi
}

summary() {
  echo ""
  echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
  [ "$FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
}

# Setup temp environment for testing
setup_test_env() {
  export TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  export OPENCLAW_INSTALL_ROOT="$TEST_HOME/.openclaw/memory-stack"
  export OPENCLAW_VERIFY_URL="http://localhost:${STUB_PORT:-9199}/api/verify"
  export OPENCLAW_ACTIVATE_URL="http://localhost:${STUB_PORT:-9199}/api/activate"
  mkdir -p "$TEST_HOME/.openclaw/state"
  mkdir -p "$OPENCLAW_INSTALL_ROOT/bin"
  mkdir -p "$OPENCLAW_INSTALL_ROOT/lib"
  mkdir -p "$OPENCLAW_INSTALL_ROOT/skills"

  # Copy project files to fake install root
  cp -r "$PROJECT_ROOT/bin/"* "$OPENCLAW_INSTALL_ROOT/bin/"
  cp -r "$PROJECT_ROOT/lib/"* "$OPENCLAW_INSTALL_ROOT/lib/"
  for skill in memory-router memory-totalrecall memory-qmd; do
    if [ -d "$PROJECT_ROOT/skills/$skill" ]; then
      cp -r "$PROJECT_ROOT/skills/$skill" "$OPENCLAW_INSTALL_ROOT/skills/"
    fi
  done
  chmod +x "$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory"
}

teardown_test_env() {
  rm -rf "$TEST_HOME" 2>/dev/null || true
}

# Write a test license.json
write_license() {
  local key="${1:-oc-starter-test123}"
  local tier="${2:-starter}"
  local device_id="${3:-testdevice1234}"
  local last_verified="${4:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
  local revoked="${5:-false}"

  cat > "$TEST_HOME/.openclaw/state/license.json" <<EOF
{
  "key": "$key",
  "tier": "$tier",
  "device_id": "$device_id",
  "activated_at": "2026-01-01T00:00:00Z",
  "last_verified": "$last_verified",
  "verify_interval_s": 604800,
  "revoked": $revoked
}
EOF
}

# Write a test backends.json (global — runtime only)
write_backends() {
  local tr_runtime="${1:-ready}"
  local qmd_runtime="${2:-ready}"

  cat > "$TEST_HOME/.openclaw/state/backends.json" <<EOF
{
  "version": "2.0",
  "tier": "starter",
  "installed_at": "2026-01-01T00:00:00Z",
  "backends": {
    "totalrecall": { "runtime": "$tr_runtime" },
    "qmd":         { "runtime": "$qmd_runtime" }
  }
}
EOF
}

# Write a per-repo .openclaw-memory.json
write_repo_config() {
  local repo_root="$1"
  local tr_status="${2:-ready}"
  local qmd_status="${3:-bm25_ready}"
  local collection="${4:-test-col}"

  cat > "$repo_root/.openclaw-memory.json" <<EOF
{
  "tier": "starter",
  "version": "0.1.0",
  "initialized_at": "2026-01-01T00:00:00Z",
  "backends": {
    "totalrecall": { "status": "$tr_status", "branch": "openclaw-memory" },
    "qmd": { "status": "$qmd_status", "collection": "$collection" }
  }
}
EOF
}

# Create a temp git repo for testing
create_test_repo() {
  local repo_dir=$(mktemp -d)
  git -C "$repo_dir" init --quiet
  git -C "$repo_dir" commit --allow-empty --quiet -m "init"
  echo "$repo_dir"
}
