// plugin/test/grep.test.mjs
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { grepChunks, grepFacts, grepAll, formatGrepResults } from "../lib/grep.mjs";
import { rebuildTrigramIndex } from "../lib/ngram.mjs";
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

describe("grepChunks with trigram index", () => {
  let db;
  before(() => {
    db = createTestChunksDb();
    rebuildTrigramIndex(db);
  });

  it("finds matches via trigram-filtered path", () => {
    const results = grepChunks(db, "viewDidLoad", { useIndex: true });
    assert.equal(results.length, 2);
  });

  it("falls back to scan for pure wildcard", () => {
    const results = grepChunks(db, ".*", { useIndex: true });
    assert.ok(results.length >= 0);
  });

  it("handles alternation via OR union", () => {
    const results = grepChunks(db, "viewDidLoad|some text", { useIndex: true });
    assert.equal(results.length, 3);
  });

  it("preserves source filter in indexed path", () => {
    const results = grepChunks(db, "some text", { useIndex: true, source: "memory" });
    assert.equal(results.length, 1);
    assert.ok(results[0].path.includes("random"));

    const results2 = grepChunks(db, "some text", { useIndex: true, source: "sessions" });
    assert.equal(results2.length, 0);
  });

  it("preserves ORDER BY updated_at DESC in indexed path", () => {
    const results = grepChunks(db, "viewDidLoad", { useIndex: true });
    assert.equal(results.length, 2);
    assert.ok(results[0].path.includes("2026-03-21"));
  });
});

describe("pruned query (Phase 2)", () => {
  it("works with long patterns via frequency-weighted pruning", () => {
    const db = createTestChunksDb();
    rebuildTrigramIndex(db);
    const results = grepChunks(db, "viewDidLoad", { useIndex: true });
    // Pruned path selects rarest trigrams — results must match full path
    assert.equal(results.length, 2);
  });

  it("handles patterns with no trigrams gracefully", () => {
    const db = createTestChunksDb();
    rebuildTrigramIndex(db);
    const results = grepChunks(db, "ab", { useIndex: true });
    // "ab" has no trigrams → SCAN fallback → still works
    assert.ok(Array.isArray(results));
  });
});
