# Memory Stack v3 — Complete Feature Parity + Differentiation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Memory Stack definitively better than OpenClaw native memory by adding MMR, temporal decay, knowledge graph, self-evolving memory, and session indexing — all in one plugin file.

**Architecture:** All features are added to the existing `plugin/index.mjs` as pure JavaScript functions. Cognee and A-MEM concepts are reimplemented as lightweight local algorithms (no Python dependencies in the plugin). The plugin remains a single `.mjs` file with zero npm dependencies.

**Tech Stack:** JavaScript (ES modules), SQLite3 CLI, QMD CLI, JSON file storage

---

## Task 1: MMR Reranking (P0 — can't be worse than native)

Maximal Marginal Relevance: re-ranks search results to balance relevance and diversity. Native OpenClaw has this; we don't.

**Files:**
- Modify: `plugin/index.mjs` — add `applyMMR()` function, integrate into `combinedSearch()`

- [ ] **Step 1: Add MMR function after `combinedSearch`**

Add this function before the plugin registration block:

```javascript
/**
 * MMR (Maximal Marginal Relevance) — balances relevance vs diversity.
 * lambda=1.0 → pure relevance, lambda=0.0 → max diversity.
 * Uses Jaccard similarity on word sets as a lightweight proxy for
 * cosine similarity (no embeddings needed).
 */
function applyMMR(results, lambda, maxResults) {
  if (results.length <= 1) return results;
  lambda = lambda ?? 0.7;

  function wordSet(text) {
    return new Set((text || "").toLowerCase().split(/\s+/).filter(w => w.length > 2));
  }
  function jaccard(a, b) {
    const inter = [...a].filter(x => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 0 : inter / union;
  }

  const selected = [results[0]];
  const remaining = results.slice(1);
  const selectedWords = [wordSet(results[0].content)];

  while (selected.length < maxResults && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidateWords = wordSet(remaining[i].content);
      const relevance = remaining[i].relevance || 0;
      // Max similarity to any already-selected result
      const maxSim = Math.max(...selectedWords.map(sw => jaccard(candidateWords, sw)));
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    selected.push(remaining[bestIdx]);
    selectedWords.push(wordSet(remaining[bestIdx].content));
    remaining.splice(bestIdx, 1);
  }

  return selected;
}
```

- [ ] **Step 2: Integrate MMR into combinedSearch**

In `combinedSearch()`, after deduping and before token budgeting, apply MMR:

Replace the line `// Token budget` section with:

```javascript
  // Apply MMR reranking for diversity
  const mmrLambda = 0.7; // configurable later
  const mmrResults = applyMMR(deduped, mmrLambda, maxResults);

  // Token budget
  const charBudget = maxTokens * 4;
```

And change the token budget loop to iterate over `mmrResults` instead of `deduped`.

- [ ] **Step 3: Add MMR lambda to plugin config**

In `register()`, read from config:
```javascript
const mmrLambda = cfg.mmrLambda ?? 0.7;
```

Pass it to `combinedSearch` and through to `applyMMR`.

- [ ] **Step 4: Test — search should return diverse results**

Deploy to extensions, restart gateway, test with:
```
搜尋記憶：project deadline
```
Verify results are diverse (not all from same source).

- [ ] **Step 5: Commit**

```bash
git add plugin/index.mjs
git commit -m "feat: add MMR reranking for search result diversity"
```

---

## Task 2: Temporal Decay (P0 — can't be worse than native)

Recent memories should rank higher than old ones. Native has `halfLifeDays` decay.

**Files:**
- Modify: `plugin/index.mjs` — add `applyTemporalDecay()`, integrate into search

- [ ] **Step 1: Add temporal decay function**

```javascript
/**
 * Temporal decay — exponential multiplier based on age.
 * halfLifeDays=30 means a 30-day-old memory gets 50% weight.
 * Evergreen sources (MEMORY.md) are exempt.
 */
function applyTemporalDecay(results, halfLifeDays) {
  if (!halfLifeDays || halfLifeDays <= 0) return results;
  const now = Date.now();
  const decayRate = Math.LN2 / (halfLifeDays * 86400000);

  return results.map(r => {
    // Evergreen: MEMORY.md and rescue store don't decay
    if (r.source === "MEMORY.md" || (r.source || "").startsWith("rescue:")) return r;

    // Extract date from path (memory/YYYY-MM-DD.md)
    const dateMatch = (r.source || "").match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return r; // No date → no decay

    const age = now - new Date(dateMatch[1]).getTime();
    if (age < 0) return r; // Future date → no decay
    const decayMultiplier = Math.exp(-decayRate * age);
    const floor = 0.2; // Never decay below 20%

    return { ...r, relevance: (r.relevance || 0) * Math.max(floor, decayMultiplier) };
  });
}
```

