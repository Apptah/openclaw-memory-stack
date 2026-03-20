import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HOME } from "../constants.mjs";

const DB_PATH = process.env.OPENCLAW_LCM_DB || resolve(HOME, ".openclaw/lcm/lcm.sqlite");

let schema = null;

function probeSchema() {
  if (schema !== null) return schema;
  if (!existsSync(DB_PATH)) { schema = false; return false; }
  try {
    const raw = execSync(`sqlite3 -json "${DB_PATH}" "PRAGMA table_info(nodes);"`, { encoding: "utf-8", timeout: 3000 });
    const columns = JSON.parse(raw || "[]").map(c => c.name);
    if (!columns.includes("content")) { schema = false; return false; }
    schema = {
      hasKind: columns.includes("kind"),
      hasCreatedAt: columns.includes("created_at"),
      columns,
    };
    return schema;
  } catch { schema = false; return false; }
}

export default {
  name: "lossless",
  queryType: "raw",
  async search(query, options = {}) {
    const s = probeSchema();
    if (!s) return [];
    const maxResults = options.maxResults || 10;
    const safeQuery = query.replace(/'/g, "''").replace(/"/g, '""');

    let temporalClause = "";
    if (s.hasCreatedAt) {
      if (options.after) temporalClause += ` AND created_at >= '${options.after.toISOString()}'`;
      if (options.before) temporalClause += ` AND created_at <= '${options.before.toISOString()}'`;
    }

    const kindSelect = s.hasKind ? ", kind" : "";
    const createdSelect = s.hasCreatedAt ? ", created_at" : "";
    const sql = `SELECT rowid, content${kindSelect}${createdSelect} FROM nodes WHERE content LIKE '%${safeQuery}%'${temporalClause} ORDER BY rowid DESC LIMIT ${maxResults};`;

    try {
      const raw = execSync(`sqlite3 -json "${DB_PATH}" "${sql}"`, { encoding: "utf-8", timeout: 5000 });
      return JSON.parse(raw || "[]").map(r => ({
        content: r.content || "",
        source: `lossless:${r.kind || "node"}`,
        relevance: 0.5,
        engine: "lossless",
        timestamp: r.created_at || undefined,
      }));
    } catch { return []; }
  },
};
