import { execSync } from "../exec.mjs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { RESCUE_DIR, RESCUE_DB } from "../constants.mjs";
import { initRescueDB } from "../rescue.mjs";

let coldStartDone = false;

export default {
  name: "rescue",
  queryType: "raw",
  async search(query, options = {}) {
    const maxResults = options.maxResults || 10;

    // Cold start: init DB + migrate legacy JSON on first search
    if (!coldStartDone) {
      try { initRescueDB(); } catch { /* best-effort */ }
      coldStartDone = true;
    }

    // Try SQLite FTS5 first
    if (existsSync(RESCUE_DB)) {
      try {
        return searchSQLite(query, options, maxResults);
      } catch { /* fall through to JSON fallback */ }
    }

    // Fallback: legacy JSON files
    return searchJSON(query, options, maxResults);
  },
};

function searchSQLite(query, options, maxResults) {
  const safeQuery = query.replace(/'/g, "''").replace(/"/g, '""');

  let temporalClause = "";
  if (options.after) temporalClause += ` AND f.timestamp >= '${options.after.toISOString()}'`;
  if (options.before) temporalClause += ` AND f.timestamp <= '${options.before.toISOString()}'`;

  // Try FTS5 match first
  try {
    const sql = `SELECT f.content, f.type, f.source, f.timestamp, bm25(facts_fts) as rank FROM facts_fts JOIN facts f ON facts_fts.rowid = f.id WHERE facts_fts MATCH '${safeQuery}'${temporalClause} ORDER BY rank LIMIT ${maxResults};`;
    const result = execSync(`sqlite3 -json "${RESCUE_DB}" "${sql}"`, { encoding: "utf-8", timeout: 5000 });
    const rows = JSON.parse(result || "[]");
    if (rows.length > 0) {
      return rows.map(r => ({
        content: r.content || "",
        source: r.source || "rescue:" + (r.type || "unknown"),
        relevance: Math.min(1, 0.6 + Math.abs(r.rank || 0) / 10),
        engine: "rescue",
        timestamp: r.timestamp || undefined,
      }));
    }
  } catch { /* FTS match failed, try LIKE fallback */ }

  // LIKE fallback within SQLite
  const likeSql = `SELECT content, type, source, timestamp FROM facts WHERE content LIKE '%${safeQuery}%'${temporalClause} ORDER BY timestamp DESC LIMIT ${maxResults};`;
  const result = execSync(`sqlite3 -json "${RESCUE_DB}" "${likeSql}"`, { encoding: "utf-8", timeout: 5000 });
  return JSON.parse(result || "[]").map(r => ({
    content: r.content || "",
    source: r.source || "rescue:" + (r.type || "unknown"),
    relevance: 0.4,
    engine: "rescue",
    timestamp: r.timestamp || undefined,
  }));
}

function searchJSON(query, options, maxResults) {
  if (!existsSync(RESCUE_DIR)) return [];
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const results = [];
  try {
    const files = readdirSync(RESCUE_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => resolve(RESCUE_DIR, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, 20);
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(file, "utf-8"));
        const facts = data.facts || [];
        for (const fact of facts) {
          const text = fact.text || fact.fact || "";
          const lower = text.toLowerCase();
          const matchCount = words.filter(w => lower.includes(w)).length;
          if (matchCount === 0) continue;

          const factTimestamp = fact.timestamp || data.timestamp || undefined;

          // Temporal filter
          if (factTimestamp && (options.after || options.before)) {
            const ts = new Date(factTimestamp).getTime();
            if (!isNaN(ts)) {
              if (options.after && ts < options.after.getTime()) continue;
              if (options.before && ts > options.before.getTime()) continue;
            }
          }

          const confidence = fact.confidence ?? fact.weight ?? 0.6;
          results.push({
            content: text, source: "rescue:" + (fact.category || fact.type || "unknown"),
            relevance: Math.min(1, confidence + matchCount * 0.1),
            engine: "rescue",
            timestamp: factTimestamp,
          });
          if (results.length >= maxResults) break;
        }
      } catch { /* skip bad files */ }
      if (results.length >= maxResults) break;
    }
  } catch { /* no rescue files */ }
  return results;
}
