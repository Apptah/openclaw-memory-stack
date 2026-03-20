import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { GRAPH_PATH } from "../constants.mjs";

export function loadGraph() {
  try {
    if (existsSync(GRAPH_PATH)) {
      return JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
    }
  } catch { /* corrupted file, start fresh */ }
  return { entities: {}, edges: [] };
}

export function saveGraph(graph) {
  const dir = resolve(GRAPH_PATH, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2));
}

export function extractEntities(text) {
  const entities = new Map();
  const edges = [];

  // Standalone capitalized multi-word names
  const standaloneNames = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  for (const name of standaloneNames) {
    if (name.length < 3 || name.length > 60) continue;
    const key = name.toLowerCase();
    if (!entities.has(key)) entities.set(key, { name, type: "entity", mentions: 0 });
    entities.get(key).mentions++;
  }

  const lines = text.split("\n").filter(l => l.trim());

  const entityPatterns = [
    { pattern: /\b(project|app|service|system)\s+([A-Z][A-Za-z0-9_-]+)/g, type: "project" },
    { pattern: /\b(api|endpoint)\s+([/A-Za-z0-9._-]+)/g, type: "api" },
    { pattern: /\b(function|method|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g, type: "code" },
    { pattern: /\b(client|customer|team)\s+([A-Z][A-Za-z0-9_-]+)/g, type: "person" },
    { pattern: /\b(database|table|collection)\s+([A-Za-z_][A-Za-z0-9_-]*)/g, type: "data" },
    { pattern: /\b(file|module)\s+([A-Za-z0-9_./-]+)/g, type: "file" },
  ];

  for (const line of lines) {
    for (const { pattern, type } of entityPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const name = match[2];
        if (name.length < 2) continue;
        const existing = entities.get(name);
        if (existing) {
          existing.mentions = (existing.mentions || 1) + 1;
        } else {
          entities.set(name, { name, type, mentions: 1 });
        }
      }
    }

    const relPatterns = [
      /([A-Za-z_][A-Za-z0-9_-]*)\s+(?:uses|calls|imports|requires|depends on|connects to)\s+([A-Za-z_][A-Za-z0-9_-]*)/gi,
      /([A-Za-z_][A-Za-z0-9_-]*)\s*(?:→|->|=>)\s*([A-Za-z_][A-Za-z0-9_-]*)/g,
    ];

    for (const rp of relPatterns) {
      rp.lastIndex = 0;
      let match;
      while ((match = rp.exec(line)) !== null) {
        const from = match[1];
        const to = match[2];
        if (from.length >= 2 && to.length >= 2 && from !== to) {
          edges.push({ from, to, context: line.trim().slice(0, 120) });
        }
      }
    }
  }

  return { entities, edges };
}

export function mergeIntoGraph(graph, extracted) {
  for (const [name, entity] of extracted.entities) {
    if (graph.entities[name]) {
      graph.entities[name].mentions = (graph.entities[name].mentions || 1) + (entity.mentions || 1);
      if (!graph.entities[name].type && entity.type) {
        graph.entities[name].type = entity.type;
      }
    } else {
      graph.entities[name] = { ...entity };
    }
  }

  const existingEdgeKeys = new Set(
    graph.edges.map(e => `${e.from}|||${e.to}`)
  );

  for (const edge of extracted.edges) {
    const key = `${edge.from}|||${edge.to}`;
    if (!existingEdgeKeys.has(key)) {
      graph.edges.push({
        ...edge,
        type: edge.type || "RELATES",
        timestamp: edge.timestamp || new Date().toISOString(),
      });
      existingEdgeKeys.add(key);
    }
  }

  if (graph.edges.length > 500) {
    graph.edges = graph.edges.slice(-500);
  }
}

export function queryGraph(graph, query, maxResults = 10) {
  const entityNames = Object.keys(graph.entities);
  if (entityNames.length === 0) return [];

  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return [];

  const scored = [];

  for (const name of entityNames) {
    const entity = graph.entities[name];
    const nameLower = name.toLowerCase();
    const matchCount = words.filter(w => nameLower.includes(w)).length;
    if (matchCount === 0) continue;

    const relatedEdges = graph.edges.filter(
      e => e.from === name || e.to === name
    );

    let content = `[Entity] ${name} (${entity.type || "unknown"}, mentions: ${entity.mentions || 1})`;
    if (relatedEdges.length > 0) {
      const edgeDescriptions = relatedEdges.slice(0, 5).map(e => {
        const edgeType = e.type || "RELATES";
        return e.from === name ? `${name} -[${edgeType}]-> ${e.to}` : `${e.from} -[${edgeType}]-> ${name}`;
      });
      content += `\nRelationships: ${edgeDescriptions.join(", ")}`;
    }

    scored.push({
      content,
      source: "knowledge-graph",
      relevance: Math.min(1, 0.4 + matchCount * 0.15 + (entity.mentions || 1) * 0.05),
      engine: "graph",
    });
  }

  return scored
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxResults);
}

// Placeholder — will be replaced by algorithms.mjs invalidation hook
export function invalidateGraphCache() {}
