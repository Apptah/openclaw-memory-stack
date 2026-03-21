import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { MEMORY_DB } from "../constants.mjs";

export default {
  name: "fts5",
  queryType: "raw",
  /**
   * @param {string} query
   * @param {Object} [options]
   * @param {number} [options.maxResults]
   * @param {Date}   [options.after]
   * @param {Date}   [options.before]
   * @param {string} [options.source] - Filter by source column (e.g. "sessions")
   */
  async search(query, options = {}) {
    if (!existsSync(MEMORY_DB)) return [];
    const maxResults = options.maxResults || 10;
    const safeQuery = query.replace(/'/g, "''").replace(/"/g, '""');
    try {
      let filterClause = "";
      if (options.source) filterClause += ` AND c.source = '${options.source.replace(/'/g, "''")}'`;
      // Note: chunks.updated_at is INTEGER epoch ms, not ISO string.
      // Temporal filtering is handled by pipeline fallback filter (pipeline.mjs:41-52).
      const sql = `SELECT c.text, c.path, c.updated_at, bm25(chunks_fts) as rank FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid WHERE chunks_fts MATCH '${safeQuery}'${filterClause} ORDER BY rank LIMIT ${maxResults};`;
      const result = execSync(`sqlite3 -json "${MEMORY_DB}" "${sql}"`, { encoding: "utf-8", timeout: 5000 });
      const engineLabel = options.source ? `fts5:${options.source}` : "fts5";
      return JSON.parse(result || "[]").map(r => ({
        content: r.text || "",
        source: options.source ? `${options.source}:${r.path || ""}` : (r.path || "memory-sqlite"),
        relevance: Math.min(1, Math.abs(r.rank || 0) / 10),
        engine: engineLabel,
        timestamp: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
      }));
    } catch {
      try {
        let likeFilter = "";
        if (options.source) likeFilter += ` AND source = '${options.source.replace(/'/g, "''")}'`;
        const likeSql = `SELECT text, path, updated_at FROM chunks WHERE text LIKE '%${safeQuery}%'${likeFilter} LIMIT ${maxResults};`;
        const result = execSync(`sqlite3 -json "${MEMORY_DB}" "${likeSql}"`, { encoding: "utf-8", timeout: 5000 });
        return JSON.parse(result || "[]").map(r => ({
          content: r.text || "", source: r.path || "memory-sqlite",
          relevance: 0.3, engine: "fts5-like",
          timestamp: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
        }));
      } catch { return []; }
    }
  },
};
