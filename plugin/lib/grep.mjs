/**
 * grep.mjs — Indexed regex search engine for openclaw-memory-stack
 *
 * Phase 0: Direct regex scan of SQLite-stored content
 * Phase 1-2: Trigram candidate filtering + frequency-weighted query pruning
 * Phase 3: Binary posting file path for 80K+ chunks
 */

import { execSync } from "./exec.mjs";
import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { MEMORY_DB, RESCUE_DB } from "./constants.mjs";
import { decomposeRegex, extractTrigrams, selectRarestTrigrams, prunedQueryTrigramIndex, rebuildTrigramIndex, buildPostingFiles } from "./ngram.mjs";
import { PostingReader } from "./posting.mjs";

// =============================================================================
// Core: grep chunks (main.sqlite) — Phase 0 direct scan
// =============================================================================

/**
 * @param {string} dbPath
 * @param {string} pattern - Regex pattern string
 * @param {Object} [opts]
 * @param {number} [opts.contextLines=2]
 * @param {number} [opts.maxResults=30]
 * @param {number} [opts.maxMatchesPerChunk=5]
 * @param {string} [opts.source]
 * @param {boolean} [opts.caseSensitive=false]
 * @param {boolean} [opts.useIndex=false]
 * @returns {ChunkGrepResult[]}
 */
export function grepChunks(dbPath, pattern, opts = {}) {
  const {
    contextLines = 2,
    maxResults = 30,
    maxMatchesPerChunk = 5,
    source,
    caseSensitive = false,
    useIndex = false,
  } = opts;

  if (!existsSync(dbPath)) return [];

  const flags = caseSensitive ? "g" : "gi";
  let regex;
  try { regex = new RegExp(pattern, flags); } catch { return []; }

  // Phase 1+: trigram candidate filtering
  let candidateFilter = null; // null = full scan

  if (useIndex) {
    try {
      const tree = decomposeRegex(pattern);

      if (tree.type !== "SCAN") {
        // Derive posting paths from dbPath's directory (not global MEMORY_ROOT)
        const dbDir = dirname(dbPath);
        const postingsPath = resolve(dbDir, "grep-postings.bin");
        const lookupPath = resolve(dbDir, "grep-lookup.bin");

        // Use binary postings only if they exist AND are not stale (older than the DB)
        let useBinaryPostings = false;
        if (existsSync(postingsPath) && existsSync(lookupPath)) {
          const dbMtime = statSync(dbPath).mtimeMs;
          const postingsMtime = statSync(postingsPath).mtimeMs;
          useBinaryPostings = postingsMtime >= dbMtime;
        }

        if (useBinaryPostings) {
          // Phase 3: binary posting path
          const reader = new PostingReader(postingsPath, lookupPath);
          candidateFilter = queryWithBinaryPostings(reader, tree);
        } else {
          // Phase 1-2: SQLite trigram path
          const checkSql = `SELECT name FROM sqlite_master WHERE type='table' AND name='trigrams'`;
          const check = execSync(`sqlite3 -json "${dbPath}" "${checkSql}"`, { encoding: "utf-8", timeout: 2000 });
          const tables = JSON.parse(check || "[]");
          if (tables.length === 0) {
            rebuildTrigramIndex(dbPath);
          }
          candidateFilter = prunedQueryTrigramIndex(dbPath, tree);
        }
      }
    } catch { /* fall through to full scan */ }
  }

  // Build SQL with candidate filter + source filter + ordering
  let sql = `SELECT id, path, source, start_line, text FROM chunks`;
  const conditions = [];
  if (candidateFilter !== null && candidateFilter.size > 0) {
    const idList = [...candidateFilter].map(id => `'${id}'`).join(",");
    conditions.push(`id IN (${idList})`);
  } else if (candidateFilter !== null && candidateFilter.size === 0) {
    return []; // No candidates — zero matches guaranteed
  }
  if (source) conditions.push(`source = '${source.replace(/'/g, "''")}'`);
  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += ` ORDER BY updated_at DESC`;

  let rows;
  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, {
      encoding: "utf-8", timeout: 5000,
    });
    rows = JSON.parse(result || "[]");
  } catch { return []; }

  const results = [];

  for (const row of rows) {
    const lines = (row.text || "").split("\n");
    const matches = [];
    const baseLineNum = row.start_line || 1;

    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        matches.push({
          line: baseLineNum + i,
          content: lines[i],
          before: lines.slice(start, i),
          after: lines.slice(i + 1, end + 1),
        });
        if (matches.length >= maxMatchesPerChunk) break;
      }
    }

    if (matches.length > 0) {
      results.push({ path: row.path, source: row.source || "memory", chunkId: row.id, matches });
      if (results.length >= maxResults) break;
    }
  }

  return results;
}

