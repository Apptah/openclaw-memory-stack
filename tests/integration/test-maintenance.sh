#!/usr/bin/env bash
set -euo pipefail

FACTS_DB="$HOME/.openclaw/memory/facts.sqlite"
STATE_FILE="$HOME/.openclaw/memory/maintenance-state.json"
PLUGIN_DIR="$(cd "$(dirname "$0")/../../plugin" && pwd)"

PASS=0; FAIL=0

pass() { echo "  PASS $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

echo "=== Maintenance Integration Tests ==="

# Setup: ensure DB directory + tables
mkdir -p "$(dirname "$FACTS_DB")"

sqlite3 "$FACTS_DB" "
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, content TEXT NOT NULL, source TEXT, timestamp TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  key TEXT, value TEXT, scope TEXT DEFAULT 'global',
  confidence REAL DEFAULT 0.5, evidence TEXT, supersedes INTEGER, entities TEXT
);
CREATE TABLE IF NOT EXISTS facts_archive (
  id INTEGER PRIMARY KEY, type TEXT, content TEXT, source TEXT, timestamp TEXT, created_at TEXT,
  key TEXT, value TEXT, scope TEXT, confidence REAL, evidence TEXT, supersedes INTEGER, entities TEXT,
  archived_at TEXT DEFAULT (datetime('now')), archived_reason TEXT DEFAULT 'superseded'
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, type, key, value, scope, entities);
" 2>/dev/null || true

# Seed + corrupt FTS
sqlite3 "$FACTS_DB" "INSERT INTO facts (type, content, source, timestamp) VALUES ('test', 'shell-maint-test', 'test', datetime('now'));" 2>/dev/null || true
sqlite3 "$FACTS_DB" "DELETE FROM facts_fts;" 2>/dev/null || true

# Remove state file to force run
rm -f "$STATE_FILE"

# --- Test 1: maintenance runs without error ---
MAINT_OUTPUT=$(node --input-type=module <<EOF
import { runMaintenanceIfDue } from '${PLUGIN_DIR}/lib/maintenance.mjs';
const r = await runMaintenanceIfDue();
console.log(JSON.stringify(r));
EOF
)
MAINT_EXIT=$?
if [ $MAINT_EXIT -eq 0 ]; then pass "maintenance runs without error"; else fail "maintenance runs without error"; fi

# --- Test 2: result.ran === true ---
RAN=$(echo "$MAINT_OUTPUT" | node -e "const d=[]; process.stdin.on('data',c=>d.push(c)); process.stdin.on('end',()=>{const r=JSON.parse(d.join('')); process.exit(r.ran===true?0:1);})")
if [ $? -eq 0 ]; then pass "result.ran is true"; else fail "result.ran is true"; fi

# --- Test 3: FTS rebuilt ---
FTS_COUNT=$(sqlite3 "$FACTS_DB" "SELECT COUNT(*) FROM facts_fts;" 2>/dev/null || echo "0")
if [ "$FTS_COUNT" -gt 0 ]; then pass "FTS rebuilt (count=$FTS_COUNT)"; else fail "FTS rebuilt (count=$FTS_COUNT)"; fi

# --- Test 4: state file written ---
if [ -f "$STATE_FILE" ]; then pass "maintenance-state.json written"; else fail "maintenance-state.json written"; fi

# --- Test 5: state file has expected fields ---
HAS_FIELDS=$(node -e "const s=JSON.parse(require('fs').readFileSync('${STATE_FILE}','utf-8')); process.exit(s.lastRun&&s.lastRunISO?0:1);" 2>/dev/null; echo $?)
if [ "$HAS_FIELDS" -eq 0 ]; then pass "state has lastRun + lastRunISO"; else fail "state has lastRun + lastRunISO"; fi

# --- Test 6: second run is throttled ---
SECOND_OUTPUT=$(node --input-type=module <<EOF
import { runMaintenanceIfDue } from '${PLUGIN_DIR}/lib/maintenance.mjs';
const r = await runMaintenanceIfDue();
console.log(JSON.stringify(r));
EOF
)
THROTTLED=$(echo "$SECOND_OUTPUT" | node -e "const d=[]; process.stdin.on('data',c=>d.push(c)); process.stdin.on('end',()=>{const r=JSON.parse(d.join('')); process.exit(r.ran===false?0:1);})")
if [ $? -eq 0 ]; then pass "second run is throttled (ran=false)"; else fail "second run is throttled (ran=false)"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
