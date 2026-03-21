import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatL0, formatL1, formatL2, parseFullSuffix } from "../lib/tiered.mjs";

const sampleResults = [
  {
    content: "Authentication uses OAuth2 tokens for API access. The server validates each token against the database before allowing requests through.",
    source: "memory.md",
    relevance: 0.95,
    engine: "fts5",
    timestamp: "2026-03-20T10:00:00Z",
  },
  {
    content: "Database migration scripts run on deploy via CI pipeline. PostgreSQL is the primary store with Redis for caching.",
    source: "sessions/2026-03-19.md",
    relevance: 0.82,
    engine: "qmd",
  },
  {
    content: "The frontend uses React with TypeScript. Components follow atomic design patterns for reusability.",
    source: "rescue/facts-abc123.md",
    relevance: 0.71,
    engine: "rescue",
  },
];

function roughTokenCount(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

describe("tiered formatters", () => {
  describe("formatL0", () => {
    it("returns strings under 100 tokens", () => {
      const output = formatL0(sampleResults);
      assert.ok(roughTokenCount(output) < 100, `L0 output was ${roughTokenCount(output)} tokens, expected < 100`);
    });

    it("starts each line with [source]", () => {
      const output = formatL0(sampleResults);
      const lines = output.split("\n");
      assert.equal(lines.length, 3);
      assert.ok(lines[0].startsWith("[memory.md]"));
      assert.ok(lines[1].startsWith("[sessions/2026-03-19.md]"));
      assert.ok(lines[2].startsWith("[rescue/facts-abc123.md]"));
    });

    it("truncates content to 60 chars with ellipsis", () => {
      const output = formatL0(sampleResults);
      const lines = output.split("\n");
      // First result content is > 60 chars, should have ellipsis
      assert.ok(lines[0].endsWith("..."));
    });

    it("returns empty string for empty results", () => {
      assert.equal(formatL0([]), "");
      assert.equal(formatL0(null), "");
      assert.equal(formatL0(undefined), "");
    });
  });

  describe("formatL1", () => {
    it("returns strings under 800 tokens", () => {
      const output = formatL1(sampleResults);
      assert.ok(roughTokenCount(output) < 800, `L1 output was ${roughTokenCount(output)} tokens, expected < 800`);
    });

    it("includes first sentence of content", () => {
      const output = formatL1(sampleResults);
      assert.ok(output.includes("Authentication uses OAuth2 tokens for API access."));
      assert.ok(output.includes("Database migration scripts run on deploy via CI pipeline."));
    });

    it("includes source and score", () => {
      const output = formatL1(sampleResults);
      assert.ok(output.includes("memory.md"));
      assert.ok(output.includes("0.95"));
    });

    it("includes entity names when present", () => {
      const output = formatL1(sampleResults);
      // OAuth2 and API should be detected as entities
      assert.ok(output.includes("entities:"), "Should include entities section");
    });

    it("returns empty string for empty results", () => {
      assert.equal(formatL1([]), "");
      assert.equal(formatL1(null), "");
    });
  });

  describe("formatL2", () => {
    it("returns full content for small result sets", () => {
      const output = formatL2(sampleResults);
      assert.ok(output.includes("Authentication uses OAuth2 tokens for API access."));
      assert.ok(output.includes("server validates each token"));
      assert.ok(output.includes("Database migration scripts"));
    });

    it("uses --- separator between results", () => {
      const output = formatL2(sampleResults);
      assert.ok(output.includes("---"));
    });

    it("budget-truncates when content exceeds 2000 tokens", () => {
      // Create results that far exceed the budget
      const bigResults = Array.from({ length: 20 }, (_, i) => ({
        content: "word ".repeat(200),
        source: `big-${i}.md`,
        relevance: 0.9 - i * 0.01,
        engine: "fts5",
      }));
      const output = formatL2(bigResults);
      const tokens = roughTokenCount(output);
      // Should be around 2000 tokens, not 4000+
      assert.ok(tokens <= 2100, `L2 output was ${tokens} tokens, expected <= 2100`);
    });

    it("returns empty string for empty results", () => {
      assert.equal(formatL2([]), "");
      assert.equal(formatL2(null), "");
    });
  });

  describe("parseFullSuffix", () => {
    it("detects --full suffix and returns L2 tier", () => {
      const result = parseFullSuffix("search query --full", "L1");
      assert.equal(result.query, "search query");
      assert.equal(result.tier, "L2");
    });

    it("returns default tier when no --full suffix", () => {
      const result = parseFullSuffix("search query", "L1");
      assert.equal(result.query, "search query");
      assert.equal(result.tier, "L1");
    });

    it("handles --full with extra whitespace in query", () => {
      const result = parseFullSuffix("search query  --full", "L1");
      assert.equal(result.query, "search query");
      assert.equal(result.tier, "L2");
    });

    it("does not match --full in middle of query", () => {
      const result = parseFullSuffix("search --full query", "L1");
      assert.equal(result.query, "search --full query");
      assert.equal(result.tier, "L1");
    });
  });
});
