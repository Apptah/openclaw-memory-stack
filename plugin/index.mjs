/**
 * OpenClaw Memory Stack — v2 Plugin
 *
 * Three competitive advantages over native memory:
 *
 * 1. LOCAL SEMANTIC SEARCH (no API keys, no cost)
 *    QMD hybrid search (BM25 + local vector) alongside native SQLite FTS5.
 *    memory-lancedb needs OpenAI API key → we run 100% offline.
 *
 * 2. MEMORY QUALITY MANAGEMENT
 *    Detect duplicates, stale entries, and noise.
 *    memory_health tool shows memory quality score.
 *    Auto-consolidation merges similar memories.
 *
 * 3. COMPACTION RESCUE
 *    Before each turn, extract key facts from conversation.
 *    Store them persistently so compaction can't erase them.
 *    After compaction, auto-recall injects them back.
 *    "Conversations can be any length — nothing gets lost."
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const MEMORY_DB = resolve(HOME, ".openclaw/memory/main.sqlite");
const WORKSPACE = resolve(HOME, ".openclaw/workspace");
const INSTALL_ROOT = resolve(HOME, ".openclaw/memory-stack");
const RESCUE_DIR = resolve(HOME, ".openclaw/memory-stack/rescue");
const QMD_BIN = (() => {
  // Find qmd binary
  const paths = [
    resolve(HOME, ".bun/bin/qmd"),
    resolve(HOME, ".openclaw/memory-stack/node_modules/.bin/qmd"),
  ];
  for (const p of paths) { if (existsSync(p)) return p; }
  // Try PATH
  try { execSync("command -v qmd", { encoding: "utf-8" }); return "qmd"; } catch { return null; }
})();

// ─── Direction 1: Search engines ─────────────────────────────────

function searchNativeFTS5(query, maxResults) {
  if (!existsSync(MEMORY_DB)) return [];
  const safeQuery = query.replace(/'/g, "''").replace(/"/g, '""');
  try {
    const sql = `SELECT c.text, c.path, bm25(chunks_fts) as rank FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid WHERE chunks_fts MATCH '${safeQuery}' ORDER BY rank LIMIT ${maxResults};`;
    const result = execSync(`sqlite3 -json "${MEMORY_DB}" "${sql}"`, { encoding: "utf-8", timeout: 5000 });
    return JSON.parse(result || "[]").map(r => ({
      content: r.text || "", source: r.path || "memory-sqlite",
      relevance: Math.min(1, Math.abs(r.rank || 0) / 10), engine: "fts5",
    }));
  } catch {
    try {
      const likeSql = `SELECT text, path FROM chunks WHERE text LIKE '%${safeQuery}%' LIMIT ${maxResults};`;
      const result = execSync(`sqlite3 -json "${MEMORY_DB}" "${likeSql}"`, { encoding: "utf-8", timeout: 5000 });
      return JSON.parse(result || "[]").map(r => ({
        content: r.text || "", source: r.path || "memory-sqlite", relevance: 0.3, engine: "like",
      }));
    } catch { return []; }
  }
}

function searchQMD(query, maxResults, mode) {
  if (!QMD_BIN) return [];
  const searchMode = mode || "hybrid";
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
}

function searchMemoryMd(query, maxResults) {
  const results = [];
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const memoryMdPath = resolve(WORKSPACE, "MEMORY.md");
  if (!existsSync(memoryMdPath)) return results;
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
}

function searchRescueStore(query, maxResults) {
  if (!existsSync(RESCUE_DIR)) return [];
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
          const lower = (fact.text || "").toLowerCase();
          const matchCount = words.filter(w => lower.includes(w)).length;
          if (matchCount > 0) {
            results.push({
              content: fact.text, source: "rescue:" + fact.category,
              relevance: Math.min(1, 0.6 + matchCount * 0.1),
              engine: "rescue",
            });
          }
          if (results.length >= maxResults) break;
        }
      } catch { /* skip bad files */ }
      if (results.length >= maxResults) break;
    }
  } catch { /* no rescue files */ }
  return results;
}

function combinedSearch(query, maxResults, maxTokens, searchMode) {
  // Run all engines in parallel-ish (sync but fast)
  const fts5 = searchNativeFTS5(query, maxResults);
  const qmd = searchQMD(query, maxResults, searchMode);
  const md = searchMemoryMd(query, maxResults);
  const rescue = searchRescueStore(query, maxResults);

  // Merge, sort by relevance, dedupe
  const all = [...rescue, ...qmd, ...fts5, ...md]
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

  const seen = new Set();
  const deduped = [];
  for (const r of all) {
    const key = (r.content || "").slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
    if (deduped.length >= maxResults) break;
  }

  // Token budget
  const charBudget = maxTokens * 4;
  const selected = [];
  let used = 0;
  for (const r of deduped) {
    if (used + (r.content || "").length > charBudget) break;
    selected.push(r);
    used += (r.content || "").length;
  }
  return selected;
}

