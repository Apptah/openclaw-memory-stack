import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEntities, mergeIntoGraph, queryGraph } from "../lib/graph/store.mjs";

describe("graph/store", () => {
  it("extractEntities finds project entities", () => {
    const text = "The project Alpha uses database UserDB";
    const { entities } = extractEntities(text);
    assert.ok(entities.has("Alpha"));
    assert.ok(entities.has("UserDB"));
  });

  it("extractEntities finds relationship edges", () => {
    const text = "AuthService calls UserDB";
    const { edges } = extractEntities(text);
    assert.ok(edges.length > 0);
    assert.equal(edges[0].from, "AuthService");
    assert.equal(edges[0].to, "UserDB");
  });

  it("mergeIntoGraph adds entities and dedupes edges", () => {
    const graph = { entities: {}, edges: [] };
    const extracted = {
      entities: new Map([["Alpha", { name: "Alpha", type: "project", mentions: 1 }]]),
      edges: [{ from: "A", to: "B", context: "test" }],
    };
    mergeIntoGraph(graph, extracted);
    assert.ok(graph.entities["Alpha"]);
    assert.equal(graph.edges.length, 1);
    mergeIntoGraph(graph, extracted);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.entities["Alpha"].mentions, 2);
  });

  it("mergeIntoGraph adds timestamp and type to new edges", () => {
    const graph = { entities: {}, edges: [] };
    const extracted = {
      entities: new Map(),
      edges: [{ from: "A", to: "B", context: "test" }],
    };
    mergeIntoGraph(graph, extracted);
    assert.ok(graph.edges[0].timestamp);
    assert.equal(graph.edges[0].type, "RELATES");
  });

  it("legacy edges without type treated as RELATES in queryGraph", () => {
    const graph = {
      entities: { AuthService: { name: "AuthService", type: "project", mentions: 1 } },
      edges: [{ from: "AuthService", to: "UserDB", context: "old" }],
    };
    const results = queryGraph(graph, "AuthService", 5);
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
    assert.ok(results[0].content.includes("RELATES"));
  });

  it("queryGraph returns empty for no matches", () => {
    const graph = { entities: { Alpha: { name: "Alpha", mentions: 1 } }, edges: [] };
    const results = queryGraph(graph, "zzzznotfound", 5);
    assert.equal(results.length, 0);
  });
});
