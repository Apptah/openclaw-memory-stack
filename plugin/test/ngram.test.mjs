// plugin/test/ngram.test.mjs
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { extractTrigrams, decomposeRegex, getCharPairWeight, selectRarestTrigrams, rebuildTrigramIndex, buildPostingFiles } from "../lib/ngram.mjs";
import { PostingReader } from "../lib/posting.mjs";
import { execSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createTestChunksDb() {
  const dir = mkdtempSync(join(tmpdir(), "ngram-test-"));
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
      'func viewDidLoad() { let x = 1 }','[]',1);
    INSERT INTO chunks VALUES ('c2','sessions/2026-03-21.md','sessions',1,3,'h2','m1',
      'override func viewDidLoad() { super.viewDidLoad() }','[]',2);
  "`, { encoding: "utf-8" });
  return db;
}

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
    assert.ok(rarest.includes("qxz") || rarest.includes("zzj"));
  });

  it("returns all if fewer than K", () => {
    const trigrams = new Set(["abc"]);
    const rarest = selectRarestTrigrams(trigrams, 3);
    assert.equal(rarest.length, 1);
  });
});

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
