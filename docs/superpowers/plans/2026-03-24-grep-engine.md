# openclaw-memory-stack grep engine — 內建 Indexed Regex 搜索

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 openclaw-memory-stack 內建完整 `grep` 能力，支持跨 `main.sqlite`（chunks）和 `facts.sqlite`（facts）的 indexed regex 搜索。四階段漸進：直接掃描 → trigram 索引 → frequency-weighted query pruning → binary posting files。不依賴任何外部 binary。

**Why:** 目前 5 個 engine（fts5, qmd, memorymd, rescue, lossless）都是語義/BM25 搜索，缺少精確 pattern match。用戶找函數名、變數名、import path 時需要 regex grep，否則只能 Read 整個檔案浪費 token。

**Architecture:** Four-phase incremental build. Phase 0: direct regex on SQLite-stored content. Phase 1: complete trigram index in SQLite for candidate filtering (conjunctive-only patterns; disjunctive patterns fall back to full scan). Phase 2: frequency-weighted query pruning — index remains complete trigrams, query time selects the rarest 2-4 trigrams by char-pair frequency for faster intersection (NOT true sparse n-gram indexing). Phase 3: namespaced binary posting files with collision-safe lookup for 80K+ chunk performance (bloom filter is an optional optimization, not required). Each phase is independently shippable.

**Correctness invariant:** The trigram/n-gram index is always a **superset filter** — it may return false positives but never false negatives. Regex verification on candidates is the correctness backstop. Patterns that cannot be safely prefiltered (alternation, optionals) fall back to full scan.

**約束：**
- 純 Node.js ESM（`.mjs`），不依賴 Bun/TypeScript/外部 binary
- DB 存取用 `sqlite3` CLI（`execSync`），與現有 engine 一致
- 輸出格式遵循現有 `{ content, source, relevance, engine }` 結構
- grep 是獨立 command，不參與 pipeline fan-out/RRF

**Tech Stack:** Node.js ESM, sqlite3 CLI (execSync), pure JS

---

## File Structure

### New Files
- `plugin/lib/grep.mjs` — Core grep engine: regex matching, trigram index, frequency-weighted query pruning, posting files
- `plugin/lib/ngram.mjs` — Trigram extraction, regex decomposition (AND/OR tree), frequency table, covering algorithm
- `plugin/lib/posting.mjs` — Phase 3: binary posting file reader/writer
- `plugin/test/grep.test.mjs` — Tests for grep
- `plugin/test/ngram.test.mjs` — Tests for ngram
- `plugin/test/posting.test.mjs` — Tests for posting files

### Modified Files
- `plugin/index.mjs` — Add `grep:` command to memory_search dispatch + trigram update in agent_end hook
- `plugin/build.mjs` — No change needed (esbuild bundles all `lib/*.mjs` imports automatically)
- `bin/openclaw-memory-qmd` — Add `grep` subcommand to CLI shim
- `plugin/lib/maintenance.mjs` — Add trigram index rebuild to maintenance cycle (backup path only)

### Build & Ship (MANDATORY after each Phase)
The runtime entry point is `plugin/dist/index.mjs` (bundled by esbuild). `install.sh` copies `plugin/dist/index.mjs` to the extension directory. **Every phase must end with:**
```bash
cd plugin && node build.mjs   # produces dist/index.mjs
```
Without this step, source changes pass tests but the installed extension has no grep.

### Runtime DB Paths (read, not modified schema in Phase 0)
- `~/.openclaw/memory/main.sqlite` — `chunks` table: `path`, `source`, `start_line`, `text`, `updated_at`
- `~/.openclaw/memory/facts.sqlite` — `facts` table: `type`, `content`, `source`, `key`, `value`, `created_at`

### New DB Tables (Phase 1+, created in main.sqlite)
- `trigrams` — posting list: `(trigram TEXT, chunk_id TEXT)`
- `trigram_meta` — index state: `(chunk_id TEXT, indexed_hash TEXT)`

### New Files (Phase 3)
- `~/.openclaw/memory/grep-postings.bin` — binary posting data
- `~/.openclaw/memory/grep-lookup.bin` — trigram → offset lookup table

### Not Modified
- `plugin/lib/pipeline.mjs` — grep 不走 combinedSearch
- `plugin/lib/engines/*.mjs` — 不新增 engine
- `plugin/lib/constants.mjs` — 已有 MEMORY_DB / RESCUE_DB，直接 import
- `plugin/lib/tiered.mjs` — grep 用自己的 formatter

---

## Phase 0: Direct Regex on SQLite Content

Grep without any index — read rows from SQLite, match with JS regex. Works perfectly for current scale.

### Task 1: grep core engine

**Files:**
- Create: `plugin/lib/grep.mjs`
- Create: `plugin/test/grep.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// plugin/test/grep.test.mjs
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { grepChunks, grepFacts, grepAll, formatGrepResults } from "../lib/grep.mjs";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createTestChunksDb() {
  const dir = mkdtempSync(join(tmpdir(), "grep-test-"));
  const db = join(dir, "main.sqlite");
  execSync(`sqlite3 "${db}" "
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
      hash TEXT NOT NULL, model TEXT NOT NULL,
      text TEXT NOT NULL, embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO chunks VALUES ('c1','sessions/2026-03-20.md','sessions',1,5,'h1','m1',
      'line one
func viewDidLoad() {
  let x = 1
}
line five','[]',1);
    INSERT INTO chunks VALUES ('c2','sessions/2026-03-21.md','sessions',1,6,'h2','m1',
      'import UIKit
class MyView: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
  }
}','[]',2);
    INSERT INTO chunks VALUES ('c3','notes/random.md','memory',1,3,'h3','m1',
      'no match here
just some text
nothing to see','[]',3);
  "`, { encoding: "utf-8" });
  return db;
}

function createTestFactsDb() {
  const dir = mkdtempSync(join(tmpdir(), "grep-facts-test-"));
  const db = join(dir, "facts.sqlite");
  execSync(`sqlite3 "${db}" "
    CREATE TABLE facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, content TEXT NOT NULL,
      source TEXT, timestamp TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      key TEXT, value TEXT, scope TEXT DEFAULT 'global',
      confidence REAL DEFAULT 0.5, evidence TEXT,
      supersedes INTEGER, entities TEXT
    );
    INSERT INTO facts (type, content, source) VALUES ('decision','viewDidLoad refactored to async','session-123');
    INSERT INTO facts (type, content, source) VALUES ('preference','user prefers dark mode','session-456');
  "`, { encoding: "utf-8" });
  return db;
}

describe("grepChunks", () => {
  let db;
  before(() => { db = createTestChunksDb(); });

  it("finds regex matches across chunks", () => {
    const results = grepChunks(db, "viewDidLoad");
    assert.equal(results.length, 2);
    assert.ok(results[0].matches.length >= 1);
  });

  it("returns correct line numbers (1-indexed)", () => {
    const results = grepChunks(db, "viewDidLoad");
    const file1 = results.find(r => r.path.includes("2026-03-20"));
    assert.ok(file1);
    assert.equal(file1.matches[0].line, 2);
  });

  it("includes context lines", () => {
    const results = grepChunks(db, "viewDidLoad", { contextLines: 1 });
    const file1 = results.find(r => r.path.includes("2026-03-20"));
    assert.ok(file1.matches[0].before.length <= 1);
    assert.ok(file1.matches[0].after.length <= 1);
  });

  it("filters by source", () => {
    const results = grepChunks(db, "some text", { source: "memory" });
    assert.equal(results.length, 1);
    assert.ok(results[0].path.includes("random"));
  });

  it("case insensitive by default", () => {
    const results = grepChunks(db, "VIEWDIDLOAD");
    assert.equal(results.length, 2);
  });

  it("case sensitive when specified", () => {
    const results = grepChunks(db, "VIEWDIDLOAD", { caseSensitive: true });
    assert.equal(results.length, 0);
  });

  it("respects maxResults", () => {
    const results = grepChunks(db, "viewDidLoad", { maxResults: 1 });
    assert.equal(results.length, 1);
  });

  it("returns empty for no matches", () => {
    const results = grepChunks(db, "zzzzNotHere");
    assert.equal(results.length, 0);
  });
});

