#!/usr/bin/env bash
# OpenClaw Memory Stack — Structured facts SQLite helpers
# Used by bin/openclaw-memory for query/add/recent subcommands

FACTS_DB="${HOME}/.openclaw/memory/facts.sqlite"

facts_query_json() {
  local query="$1"
  local limit="${2:-10}"
  # FTS search returning JSON
  sqlite3 -json "$FACTS_DB" "SELECT id, type, content, key, value, scope, confidence, entities, timestamp FROM facts WHERE id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${query//\'/\'\'}') ORDER BY timestamp DESC LIMIT $limit;" 2>/dev/null || echo "[]"
}

facts_recent_json() {
  local days="${1:-7}"
  local limit="${2:-20}"
  local cutoff
  cutoff=$(date -v-${days}d +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -d "${days} days ago" +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "2000-01-01")
  sqlite3 -json "$FACTS_DB" "SELECT id, type, content, key, value, scope, confidence, entities, timestamp, created_at FROM facts WHERE created_at >= '$cutoff' ORDER BY created_at DESC LIMIT $limit;" 2>/dev/null || echo "[]"
}

facts_insert_structured() {
  local type="$1" key="$2" value="$3" scope="${4:-global}" entities="${5:-}"
  local content="${value}"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Exact duplicate check (type + key)
  if [ -n "$key" ]; then
    local existing
    existing=$(sqlite3 "$FACTS_DB" "SELECT id FROM facts WHERE type = '${type//\'/\'\'}' AND key = '${key//\'/\'\'}' LIMIT 1;" 2>/dev/null)
    if [ -n "$existing" ]; then
      # Archive old fact and remove from FTS
      sqlite3 "$FACTS_DB" "
        INSERT INTO facts_archive SELECT id, type, content, source, timestamp, created_at, key, value, scope, confidence, evidence, supersedes, entities, datetime('now'), 'superseded' FROM facts WHERE id = $existing;
        DELETE FROM facts_fts WHERE rowid = $existing;
        DELETE FROM facts WHERE id = $existing;
      " 2>/dev/null
    fi
  fi

  sqlite3 "$FACTS_DB" "
    INSERT INTO facts (type, content, source, timestamp, key, value, scope, entities)
      VALUES ('${type//\'/\'\'}', '${content//\'/\'\'}', 'cli', '$now', '${key//\'/\'\'}', '${value//\'/\'\'}', '${scope//\'/\'\'}', '${entities//\'/\'\'}');
    INSERT INTO facts_fts (rowid, content, type, key, value, scope, entities)
      VALUES (last_insert_rowid(), '${content//\'/\'\'}', '${type//\'/\'\'}', '${key//\'/\'\'}', '${value//\'/\'\'}', '${scope//\'/\'\'}', '${entities//\'/\'\'}');
  " 2>/dev/null

  if [ $? -eq 0 ]; then
    echo '{"status":"ok"}'
  else
    echo '{"status":"error","reason":"insert failed"}' >&2
    return 1
  fi
}
