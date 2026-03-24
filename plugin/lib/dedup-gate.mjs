import { execSync } from "node:child_process";
import { RESCUE_DB } from "./constants.mjs";

function sqlEscape(val) {
  if (val == null) return "NULL";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

/**
 * Check if a fact already exists and decide whether to insert, skip, or archive+insert.
 * Returns { action: "insert"|"skip"|"archive", archivedId?: number }
 */
export function gateFactInsert(fact) {
  const content = fact.text || fact.fact || fact.value || "";
  if (!content) return { action: "skip" };

  const type = fact.type || "unknown";
  const key = fact.key || null;

  // Level 1: Exact content match (same type + first 80 chars lowercase)
  const contentKey = content.slice(0, 80).toLowerCase();
  try {
    const raw = execSync(
      `sqlite3 -json "${RESCUE_DB}" "SELECT id, content FROM facts WHERE type = ${sqlEscape(type)} AND LOWER(SUBSTR(content, 1, 80)) = ${sqlEscape(contentKey)} LIMIT 1;"`,
      { encoding: "utf-8", timeout: 3000 }
    ).trim();
    if (raw && JSON.parse(raw).length > 0) {
      return { action: "skip" };
    }
  } catch {}

  // Level 2: Normalized text match (strip punctuation, collapse whitespace)
  const normalized = content.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  try {
    const raw = execSync(
      `sqlite3 -json "${RESCUE_DB}" "SELECT id, content FROM facts WHERE type = ${sqlEscape(type)} LIMIT 100;"`,
      { encoding: "utf-8", timeout: 3000 }
    ).trim();
    const rows = JSON.parse(raw || "[]");
    for (const row of rows) {
      const rowNorm = (row.content || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
      if (rowNorm === normalized) return { action: "skip" };
    }
  } catch {}

  // Level 3: Structured key match — if same type+key but different value, archive old
  if (key) {
    try {
      const raw = execSync(
        `sqlite3 -json "${RESCUE_DB}" "SELECT id FROM facts WHERE type = ${sqlEscape(type)} AND key = ${sqlEscape(key)} LIMIT 1;"`,
        { encoding: "utf-8", timeout: 3000 }
      ).trim();
      const keyMatch = JSON.parse(raw || "[]");
      if (keyMatch.length > 0) {
        return { action: "archive", archivedId: keyMatch[0].id };
      }
    } catch {}
  }

  return { action: "insert" };
}

/**
 * Archive a fact by moving it to facts_archive table.
 */
export function archiveFact(factId) {
  try {
    const sql = [
      "CREATE TABLE IF NOT EXISTS facts_archive (",
      "  id INTEGER PRIMARY KEY,",
      "  type TEXT, content TEXT, source TEXT, timestamp TEXT, created_at TEXT,",
      "  key TEXT, value TEXT, scope TEXT, confidence REAL, evidence TEXT, supersedes INTEGER, entities TEXT,",
      "  archived_at TEXT DEFAULT (datetime('now')), archived_reason TEXT DEFAULT 'superseded'",
      ");",
      `INSERT INTO facts_archive SELECT id, type, content, source, timestamp, created_at, key, value, scope, confidence, evidence, supersedes, entities, datetime('now'), 'superseded' FROM facts WHERE id = ${factId};`,
      `DELETE FROM facts WHERE id = ${factId};`,
    ].join(" ");
    execSync(`sqlite3 "${RESCUE_DB}" "${sql.replace(/"/g, '\\"')}"`, { timeout: 5000 });
  } catch { /* best-effort archive */ }
}
