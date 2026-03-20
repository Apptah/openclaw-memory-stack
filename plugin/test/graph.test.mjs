import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEntities, mergeIntoGraph, queryGraph } from "../lib/graph/store.mjs";
import { multiHopQuery, extractEvolutionEdges, getEvolutionTimeline, detectCommunities, rankByPageRank, EVOLUTION_PATTERNS, invalidateGraphCache } from "../lib/graph/algorithms.mjs";

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

describe("graph/algorithms", () => {
  const testGraph = {
    entities: { A: { name: "A", mentions: 3 }, B: { name: "B", mentions: 2 }, C: { name: "C", mentions: 1 }, D: { name: "D", mentions: 1 } },
    edges: [
      { from: "A", to: "B", type: "RELATES", context: "A uses B" },
      { from: "B", to: "C", type: "RELATES", context: "B calls C" },
      { from: "C", to: "D", type: "EVOLVES", context: "renamed C to D", timestamp: "2026-03-01T00:00:00Z" },
    ],
  };

  it("multiHopQuery BFS depth 1 returns direct neighbors", () => {
    invalidateGraphCache();
    const result = multiHopQuery(testGraph, "A", 1, 50);
    assert.ok(result.paths.length > 0);
    assert.ok(result.nodesVisited >= 1);
    assert.equal(result.truncated, false);
  });

  it("multiHopQuery BFS depth 2 reaches 2-hop neighbors", () => {
    const result = multiHopQuery(testGraph, "A", 2, 50);
    const allEntities = new Set(result.paths.flatMap(p => p.entities));
    assert.ok(allEntities.has("B"));
    assert.ok(allEntities.has("C"));
  });

  it("multiHopQuery respects maxNodes cap", () => {
    const result = multiHopQuery(testGraph, "A", 10, 2);
    assert.equal(result.truncated, true);
    assert.ok(result.nodesVisited <= 2);
  });

  it("EVOLUTION_PATTERNS match expected strings", () => {
    assert.ok(EVOLUTION_PATTERNS.some(p => p.pattern.test("replaced foo with bar")));
    assert.ok(EVOLUTION_PATTERNS.some(p => p.pattern.test("upgraded from v1 to v2")));
    assert.ok(EVOLUTION_PATTERNS.some(p => p.pattern.test("renamed OldName to NewName")));
    assert.ok(EVOLUTION_PATTERNS.some(p => p.pattern.test("migrated from MySQL to Postgres")));
    assert.ok(EVOLUTION_PATTERNS.some(p => p.pattern.test("deprecated X in favor of Y")));
  });

  it("extractEvolutionEdges from text", () => {
    const edges = extractEvolutionEdges("We replaced AuthV1 with AuthV2 last week");
    assert.ok(edges.length >= 1);
    assert.equal(edges[0].type, "EVOLVES");
    assert.equal(edges[0].from, "AuthV1");
    assert.equal(edges[0].to, "AuthV2");
  });

  it("getEvolutionTimeline returns chronological EVOLVES edges", () => {
    const timeline = getEvolutionTimeline(testGraph, "C");
    assert.ok(timeline.length >= 1);
    assert.equal(timeline[0].type, "EVOLVES");
  });

  it("detectCommunities groups connected nodes", () => {
    invalidateGraphCache();
    const communities = detectCommunities(testGraph);
    assert.ok(Array.isArray(communities));
    assert.ok(communities.some(c => c.members.length >= 2));
  });

  it("rankByPageRank returns sorted scores", () => {
    invalidateGraphCache();
    const ranked = rankByPageRank(testGraph);
    assert.ok(Array.isArray(ranked));
    assert.ok(ranked.length > 0);
    assert.equal(typeof ranked[0].score, "number");
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1].score >= ranked[i].score);
    }
  });

  it("cache invalidation works", () => {
    invalidateGraphCache();
    const c1 = detectCommunities(testGraph);
    const c2 = detectCommunities(testGraph);
    assert.deepStrictEqual(c1, c2); // same from cache
    invalidateGraphCache();
    const c3 = detectCommunities(testGraph);
    assert.ok(Array.isArray(c3)); // still works after invalidation
  });
});
