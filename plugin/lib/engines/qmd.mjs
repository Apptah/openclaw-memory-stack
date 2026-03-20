import { execSync } from "node:child_process";
import { findQmdBin } from "../constants.mjs";

const QMD_BIN = findQmdBin();

export default {
  name: "qmd",
  queryType: "expanded",
  async search(query, options = {}) {
    if (!QMD_BIN) return [];
    const maxResults = options.maxResults || 10;
    const searchMode = options.searchMode || "hybrid";
    const cmd = searchMode === "hybrid"
      ? `"${QMD_BIN}" query "${query.replace(/"/g, '\\"')}" --limit ${maxResults} --json 2>/dev/null`
      : `"${QMD_BIN}" search "${query.replace(/"/g, '\\"')}" --limit ${maxResults} --json 2>/dev/null`;
    try {
      const result = execSync(cmd, { encoding: "utf-8", timeout: 8000 });
      const data = JSON.parse(result || "{}");
      const hits = data.results || data.hits || [];
      return hits.map(h => ({
        content: h.text || h.content || h.snippet || "",
        source: h.path || h.file || "qmd",
        relevance: h.score || h.relevance || 0.5,
        engine: "qmd-" + searchMode,
      }));
    } catch { return []; }
  },
};
