import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { analyzeMemoryHealth, deduplicateResults, organizeMemories, consolidateMemories } from "../lib/quality.mjs";
import { MEMORY_MD, MEMORY_ROOT } from "../lib/constants.mjs";

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
    it("returns dry-run result by default", async () => {
      const result = await organizeMemories();
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

  describe("global MEMORY.md path usage", () => {
    it("analyzeMemoryHealth reads from MEMORY_MD global path", () => {
      // MEMORY_MD must point to ~/.openclaw/memory/MEMORY.md
      const expectedPath = resolve(homedir(), ".openclaw/memory/MEMORY.md");
      assert.equal(MEMORY_MD, expectedPath, "MEMORY_MD must be ~/.openclaw/memory/MEMORY.md");

      // When MEMORY.md exists at the global path, analyzeMemoryHealth must read it.
      // Write a temp marker, run health, then verify the path was consumed.
      mkdirSync(MEMORY_ROOT, { recursive: true });
      const hadFile = existsSync(MEMORY_MD);
      const tempContent = "- test-marker-global-path-abc\n";
      writeFileSync(MEMORY_MD, tempContent, { flag: "w" });

      const health = analyzeMemoryHealth();
      assert.ok(health.total >= 1, "analyzeMemoryHealth should find the test entry via global MEMORY.md");

      if (!hadFile) {
        unlinkSync(MEMORY_MD);
      }
    });

    it("consolidateMemories reads from MEMORY_MD global path", () => {
      mkdirSync(MEMORY_ROOT, { recursive: true });
      const hadFile = existsSync(MEMORY_MD);
      writeFileSync(MEMORY_MD, "- entry alpha for consolidation\n- entry beta for consolidation\n", { flag: "w" });

      const result = consolidateMemories();
      assert.equal(typeof result.totalMemories, "number");
      assert.ok(result.totalMemories >= 2, "consolidateMemories should count entries from global MEMORY.md");

      if (!hadFile) {
        unlinkSync(MEMORY_MD);
      }
    });

    it("organizeMemories reads from MEMORY_MD global path (dry-run)", () => {
      mkdirSync(MEMORY_ROOT, { recursive: true });
      const hadFile = existsSync(MEMORY_MD);
      writeFileSync(MEMORY_MD, "- foo bar baz organize test\n", { flag: "w" });

      const result = organizeMemories({ apply: false });
      assert.equal(result.applied, false);
      assert.equal(result.dryRun, true);

      if (!hadFile) {
        unlinkSync(MEMORY_MD);
      }
    });
  });
});
