#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$PROJECT_ROOT/bin/openclaw-memory"
FACTS_DB="$HOME/.openclaw/memory/facts.sqlite"

PASS=0 FAIL=0
assert_contains() {
  if echo "$1" | grep -q "$2"; then
    echo "  ✔ $3"; PASS=$((PASS + 1))
  else
    echo "  ✗ $3 (expected '$2')"; FAIL=$((FAIL + 1))
  fi
}
assert_eq() {
  if [ "$1" = "$2" ]; then
    echo "  ✔ $3"; PASS=$((PASS + 1))
  else
    echo "  ✗ $3 (got '$1', expected '$2')"; FAIL=$((FAIL + 1))
  fi
}

echo "=== Dedup Acceptance Tests ==="

# Ensure schema (in case DB is fresh)
mkdir -p "$(dirname "$FACTS_DB")"
sqlite3 "$FACTS_DB" "
CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, content TEXT NOT NULL, source TEXT, timestamp TEXT, created_at TEXT DEFAULT (datetime('now')), key TEXT, value TEXT, scope TEXT DEFAULT 'global', confidence REAL DEFAULT 0.5, evidence TEXT, supersedes INTEGER, entities TEXT);
CREATE TABLE IF NOT EXISTS facts_archive (id INTEGER PRIMARY KEY, type TEXT, content TEXT, source TEXT, timestamp TEXT, created_at TEXT, key TEXT, value TEXT, scope TEXT, confidence REAL, evidence TEXT, supersedes INTEGER, entities TEXT, archived_at TEXT DEFAULT (datetime('now')), archived_reason TEXT DEFAULT 'superseded');
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, type, key, value, scope, entities);
" 2>/dev/null

# Clean up any previous test data
sqlite3 "$FACTS_DB" "DELETE FROM facts WHERE source = 'cli' AND key LIKE 'dedup_test_%';" 2>/dev/null || true
sqlite3 "$FACTS_DB" "DELETE FROM facts_archive WHERE key LIKE 'dedup_test_%';" 2>/dev/null || true

# Test 1: Insert first fact
OUTPUT=$(OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" bash "$CLI" add --type preference --key dedup_test_db --value PostgreSQL 2>&1) || true
assert_contains "$OUTPUT" '"status":"ok"' "first insert succeeds"

# Test 2: Insert exact duplicate — should be skipped (no new row, no archive row)
OUTPUT=$(OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" bash "$CLI" add --type preference --key dedup_test_db --value PostgreSQL 2>&1) || true
COUNT=$(sqlite3 "$FACTS_DB" "SELECT COUNT(*) FROM facts WHERE key = 'dedup_test_db';" 2>/dev/null)
assert_eq "$COUNT" "1" "exact duplicate produces only 1 row in facts"

ARCHIVE_COUNT_AFTER_DUP=$(sqlite3 "$FACTS_DB" "SELECT COUNT(*) FROM facts_archive WHERE key = 'dedup_test_db';" 2>/dev/null)
assert_eq "$ARCHIVE_COUNT_AFTER_DUP" "0" "exact duplicate produces 0 rows in facts_archive"

# Test 3: Insert with same key but different value — should supersede (archive old)
OUTPUT=$(OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" bash "$CLI" add --type preference --key dedup_test_db --value MySQL 2>&1) || true
assert_contains "$OUTPUT" '"status":"ok"' "supersede insert succeeds"

# Verify: old fact archived, new fact in facts table
FACTS_COUNT=$(sqlite3 "$FACTS_DB" "SELECT COUNT(*) FROM facts WHERE key = 'dedup_test_db';" 2>/dev/null)
assert_eq "$FACTS_COUNT" "1" "after supersede: 1 row in facts"

ARCHIVE_COUNT=$(sqlite3 "$FACTS_DB" "SELECT COUNT(*) FROM facts_archive WHERE key = 'dedup_test_db';" 2>/dev/null)
assert_eq "$ARCHIVE_COUNT" "1" "after supersede: 1 row in facts_archive"

# Verify the current fact has MySQL
CURRENT_VALUE=$(sqlite3 "$FACTS_DB" "SELECT value FROM facts WHERE key = 'dedup_test_db';" 2>/dev/null)
assert_eq "$CURRENT_VALUE" "MySQL" "current fact has updated value"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
