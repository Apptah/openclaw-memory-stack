import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { MEMORY_DB } from "../constants.mjs";

export default {
  name: "fts5",
  queryType: "raw",
  async search(query, options = {}) {
    if (!existsSync(MEMORY_DB)) return [];
    const maxResults = options.maxResults || 10;
    const safeQuery = query.replace(/'/g, "''").replace(/"/g, '""');
    try {
      let temporalClause = "";
      if (options.after) temporalClause += ` AND c.created_at >= '${options.after.toISOString()}'`;
      if (options.before) temporalClause += ` AND c.created_at <= '${options.before.toISOString()}'`;
      const sql = `SELECT c.text, c.path, c.created_at, bm25(chunks_fts) as rank FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid WHERE chunks_fts MATCH '${safeQuery}'${temporalClause} ORDER BY rank LIMIT ${maxResults};`;
      const result = execSync(`sqlite3 -json "${MEMORY_DB}" "${sql}"`, { encoding: "utf-8", timeout: 5000 });
      return JSON.parse(result || "[]").map(r => ({
        content: r.text || "",
        source: r.path || "memory-sqlite",
        relevance: Math.min(1, Math.abs(r.rank || 0) / 10),
        engine: "fts5",
        timestamp: r.created_at || undefined,
      }));
    } catch {
      try {
        const likeSql = `SELECT text, path FROM chunks WHERE text LIKE '%${safeQuery}%' LIMIT ${maxResults};`;
        const result = execSync(`sqlite3 -json "${MEMORY_DB}" "${likeSql}"`, { encoding: "utf-8", timeout: 5000 });
        return JSON.parse(result || "[]").map(r => ({
          content: r.text || "", source: r.path || "memory-sqlite",
          relevance: 0.3, engine: "fts5-like",
        }));
      } catch { return []; }
    }
  },
};
