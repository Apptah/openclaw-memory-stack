import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEntities, extractFacts, extractAll } from "../lib/extract.mjs";

describe("extract", () => {
  describe("extractEntities", () => {
    it("finds capitalized multi-word names", () => {
      const text = "We spoke with John Smith about the project.";
      const { entities } = extractEntities(text);
      assert.ok(entities.has("john smith"), "should find 'John Smith' (lowercase key)");
      assert.equal(entities.get("john smith").name, "John Smith");
    });

    it("finds project/service entities", () => {
      const text = "The project Alpha uses database UserDB";
      const { entities } = extractEntities(text);
      assert.ok(entities.has("Alpha"), "should find project Alpha");
      assert.ok(entities.has("UserDB"), "should find database UserDB");
    });

    it("finds code entities", () => {
      const text = "The function processData handles all transformations";
      const { entities } = extractEntities(text);
      assert.ok(entities.has("processData"), "should find function processData");
    });

    it("finds relationship edges", () => {
      const text = "AuthService calls UserDB";
      const { edges } = extractEntities(text);
      assert.ok(edges.length > 0, "should find at least one edge");
      assert.equal(edges[0].from, "AuthService");
      assert.equal(edges[0].to, "UserDB");
    });

    it("finds arrow-style relationships", () => {
      const text = "Frontend -> Backend";
      const { edges } = extractEntities(text);
      assert.ok(edges.length > 0, "should find arrow relationship");
      assert.equal(edges[0].from, "Frontend");
      assert.equal(edges[0].to, "Backend");
    });

    it("increments mentions on duplicates", () => {
      const text = "project Alpha is great.\nproject Alpha is reliable.";
      const { entities } = extractEntities(text);
      assert.ok(entities.has("Alpha"));
      assert.ok(entities.get("Alpha").mentions >= 2, "mentions should be >= 2");
    });

    it("skips very short entity names", () => {
      const text = "project X uses database Y";
      const { entities } = extractEntities(text);
      assert.ok(!entities.has("X"), "single-char name should be skipped");
    });
  });

  describe("extractFacts", () => {
    it("extracts decision facts", () => {
      const { facts } = extractFacts("We decided to use PostgreSQL for the new service.");
      assert.ok(facts.some(f => f.type === "decision"), "should find decision");
      assert.ok(facts[0].confidence >= 0.8);
    });

    it("extracts deadline facts", () => {
      const { facts } = extractFacts("The deadline is March 25 for the MVP launch.");
      assert.ok(facts.some(f => f.type === "deadline"), "should find deadline");
      assert.ok(facts[0].confidence >= 0.9);
    });

    it("extracts requirement facts", () => {
      const { facts } = extractFacts("The system must support at least 1000 concurrent connections.");
      assert.ok(facts.some(f => f.type === "requirement"), "should find requirement");
    });

    it("extracts entity facts", () => {
      const { facts } = extractFacts("The client Acme requested the new feature.");
      assert.ok(facts.some(f => f.type === "entity"), "should find entity fact");
    });

    it("deduplicates facts", () => {
      const text = "We decided to use Redis.\nWe decided to use Redis.\nWe decided to use Redis.";
      const { facts } = extractFacts(text);
      assert.ok(facts.length <= 2, "should deduplicate identical facts");
    });

    it("respects types filter", () => {
      const text = "We decided to use Redis.\nThe deadline is March 25.";
      const { facts } = extractFacts(text, { types: ["deadline"] });
      assert.ok(facts.every(f => f.type === "deadline"), "should only return deadline facts");
    });
  });

  describe("extractAll", () => {
    it("returns both entities and facts", () => {
      const text = "We decided to use project Alpha.\nAuthService calls UserDB.";
      const result = extractAll(text);
      assert.ok(result.entities instanceof Map, "should have entities Map");
      assert.ok(Array.isArray(result.edges), "should have edges array");
      assert.ok(Array.isArray(result.facts), "should have facts array");
      assert.ok(result.entities.size > 0, "should find entities");
      assert.ok(result.facts.length > 0, "should find facts");
    });

    it("finds edges and facts together", () => {
      const text = "We decided that AuthService calls UserDB for authentication.";
      const result = extractAll(text);
      assert.ok(result.edges.length > 0, "should find edges");
      assert.ok(result.facts.length > 0, "should find decision fact");
    });
  });
});
