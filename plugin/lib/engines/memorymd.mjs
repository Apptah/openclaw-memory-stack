import { existsSync, readFileSync } from "node:fs";
import { MEMORY_MD } from "../constants.mjs";

export default {
  name: "memorymd",
  queryType: "raw",
  async search(query, options = {}) {
    const maxResults = options.maxResults || 10;
    if (!existsSync(MEMORY_MD)) return [];
    const results = [];
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    try {
      const lines = readFileSync(MEMORY_MD, "utf-8").split("\n").filter(l => l.trim() && !l.startsWith("#"));
      for (const line of lines) {
        const lower = line.toLowerCase();
        const matchCount = words.filter(w => lower.includes(w)).length;
        if (matchCount > 0) {
          results.push({
            content: line.trim(), source: "MEMORY.md",
            relevance: Math.min(1, matchCount / Math.max(words.length, 1)),
            engine: "memorymd",
          });
        }
        if (results.length >= maxResults) break;
      }
    } catch { /* ignore */ }
    return results;
  },
};