// =============================================================================
// Phase 3: Binary posting query
// =============================================================================

function queryWithBinaryPostings(reader, tree, k = 3) {
  if (tree.type === "SCAN") return null;

  if (tree.type === "AND") {
    const allTrigrams = new Set();
    for (const literal of (tree.literals || [])) {
      for (const t of extractTrigrams(literal.toLowerCase())) {
        allTrigrams.add(t);
      }
    }

    const selected = selectRarestTrigrams(allTrigrams, k);
    let result = null;

    for (const trigram of selected) {
      const ids = new Set(reader.lookup(trigram));
      if (result === null) {
        result = ids;
      } else {
        result = new Set([...result].filter(id => ids.has(id)));
      }
      if (result.size === 0) return result;
    }

    for (const child of (tree.children || [])) {
      const childIds = queryWithBinaryPostings(reader, child, k);
      if (childIds === null) return null;
      if (result === null) result = childIds;
      else result = new Set([...result].filter(id => childIds.has(id)));
    }

    return result || new Set();
  }

  if (tree.type === "OR") {
    const result = new Set();
    for (const child of tree.children) {
      const childIds = queryWithBinaryPostings(reader, child, k);
      if (childIds === null) return null;
      for (const id of childIds) result.add(id);
    }
    return result;
  }

  return null;
}

// =============================================================================
// Core: grep facts (facts.sqlite)
// =============================================================================

export function grepFacts(dbPath, pattern, opts = {}) {
  const { maxResults = 20, caseSensitive = false } = opts;
  if (!existsSync(dbPath)) return [];

  const flags = caseSensitive ? "g" : "gi";
  let regex;
  try { regex = new RegExp(pattern, flags); } catch { return []; }

  let rows;
  try {
    const sql = `SELECT type, content, source, key, value FROM facts ORDER BY created_at DESC`;
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, {
      encoding: "utf-8", timeout: 5000,
    });
    rows = JSON.parse(result || "[]");
  } catch { return []; }

  const results = [];
  for (const row of rows) {
    regex.lastIndex = 0;
    if (regex.test(row.content || "")) {
      results.push({
        type: row.type, content: row.content || "",
        source: row.source || "", key: row.key || undefined, value: row.value || undefined,
      });
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

// =============================================================================
// Combined grep
// =============================================================================

export function grepAll(pattern, opts = {}) {
  const chunksDb = opts.chunksDb || MEMORY_DB;
  const factsDb = opts.factsDb || RESCUE_DB;
  const scope = opts.scope;

  const chunks = (!scope || scope === "chunks") ? grepChunks(chunksDb, pattern, opts) : [];
  const facts = (!scope || scope === "facts") ? grepFacts(factsDb, pattern, opts) : [];

  return { chunks, facts };
}

// =============================================================================
// Formatting
// =============================================================================

export function formatGrepResults(results) {
  const { chunks, facts } = results;
  const totalMatches = chunks.reduce((s, c) => s + c.matches.length, 0) + facts.length;
  if (totalMatches === 0) return "No matches found.";

  const parts = [];

  if (chunks.length > 0) {
    parts.push(`**Chunks** (${chunks.reduce((s, c) => s + c.matches.length, 0)} matches in ${chunks.length} files)\n`);
    for (const chunk of chunks) {
      parts.push(`### ${chunk.path}`);
      for (const m of chunk.matches) {
        const before = m.before.map((l, i) =>
          `  ${(m.line - m.before.length + i).toString().padStart(4)}| ${l}`
        ).join("\n");
        const main = `  ${m.line.toString().padStart(4)}| ${m.content}  <--`;
        const after = m.after.map((l, i) =>
          `  ${(m.line + 1 + i).toString().padStart(4)}| ${l}`
        ).join("\n");
        parts.push([before, main, after].filter(Boolean).join("\n"));
      }
    }
  }

  if (facts.length > 0) {
    parts.push(`\n**Facts** (${facts.length} matches)\n`);
    for (const f of facts) {
      const label = f.key ? `[${f.type}] ${f.key}` : `[${f.type}]`;
      parts.push(`- ${label}: ${f.content}${f.source ? ` (source: ${f.source})` : ""}`);
    }
  }

  return parts.join("\n");
}