- [ ] **Step 2: Integrate into combinedSearch before MMR**

After merge + sort + dedupe, before MMR:
```javascript
  // Apply temporal decay
  const decayed = applyTemporalDecay(deduped, halfLifeDays);
  // Re-sort after decay
  decayed.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
  // Apply MMR
  const mmrResults = applyMMR(decayed, mmrLambda, maxResults);
```

- [ ] **Step 3: Add halfLifeDays to config**

```javascript
const halfLifeDays = cfg.halfLifeDays ?? 30;
```

- [ ] **Step 4: Test and commit**

```bash
git add plugin/index.mjs
git commit -m "feat: add temporal decay for time-aware memory ranking"
```

---

## Task 3: Knowledge Graph (P1 — biggest differentiator)

Lightweight local knowledge graph that tracks relationships between entities. No Cognee/Kuzu Python dependency — pure JS + JSON storage.

**Files:**
- Modify: `plugin/index.mjs` — add graph storage, extraction, and query functions
- Create: `~/.openclaw/memory-stack/graph.json` at runtime (auto-created)

- [ ] **Step 1: Add graph storage functions**

```javascript
const GRAPH_PATH = resolve(HOME, ".openclaw/memory-stack/graph.json");

function loadGraph() {
  if (!existsSync(GRAPH_PATH)) return { entities: {}, edges: [] };
  try { return JSON.parse(readFileSync(GRAPH_PATH, "utf-8")); }
  catch { return { entities: {}, edges: [] }; }
}

function saveGraph(graph) {
  mkdirSync(resolve(HOME, ".openclaw/memory-stack"), { recursive: true });
  writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2));
}
```

- [ ] **Step 2: Add entity extraction (regex-based, no LLM)**

```javascript
/**
 * Extract entities and relationships from text.
 * Pattern-based: finds "X uses/calls/depends on/connects to Y" patterns.
 */
function extractEntities(text) {
  const entities = new Map(); // name → { type, mentions }
  const edges = [];

  // Entity patterns
  const patterns = [
    { re: /\b(project|app|service|system)\s+([A-Z][A-Za-z0-9_-]+)/gi, type: "project" },
    { re: /\b(api|endpoint)\s+([\/\w.-]+)/gi, type: "api" },
    { re: /\b(function|method|class)\s+([A-Za-z_]\w+)/gi, type: "code" },
    { re: /\b(client|customer|team|person)\s+([A-Z][A-Za-z\s]+?)(?=[,.\n])/gi, type: "person" },
    { re: /\b(database|table|collection)\s+([A-Za-z_]\w+)/gi, type: "data" },
    { re: /\b(file|module)\s+([A-Za-z_][\w./]+)/gi, type: "file" },
  ];

  for (const { re, type } of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[2].trim();
      if (name.length < 2 || name.length > 60) continue;
      const key = name.toLowerCase();
      if (!entities.has(key)) entities.set(key, { name, type, mentions: 0 });
      entities.get(key).mentions++;
    }
  }

  // Relationship patterns: "X uses/calls/depends Y"
  const relPatterns = [
    { re: /([A-Z]\w+)\s+(uses|calls|imports|requires|depends on|connects to|sends to)\s+([A-Z]\w+)/gi, rel: "$2" },
    { re: /([A-Z]\w+)\s+(→|->|=>)\s+([A-Z]\w+)/g, rel: "connects" },
  ];

  for (const { re, rel } of relPatterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      edges.push({
        from: m[1].toLowerCase(),
        to: m[3].toLowerCase(),
        relation: rel === "$2" ? m[2].toLowerCase() : rel,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return { entities: Object.fromEntries(entities), edges };
}
```

- [ ] **Step 3: Add graph merge function**

```javascript
function mergeIntoGraph(graph, extracted) {
  // Merge entities
  for (const [key, entity] of Object.entries(extracted.entities)) {
    if (graph.entities[key]) {
      graph.entities[key].mentions += entity.mentions;
    } else {
      graph.entities[key] = { ...entity, addedAt: new Date().toISOString() };
    }
  }
  // Add edges (dedupe by from+to+relation)
  const edgeKeys = new Set(graph.edges.map(e => `${e.from}|${e.to}|${e.relation}`));
  for (const edge of extracted.edges) {
    const key = `${edge.from}|${edge.to}|${edge.relation}`;
    if (!edgeKeys.has(key)) {
      graph.edges.push(edge);
      edgeKeys.add(key);
    }
  }
  // Cap edges at 500 (remove oldest)
  if (graph.edges.length > 500) {
    graph.edges = graph.edges.slice(-500);
  }
  return graph;
}
```

