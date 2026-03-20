import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { combinedSearch, computeRRF, fallbackTemporalFilter } from "../lib/pipeline.mjs";

describe("pipeline", () => {
  describe("RRF scoring", () => {
    it("computes RRF scores correctly", () => {
      const engineResults = [
        { engineName: "fts5", weight: 1.0, results: [
          { content: "Result A with enough text to differentiate from others", source: "a", relevance: 0.9, engine: "fts5" },
          { content: "Result B shared between engines for testing RRF merge", source: "b", relevance: 0.5, engine: "fts5" },
        ]},
        { engineName: "qmd", weight: 1.0, results: [
          { content: "Result B shared between engines for testing RRF merge", source: "b", relevance: 0.8, engine: "qmd" },
          { content: "Result C only from qmd engine for testing", source: "c", relevance: 0.3, engine: "qmd" },
        ]},
      ];
      const merged = computeRRF(engineResults, 60);
      assert.ok(Array.isArray(merged));
      assert.ok(merged.length >= 2);
      // B appears in both engines, should get highest combined RRF score
      const bResult = merged.find(r => r.content.startsWith("Result B"));
      assert.ok(bResult);
      // B's score should be sum of 1/(60+1+1) + 1/(60+0+1) from two engines
      // A's score is only 1/(60+0+1)
      assert.ok(bResult.relevance > merged.find(r => r.content.startsWith("Result A")).relevance);
    });

    it("handles single engine", () => {
      const engineResults = [
        { engineName: "fts5", weight: 1.0, results: [
          { content: "Only result", source: "a", relevance: 0.9, engine: "fts5" },
        ]},
      ];
      const merged = computeRRF(engineResults);
      assert.equal(merged.length, 1);
    });

    it("handles empty results", () => {
      const merged = computeRRF([]);
      assert.equal(merged.length, 0);
    });
  });

  describe("fallbackTemporalFilter", () => {
    it("filters results by after/before dates", () => {
      const results = [
        { content: "old", source: "a", relevance: 0.9, engine: "fts5", timestamp: "2025-01-01T00:00:00Z" },
        { content: "new", source: "b", relevance: 0.7, engine: "fts5", timestamp: "2026-03-15T00:00:00Z" },
        { content: "no-ts", source: "c", relevance: 0.5, engine: "memorymd" },
      ];
      const filtered = fallbackTemporalFilter(results, {
        after: new Date("2026-01-01"),
        before: new Date("2026-12-31"),
      });
      assert.equal(filtered.length, 2);
      assert.ok(filtered.some(r => r.content === "new"));
      assert.ok(filtered.some(r => r.content === "no-ts"));
    });

    it("passes all results when no temporal options", () => {
      const results = [{ content: "test", source: "a", relevance: 0.5, engine: "fts5" }];
      const filtered = fallbackTemporalFilter(results, {});
      assert.equal(filtered.length, 1);
    });
  });

  describe("combinedSearch", () => {
    it("returns SearchResponse with results and meta", async () => {
      const response = await combinedSearch("test query", {
        maxResults: 5, maxTokens: 1500, searchMode: "hybrid",
        mmrLambda: 0.7, halfLifeDays: 30,
      });
      assert.ok(Array.isArray(response.results));
      assert.ok(response.meta !== undefined);
      if (response.meta.trajectory) {
        assert.ok(Array.isArray(response.meta.trajectory.engines));
        assert.equal(typeof response.meta.trajectory.candidates, "number");
        assert.equal(typeof response.meta.trajectory.afterRRF, "number");
        assert.equal(typeof response.meta.trajectory.afterDedup, "number");
        assert.equal(typeof response.meta.trajectory.afterMMR, "number");
        assert.equal(typeof response.meta.trajectory.hydeUsed, "boolean");
        assert.equal(typeof response.meta.trajectory.cosineDedupUsed, "boolean");
        assert.ok(["L0", "L1", "L2"].includes(response.meta.trajectory.tier));
      }
    });
  });
});
