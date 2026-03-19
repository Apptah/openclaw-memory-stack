/**
 * OpenClaw Memory Stack — Plugin Entry Point
 *
 * Strategy: Index and search OpenClaw's NATIVE memory files directly.
 * - Reads ~/.openclaw/memory/main.sqlite (FTS5 + vectors)
 * - Reads workspace MEMORY.md files
 * - Provides enhanced memory_search via FTS5 + BM25 ranking
 * - auto-recall injects top results before each agent turn (saves tokens)
 * - No separate backends needed — works with what OpenClaw already stores
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const MEMORY_DB = resolve(HOME, ".openclaw/memory/main.sqlite");
const WORKSPACE = resolve(HOME, ".openclaw/workspace");

/**
 * Search OpenClaw's native memory SQLite using FTS5 BM25.
 * Returns ranked results directly — no shell exec, no external backends.
 */
function searchNativeMemory(query, maxResults) {
  if (!existsSync(MEMORY_DB)) return [];

  // Escape quotes for SQL
  const safeQuery = query.replace(/"/g, '""').replace(/'/g, "''");

  try {
    // FTS5 BM25 search on the chunks table
    const sql = `SELECT c.text, c.path, bm25(chunks_fts) as rank FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid WHERE chunks_fts MATCH '${safeQuery}' ORDER BY rank LIMIT ${maxResults};`;

    const result = execSync(
      `sqlite3 -json "${MEMORY_DB}" "${sql}"`,
      { encoding: "utf-8", timeout: 5000 },
    );

    const rows = JSON.parse(result || "[]");
    return rows.map(r => ({
      content: r.text || "",
      source: r.path || "memory",
      relevance: Math.min(1, Math.abs(r.rank || 0) / 10),
    }));
  } catch {
    // FTS5 MATCH can fail on certain query syntax; fall back to LIKE search
    try {
      const likeSql = `SELECT text, path FROM chunks WHERE text LIKE '%${safeQuery}%' LIMIT ${maxResults};`;
      const result = execSync(
        `sqlite3 -json "${MEMORY_DB}" "${likeSql}"`,
        { encoding: "utf-8", timeout: 5000 },
      );
      const rows = JSON.parse(result || "[]");
      return rows.map(r => ({
        content: r.text || "",
        source: r.path || "memory",
        relevance: 0.5,
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Search MEMORY.md files in workspace for simple keyword match.
 */
function searchMemoryMd(query, maxResults) {
  const results = [];
  const lowerQuery = query.toLowerCase();

  // Check workspace MEMORY.md
  const memoryMdPath = resolve(WORKSPACE, "MEMORY.md");
  if (existsSync(memoryMdPath)) {
    try {
      const content = readFileSync(memoryMdPath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim());
      for (const line of lines) {
        if (line.toLowerCase().includes(lowerQuery) || lowerQuery.split(/\s+/).some(w => line.toLowerCase().includes(w))) {
          results.push({ content: line.trim(), source: "MEMORY.md", relevance: 0.7 });
          if (results.length >= maxResults) break;
        }
      }
    } catch { /* ignore */ }
  }

  return results;
}

function truncateToTokenBudget(results, maxTokens) {
  const charBudget = maxTokens * 4;
  const selected = [];
  let used = 0;
  for (const r of results) {
    const content = r.content || "";
    if (used + content.length > charBudget) break;
    selected.push(r);
    used += content.length;
  }
  return selected;
}

function combinedSearch(query, maxResults, maxTokens) {
  // Search both native SQLite and MEMORY.md, merge and dedupe
  const sqliteResults = searchNativeMemory(query, maxResults);
  const mdResults = searchMemoryMd(query, maxResults);

  // Merge, sort by relevance, dedupe by content prefix
  const all = [...sqliteResults, ...mdResults]
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

  const seen = new Set();
  const deduped = [];
  for (const r of all) {
    const key = (r.content || "").slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
    if (deduped.length >= maxResults) break;
  }

  return truncateToTokenBudget(deduped, maxTokens);
}

export default {
  id: "openclaw-memory-stack",
  name: "OpenClaw Memory Stack",
  description: "Enhanced memory search over OpenClaw native memory using FTS5 BM25 ranking",
  kind: "memory",

  register(api) {
    const cfg = api.pluginConfig || {};
    const autoRecall = cfg.autoRecall !== false;
    const maxResults = cfg.maxRecallResults || 5;
    const maxTokens = cfg.maxRecallTokens || 1500;

    api.logger.info("Memory Stack initializing (recall=" + autoRecall + ", db=" + (existsSync(MEMORY_DB) ? "found" : "missing") + ")");

    // Register memory_search tool — searches OpenClaw's native memory
    api.registerTool({
      name: "memory_search",
      label: "Memory Search",
      description: "Search past memories, decisions, and conversation history using BM25 ranking. Faster and more precise than file search.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
      async execute(_toolCallId, params) {
        const results = combinedSearch(params.query, maxResults, maxTokens);

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No relevant memories found." }] };
        }

        const text = results
          .map((r, i) => `[${i + 1}] (${r.source}, score: ${(r.relevance || 0).toFixed(2)})\n${r.content}`)
          .join("\n---\n");

        return { content: [{ type: "text", text }] };
      },
    }, { names: ["memory_search"] });

    // Auto-recall: inject relevant memories before each agent turn
    if (autoRecall) {
      api.on("before_agent_start", async (event) => {
        const query = event.lastUserMessage || event.summary || "";
        if (!query || query.length < 5) return {};

        const results = combinedSearch(query, maxResults, maxTokens);
        if (results.length === 0) return {};

        const memoryText = results.map(r => r.content).join("\n---\n");
        return {
          prependContext: `<relevant-memories>\n${memoryText}\n</relevant-memories>`,
        };
      });
    }

    api.logger.info("Memory Stack registered (search=native-fts5, recall=" + autoRecall + ")");
  },
};
