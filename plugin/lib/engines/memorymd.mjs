import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORKSPACE } from "../constants.mjs";

export default {
  name: "memorymd",
  queryType: "raw",
  async search(query, options = {}) {
    const maxResults = options.maxResults || 10;
    const memoryMdPath = resolve(WORKSPACE, "MEMORY.md");
    if (!existsSync(memoryMdPath)) return [];
    const results = [];
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    try {
      const lines = readFileSync(memoryMdPath, "utf-8").split("\n").filter(l => l.trim() && !l.startsWith("#"));
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