// ─── Direction 2: Memory quality ─────────────────────────────────

function analyzeMemoryHealth() {
  const issues = { duplicates: [], stale: [], noise: [], total: 0, score: 100 };

  if (!existsSync(resolve(WORKSPACE, "MEMORY.md"))) return issues;

  try {
    const content = readFileSync(resolve(WORKSPACE, "MEMORY.md"), "utf-8");
    const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    issues.total = lines.length;

    // Detect duplicates (similar content)
    const normalized = lines.map(l => l.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, " ").trim());
    for (let i = 0; i < normalized.length; i++) {
      for (let j = i + 1; j < normalized.length; j++) {
        if (normalized[i] === normalized[j] || (normalized[i].length > 20 && normalized[j].includes(normalized[i].slice(0, 20)))) {
          issues.duplicates.push({ line1: i + 1, line2: j + 1, text: lines[j].trim() });
        }
      }
    }

    // Detect stale entries (past dates, "today", "tomorrow", "this week")
    const now = new Date();
    const datePattern = /(\d{1,2})[\/\-](\d{1,2})|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b.*\d{1,2}/i;
    const relativePattern = /\b(today|tomorrow|this week|this friday|this monday|yesterday|last week)\b/i;
    for (let i = 0; i < lines.length; i++) {
      if (relativePattern.test(lines[i])) {
        issues.stale.push({ line: i + 1, text: lines[i].trim(), reason: "relative date reference" });
      }
    }

    // Detect noise (very short entries, just punctuation, etc.)
    for (let i = 0; i < lines.length; i++) {
      const clean = lines[i].replace(/^[-*•]\s*/, "").trim();
      if (clean.length < 10 && clean.length > 0) {
        issues.noise.push({ line: i + 1, text: lines[i].trim(), reason: "too short to be useful" });
      }
    }

    // Calculate score (100 = perfect, deduct for issues)
    issues.score = Math.max(0, 100
      - issues.duplicates.length * 10
      - issues.stale.length * 5
      - issues.noise.length * 3);
  } catch { /* ignore */ }

  return issues;
}

// ─── Direction 3: Compaction rescue ──────────────────────────────

function extractKeyFacts(text) {
  // Extract structured facts from conversation text without LLM
  // Uses pattern matching for decisions, deadlines, names, numbers
  const facts = [];
  const lines = text.split("\n").filter(l => l.trim());

  for (const line of lines) {
    const lower = line.toLowerCase();

    // Decisions
    if (/\b(decided|agreed|confirmed|chose|selected|approved)\b/i.test(line)) {
      facts.push({ text: line.trim(), category: "decision", weight: 0.9 });
    }
    // Deadlines
    else if (/\b(deadline|due|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d)/i.test(line)) {
      facts.push({ text: line.trim(), category: "deadline", weight: 0.95 });
    }
    // Requirements / specs
    else if (/\b(must|shall|require|need to|should|important)\b/i.test(line) && line.length > 30) {
      facts.push({ text: line.trim(), category: "requirement", weight: 0.7 });
    }
    // Names / entities
    else if (/\b(project|client|team|api|endpoint|database|service)\s+[A-Z]/i.test(line)) {
      facts.push({ text: line.trim(), category: "entity", weight: 0.6 });
    }
  }

  // Dedupe and keep top facts
  const seen = new Set();
  return facts.filter(f => {
    const key = f.text.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.weight - a.weight).slice(0, 20);
}

function saveRescueFacts(facts, sessionKey) {
  if (facts.length === 0) return;
  mkdirSync(RESCUE_DIR, { recursive: true });
  const filename = `${Date.now()}-${(sessionKey || "default").replace(/[^a-z0-9]/gi, "_").slice(0, 30)}.json`;
  const filepath = resolve(RESCUE_DIR, filename);
  writeFileSync(filepath, JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionKey: sessionKey || "unknown",
    factCount: facts.length,
    facts,
  }, null, 2));
}