- [ ] **Step 4: Add graph query function**

```javascript
function queryGraph(query, maxResults) {
  const graph = loadGraph();
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const results = [];

  // Find matching entities
  for (const [key, entity] of Object.entries(graph.entities)) {
    const matchCount = words.filter(w => key.includes(w) || (entity.name || "").toLowerCase().includes(w)).length;
    if (matchCount > 0) {
      // Find edges involving this entity
      const relatedEdges = graph.edges.filter(e => e.from === key || e.to === key);
      let content = `Entity: ${entity.name} (${entity.type}, ${entity.mentions} mentions)`;
      if (relatedEdges.length > 0) {
        content += "\nRelationships:";
        for (const e of relatedEdges.slice(0, 5)) {
          const other = e.from === key ? e.to : e.from;
          const otherName = graph.entities[other]?.name || other;
          content += `\n  ${entity.name} ${e.relation} ${otherName}`;
        }
      }
      results.push({
        content,
        source: "knowledge-graph",
        relevance: Math.min(1, 0.5 + matchCount * 0.15 + entity.mentions * 0.05),
        engine: "graph",
      });
    }
    if (results.length >= maxResults) break;
  }

  return results;
}
```

- [ ] **Step 5: Integrate graph into search + agent_end hook**

In `combinedSearch`, add graph results:
```javascript
  const graphResults = queryGraph(query, maxResults);
  const all = [...rescue, ...graphResults, ...qmd, ...fts5, ...md]
```

In the `agent_end` hook, add graph extraction:
```javascript
  // Update knowledge graph
  const extracted = extractEntities(content);
  if (Object.keys(extracted.entities).length > 0 || extracted.edges.length > 0) {
    const graph = loadGraph();
    mergeIntoGraph(graph, extracted);
    saveGraph(graph);
  }
```

- [ ] **Step 6: Add "graph" special command to memory_search**

Like "health", add a "graph" command that shows the knowledge graph summary:
```javascript
if (/^graph\b/i.test(params.query)) {
  const graph = loadGraph();
  const entityCount = Object.keys(graph.entities).length;
  const edgeCount = graph.edges.length;
  let report = `Knowledge Graph: ${entityCount} entities, ${edgeCount} relationships\n\n`;
  // Top entities by mentions
  const sorted = Object.entries(graph.entities)
    .sort((a, b) => b[1].mentions - a[1].mentions)
    .slice(0, 15);
  report += "Top entities:\n";
  for (const [key, e] of sorted) {
    report += `  ${e.name} (${e.type}, ${e.mentions} mentions)\n`;
  }
  return { content: [{ type: "text", text: report }] };
}
```

- [ ] **Step 7: Test and commit**

```bash
git add plugin/index.mjs
git commit -m "feat: add local knowledge graph (entity + relationship tracking)"
```

---

## Task 4: Self-Evolving Memory / A-MEM (P2)

Memories automatically consolidate and abstract over time. Inspired by A-MEM but implemented as pure JS — no Python.

**Files:**
- Modify: `plugin/index.mjs` — add consolidation logic

- [ ] **Step 1: Add memory consolidation function**

```javascript
/**
 * Self-evolving memory: find clusters of similar memories
 * and generate consolidated summaries.
 * Runs periodically (not on every turn).
 */
function consolidateMemories() {
  const memoryMdPath = resolve(WORKSPACE, "MEMORY.md");
  if (!existsSync(memoryMdPath)) return null;

  const content = readFileSync(memoryMdPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
  if (lines.length < 5) return null;

  // Find clusters by word overlap
  function wordBag(text) {
    return new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  }

  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < lines.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [i];
    const bag = wordBag(lines[i]);

    for (let j = i + 1; j < lines.length; j++) {
      if (assigned.has(j)) continue;
      const otherBag = wordBag(lines[j]);
      const inter = [...bag].filter(w => otherBag.has(w)).length;
      const similarity = inter / Math.max(bag.size, otherBag.size, 1);
      if (similarity > 0.4) {
        cluster.push(j);
        assigned.add(j);
      }
    }
    assigned.add(i);
    if (cluster.length > 1) {
      clusters.push(cluster.map(idx => lines[idx].trim()));
    }
  }

  return {
    totalMemories: lines.length,
    clusters: clusters.length,
    consolidatable: clusters.map(c => ({
      count: c.length,
      entries: c.slice(0, 3), // Show first 3
      suggestion: `These ${c.length} memories are about the same topic and could be merged into one.`,
    })),
  };
}
```

