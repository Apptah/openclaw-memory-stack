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
