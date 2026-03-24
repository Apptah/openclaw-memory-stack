#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$PROJECT_ROOT/bin/openclaw-memory"

PASS=0 FAIL=0
assert_contains() {
  if echo "$1" | grep -q "$2"; then
    echo "  ✔ $3"; PASS=$((PASS + 1))
  else
    echo "  ✗ $3 (expected '$2' in output)"; FAIL=$((FAIL + 1))
  fi
}

echo "=== Cross-Agent CLI Tests ==="

# Ensure facts DB exists with proper schema
FACTS_DB="$HOME/.openclaw/memory/facts.sqlite"
mkdir -p "$(dirname "$FACTS_DB")"

# Initialize schema if needed (minimal)
sqlite3 "$FACTS_DB" "
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, content TEXT NOT NULL,
  source TEXT, timestamp TEXT, created_at TEXT DEFAULT (datetime('now')),
  key TEXT, value TEXT, scope TEXT DEFAULT 'global', confidence REAL DEFAULT 0.5,
  evidence TEXT, supersedes INTEGER, entities TEXT
);
CREATE TABLE IF NOT EXISTS facts_archive (
  id INTEGER PRIMARY KEY, type TEXT, content TEXT, source TEXT, timestamp TEXT, created_at TEXT,
  key TEXT, value TEXT, scope TEXT, confidence REAL, evidence TEXT, supersedes INTEGER, entities TEXT,
  archived_at TEXT DEFAULT (datetime('now')), archived_reason TEXT DEFAULT 'superseded'
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, type, key, value, scope, entities);
" 2>/dev/null

# Test: add
OUTPUT=$(OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" bash "$CLI" add --type preference --key pr_size --value small 2>&1) || true
assert_contains "$OUTPUT" '"status":"ok"' "cli add returns success"

# Test: query
QUERY=$(OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" bash "$CLI" query "small" --format json --limit 5 2>&1) || true
assert_contains "$QUERY" '"key":"pr_size"' "query returns structured fact"

# Test: recent
RECENT=$(OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" bash "$CLI" recent --days 7 --format json 2>&1) || true
assert_contains "$RECENT" '"type":"preference"' "recent returns inserted fact"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