- [ ] **Step 2: Add "consolidate" command to memory_search**

```javascript
if (/^consolidate\b/i.test(params.query)) {
  const result = consolidateMemories();
  if (!result || result.clusters === 0) {
    return { content: [{ type: "text", text: "No consolidation needed — memories are distinct." }] };
  }
  let report = `Found ${result.clusters} groups of similar memories (${result.totalMemories} total):\n\n`;
  for (const c of result.consolidatable) {
    report += `Group (${c.count} entries):\n`;
    c.entries.forEach(e => { report += `  - ${e.slice(0, 80)}\n`; });
    report += `  → ${c.suggestion}\n\n`;
  }
  return { content: [{ type: "text", text: report }] };
}
```

- [ ] **Step 3: Test and commit**

```bash
git add plugin/index.mjs
git commit -m "feat: add memory consolidation (self-evolving memory)"
```

---

## Task 5: Session Indexing (P3)

Index past conversation sessions so the agent can search across all previous conversations.

**Files:**
- Modify: `plugin/index.mjs` — add session search function

- [ ] **Step 1: Add session search function**

OpenClaw stores sessions in `~/.openclaw/memory/main.sqlite` (the same DB we already query). Session data may be in the `chunks` table with `source='sessions'`. Check and search:

```javascript
function searchSessions(query, maxResults) {
  if (!existsSync(MEMORY_DB)) return [];
  const safeQuery = query.replace(/'/g, "''").replace(/"/g, '""');
  try {
    // Search session-sourced chunks
    const sql = `SELECT c.text, c.path, bm25(chunks_fts) as rank FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid WHERE chunks_fts MATCH '${safeQuery}' AND c.source = 'sessions' ORDER BY rank LIMIT ${maxResults};`;
    const result = execSync(`sqlite3 -json "${MEMORY_DB}" "${sql}"`, { encoding: "utf-8", timeout: 5000 });
    return JSON.parse(result || "[]").map(r => ({
      content: r.text || "", source: "session:" + (r.path || ""),
      relevance: Math.min(1, Math.abs(r.rank || 0) / 10), engine: "session",
    }));
  } catch { return []; }
}
```

- [ ] **Step 2: Integrate into combinedSearch**

```javascript
  const sessions = searchSessions(query, maxResults);
  const all = [...rescue, ...graphResults, ...sessions, ...qmd, ...fts5, ...md]
```

- [ ] **Step 3: Test and commit**

```bash
git add plugin/index.mjs
git commit -m "feat: add session indexing search across past conversations"
```

---

## Task 6: Update plugin config schema + landing page

- [ ] **Step 1: Update `plugin/openclaw.plugin.json` configSchema**

Add new config fields:
```json
"mmrLambda": { "type": "number", "minimum": 0, "maximum": 1 },
"halfLifeDays": { "type": "integer", "minimum": 1 },
"graphEnabled": { "type": "boolean" },
"sessionSearch": { "type": "boolean" }
```

- [ ] **Step 2: Update landing page features section**

Add Knowledge Graph and Self-Evolving Memory to the feature cards. Update "How It Works" section.

- [ ] **Step 3: Update README.md**

Add new features to the What's Included table.

- [ ] **Step 4: Rebuild release artifact + deploy**

```bash
bash scripts/build-release.sh
cp dist/openclaw-memory-stack-v0.1.0.tar.gz /tmp/
cd site && npm run build --silent && npx wrangler pages deploy dist/ --project-name openclaw-site --branch main
```

- [ ] **Step 5: Deploy updated plugin to extensions + restart**

```bash
cp plugin/index.mjs ~/.openclaw/extensions/openclaw-memory-stack/
cp plugin/openclaw.plugin.json ~/.openclaw/extensions/openclaw-memory-stack/
# Telegram: openclaw gateway restart
```

- [ ] **Step 6: Full integration test via Telegram**

Test each feature:
1. `搜尋記憶：deadline` — should show MMR-diverse, temporally-ranked results
2. `搜尋記憶：health` — memory quality report
3. `搜尋記憶：graph` — knowledge graph summary
4. `搜尋記憶：consolidate` — memory consolidation suggestions
5. Send a message with entities/relationships, then search graph again

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: Memory Stack v3 — full feature parity + knowledge graph + self-evolving memory"
```
