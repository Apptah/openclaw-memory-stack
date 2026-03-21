import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("llm provider chain (Step 3.4)", () => {
  it("exports all required functions", async () => {
    const m = await import("../lib/llm.mjs");
    assert.equal(typeof m.llmAvailable, "function");
    assert.equal(typeof m.llmProvider, "function");
    assert.equal(typeof m.llmGenerate, "function");
    assert.equal(typeof m.llmEmbed, "function");
    assert.equal(typeof m.resetProviderCache, "function");
  });

  it("llmProvider returns string or null", async () => {
    const { llmProvider } = await import("../lib/llm.mjs");
    const provider = await llmProvider();
    assert.ok(
      provider === null || provider === "mlx" || provider === "ollama" || provider === "openai",
      `expected valid provider or null, got: ${provider}`
    );
  });

  it("llmAvailable returns boolean", async () => {
    const { llmAvailable } = await import("../lib/llm.mjs");
    const result = await llmAvailable();
    assert.equal(typeof result, "boolean");
  });

  it("llmGenerate returns null when no provider", async () => {
    const { llmGenerate, llmProvider } = await import("../lib/llm.mjs");
    const provider = await llmProvider();
    if (provider === null) {
      const result = await llmGenerate("test");
      assert.equal(result, null);
    }
  });

  it("llmEmbed returns null when no provider", async () => {
    const { llmEmbed, llmProvider } = await import("../lib/llm.mjs");
    const provider = await llmProvider();
    if (provider === null) {
      const result = await llmEmbed("test");
      assert.equal(result, null);
    }
  });
});

describe("embedding cache (Step 3.5)", () => {
  it("getEmbedding returns null when no LLM available", async () => {
    const { getEmbedding, embeddingCacheSize } = await import("../lib/quality.mjs");
    const { llmProvider } = await import("../lib/llm.mjs");
    const provider = await llmProvider();
    if (provider === null) {
      const result = await getEmbedding("test text");
      assert.equal(result, null);
      assert.equal(embeddingCacheSize(), 0);
    }
  });

  it("applyCosineDedup skips when no LLM available", async () => {
    const { applyCosineDedup } = await import("../lib/quality.mjs");
    const { llmProvider } = await import("../lib/llm.mjs");
    const provider = await llmProvider();
    if (provider === null) {
      const results = [
        { content: "alpha", relevance: 0.9 },
        { content: "beta", relevance: 0.8 },
      ];
      const { results: out, cosineDedupUsed } = await applyCosineDedup(results);
      assert.equal(cosineDedupUsed, false);
      assert.equal(out.length, 2);
    }
  });
});

describe("A-MEM linking (Step 3.6)", () => {
  it("exports amemLink function", async () => {
    const m = await import("../lib/graph/algorithms.mjs");
    assert.equal(typeof m.amemLink, "function");
  });

  it("returns RELATES edge for same entity pair with different context", async () => {
    const { amemLink } = await import("../lib/graph/algorithms.mjs");
    const extraction = {
      entities: new Map([["Redis", { name: "Redis", type: "data", mentions: 1 }]]),
      edges: [{ from: "Redis", to: "Cache", context: "Redis used for caching" }],
    };
    const graph = {
      entities: { Redis: { name: "Redis", type: "project", mentions: 3 } },
      edges: [{ from: "Redis", to: "Cache", context: "Redis stores session data" }],
    };
    const links = amemLink(extraction, graph);
    // Should get RELATES (same pair, different context) and SUPERSEDES (type changed)
    const relatesEdges = links.filter(e => e.type === "RELATES");
    const supersedesEdges = links.filter(e => e.type === "SUPERSEDES");
    assert.ok(relatesEdges.length >= 1, "should have at least 1 RELATES edge");
    assert.ok(supersedesEdges.length >= 1, "should have at least 1 SUPERSEDES edge");
    assert.equal(relatesEdges[0].from, "Redis");
    assert.equal(relatesEdges[0].to, "Cache");
    assert.ok(relatesEdges[0].context.includes("New:"));
    assert.ok(relatesEdges[0].context.includes("Prior:"));
    assert.ok(supersedesEdges[0].context.includes("data"));
    assert.ok(supersedesEdges[0].context.includes("project"));
  });

  it("returns empty array when no overlapping entities", async () => {
    const { amemLink } = await import("../lib/graph/algorithms.mjs");
    const extraction = {
      entities: new Map([["NewThing", { name: "NewThing", type: "entity", mentions: 1 }]]),
      edges: [],
    };
    const graph = {
      entities: { OldThing: { name: "OldThing", type: "entity", mentions: 2 } },
      edges: [],
    };
    const links = amemLink(extraction, graph);
    assert.equal(links.length, 0);
  });

  it("returns SUPERSEDES when entity type changes", async () => {
    const { amemLink } = await import("../lib/graph/algorithms.mjs");
    const extraction = {
      entities: new Map([["Auth", { name: "Auth", type: "api", mentions: 1 }]]),
      edges: [],
    };
    const graph = {
      entities: { Auth: { name: "Auth", type: "code", mentions: 5 } },
      edges: [],
    };
    const links = amemLink(extraction, graph);
    assert.equal(links.length, 1);
    assert.equal(links[0].type, "SUPERSEDES");
    assert.equal(links[0].from, "Auth");
    assert.equal(links[0].to, "Auth");
  });
});
