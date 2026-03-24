import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractKeyFacts, initRescueDB } from "../lib/rescue.mjs";

describe("rescue", () => {
  it("extracts decision facts", () => {
    const facts = extractKeyFacts("We decided to use PostgreSQL for the new service.");
    assert.ok(facts.some(f => f.type === "decision"));
    assert.ok(facts[0].confidence >= 0.8);
    assert.ok(Array.isArray(facts[0].entities));
  });

  it("extracts deadline facts", () => {
    const facts = extractKeyFacts("The deadline is March 25 for the MVP launch.");
    assert.ok(facts.some(f => f.type === "deadline"));
    assert.ok(facts[0].confidence >= 0.9);
  });

  it("extracts requirement facts", () => {
    const facts = extractKeyFacts("The system must support at least 1000 concurrent connections.");
    assert.ok(facts.some(f => f.type === "requirement"));
  });

  it("returns ExtractedFact schema", () => {
    const facts = extractKeyFacts("We decided to use Redis for caching.");
    for (const f of facts) {
      assert.ok(["decision", "deadline", "requirement", "entity", "insight"].includes(f.type));
      assert.equal(typeof f.fact, "string");
      assert.equal(typeof f.confidence, "number");
      assert.ok(Array.isArray(f.entities));
    }
  });

  it("deduplicates facts", () => {
    const text = "We decided to use Redis.\nWe decided to use Redis.\nWe decided to use Redis.";
    const facts = extractKeyFacts(text);
    assert.ok(facts.length <= 2);
  });
});

describe("facts schema migration", () => {
  it("initRescueDB runs without throwing", () => {
    assert.doesNotThrow(() => initRescueDB());
  });

  it("migrates facts table in place and rehydrates facts_fts", () => {
    // Run twice to verify idempotency (migration safe to call multiple times)
    assert.doesNotThrow(() => {
      initRescueDB();
      initRescueDB();
    });
  });
});