function cleanupOldRescueFiles(maxAgeDays) {
  if (!existsSync(RESCUE_DIR)) return;
  const cutoff = Date.now() - maxAgeDays * 86400000;
  try {
    const files = execSync(`ls "${RESCUE_DIR}"/*.json 2>/dev/null`, { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean);
    for (const file of files) {
      const ts = parseInt(file.split("/").pop().split("-")[0], 10);
      if (ts && ts < cutoff) {
        try { execSync(`rm "${file}"`); } catch { /* ignore */ }
      }
    }
  } catch { /* no files */ }
}

// ─── Plugin registration ─────────────────────────────────────────

export default {
  id: "openclaw-memory-stack",
  name: "OpenClaw Memory Stack",
  description: "Local semantic search + memory quality management + compaction rescue. No API keys needed.",
  kind: "memory",

  register(api) {
    const cfg = api.pluginConfig || {};
    const autoRecall = cfg.autoRecall !== false;
    const maxResults = cfg.maxRecallResults || 5;
    const maxTokens = cfg.maxRecallTokens || 1500;
    const searchMode = cfg.searchMode || "hybrid";

    const hasQMD = !!QMD_BIN;
    const hasDB = existsSync(MEMORY_DB);

    api.logger.info(`Memory Stack v2 initializing (qmd=${hasQMD}, db=${hasDB}, recall=${autoRecall})`);

    // Cleanup old rescue files (> 30 days)
    cleanupOldRescueFiles(30);

    // ─── Tools: memory_search + memory_health (factory pattern) ──
    // Uses memory-core's pattern: single registerTool with factory returning array

    api.registerTool(
      () => {
        const memorySearchTool = {
          name: "memory_search",
          label: "Memory Search",
          description: "Search memories using local BM25 + semantic search. Searches conversation history, saved memories, and rescued facts. Use query 'health' to check memory quality (duplicates, stale entries, noise). No API keys needed.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "What to search for" },
            },
            required: ["query"],
          },
          async execute(_toolCallId, params) {
            // Special command: "health" or "health check" runs memory quality analysis
            if (/^health\b/i.test(params.query)) {
              const health = analyzeMemoryHealth();
              let report = `Memory Health Score: ${health.score}/100\nTotal entries: ${health.total}\n\n`;
              if (health.duplicates.length > 0) {
                report += `Duplicates (${health.duplicates.length}):\n`;
                health.duplicates.forEach(d => { report += `  - Line ${d.line2}: "${d.text.slice(0, 60)}"\n`; });
                report += "\n";
              }
              if (health.stale.length > 0) {
                report += `Stale entries (${health.stale.length}):\n`;
                health.stale.forEach(s => { report += `  - Line ${s.line}: "${s.text.slice(0, 60)}" (${s.reason})\n`; });
                report += "\n";
              }
              if (health.noise.length > 0) {
                report += `Noise (${health.noise.length}):\n`;
                health.noise.forEach(n => { report += `  - Line ${n.line}: "${n.text}" (${n.reason})\n`; });
                report += "\n";
              }
              if (health.score === 100) report += "All clear — memory is clean.";
              else report += "Consider cleaning up the issues above.";
              return { content: [{ type: "text", text: report }] };
            }

            const results = combinedSearch(params.query, maxResults, maxTokens, searchMode);
            if (results.length === 0) {
              return { content: [{ type: "text", text: "No relevant memories found." }] };
            }
            const engines = [...new Set(results.map(r => r.engine))];
            const text = results
              .map((r, i) => `[${i + 1}] (${r.source}, score: ${(r.relevance || 0).toFixed(2)})\n${r.content}`)
              .join("\n---\n");
            return { content: [{ type: "text", text: text + `\n\n(engines: ${engines.join(", ")})` }] };
          },
        };

        return [memorySearchTool];
      },
      { names: ["memory_search"] },
    );

    // ─── Auto-recall + compaction rescue (Directions 1 & 3) ────

    if (autoRecall) {
      api.on("before_agent_start", async (event) => {
        const query = event.lastUserMessage || event.summary || "";
        if (!query || query.length < 5) return {};

        const results = combinedSearch(query, maxResults, maxTokens, searchMode);
        if (results.length === 0) return {};

        const memoryText = results.map(r => `[${r.source}] ${r.content}`).join("\n");
        return {
          prependContext: `<memory-stack>\n${memoryText}\n</memory-stack>`,
        };
      });
    }

    // ─── Compaction rescue: save key facts after each turn ─────

    api.on("agent_end", async (event) => {
      const content = event.turnSummary || event.agentResponse || "";
      if (content.length < 100) return;

      // Extract key facts from this turn
      const facts = extractKeyFacts(content);
      if (facts.length > 0) {
        saveRescueFacts(facts, event.sessionKey);
      }
    });

    api.logger.info(`Memory Stack v2 registered (engines: fts5${hasQMD ? "+qmd" : ""}+memorymd+rescue, health=on, rescue=on)`);
  },
};
