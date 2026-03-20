import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeMemoryHealth, deduplicateResults, organizeMemories } from "../lib/quality.mjs";

describe("quality", () => {
  describe("deduplicateResults (Gap 6)", () => {
    it("removes exact key duplicates (Level 1)", () => {
      const results = [
        { content: "The quick brown fox jumps over the lazy dog and more text here padding", relevance: 0.9, source: "a", engine: "fts5" },
        { content: "The quick brown fox jumps over the lazy dog and more text here padding", relevance: 0.7, source: "b", engine: "qmd" },
      ];
      const deduped = deduplicateResults(results);
      assert.equal(deduped.length, 1);
      assert.equal(deduped[0].relevance, 0.9);
    });

    it("removes normalized text duplicates (Level 2)", () => {
      const results = [
        { content: "Hello, World! Testing 123.", relevance: 0.9, source: "a", engine: "fts5" },
        { content: "hello world testing 123", relevance: 0.7, source: "b", engine: "qmd" },
      ];
      const deduped = deduplicateResults(results);
      assert.equal(deduped.length, 1);
    });

    it("removes substring overlaps > 80% (Level 3)", () => {
      const longText = "This is a fairly long piece of text that should be considered a duplicate entry in the results";
      const results = [
        { content: longText, relevance: 0.9, source: "a", engine: "fts5" },
        { content: longText + " extra", relevance: 0.7, source: "b", engine: "qmd" },
      ];
      const deduped = deduplicateResults(results);
      assert.equal(deduped.length, 1);
    });

    it("keeps distinct results", () => {
      const results = [
        { content: "Authentication uses OAuth2 tokens for API access", relevance: 0.9, source: "a", engine: "fts5" },
        { content: "Database migration scripts run on deploy via CI pipeline", relevance: 0.7, source: "b", engine: "qmd" },
      ];
      const deduped = deduplicateResults(results);
      assert.equal(deduped.length, 2);
    });
  });

  describe("organizeMemories (Gap 10)", () => {
    it("returns dry-run result by default", () => {
      const result = organizeMemories();
      assert.equal(result.applied, false);
      assert.equal(result.dryRun, true);
    });
  });

  describe("analyzeMemoryHealth", () => {
    it("returns health object with score", () => {
      const health = analyzeMemoryHealth();
      assert.equal(typeof health.score, "number");
      assert.ok(health.score >= 0 && health.score <= 100);
    });
  });
});
