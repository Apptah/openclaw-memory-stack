// ─── Cache ───────────────────────────────────────────────────────

let cache = null;

export function invalidateGraphCache() {
  cache = null;
}

// ─── Evolution Patterns (Gap 7) ──────────────────────────────────

export const EVOLUTION_PATTERNS = [
  { pattern: /replaced\s+(\S+)\s+with\s+(\S+)/i, type: "EVOLVES" },
  { pattern: /upgraded\s+(?:from\s+)?(\S+)\s+to\s+(\S+)/i, type: "EVOLVES" },
  { pattern: /renamed\s+(\S+)\s+to\s+(\S+)/i, type: "EVOLVES" },
  { pattern: /migrated\s+(?:from\s+)?(\S+)\s+to\s+(\S+)/i, type: "EVOLVES" },
  { pattern: /deprecated\s+(\S+)\s+in\s+favor\s+of\s+(\S+)/i, type: "EVOLVES" },
];

export function extractEvolutionEdges(text) {
  const edges = [];
  const lines = text.split("\n");
  for (const line of lines) {
    for (const { pattern, type } of EVOLUTION_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) {
        edges.push({
          from: match[1],
          to: match[2],
          type,
          timestamp: new Date().toISOString(),
          context: line.trim().slice(0, 120),
        });
      }
    }
  }
  return edges;
}

export function getEvolutionTimeline(graph, entityName) {
  return graph.edges
    .filter(e => e.type === "EVOLVES" && (e.from === entityName || e.to === entityName))
    .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
}

// ─── Multi-hop BFS (Gap 8) ──────────────────────────────────────

export function multiHopQuery(graph, startEntity, depth = 2, maxNodes = 50) {
  const visited = new Set();
  const queue = [{ entity: startEntity, depth: 0, path: [startEntity] }];
  const paths = [];

  // Build adjacency list
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push({ target: edge.to, edge });
    adjacency.get(edge.to).push({ target: edge.from, edge });
  }

  while (queue.length > 0 && visited.size < maxNodes) {
    const { entity, depth: d, path } = queue.shift();
    if (visited.has(entity)) continue;
    visited.add(entity);

    if (d > 0) {
      paths.push({ entities: [...path], depth: d });
    }

    if (d >= depth) continue;

    const neighbors = adjacency.get(entity) || [];
    for (const { target, edge } of neighbors) {
      if (!visited.has(target)) {
        queue.push({ entity: target, depth: d + 1, path: [...path, target] });
      }
    }
  }

  return {
    paths,
    nodesVisited: visited.size,
    truncated: visited.size >= maxNodes,
  };
}

// ─── Community Detection (Gap 9) ────────────────────────────────

function buildAdjacencyList(graph) {
  const adj = new Map();
  const allNodes = new Set(Object.keys(graph.entities));
  for (const edge of graph.edges) {
    allNodes.add(edge.from);
    allNodes.add(edge.to);
  }
  for (const node of allNodes) adj.set(node, new Set());
  for (const edge of graph.edges) {
    adj.get(edge.from).add(edge.to);
    adj.get(edge.to).add(edge.from);
  }
  return { adj, nodes: [...allNodes] };
}

export function detectCommunities(graph) {
  if (cache?.communities) return cache.communities;

  const { adj, nodes } = buildAdjacencyList(graph);
  if (nodes.length === 0) return [];

  const totalEdges = graph.edges.length;
  if (totalEdges === 0) {
    const result = nodes.map(n => ({ name: n, members: [n], density: 0, modularity: 0 }));
    cache = cache || {};
    cache.communities = result;
    return result;
  }

  // Initialize: each node in its own community
  const community = new Map();
  nodes.forEach((n, i) => community.set(n, i));

  // Greedy modularity optimization
  let improved = true;
  let iterations = 0;
  const maxIterations = 50;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    for (const node of nodes) {
      const currentComm = community.get(node);
      const neighbors = adj.get(node) || new Set();

      // Count edges to each neighbor community
      const commEdges = new Map();
      for (const neighbor of neighbors) {
        const nc = community.get(neighbor);
        commEdges.set(nc, (commEdges.get(nc) || 0) + 1);
      }

      // Try moving to best neighbor community
      let bestComm = currentComm;
      let bestGain = 0;

      for (const [comm, edgeCount] of commEdges) {
        if (comm === currentComm) continue;
        // Simplified modularity gain: more edges to target community = better
        const gain = edgeCount;
        if (gain > bestGain) {
          bestGain = gain;
          bestComm = comm;
        }
      }

      if (bestComm !== currentComm && bestGain > 0) {
        community.set(node, bestComm);
        improved = true;
      }
    }
  }

  // Group by community
  const groups = new Map();
  for (const [node, comm] of community) {
    if (!groups.has(comm)) groups.set(comm, []);
    groups.get(comm).push(node);
  }

  const result = [];
  for (const [, members] of groups) {
    // Density: internal edges / possible edges
    let internalEdges = 0;
    for (const m of members) {
      for (const n of (adj.get(m) || new Set())) {
        if (members.includes(n)) internalEdges++;
      }
    }
    internalEdges /= 2; // undirected
    const possibleEdges = (members.length * (members.length - 1)) / 2;
    const density = possibleEdges > 0 ? internalEdges / possibleEdges : 0;

    result.push({
      name: `community-${result.length + 1}`,
      members,
      density: Math.round(density * 100) / 100,
      modularity: Math.round((internalEdges / Math.max(totalEdges, 1)) * 100) / 100,
    });
  }

  const sorted = result.sort((a, b) => b.members.length - a.members.length);
  cache = cache || {};
  cache.communities = sorted;
  return sorted;
}

// ─── PageRank (Gap 9) ────────────────────────────────────────────

export function rankByPageRank(graph, iterations = 20, damping = 0.85) {
  if (cache?.pageRank) return cache.pageRank;

  const { adj, nodes } = buildAdjacencyList(graph);
  if (nodes.length === 0) return [];

  const n = nodes.length;
  const rank = new Map();
  const initial = 1 / n;
  for (const node of nodes) rank.set(node, initial);

  for (let iter = 0; iter < iterations; iter++) {
    const newRank = new Map();
    for (const node of nodes) {
      let sum = 0;
      const neighbors = adj.get(node) || new Set();
      for (const neighbor of neighbors) {
        const outDegree = (adj.get(neighbor) || new Set()).size;
        if (outDegree > 0) {
          sum += rank.get(neighbor) / outDegree;
        }
      }
      newRank.set(node, (1 - damping) / n + damping * sum);
    }
    for (const [node, score] of newRank) rank.set(node, score);
  }

  const result = nodes
    .map(entity => ({ entity, score: Math.round(rank.get(entity) * 10000) / 10000 }))
    .sort((a, b) => b.score - a.score);

  cache = cache || {};
  cache.pageRank = result;
  return result;
}
