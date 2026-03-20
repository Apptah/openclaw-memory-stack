import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { RESCUE_DIR } from "../constants.mjs";

export default {
  name: "rescue",
  queryType: "raw",
  async search(query, options = {}) {
    if (!existsSync(RESCUE_DIR)) return [];
    const maxResults = options.maxResults || 10;
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const results = [];
    try {
      const files = execSync(`ls -t "${RESCUE_DIR}"/*.json 2>/dev/null`, { encoding: "utf-8" })
        .trim().split("\n").filter(Boolean).slice(0, 20);
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

            // Temporal filter: use fact timestamp if available
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
  },
};