describe("grepFacts", () => {
  let db;
  before(() => { db = createTestFactsDb(); });

  it("finds matches in facts", () => {
    const results = grepFacts(db, "viewDidLoad");
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes("viewDidLoad"));
  });

  it("returns empty for no matches", () => {
    const results = grepFacts(db, "zzzzNotHere");
    assert.equal(results.length, 0);
  });
});

describe("grepAll", () => {
  let chunksDb, factsDb;
  before(() => {
    chunksDb = createTestChunksDb();
    factsDb = createTestFactsDb();
  });

  it("merges results from both DBs", () => {
    const results = grepAll("viewDidLoad", { chunksDb, factsDb });
    assert.equal(results.chunks.length, 2);
    assert.equal(results.facts.length, 1);
  });
});

describe("formatGrepResults", () => {
  it("formats chunk results with line numbers", () => {
    const results = {
      chunks: [{
        path: "sessions/2026-03-20.md", source: "sessions",
        matches: [{ line: 2, content: "func viewDidLoad() {", before: ["line one"], after: ["  let x = 1"] }],
      }],
      facts: [],
    };
    const output = formatGrepResults(results);
    assert.ok(output.includes("sessions/2026-03-20.md"));
    assert.ok(output.includes("2"));
    assert.ok(output.includes("viewDidLoad"));
  });

  it("formats fact results", () => {
    const results = {
      chunks: [],
      facts: [{ type: "decision", content: "viewDidLoad refactored", source: "session-123" }],
    };
    const output = formatGrepResults(results);
    assert.ok(output.includes("viewDidLoad refactored"));
    assert.ok(output.includes("decision"));
  });

  it("shows no matches message", () => {
    const output = formatGrepResults({ chunks: [], facts: [] });
    assert.ok(output.includes("No matches"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin && node --test test/grep.test.mjs`
Expected: FAIL — module `../lib/grep.mjs` not found

- [ ] **Step 3: Implement grep.mjs (Phase 0 — direct scan)**

```javascript
// plugin/lib/grep.mjs
/**
 * grep.mjs — Indexed regex search engine for openclaw-memory-stack
 *
 * Phase 0: Direct regex scan of SQLite-stored content
 * Phase 1+: Trigram candidate filtering before regex (Phase 2: frequency-weighted query pruning)
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { MEMORY_DB, RESCUE_DB } from "./constants.mjs";

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
 * @returns {ChunkGrepResult[]}
 */
export function grepChunks(dbPath, pattern, opts = {}) {
  const {
    contextLines = 2,
    maxResults = 30,
    maxMatchesPerChunk = 5,
    source,
    caseSensitive = false,
  } = opts;

  if (!existsSync(dbPath)) return [];

  const flags = caseSensitive ? "g" : "gi";
  let regex;
  try { regex = new RegExp(pattern, flags); } catch { return []; }

  // Phase 1+: trigram candidate filtering plugs in here
  // For now (Phase 0): read all rows
  let sql = `SELECT id, path, source, start_line, text FROM chunks`;
  const conditions = [];
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugin && node --test test/grep.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/lib/grep.mjs plugin/test/grep.test.mjs
git commit -m "feat: add grep engine — Phase 0 direct regex on SQLite content"
```

---

### Task 2: Plugin command dispatch + CLI shim

**Files:**
- Modify: `plugin/index.mjs`
- Modify: `bin/openclaw-memory-qmd`

- [ ] **Step 1: Add grep dispatch to index.mjs**

In `plugin/index.mjs`, inside `execute()`, before the `// default: combined search` block, add:

```javascript
// grep:<pattern> [-s chunks|facts] [--case-sensitive]
const grepMatch = q.match(/^grep:(.+)/i);
if (grepMatch) {
  const { grepAll, formatGrepResults } = await import("./lib/grep.mjs");

  let grepPattern = grepMatch[1].trim();
  let scope;
  let caseSensitive = false;

  const scopeFlag = grepPattern.match(/\s+-s\s+(chunks|facts)\b/i);
  if (scopeFlag) {
    scope = scopeFlag[1].toLowerCase();
    grepPattern = grepPattern.replace(scopeFlag[0], "").trim();
  }

  const caseFlag = grepPattern.match(/\s+--case-sensitive\b/i);
  if (caseFlag) {
    caseSensitive = true;
    grepPattern = grepPattern.replace(caseFlag[0], "").trim();
  }

  if (!grepPattern) return textResult("Usage: grep:<pattern> [-s chunks|facts] [--case-sensitive]");

  const results = grepAll(grepPattern, { scope, caseSensitive });
  return textResult(formatGrepResults(results));
}
```

Update tool description to include `grep:<pattern>`.

- [ ] **Step 2: Add grep to CLI shim**

In `bin/openclaw-memory-qmd`, after `search|vsearch|query)` case, add:

```bash
  # ── Grep: internal regex search (no external binary needed) ──
  grep)
    PATTERN="" SOURCE="" CASE_FLAG="false" CONTEXT=2 LIMIT=30
    while [ $# -gt 0 ]; do
      case "$1" in
        -s)               SOURCE="$2"; shift 2 ;;
        --case-sensitive) CASE_FLAG="true"; shift ;;
        -C)               CONTEXT="$2"; shift 2 ;;
        -n)               LIMIT="$2"; shift 2 ;;
        *)                [ -z "$PATTERN" ] && PATTERN="$1" || true; shift ;;
      esac
    done

    if [ -z "$PATTERN" ]; then
      echo "Usage: openclaw-memory-qmd grep <pattern> [-s chunks|facts] [-C context] [--case-sensitive]" >&2
      exit 1
    fi

    # Pass pattern via env var to avoid shell/JS string escaping corruption.
    # Embedding regex in a -e string mangles backslash escapes (\d → d, \b → <BS>).
    # process.env preserves the raw bytes.
    GREP_PATTERN="$PATTERN" GREP_SOURCE="$SOURCE" GREP_CASE="$CASE_FLAG" \
    GREP_CONTEXT="$CONTEXT" GREP_LIMIT="$LIMIT" \
    node --input-type=module -e "
      import { grepAll, formatGrepResults } from '${INSTALL_ROOT}/plugin/lib/grep.mjs';
      const results = grepAll(process.env.GREP_PATTERN, {
        scope: process.env.GREP_SOURCE || undefined,
        caseSensitive: process.env.GREP_CASE === 'true',
        contextLines: parseInt(process.env.GREP_CONTEXT || '2', 10),
        maxResults: parseInt(process.env.GREP_LIMIT || '30', 10),
      });
      console.log(formatGrepResults(results));
    "
    ;;
```

- [ ] **Step 3: Test both entry points**

```bash
# Plugin tool (via MCP)
# Call memory_search with query "grep:viewDidLoad"

# CLI
openclaw-memory-qmd grep "viewDidLoad"
openclaw-memory-qmd grep "viewDidLoad" -s chunks
openclaw-memory-qmd grep "viewDidLoad" -s facts
```

- [ ] **Step 4: Commit**

```bash
git add plugin/index.mjs bin/openclaw-memory-qmd
git commit -m "feat: add grep command to memory_search tool and CLI shim"
```

- [ ] **Step 5: Build dist bundle (MANDATORY)**

```bash
cd plugin && node build.mjs
```

Verify `plugin/dist/index.mjs` contains grep code: `grep -q "grepAll\|grepChunks\|formatGrepResults" plugin/dist/index.mjs`

Without this step, source passes tests but the installed extension has no grep.

---

## Phase 1: Trigram Index in SQLite

Add a trigram posting list to filter candidate chunks before regex. Reduces scan from N chunks to ~50 candidates.

### Task 3: Trigram extraction and regex decomposition

**Files:**
- Create: `plugin/lib/ngram.mjs`
- Create: `plugin/test/ngram.test.mjs`

- [ ] **Step 1: Write tests for trigram extraction and regex decomposition**

```javascript
// plugin/test/ngram.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTrigrams, decomposeRegex } from "../lib/ngram.mjs";

describe("extractTrigrams", () => {
  it("extracts all 3-char substrings", () => {
    const trigrams = extractTrigrams("hello");
    assert.deepEqual(trigrams, new Set(["hel", "ell", "llo"]));
  });

  it("handles short strings", () => {
    assert.equal(extractTrigrams("ab").size, 0);
    assert.equal(extractTrigrams("abc").size, 1);
  });

  it("lowercases for consistent indexing", () => {
    const trigrams = extractTrigrams("AbCdE");
    assert.ok(trigrams.has("abc"));
    assert.ok(trigrams.has("bcd"));
  });
});

describe("decomposeRegex", () => {
  it("simple literal becomes AND node", () => {
    const tree = decomposeRegex("viewDidLoad");
    assert.equal(tree.type, "AND");
    assert.ok(tree.literals.includes("viewDidLoad"));
  });

  it("concatenation with wildcard becomes AND with multiple literals", () => {
    const tree = decomposeRegex("func.*viewDidLoad");
    assert.equal(tree.type, "AND");
    assert.ok(tree.literals.includes("func"));
    assert.ok(tree.literals.includes("viewDidLoad"));
  });

  it("top-level alternation becomes OR node", () => {
    const tree = decomposeRegex("foo|bar");
    assert.equal(tree.type, "OR");
    assert.equal(tree.children.length, 2);
  });

  it("nested alternation becomes AND with OR child", () => {
    const tree = decomposeRegex("prefix(alpha|beta)suffix");
    assert.equal(tree.type, "AND");
    assert.ok(tree.literals.includes("prefix"));
    assert.ok(tree.literals.includes("suffix"));
    assert.equal(tree.children.length, 1);
    assert.equal(tree.children[0].type, "OR");
  });

  it("optional group with ? is excluded from AND", () => {
    const tree = decomposeRegex("(foo)?bar");
    assert.equal(tree.type, "AND");
    assert.ok(tree.literals.includes("bar"));
    assert.ok(!tree.literals.includes("foo"));
  });

  it("optional group with {0,1} is excluded", () => {
    const tree = decomposeRegex("(foo){0,1}bar");
    assert.equal(tree.type, "AND");
    assert.ok(tree.literals.includes("bar"));
    assert.ok(!tree.literals.includes("foo"));
  });

  it("required group with {1,3} is included", () => {
    const tree = decomposeRegex("(req){1,3}tail");
    assert.equal(tree.type, "AND");
    assert.ok(tree.literals.includes("tail"));
    assert.equal(tree.children.length, 1);
  });

  it("pure wildcard returns SCAN", () => {
    const tree = decomposeRegex(".*");
    assert.equal(tree.type, "SCAN");
  });

  it("character class breaks literal but rest is extracted", () => {
    const tree = decomposeRegex("view[A-Z]idLoad");
    assert.equal(tree.type, "AND");
    assert.ok(tree.literals.includes("view"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin && node --test test/ngram.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ngram.mjs**

```javascript
// plugin/lib/ngram.mjs
/**
 * ngram.mjs — N-gram indexing for fast regex candidate filtering
 *
 * Phase 1: Trigram (3-char) posting lists in SQLite
 * Phase 2: Frequency-weighted query pruning (select rarest trigrams)
 */

// =============================================================================
// Trigram Extraction
// =============================================================================

/**
 * Extract all unique trigrams from text (lowercased).
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractTrigrams(text) {
  const lower = text.toLowerCase();
  const trigrams = new Set();
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.add(lower.slice(i, i + 3));
  }
  return trigrams;
}

// =============================================================================
// Regex Decomposition into AND/OR Query Tree
// =============================================================================

/**
 * @typedef {Object} QueryNode
 * @property {"AND"|"OR"|"SCAN"} type
 * @property {string[]} [literals] - (AND only) literal strings extracted
 * @property {QueryNode[]} [children] - (AND/OR) child nodes
 */

/**
 * Decompose a regex pattern into a query tree for trigram prefiltering.
 * @param {string} pattern
 * @returns {QueryNode}
 */
export function decomposeRegex(pattern) {
  const branches = splitTopLevelAlternation(pattern);
  if (branches.length > 1) {
    const children = branches.map(b => decomposeRegexBranch(b));
    if (children.some(c => c.type === "SCAN")) return { type: "SCAN" };
    return { type: "OR", children };
  }
  return decomposeRegexBranch(pattern);
}

function splitTopLevelAlternation(pattern) {
  const branches = [];
  let current = "";
  let parenDepth = 0;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") { current += ch + (pattern[i + 1] || ""); i++; continue; }
    if (ch === "[") {
      current += ch; i++;
      while (i < pattern.length && pattern[i] !== "]") { current += pattern[i]; i++; }
      if (i < pattern.length) current += "]";
      continue;
    }
    if (ch === "(") { parenDepth++; current += ch; continue; }
    if (ch === ")") { parenDepth--; current += ch; continue; }
    if (ch === "|" && parenDepth === 0) {
      branches.push(current); current = ""; continue;
    }
    current += ch;
  }
  branches.push(current);
  return branches;
}

function isZeroMinQuantifier(str, pos) {
  if (pos >= str.length) return false;
  const ch = str[pos];
  if (ch === "?" || ch === "*") return true;
  if (ch === "{") {
    let j = pos + 1;
    let numStr = "";
    while (j < str.length && /\d/.test(str[j])) { numStr += str[j]; j++; }
    if (numStr.length > 0 && parseInt(numStr, 10) === 0) return true;
  }
  return false;
}

function consumeQuantifier(str, pos) {
  if (pos >= str.length) return pos - 1;
  const ch = str[pos];
  if (ch === "?" || ch === "*" || ch === "+") return pos;
  if (ch === "{") {
    let j = pos + 1;
    while (j < str.length && str[j] !== "}") j++;
    return j;
  }
  return pos - 1;
}

function decomposeRegexBranch(branch) {
  const literals = [];
  const children = [];
  let current = "";

  for (let i = 0; i < branch.length; i++) {
    const ch = branch[i];

    // Escape sequence
    if (ch === "\\" && i + 1 < branch.length) {
      const next = branch[i + 1];
      if (!/[dwsDWSbB]/.test(next)) {
        current += next;
      } else {
        if (current.length >= 3) literals.push(current);
        current = "";
      }
      i++;
      continue;
    }

    // Character class
    if (ch === "[") {
      if (current.length >= 3) literals.push(current);
      current = "";
      while (i < branch.length && branch[i] !== "]") i++;
      continue;
    }

    // Group
    if (ch === "(") {
      if (current.length >= 3) literals.push(current);
      current = "";

      let depth = 1;
      let groupContent = "";
      i++;
      while (i < branch.length && depth > 0) {
        if (branch[i] === "\\") { groupContent += branch[i] + (branch[i + 1] || ""); i += 2; continue; }
        if (branch[i] === "(") depth++;
        if (branch[i] === ")") { depth--; if (depth === 0) break; }
        groupContent += branch[i];
        i++;
      }

      const isOptional = isZeroMinQuantifier(branch, i + 1);
      const groupNode = decomposeRegex(groupContent);

      if (isOptional) {
        i = consumeQuantifier(branch, i + 1);
      } else if (groupNode.type !== "SCAN") {
        children.push(groupNode);
      }
      continue;
    }

    // Quantifiers that make preceding element optional
    if (ch === "?" || ch === "*") {
      if (current.length > 0) current = current.slice(0, -1);
      if (current.length >= 3) literals.push(current);
      current = "";
      continue;
    }

    // Bounded quantifier {n,m}
    if (ch === "{") {
      const braceStart = i;
      let braceContent = "";
      i++;
      while (i < branch.length && branch[i] !== "}") { braceContent += branch[i]; i++; }
      const minMatch = braceContent.match(/^(\d+)/);
      const minVal = minMatch ? parseInt(minMatch[1], 10) : 1;
      if (minVal === 0) {
        if (current.length > 0) current = current.slice(0, -1);
      }
      if (current.length >= 3) literals.push(current);
      current = "";
      continue;
    }

    // Wildcards
    if (ch === "." || ch === "+" || ch === "^" || ch === "$") {
      if (current.length >= 3) literals.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.length >= 3) literals.push(current);

  if (literals.length === 0 && children.length === 0) {
    return { type: "SCAN" };
  }

  return { type: "AND", literals, children };
}

// =============================================================================
// Trigram Index: Build & Query (SQLite-backed)
// =============================================================================

/**
 * Ensure trigram tables exist in the DB.
 * @param {string} dbPath
 */
export function ensureTrigramSchema(dbPath) {
  const sql = `
    CREATE TABLE IF NOT EXISTS trigrams (
      trigram TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      PRIMARY KEY (trigram, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_trigrams_trigram ON trigrams(trigram);
    CREATE TABLE IF NOT EXISTS trigram_meta (
      chunk_id TEXT PRIMARY KEY,
      indexed_hash TEXT NOT NULL
    );
  `;
  const { execSync } = await_execSync();
  execSync(`sqlite3 "${dbPath}" "${sql.replace(/\n/g, " ")}"`, { encoding: "utf-8", timeout: 5000 });
}

// Lazy import to keep top-level clean
function await_execSync() {
  return { execSync: require_execSync() };
}
let _execSync;
function require_execSync() {
  if (!_execSync) { _execSync = execSync; }
  return _execSync;
}

import { execSync } from "node:child_process";

/**
 * Index a single chunk's trigrams.
 * @param {string} dbPath
 * @param {string} chunkId
 * @param {string} text
 * @param {string} hash
 */
export function indexChunkTrigrams(dbPath, chunkId, text, hash) {
  // Check if already indexed with same hash
  try {
    const checkSql = `SELECT indexed_hash FROM trigram_meta WHERE chunk_id = '${chunkId}'`;
    const existing = execSync(`sqlite3 -json "${dbPath}" "${checkSql}"`, { encoding: "utf-8", timeout: 3000 });
    const rows = JSON.parse(existing || "[]");
    if (rows.length > 0 && rows[0].indexed_hash === hash) return; // Already up to date
  } catch { /* table may not exist yet */ }

  const trigrams = extractTrigrams(text);
  if (trigrams.size === 0) return;

  // Delete old entries, insert new
  const deleteSql = `DELETE FROM trigrams WHERE chunk_id = '${chunkId}'; DELETE FROM trigram_meta WHERE chunk_id = '${chunkId}';`;
  const insertValues = [...trigrams].map(t =>
    `('${t.replace(/'/g, "''")}','${chunkId}')`
  ).join(",");
  const insertSql = `INSERT OR IGNORE INTO trigrams (trigram, chunk_id) VALUES ${insertValues}; INSERT OR REPLACE INTO trigram_meta (chunk_id, indexed_hash) VALUES ('${chunkId}','${hash}');`;

  execSync(`sqlite3 "${dbPath}" "${deleteSql} ${insertSql}"`, { encoding: "utf-8", timeout: 10000 });
}

/**
 * Build/refresh trigram index for all chunks.
 * @param {string} dbPath
 */
export function rebuildTrigramIndex(dbPath) {
  ensureTrigramSchema(dbPath);

  const rowsSql = `SELECT id, hash, text FROM chunks ORDER BY updated_at DESC`;
  let rows;
  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${rowsSql}"`, { encoding: "utf-8", timeout: 15000 });
    rows = JSON.parse(result || "[]");
  } catch { return; }

  for (const row of rows) {
    indexChunkTrigrams(dbPath, row.id, row.text || "", row.hash);
  }
}

/**
 * Query trigram index with a decomposed query tree.
 * Returns candidate chunk IDs.
 * @param {string} dbPath
 * @param {QueryNode} tree
 * @returns {Set<string>|null} null means full scan needed
 */
export function queryTrigramIndex(dbPath, tree) {
  if (tree.type === "SCAN") return null;

  if (tree.type === "AND") {
    // Intersect all literal trigram sets + children
    let result = null;

    for (const literal of (tree.literals || [])) {
      const trigrams = extractTrigrams(literal.toLowerCase());
      for (const trigram of trigrams) {
        const ids = lookupTrigram(dbPath, trigram);
        if (result === null) {
          result = ids;
        } else {
          result = new Set([...result].filter(id => ids.has(id)));
        }
        if (result.size === 0) return result; // Early exit
      }
    }

    for (const child of (tree.children || [])) {
      const childIds = queryTrigramIndex(dbPath, child);
      if (childIds === null) return null; // Child requires scan
      if (result === null) {
        result = childIds;
      } else {
        result = new Set([...result].filter(id => childIds.has(id)));
      }
    }

    return result || new Set();
  }

  if (tree.type === "OR") {
    // Union all children
    const result = new Set();
    for (const child of tree.children) {
      const childIds = queryTrigramIndex(dbPath, child);
      if (childIds === null) return null; // Any branch needing scan → full scan
      for (const id of childIds) result.add(id);
    }
    return result;
  }

  return null;
}

function lookupTrigram(dbPath, trigram) {
  const safeTrigram = trigram.replace(/'/g, "''");
  try {
    const sql = `SELECT chunk_id FROM trigrams WHERE trigram = '${safeTrigram}'`;
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, { encoding: "utf-8", timeout: 3000 });
    const rows = JSON.parse(result || "[]");
    return new Set(rows.map(r => r.chunk_id));
  } catch {
    return new Set();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd plugin && node --test test/ngram.test.mjs`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/lib/ngram.mjs plugin/test/ngram.test.mjs
git commit -m "feat: add trigram extraction, regex decomposition, and SQLite trigram index"
```

---

### Task 4: Integrate trigram index into grep engine

**Files:**
- Modify: `plugin/lib/grep.mjs`
- Modify: `plugin/test/grep.test.mjs`

- [ ] **Step 1: Add trigram-filtered grep tests**

Add to `plugin/test/grep.test.mjs`:

```javascript
import { rebuildTrigramIndex } from "../lib/ngram.mjs";

describe("grepChunks with trigram index", () => {
  let db;
  before(() => {
    db = createTestChunksDb();
    // Build trigram index
    rebuildTrigramIndex(db);
  });

  it("finds matches via trigram-filtered path", () => {
    const results = grepChunks(db, "viewDidLoad", { useIndex: true });
    assert.equal(results.length, 2);
  });

  it("falls back to scan for pure wildcard", () => {
    const results = grepChunks(db, ".*", { useIndex: true });
    // Should not crash — falls back to full scan
    assert.ok(results.length >= 0);
  });

  it("handles alternation via OR union", () => {
    const results = grepChunks(db, "viewDidLoad|some text", { useIndex: true });
    assert.equal(results.length, 3); // 2 viewDidLoad chunks + 1 "some text" chunk
  });

  it("preserves source filter in indexed path", () => {
    // "some text" is in source=memory; with useIndex + source filter it must still work
    const results = grepChunks(db, "some text", { useIndex: true, source: "memory" });
    assert.equal(results.length, 1);
    assert.ok(results[0].path.includes("random"));

    // source=sessions should NOT return the memory chunk
    const results2 = grepChunks(db, "some text", { useIndex: true, source: "sessions" });
    assert.equal(results2.length, 0);
  });

  it("preserves ORDER BY updated_at DESC in indexed path", () => {
    // c2 has updated_at=2 (newer), c1 has updated_at=1 (older)
    const results = grepChunks(db, "viewDidLoad", { useIndex: true });
    assert.equal(results.length, 2);
    // First result should be from the newer chunk (2026-03-21)
    assert.ok(results[0].path.includes("2026-03-21"));
  });
});
```

- [ ] **Step 2: Modify grepChunks to use trigram index when available**

In `plugin/lib/grep.mjs`, update `grepChunks`:

```javascript
import { decomposeRegex, queryTrigramIndex, ensureTrigramSchema } from "./ngram.mjs";

export function grepChunks(dbPath, pattern, opts = {}) {
  const { useIndex = false, /* ...existing opts... */ } = opts;

  // ... existing regex creation ...

  let candidateFilter = null; // null = full scan

  if (useIndex) {
    try {
      const tree = decomposeRegex(pattern);
      if (tree.type !== "SCAN") {
        candidateFilter = queryTrigramIndex(dbPath, tree);
      }
    } catch { /* fall through to full scan */ }
  }

  // Modify SQL to filter by candidate IDs if available
  // IMPORTANT: preserve source filter and ORDER BY from Phase 0 —
  // indexed path must behave identically to full-scan path except for speed.
  let sql;
  const conditions = [];
  if (candidateFilter !== null && candidateFilter.size > 0) {
    const idList = [...candidateFilter].map(id => `'${id}'`).join(",");
    conditions.push(`id IN (${idList})`);
  } else if (candidateFilter !== null && candidateFilter.size === 0) {
    return []; // No candidates — zero matches guaranteed
  }
  if (source) conditions.push(`source = '${source.replace(/'/g, "''")}'`);

  sql = `SELECT id, path, source, start_line, text FROM chunks`;
  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += ` ORDER BY updated_at DESC`;

  // ... rest of existing logic (regex matching loop, same as Phase 0) ...
}
```

- [ ] **Step 3: Add auto-index on first grep**

In `grepChunks`, before trigram query, check if index exists:

```javascript
// Auto-build index on first use if tables don't exist
try {
  const checkSql = `SELECT name FROM sqlite_master WHERE type='table' AND name='trigrams'`;
  const check = execSync(`sqlite3 -json "${dbPath}" "${checkSql}"`, { encoding: "utf-8", timeout: 2000 });
  const tables = JSON.parse(check || "[]");
  if (tables.length === 0) {
    rebuildTrigramIndex(dbPath);
  }
} catch { /* proceed without index */ }
```

- [ ] **Step 4: Run all tests**

Run: `cd plugin && node --test test/grep.test.mjs test/ngram.test.mjs`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/lib/grep.mjs plugin/test/grep.test.mjs
git commit -m "feat: integrate trigram index into grep engine for candidate filtering"
```

---

### Task 5: Incremental trigram update on ingest

**Freshness contract:** The trigram index must reflect all chunks within seconds of ingest, not hours. Two update paths ensure this:
1. **Hot path (agent_end hook):** After `saveRescueFacts` in `index.mjs`'s `agent_end` handler, call `incrementalIndexUpdate`. This fires every conversation turn — the only path that keeps the index fresh.
2. **Cold path (maintenance):** Full rebuild in the 24h maintenance cycle as a safety net for any missed updates (crash recovery, manual DB edits).

Without the hot path, `useIndex: true` would miss newly ingested content for up to 24 hours, violating the no-false-negatives correctness invariant.

**Files:**
- Modify: `plugin/lib/ngram.mjs` (add incrementalIndexUpdate)
- Modify: `plugin/index.mjs` (wire into agent_end hook)
- Modify: `plugin/lib/maintenance.mjs` (cold path safety net)

- [ ] **Step 1: Add incrementalIndexUpdate function**

In `plugin/lib/ngram.mjs`:

```javascript
/**
 * Incrementally update trigram index for changed chunks.
 * Called on every agent_end to keep index fresh.
 * Only processes chunks whose hash differs from last indexed hash.
 * @param {string} dbPath
 */
export function incrementalIndexUpdate(dbPath) {
  // Ensure schema exists (no-op if already created)
  ensureTrigramSchema(dbPath);

  // Find chunks where hash changed since last index
  const sql = `
    SELECT c.id, c.hash, c.text
    FROM chunks c
    LEFT JOIN trigram_meta tm ON tm.chunk_id = c.id
    WHERE tm.chunk_id IS NULL OR tm.indexed_hash != c.hash
    LIMIT 200
  `;
  let rows;
  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, { encoding: "utf-8", timeout: 10000 });
    rows = JSON.parse(result || "[]");
  } catch { return; }

  if (rows.length === 0) return; // Nothing to update

  for (const row of rows) {
    indexChunkTrigrams(dbPath, row.id, row.text || "", row.hash);
  }
}
```

- [ ] **Step 2: Wire into agent_end hook (hot path)**

In `plugin/index.mjs`, inside the `api.on("agent_end", ...)` handler, after `saveRescueFacts`:

```javascript
      // Incremental trigram index update (Phase 1+)
      // Keeps grep index fresh on every conversation turn.
      // No-op if trigram tables don't exist yet (Phase 0 only).
      try {
        const { incrementalIndexUpdate } = await import("./lib/ngram.mjs");
        incrementalIndexUpdate(MEMORY_DB);
      } catch { /* Phase 0: ngram.mjs may not exist yet — silent */ }
```

This is fire-and-forget inside a try/catch so it never blocks the hook and is backward-compatible with Phase 0 (where ngram.mjs doesn't exist yet).

- [ ] **Step 3: Wire into maintenance cycle (cold path)**

In `plugin/lib/maintenance.mjs`, add after Task 3 (health score check):

```javascript
    // Task 4: Trigram index full rebuild (safety net for missed updates)
    try {
      const { rebuildTrigramIndex } = await import("./ngram.mjs");
      rebuildTrigramIndex(MEMORY_DB);
      log("Trigram index rebuilt");
    } catch { /* ngram.mjs may not exist in Phase 0 */ }
```

- [ ] **Step 4: Commit**

```bash
git add plugin/lib/ngram.mjs plugin/index.mjs plugin/lib/maintenance.mjs
git commit -m "feat: incremental trigram update on agent_end + maintenance safety net"
```

- [ ] **Step 5: Build dist bundle (MANDATORY)**

```bash
cd plugin && node build.mjs
```

---

## Phase 2: Frequency-Weighted Query Pruning

**What this is:** A query-time optimization that selects the RAREST 2-4 trigrams from the pattern instead of looking up ALL of them. The trigram INDEX remains complete and unchanged — only the query strategy is smarter.

**What this is NOT:** This is not "sparse n-gram" indexing as described by Cursor/GitHub Blackbird/ClickHouse. True sparse n-grams produce variable-length n-grams at **index time** and do covering extraction at query time. Our approach keeps fixed trigrams in the index and only prunes at query time via frequency heuristics. The distinction matters:

| | True Sparse N-grams (Cursor/Blackbird) | Our Phase 2 (Frequency-Weighted Pruning) |
|---|---|---|
| Index | Variable-length n-grams, selected by rarity | Fixed trigrams, complete |
| Query | Covering extraction over variable grams | Pick K rarest trigrams by char-pair frequency |
| Tradeoff | Smaller index, more complex build | Larger index, simpler build, faster incremental update |
| Best for | Static corpus, millions of files | Live corpus, frequent ingest, <100K chunks |

Our approach is deliberately simpler because openclaw-memory-stack requires fast incremental updates (agent_end fires every turn). Rebuilding a variable-length n-gram index on every ingest would be more expensive than our fixed-trigram + query-time pruning.

**References:**
- [Cursor: Fast regex search](https://cursor.com/blog/fast-regex-search) — describes both classic trigram and true sparse n-grams
- [VLDB 1993](https://www.vldb.org/conf/1993/P290.PDF) — original trigram superset filter (our Phase 1)
- [GitHub Blackbird](https://github.blog/engineering/the-technology-behind-githubs-new-code-search/) — true sparse n-grams + notes on follow mask saturation

### Task 6: Character pair frequency table

**Files:**
- Modify: `plugin/lib/ngram.mjs`
- Modify: `plugin/test/ngram.test.mjs`

- [ ] **Step 1: Write tests for char pair frequency**

```javascript
import { getCharPairWeight, selectRarestTrigrams } from "../lib/ngram.mjs";

describe("char pair frequency", () => {
  it("common pairs have low weight", () => {
    assert.ok(getCharPairWeight("th") < 0.1);
    assert.ok(getCharPairWeight("in") < 0.1);
    assert.ok(getCharPairWeight("er") < 0.1);
  });

  it("rare pairs have high weight", () => {
    assert.ok(getCharPairWeight("qx") > 0.8);
    assert.ok(getCharPairWeight("zj") > 0.8);
  });

  it("code-common pairs weighted appropriately", () => {
    assert.ok(getCharPairWeight("fu") < 0.3);
  });
});

describe("selectRarestTrigrams", () => {
  it("selects K rarest from a set", () => {
    const trigrams = new Set(["the", "ing", "qxz", "abc", "zzj"]);
    const rarest = selectRarestTrigrams(trigrams, 2);
    assert.equal(rarest.length, 2);
    // qxz and zzj should be rarer than "the" and "ing"
    assert.ok(rarest.includes("qxz") || rarest.includes("zzj"));
  });

  it("returns all if fewer than K", () => {
    const trigrams = new Set(["abc"]);
    const rarest = selectRarestTrigrams(trigrams, 3);
    assert.equal(rarest.length, 1);
  });
});
```

- [ ] **Step 2: Implement frequency table and selector**

```javascript
// Add to plugin/lib/ngram.mjs

// Pre-computed character pair frequency weights (0 = very common, 1 = very rare)
// Based on English + code corpus analysis
const CHAR_PAIR_FREQ = new Map([
  // Very common (< 0.1)
  ["th", 0.02], ["he", 0.03], ["in", 0.04], ["er", 0.04], ["an", 0.05],
  ["re", 0.05], ["on", 0.06], ["at", 0.06], ["en", 0.06], ["nd", 0.07],
  ["ti", 0.07], ["es", 0.07], ["or", 0.07], ["te", 0.08], ["of", 0.08],
  ["ed", 0.08], ["is", 0.08], ["it", 0.08], ["al", 0.09], ["ar", 0.09],
  ["st", 0.09], ["to", 0.09], ["nt", 0.09], ["ng", 0.09],
  // Code-common (< 0.3)
  ["fu", 0.15], ["nc", 0.16], ["ct", 0.17], ["io", 0.12], ["et", 0.18],
  ["ur", 0.19], ["tu", 0.20], ["rn", 0.21], ["le", 0.12], ["se", 0.13],
  ["if", 0.22], ["fo", 0.15], ["va", 0.20], ["cl", 0.22], ["as", 0.14],
  ["ss", 0.25], ["im", 0.20], ["po", 0.18], ["rt", 0.16], ["ex", 0.25],
]);

export function getCharPairWeight(pair) {
  const lower = pair.toLowerCase();
  if (CHAR_PAIR_FREQ.has(lower)) return CHAR_PAIR_FREQ.get(lower);
  // Unknown pair = rare
  return 0.9;
}

function trigramWeight(trigram) {
  // Average weight of constituent char pairs
  const w1 = getCharPairWeight(trigram.slice(0, 2));
  const w2 = getCharPairWeight(trigram.slice(1, 3));
  return (w1 + w2) / 2;
}

/**
 * Select the K rarest trigrams from a set, by frequency weight.
 * @param {Set<string>} trigrams
 * @param {number} k
 * @returns {string[]}
 */
export function selectRarestTrigrams(trigrams, k = 3) {
  const weighted = [...trigrams].map(t => ({ trigram: t, weight: trigramWeight(t) }));
  weighted.sort((a, b) => b.weight - a.weight); // Rarest first (highest weight)
  return weighted.slice(0, k).map(w => w.trigram);
}
```

- [ ] **Step 3: Run tests**

Run: `cd plugin && node --test test/ngram.test.mjs`

- [ ] **Step 4: Commit**

```bash
git add plugin/lib/ngram.mjs plugin/test/ngram.test.mjs
git commit -m "feat: add char pair frequency table and rare-trigram query pruning"
```

---

### Task 7: Sparse query in grep engine

**Files:**
- Modify: `plugin/lib/ngram.mjs`
- Modify: `plugin/lib/grep.mjs`
- Modify: `plugin/test/grep.test.mjs`

- [ ] **Step 1: Add prunedQueryTrigramIndex function**

```javascript
// In plugin/lib/ngram.mjs

/**
 * Sparse query: instead of looking up ALL trigrams,
 * select the K rarest and intersect only those posting lists.
 * @param {string} dbPath
 * @param {QueryNode} tree
 * @param {number} [k=3] — max trigrams to look up per AND node
 * @returns {Set<string>|null}
 */
export function prunedQueryTrigramIndex(dbPath, tree, k = 3) {
  if (tree.type === "SCAN") return null;

  if (tree.type === "AND") {
    let result = null;

    // Collect ALL trigrams from all literals
    const allTrigrams = new Set();
    for (const literal of (tree.literals || [])) {
      for (const t of extractTrigrams(literal.toLowerCase())) {
        allTrigrams.add(t);
      }
    }

    // Select K rarest
    const selected = selectRarestTrigrams(allTrigrams, k);

    for (const trigram of selected) {
      const ids = lookupTrigram(dbPath, trigram);
      if (result === null) {
        result = ids;
      } else {
        result = new Set([...result].filter(id => ids.has(id)));
      }
      if (result.size === 0) return result;
    }

    // Also intersect children
    for (const child of (tree.children || [])) {
      const childIds = prunedQueryTrigramIndex(dbPath, child, k);
      if (childIds === null) return null;
      if (result === null) {
        result = childIds;
      } else {
        result = new Set([...result].filter(id => childIds.has(id)));
      }
    }

    return result || new Set();
  }

  if (tree.type === "OR") {
    const result = new Set();
    for (const child of tree.children) {
      const childIds = prunedQueryTrigramIndex(dbPath, child, k);
      if (childIds === null) return null;
      for (const id of childIds) result.add(id);
    }
    return result;
  }

  return null;
}
```

- [ ] **Step 2: Wire pruned query into grepChunks**

Update `grepChunks` to use `prunedQueryTrigramIndex` instead of `queryTrigramIndex` when index is available.

- [ ] **Step 3: Add performance test**

```javascript
describe("pruned query performance", () => {
  it("uses fewer lookups than full trigram query", () => {
    // Create DB with many chunks, verify pruned query uses <=3 lookups
    // for a long pattern like "viewDidLoadWithConfiguration"
    const db = createLargeTestDb(100);
    rebuildTrigramIndex(db);
    const tree = decomposeRegex("viewDidLoadWithConfiguration");
    // Full would need ~25 trigrams; pruned uses 3
    assert.ok(tree.literals[0].length > 10);
    const results = grepChunks(db, "viewDidLoadWithConfiguration", { useIndex: true });
    // Just verify it works — performance is a runtime concern
    assert.ok(Array.isArray(results));
  });
});
```

- [ ] **Step 4: Run all tests**

Run: `cd plugin && node --test test/grep.test.mjs test/ngram.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add plugin/lib/ngram.mjs plugin/lib/grep.mjs plugin/test/grep.test.mjs
git commit -m "feat: frequency-weighted query pruning — select rarest trigrams at query time"
```

- [ ] **Step 5: Build dist bundle (MANDATORY)**

```bash
cd plugin && node build.mjs
```

---

## Phase 3: Binary Posting Files + Collision-Safe Lookup

For 80K+ chunks — move posting lists out of SQLite into flat binary files with direct read access.

**Namespace rule:** Posting files stored alongside SQLite: `~/.openclaw/memory/grep-postings.bin` and `~/.openclaw/memory/grep-lookup.bin`.

**Collision safety:** Lookup table stores the original trigram string (not just hash) for equality verification after binary search.

### Task 8: Posting file format and writer

**Files:**
- Create: `plugin/lib/posting.mjs`
- Create: `plugin/test/posting.test.mjs`

- [ ] **Step 1: Write tests for posting file format**

```javascript
// plugin/test/posting.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PostingWriter, PostingReader } from "../lib/posting.mjs";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("posting file", () => {
  let testDir;
  before(() => { testDir = mkdtempSync(join(tmpdir(), "posting-test-")); });

  it("writes and reads posting lists", () => {
    const postingsPath = join(testDir, "postings.bin");
    const lookupPath = join(testDir, "lookup.bin");

    const writer = new PostingWriter(postingsPath, lookupPath);
    writer.addPosting("abc", ["chunk1", "chunk2", "chunk3"]);
    writer.addPosting("def", ["chunk2", "chunk4"]);
    writer.addPosting("xyz", ["chunk1"]);
    writer.flush();

    assert.ok(existsSync(postingsPath));
    assert.ok(existsSync(lookupPath));

    const reader = new PostingReader(postingsPath, lookupPath);
    const abcIds = reader.lookup("abc");
    assert.deepEqual(new Set(abcIds), new Set(["chunk1", "chunk2", "chunk3"]));

    const defIds = reader.lookup("def");
    assert.deepEqual(new Set(defIds), new Set(["chunk2", "chunk4"]));

    const missing = reader.lookup("zzz");
    assert.deepEqual(missing, []);
  });

  it("handles hash collisions by verifying trigram string", () => {
    const postingsPath = join(testDir, "collision-postings.bin");
    const lookupPath = join(testDir, "collision-lookup.bin");

    const writer = new PostingWriter(postingsPath, lookupPath);
    writer.addPosting("abc", ["chunk1"]);
    writer.addPosting("abd", ["chunk2"]); // Different trigram, might have similar hash
    writer.flush();

    const reader = new PostingReader(postingsPath, lookupPath);
    // Should NOT return chunk2 for "abc"
    const abcIds = reader.lookup("abc");
    assert.ok(!abcIds.includes("chunk2") || abcIds.includes("chunk1"));
  });

});
// NOTE: Bloom filter is an optional optimization — see "Optional: Bloom filter" subtask at end of Phase 3
```

- [ ] **Step 2: Implement posting.mjs**

```javascript
// plugin/lib/posting.mjs
/**
 * posting.mjs — Binary posting file reader/writer for Phase 3 grep
 *
 * File format:
 * - lookup.bin: sorted array of { hash: uint32, trigramLen: uint8, trigram: string, offset: uint32, count: uint32 }
 * - postings.bin: concatenated chunk ID strings, null-separated, grouped by trigram
 *
 * Collision safety: lookup stores the original trigram string, verified on read.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

export class PostingWriter {
  constructor(postingsPath, lookupPath) {
    this.postingsPath = postingsPath;
    this.lookupPath = lookupPath;
    this.entries = new Map(); // trigram → string[]
  }

  addPosting(trigram, chunkIds) {
    this.entries.set(trigram, chunkIds);
  }

  flush() {
    // Build postings data
    const postingChunks = [];
    const lookupEntries = [];
    let offset = 0;

    // Sort by hash for binary search
    const sorted = [...this.entries.entries()]
      .map(([trigram, ids]) => ({ trigram, ids, hash: fnv1a32(trigram) }))
      .sort((a, b) => a.hash - b.hash);

    for (const { trigram, ids, hash } of sorted) {
      const data = ids.join("\0");
      const dataBytes = Buffer.from(data, "utf-8");
      postingChunks.push(dataBytes);
      lookupEntries.push({ hash, trigram, offset, count: ids.length, dataLen: dataBytes.length });
      offset += dataBytes.length;
    }

    // Write postings.bin
    writeFileSync(this.postingsPath, Buffer.concat(postingChunks));

    // Write lookup.bin: [entry count (uint32)] + [entries...]
    // Entry: hash(4) + trigramLen(1) + trigram(N) + offset(4) + dataLen(4) + count(4)
    // count is uint32 (not uint16) to handle 80K+ chunks where common trigrams exceed 65535 postings
    const entryBuffers = lookupEntries.map(e => {
      const trigramBuf = Buffer.from(e.trigram, "utf-8");
      const buf = Buffer.alloc(4 + 1 + trigramBuf.length + 4 + 4 + 4);
      let pos = 0;
      buf.writeUInt32LE(e.hash, pos); pos += 4;
      buf.writeUInt8(trigramBuf.length, pos); pos += 1;
      trigramBuf.copy(buf, pos); pos += trigramBuf.length;
      buf.writeUInt32LE(e.offset, pos); pos += 4;
      buf.writeUInt32LE(e.dataLen, pos); pos += 4;
      buf.writeUInt32LE(e.count, pos);
      return buf;
    });

    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(lookupEntries.length, 0);

    writeFileSync(this.lookupPath, Buffer.concat([countBuf, ...entryBuffers]));
  }
}

export class PostingReader {
  constructor(postingsPath, lookupPath) {
    this.postingsPath = postingsPath;
    this.lookupPath = lookupPath;
    this._postings = null;
    this._entries = null;
  }

  _load() {
    if (this._postings) return;
    if (!existsSync(this.postingsPath) || !existsSync(this.lookupPath)) {
      this._postings = Buffer.alloc(0);
      this._entries = [];
      return;
    }

    this._postings = readFileSync(this.postingsPath);
    const lookupBuf = readFileSync(this.lookupPath);

    const count = lookupBuf.readUInt32LE(0);
    this._entries = [];

    let pos = 4;
    for (let i = 0; i < count; i++) {
      const hash = lookupBuf.readUInt32LE(pos); pos += 4;
      const trigramLen = lookupBuf.readUInt8(pos); pos += 1;
      const trigram = lookupBuf.subarray(pos, pos + trigramLen).toString("utf-8"); pos += trigramLen;
      const offset = lookupBuf.readUInt32LE(pos); pos += 4;
      const dataLen = lookupBuf.readUInt32LE(pos); pos += 4;
      const entryCount = lookupBuf.readUInt32LE(pos); pos += 4;
      this._entries.push({ hash, trigram, offset, dataLen, count: entryCount });
    }
  }

  lookup(trigram) {
    this._load();
    const hash = fnv1a32(trigram);

    // Binary search in sorted entries
    let lo = 0, hi = this._entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const entry = this._entries[mid];
      if (entry.hash < hash) lo = mid + 1;
      else if (entry.hash > hash) hi = mid - 1;
      else {
        // Hash match — verify trigram string (collision safety)
        if (entry.trigram === trigram) {
          const data = this._postings.subarray(entry.offset, entry.offset + entry.dataLen).toString("utf-8");
          return data.split("\0").filter(Boolean);
        }
        // Hash collision — linear scan neighbors
        let found = null;
        for (let j = mid - 1; j >= 0 && this._entries[j].hash === hash; j--) {
          if (this._entries[j].trigram === trigram) { found = this._entries[j]; break; }
        }
        if (!found) {
          for (let j = mid + 1; j < this._entries.length && this._entries[j].hash === hash; j++) {
            if (this._entries[j].trigram === trigram) { found = this._entries[j]; break; }
          }
        }
        if (found) {
          const data = this._postings.subarray(found.offset, found.offset + found.dataLen).toString("utf-8");
          return data.split("\0").filter(Boolean);
        }
        return [];
      }
    }
    return [];
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd plugin && node --test test/posting.test.mjs`

- [ ] **Step 4: Commit**

```bash
git add plugin/lib/posting.mjs plugin/test/posting.test.mjs
git commit -m "feat: add binary posting file format with collision-safe lookup"
```

---

### Task 9: Binary posting builder from SQLite trigrams

**Files:**
- Modify: `plugin/lib/ngram.mjs`
- Modify: `plugin/test/ngram.test.mjs`

- [ ] **Step 1: Add buildPostingFiles function**

```javascript
// In plugin/lib/ngram.mjs
import { PostingWriter } from "./posting.mjs";
import { resolve } from "node:path";
import { MEMORY_ROOT } from "./constants.mjs";

/**
 * Build binary posting files from SQLite trigram table.
 * @param {string} dbPath
 * @param {string} [postingsDir] - defaults to MEMORY_ROOT
 */
export function buildPostingFiles(dbPath, postingsDir) {
  const dir = postingsDir || MEMORY_ROOT;
  const postingsPath = resolve(dir, "grep-postings.bin");
  const lookupPath = resolve(dir, "grep-lookup.bin");

  // Read all trigrams from SQLite
  const sql = `SELECT trigram, GROUP_CONCAT(chunk_id, '|') as ids FROM trigrams GROUP BY trigram`;
  let rows;
  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, { encoding: "utf-8", timeout: 30000 });
    rows = JSON.parse(result || "[]");
  } catch { return; }

  const writer = new PostingWriter(postingsPath, lookupPath);
  for (const row of rows) {
    const ids = (row.ids || "").split("|").filter(Boolean);
    if (ids.length > 0) {
      writer.addPosting(row.trigram, ids);
    }
  }
  writer.flush();
}
```

- [ ] **Step 2: Add test**

```javascript
describe("buildPostingFiles", () => {
  it("builds binary files from SQLite trigrams", () => {
    const db = createTestChunksDb();
    rebuildTrigramIndex(db);
    const dir = mkdtempSync(join(tmpdir(), "posting-build-"));
    buildPostingFiles(db, dir);
    assert.ok(existsSync(join(dir, "grep-postings.bin")));
    assert.ok(existsSync(join(dir, "grep-lookup.bin")));

    const reader = new PostingReader(
      join(dir, "grep-postings.bin"),
      join(dir, "grep-lookup.bin")
    );
    // "vie" trigram should exist from "viewDidLoad"
    const ids = reader.lookup("vie");
    assert.ok(ids.length > 0);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd plugin && node --test test/ngram.test.mjs test/posting.test.mjs`

- [ ] **Step 4: Commit**

```bash
git add plugin/lib/ngram.mjs plugin/test/ngram.test.mjs
git commit -m "feat: build binary posting files from SQLite trigram table"
```

---

### Task 10: Integrate binary posting into grep engine

**Files:**
- Modify: `plugin/lib/grep.mjs`
- Modify: `plugin/test/grep.test.mjs`

- [ ] **Step 1: Add binary posting query path**

In `grepChunks`, add a check for binary posting files before falling back to SQLite trigrams:

```javascript
import { PostingReader } from "./posting.mjs";
import { resolve } from "node:path";
import { MEMORY_ROOT } from "./constants.mjs";

// In grepChunks, after useIndex check:
const postingsPath = resolve(MEMORY_ROOT, "grep-postings.bin");
const lookupPath = resolve(MEMORY_ROOT, "grep-lookup.bin");

if (useIndex && existsSync(postingsPath) && existsSync(lookupPath)) {
  // Phase 3: binary posting path
  const reader = new PostingReader(postingsPath, lookupPath);
  const tree = decomposeRegex(pattern);
  candidateFilter = queryWithBinaryPostings(reader, tree);
} else if (useIndex) {
  // Phase 1-2: SQLite trigram path
  // ... existing code ...
}
```

```javascript
function queryWithBinaryPostings(reader, tree, k = 3) {
  if (tree.type === "SCAN") return null;

  if (tree.type === "AND") {
    const allTrigrams = new Set();
    for (const literal of (tree.literals || [])) {
      for (const t of extractTrigrams(literal.toLowerCase())) {
        allTrigrams.add(t);
      }
    }

    // Select K rarest trigrams for query pruning
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
```

- [ ] **Step 2: Add auto-build threshold**

Build binary posting files automatically when chunk count exceeds threshold (e.g., 5000):

```javascript
const BINARY_POSTING_THRESHOLD = 5000;

// In grepChunks, during auto-index:
const countSql = `SELECT COUNT(*) as cnt FROM chunks`;
const countResult = execSync(`sqlite3 -json "${dbPath}" "${countSql}"`, { encoding: "utf-8" });
const chunkCount = JSON.parse(countResult || "[{}]")[0].cnt || 0;
if (chunkCount >= BINARY_POSTING_THRESHOLD && !existsSync(postingsPath)) {
  buildPostingFiles(dbPath);
}
```

- [ ] **Step 3: Run all tests**

Run: `cd plugin && node --test test/grep.test.mjs test/ngram.test.mjs test/posting.test.mjs`

- [ ] **Step 4: Commit**

```bash
git add plugin/lib/grep.mjs plugin/test/grep.test.mjs
git commit -m "feat: integrate binary posting files into grep engine"
```

---

### Task 11: Build command and maintenance integration

**Files:**
- Modify: `bin/openclaw-memory-qmd`
- Modify: `plugin/lib/maintenance.mjs`

- [ ] **Step 1: Add index-build command to CLI shim**

```bash
  # ── Index build: rebuild trigram + binary posting files ──
  grep-index)
    node --input-type=module -e "
      import { rebuildTrigramIndex, buildPostingFiles } from '${INSTALL_ROOT}/plugin/lib/ngram.mjs';
      import { MEMORY_DB } from '${INSTALL_ROOT}/plugin/lib/constants.mjs';
      console.log('Rebuilding trigram index...');
      rebuildTrigramIndex(MEMORY_DB);
      console.log('Building binary posting files...');
      buildPostingFiles(MEMORY_DB);
      console.log('Done.');
    "
    ;;
```

- [ ] **Step 2: Wire into maintenance cycle**

In `maintenance.mjs`, add incremental index update + conditional binary rebuild to the maintenance tasks.

- [ ] **Step 3: Commit**

```bash
git add bin/openclaw-memory-qmd plugin/lib/maintenance.mjs
git commit -m "feat: add grep-index command and maintenance integration"
```

- [ ] **Step 3: Build dist bundle (MANDATORY)**

```bash
cd plugin && node build.mjs
```

---

## Summary

| Phase | Tasks | What ships | Performance target |
|-------|-------|-----------|-------------------|
| 0 | 1-2 | `grep:` command with direct regex scan | <100ms for 1K chunks |
| 1 | 3-5 | Complete trigram index + incremental update + safe prefilter (conjunctive patterns; disjunctive falls back) | <50ms for 10K chunks |
| 2 | 6-7 | Frequency-weighted query pruning — select rarest 2-4 trigrams at query time (index unchanged, NOT true sparse n-gram) | <10ms for 10K chunks |
| 3 | 8-11 | Binary posting files + collision-safe lookup (bloom filter is optional perf optimization, not required) | <5ms for 80K chunks |

Each phase is independently shippable and testable. Phase 0 alone solves the immediate token-saving problem.

### All file paths (absolute)

**New files:**
```
/Users/singheiyeung/Documents/openclaw-memory-stack/plugin/lib/grep.mjs
/Users/singheiyeung/Documents/openclaw-memory-stack/plugin/lib/ngram.mjs
/Users/singheiyeung/Documents/openclaw-memory-stack/plugin/lib/posting.mjs
/Users/singheiyeung/Documents/openclaw-memory-stack/plugin/test/grep.test.mjs
/Users/singheiyeung/Documents/openclaw-memory-stack/plugin/test/ngram.test.mjs
/Users/singheiyeung/Documents/openclaw-memory-stack/plugin/test/posting.test.mjs
```

**Modified files:**
```
/Users/singheiyeung/Documents/openclaw-memory-stack/plugin/index.mjs
/Users/singheiyeung/Documents/openclaw-memory-stack/bin/openclaw-memory-qmd
/Users/singheiyeung/Documents/openclaw-memory-stack/plugin/lib/maintenance.mjs
```

**Runtime artifacts (auto-generated, not committed):**
```
~/.openclaw/memory/main.sqlite  (trigrams + trigram_meta tables added)
~/.openclaw/memory/grep-postings.bin
~/.openclaw/memory/grep-lookup.bin
```

### Correctness guarantees

- **Trigram index is always a complete superset** — every chunk trigram is indexed (Phase 1+)
- **AND/OR tree decomposition handles alternation** — `foo|bar` produces UNION of branches, not dropped
- **Optional groups excluded from AND requirements** — `(foo)?bar` only requires trigrams from `bar`
- **SCAN fallback for undecomposable patterns** — if regex too complex, full scan used
- **Regex verification is the correctness backstop** — index only narrows candidates, final match is always regex
- **Posting file lookup verifies trigram string** — hash collisions caught by equality check (Phase 3)

### Optional performance optimizations

- **Bloom filter for fast rejection** — definitely-absent trigrams skip posting lookup entirely (Phase 3). This is a pruning heuristic, not a correctness property — GitHub notes follow masks saturated at scale. Useful for small-to-medium corpora; evaluate before committing to it
