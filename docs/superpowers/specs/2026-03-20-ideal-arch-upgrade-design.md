# OpenClaw Memory Stack — Ideal Architecture Upgrade

**Date:** 2026-03-20
**Status:** Draft
**Scope:** Close all 10 gaps between current v2 plugin and ideal 12-capability architecture

## Context

The current `plugin/index.mjs` (789 lines, single file) implements Tiered Loading fully, and 5 capabilities partially (RRF — current code does naive concat+sort, not true RRF; Bi-temporal; HyDE; Thread Distillation; Dedup). Six capabilities are missing entirely (Multi-hop, Lossless integration, Evolution Chains, Expertise Graph, A-MEM, Retrieval Trajectory).

**Note:** `index.mjs` (gateway-loaded) and `v2-index.mjs` (experimental, NOT loaded) differ. `index.mjs` lacks RRF; `v2-index.mjs` has it. This spec targets `index.mjs` as the base and incorporates all improvements.

This spec covers: modular restructuring + implementing all gaps to reach 12/12.

## Module Architecture

```
plugin/
  index.mjs                  ← Entry: import modules, register tools + hooks (~150 lines)
  lib/
    constants.mjs             ← Shared paths, config, Result type definition
    pipeline.mjs              ← HyDE → fan-out → RRF → dedup → MMR → tiered → trajectory
    rescue.mjs                ← Fact extraction (regex + LLM), schema validation, save/cleanup
    quality.mjs               ← Health, cosine dedup, consolidation, A-MEM organize
    engines/
      index.mjs               ← Aggregates all engines, exports engine registry
      fts5.mjs                ← SQLite FTS5 full-text search
      qmd.mjs                 ← QMD search/vsearch/query (3 modes)
      memorymd.mjs             ← MEMORY.md keyword search
      rescue.mjs              ← Rescue store search
      sessions.mjs            ← Session search (SQLite FTS5, source='sessions')
      lossless.mjs            ← LCM DAG search via LosslessClient
    graph/
      store.mjs               ← Load/save/merge graph.json, edge types, entity merge
      algorithms.mjs           ← Multi-hop BFS, evolution pattern extraction, community detection, PageRank
```

### Design Rationale

- Target: each module < 300 lines. If `pipeline.mjs` exceeds this (due to 9 responsibilities: HyDE, fan-out, RRF, dedup, MMR, tiered, trajectory, temporal, token budget), split into `pipeline.mjs` (orchestration + fan-out) and `postprocess.mjs` (dedup + MMR + temporal decay + token budget)
- `engines/` directory: one file per engine, barrel export via `engines/index.mjs`
- `graph/` split by responsibility: store (CRUD) vs algorithms (traversal, analysis)
- `pipeline.mjs` does orchestration only, never touches storage directly
- `index.mjs` is thin: registration + hooks, imports everything from `lib/`
- All relative ESM imports (`./lib/...`), no resolution risk for gateway

## Core Contracts

### Result Standard Structure

Every engine MUST return results conforming to this shape. No engine may add ad-hoc fields or omit required fields.

```typescript
interface Result {
  content: string;         // The matched text content
  source: string;          // Origin identifier (e.g., "memory-sqlite", "qmd", "MEMORY.md", "rescue:decision")
  relevance: number;       // 0.0 - 1.0, engine-specific scoring
  engine: string;          // Engine identifier (e.g., "fts5", "qmd-hybrid", "graph")
  timestamp?: string;      // ISO 8601, for bi-temporal filtering (preferred over source date)
}
```

### Engine Interface

Each engine module exports a single object conforming to:

```typescript
interface Engine {
  name: string;                           // Unique identifier
  queryType: "raw" | "expanded" | "both"; // Which query variant this engine consumes
  search(query: string, options?: {
    maxResults?: number;
    after?: Date;     // Bi-temporal: inclusive lower bound
    before?: Date;    // Bi-temporal: inclusive upper bound
  }): Promise<Result[]>;                  // All engines are async
}
```

**Async contract:** All engines return `Promise<Result[]>`. The pipeline uses `Promise.allSettled()` for fan-out, allowing engines to run in parallel. Engines that use `execSync` internally should wrap in `Promise.resolve()` — the async interface is for pipeline-level parallelism, not mandating internal async I/O.

- `queryType: "raw"` — receives original user query (e.g., memorymd keyword match)
- `queryType: "expanded"` — receives HyDE-expanded query (e.g., qmd semantic search)
- `queryType: "both"` — receives both, engine decides internally

**Temporal push-down by engine:**

| Engine | Push-down | Strategy |
|--------|-----------|----------|
| `fts5` | Yes | SQL `WHERE created_at BETWEEN ? AND ?` |
| `qmd` | No | Post-filter by pipeline `fallbackFilter` |
| `memorymd` | No | No timestamps in MEMORY.md lines; all results returned, pipeline skips temporal filter for results with no timestamp |
| `rescue` | Partial | Use `facts[].timestamp` from JSON content; fallback to file timestamp |
| `sessions` | Yes | SQL `WHERE created_at BETWEEN ? AND ?` |
| `lossless` | Yes | SQL `WHERE created_at BETWEEN ? AND ?` |
| `graph` | Partial | Filter edges by `timestamp` field (edges without timestamp pass through) |

### Pipeline Return Type

```typescript
interface SearchResponse {
  results: Result[];
  meta: {
    trajectory?: {
      engines: string[];                    // Engines that were queried
      timing: Record<string, number>;       // Per-engine latency in ms
      candidates: number;                   // Total results before RRF
      afterRRF: number;                     // After RRF merge + key dedup
      afterDedup: number;                   // After cosine/normalized dedup
      afterMMR: number;                     // Final count after MMR
      hydeUsed: boolean;
      cosineDedupUsed: boolean;
      tier: "L0" | "L1" | "L2";
    };
  };
}
```

**`meta.trajectory` is best-effort.** It may be partially populated or absent. Not every engine guarantees complete timing or candidate detail. Consumers MUST NOT depend on trajectory completeness for correctness — it is observability-only.

### RRF (Reciprocal Rank Fusion) — New Implementation

The current `index.mjs` does NOT implement true RRF — it concatenates results and sorts by raw relevance score. The pipeline MUST implement proper RRF:

```javascript
// For each engine's result list, compute RRF score by rank position:
// rrfScore = weight / (K + rank + 1), where K = 60
// Merge across engines: sum RRF scores for same content key
// This replaces the naive concat+sort currently in combinedSearch()
```

This is a prerequisite for all pipeline work, not a standalone gap.

## Gap Implementations

### Gap 1: HyDE Query Expansion

**Module:** `pipeline.mjs`
**Trigger:** `cfg.hyde !== false` AND Ollama endpoint reachable at init time

```
query → isOllamaReachable() → hydeExpand(query) → expandedQuery
pipeline holds both rawQuery and expandedQuery
each engine receives query variant per its queryType declaration
```

- Ollama endpoint: `cfg.hydeEndpoint || "http://localhost:11434"`
- Model: `cfg.hydeModel || "qwen2.5:7b"`
- Timeout: 5s, fallback to rawQuery on failure
- Reachability cached for 60s to avoid per-query probe

### Gap 2: Retrieval Trajectory

**Module:** `pipeline.mjs`
**Change:** `combinedSearch` returns `SearchResponse` (see contract above)

- Each engine call is timed via `performance.now()` delta
- `candidates` = sum of all engine results before RRF
- Pipeline stages (RRF, dedup, MMR) each record their output count
- Auto-recall hook includes trajectory summary in `<memory-stack>` tag
- Tool response appends `(trajectory: ...)` to output text
- **Best-effort**: missing timing for an engine → omit that key, don't fail

### Gap 3: Bi-temporal Query Filter

**Module:** `pipeline.mjs` (contract), `engines/*.mjs` (push-down)

Temporal contract defined by pipeline:
- `after` / `before`: `Date` objects, **inclusive** (closed interval)
- Format: ISO 8601 date or datetime
- Pipeline defines unified `fallbackFilter(result, temporal)` for engines that can't push down

Engine push-down strategy:
- `fts5.mjs` / `sessions.mjs`: SQL `WHERE created_at >= ? AND created_at <= ?`
- `qmd.mjs`: post-filter (QMD CLI has no temporal parameter)
- `rescue.mjs`: use `facts[].timestamp` from JSON content (NOT file mtime); fallback to file timestamp only if content timestamp absent
- `lossless.mjs`: SQL `WHERE created_at BETWEEN ? AND ?`
- `graph/store.mjs`: filter edges by `timestamp` field

Engines that cannot push down MUST return all results; pipeline applies `fallbackFilter` uniformly.

### Gap 4: Lossless Engine Integration

**Module:** `engines/lossless.mjs`

```javascript
class LosslessClient {
  constructor(dbPath) {
    // Locate lcm.db: env OPENCLAW_LCM_DB || ~/.openclaw/lcm/lcm.sqlite
    // Probe schema: verify 'nodes' table exists, detect column names
    // Store discovered schema for query generation
  }
  query(sql, params) { /* sqlite3 -json execution */ }
  toResult(row) { /* Map row → standard Result, using schema mapping */ }
}
```

- Minimum expected schema: `nodes(rowid, content, created_at)`, optionally `nodes.kind` (leaf/condensed) and `edges(source_id, target_id)`
- Schema probing: on init, `PRAGMA table_info(nodes)` to detect columns; missing columns → exclude from queries, don't fail
- SQL templates parameterized from discovered columns, not hardcoded
- Pure JS/sqlite3 CLI implementation — does NOT call the shell wrapper
- `queryType: "raw"` — keyword search against DAG content
- Registered in `engines/index.mjs` alongside other engines
- Graceful degrade: if `lcm.db` not found, engine returns `[]`

### Gap 5: Thread Distillation Upgrade

**Module:** `rescue.mjs`

Fact schema (required for both LLM and regex paths):

```typescript
interface ExtractedFact {
  type: "decision" | "deadline" | "requirement" | "entity" | "insight";
  fact: string;
  confidence: number;  // 0.0 - 1.0
  entities: string[];  // Referenced entity names
}
```

Extraction strategy:
1. If Ollama reachable → POST `/api/generate` with structured prompt including JSON schema → parse → validate against schema → accept
2. If LLM output fails validation → fallback to regex `extractKeyFacts()`
3. If Ollama not reachable → regex `extractKeyFacts()` directly

Regex path maps to same schema:
- `decision` → confidence 0.9
- `deadline` → confidence 0.95
- `requirement` → confidence 0.7
- `entity` → confidence 0.6
- `entities[]` populated from regex capture groups

### Gap 6: Cosine Deduplication

**Module:** `quality.mjs`
**Pipeline position:** After RRF merge, before MMR

Tiered dedup strategy:

```
Level 1: Exact content key (first 80 chars lowercase) — always runs
Level 2: Normalized text (lowercase, strip punctuation, collapse whitespace) — always runs
Level 3: Substring overlap > 80% of shorter string — always runs
Level 4: Cosine similarity > 0.9 via QMD embedding — only if QMD available
```

- Level 4 uses `qmd embed --text "..."` to get vectors, then computes cosine similarity
- If `qmd embed` is not available (older QMD version), Level 4 is skipped; `trajectory.cosineDedupUsed = false`
- Availability check: on init, try `qmd embed --text "test" --json`; cache result
- When merging duplicates: keep longer content + higher relevance score
- Max dedup candidates: 50 (avoid O(n²) blowup on large result sets)

### Gap 7: Evolution Chains

**Module:** `graph/store.mjs` (edge structure), `graph/algorithms.mjs` (extraction patterns)

Edge structure extended:

```javascript
{
  from: string,
  to: string,
  type: "EVOLVES" | "RELATES" | "DEPENDS",
  timestamp: string,   // ISO 8601
  context: string,      // Source line, max 120 chars
}
```

**Migration:** Existing `graph.json` edges have `{ from, to, context }` only — no `type` or `timestamp`. `graph/store.mjs` MUST treat missing `type` as `"RELATES"` and missing `timestamp` as `null` (excluded from temporal queries). No one-time migration needed; edges are enriched on next merge.

Evolution extraction patterns (in `algorithms.mjs`, NOT in store):

```javascript
const EVOLUTION_PATTERNS = [
  { pattern: /replaced\s+(\S+)\s+with\s+(\S+)/i, type: "EVOLVES" },
  { pattern: /upgraded\s+(?:from\s+)?(\S+)\s+to\s+(\S+)/i, type: "EVOLVES" },
  { pattern: /renamed\s+(\S+)\s+to\s+(\S+)/i, type: "EVOLVES" },
  { pattern: /migrated\s+(?:from\s+)?(\S+)\s+to\s+(\S+)/i, type: "EVOLVES" },
  { pattern: /deprecated\s+(\S+)\s+in\s+favor\s+of\s+(\S+)/i, type: "EVOLVES" },
];
```

Query interface: `memory_search("evolution:EntityName")` → returns chronological timeline of EVOLVES edges involving that entity.

### Gap 8: Multi-hop Graph Traversal

**Module:** `graph/algorithms.mjs`

```javascript
function multiHopQuery(graph, startEntity, depth = 2, maxNodes = 50) {
  const visited = new Set();
  const queue = [{ entity: startEntity, depth: 0, path: [] }];
  const paths = [];

  // BFS with:
  // - visited set (prevents cycles)
  // - maxNodes cap (prevents explosion on large graphs)
  // - depth limit (user-configurable, default 2)

  return {
    paths,                    // Array of entity chains with edge context
    nodesVisited: visited.size,
    truncated: visited.size >= maxNodes,
  };
}
```

Query interface: `memory_search("graph:EntityName depth:3")` triggers multi-hop with parsed depth parameter.

### Gap 9: Expertise Graph (Greedy Community Detection + PageRank)

**Module:** `graph/algorithms.mjs`

**Community detection** — greedy modularity optimization (NOT full Louvain):

```javascript
function detectCommunities(graph) {
  // 1. Build adjacency list from edges
  // 2. Initialize: each node in its own community
  // 3. Iterate: for each node, try moving to neighbor's community
  //    Accept move if modularity Q increases
  // 4. Repeat until no more improvements
  // Return: [{ name: string, members: string[], density: number, modularity: number }]
}
```

**PageRank** — standard iterative:

```javascript
function rankByPageRank(graph, iterations = 20, damping = 0.85) {
  // Standard power iteration PageRank
  // Return: [{ entity: string, score: number }] sorted descending
}
```

Query interface: `memory_search("expertise")` → returns top communities + top-ranked entities.

### Gap 10: A-MEM Self-Organizing Memory

**Module:** `quality.mjs`

```javascript
function organizeMemories(options = {}) {
  const apply = options.apply === true; // DEFAULT: dry-run

  // Phase 1: Jaccard clustering (existing logic, preserved)
  // Phase 2: LLM consolidation (if Ollama reachable)
  //   - For each cluster, prompt LLM to write consolidated memory
  //   - Output: { candidate: string, original: string[], summary: string }
  // Phase 3: Cross-link suggestions between related clusters

  if (apply) {
    // 1. Create timestamped backup: MEMORY.md.backup.{ISO timestamp}
    // 2. Write consolidated content to MEMORY.md
    // 3. If write fails → restore from backup, DO NOT delete backup
    // 4. On success → keep backup for 7 days
    return { applied: true, backupPath, changes };
  }

  return { applied: false, dryRun: true, clusters, candidates, suggestions };
}
```

**Backup policy (MANDATORY):**
- `organize --apply` ALWAYS creates backup before any write
- Failure during write → restore backup, report error, backup preserved
- Backup never auto-deleted during the operation
- Backup cleanup: separate sweep, 7-day retention

Query interface:
- `memory_search("organize")` → dry-run report
- `memory_search("organize --apply")` → execute with backup
- `cfg.autoOrganize === true` → enable auto-organize (off by default)

## Command Dispatch Table

The `memory_search` tool uses prefix matching to route special commands. Commands are checked in order; first match wins. If no command matches, the query is treated as a search.

| Pattern | Regex | Handler | Module |
|---------|-------|---------|--------|
| `health` | `/^health\b/i` | `analyzeMemoryHealth()` | `quality.mjs` |
| `graph` (summary) | `/^graph$/i` | graph summary report | `graph/store.mjs` |
| `graph:Entity` | `/^graph:(\S+)(?:\s+depth:(\d+))?/i` | `multiHopQuery(entity, depth)` | `graph/algorithms.mjs` |
| `evolution:Entity` | `/^evolution:(\S+)/i` | timeline of EVOLVES edges | `graph/algorithms.mjs` |
| `expertise` | `/^expertise$/i` | communities + PageRank | `graph/algorithms.mjs` |
| `consolidate` | `/^consolidate\b/i` | `consolidateMemories()` | `quality.mjs` |
| `organize` | `/^organize\b/i` | `organizeMemories({ apply: false })` | `quality.mjs` |
| `organize --apply` | `/^organize\s+--apply\b/i` | `organizeMemories({ apply: true })` | `quality.mjs` |
| *(no match)* | — | `combinedSearch(query)` | `pipeline.mjs` |

**Note:** `graph` (exact) and `graph:Entity` are distinguished by the colon. No prefix collision risk.

## Expertise Graph Caching

`detectCommunities()` and `rankByPageRank()` are computed on-demand. Results are cached in memory for the plugin's lifetime (no disk persistence). Cache is invalidated when `mergeIntoGraph()` adds new entities or edges.

For graphs < 500 nodes, computation is < 100ms. For larger graphs, the `maxNodes` cap (default 50 for multi-hop) limits traversal cost. Community detection operates on the full graph but is bounded by iteration convergence.

## Rescue Field Migration

Existing rescue JSON files use `weight` field. New schema uses `confidence`. `rescue.mjs` MUST support both:
- Read: accept `confidence` or `weight`, prefer `confidence` if both present
- Write: always use `confidence` (new schema)
- No migration of existing files needed — they age out via 30-day cleanup

## Config Schema Additions

New fields for `openclaw.plugin.json` (added to existing schema):

```json
{
  "hyde": { "type": "boolean", "default": true },
  "hydeEndpoint": { "type": "string" },
  "hydeModel": { "type": "string" },
  "autoOrganize": { "type": "boolean", "default": false },
  "losslessEnabled": { "type": "boolean", "default": true },
  "graphDepth": { "type": "integer", "minimum": 1, "maximum": 5, "default": 2 },
  "graphMaxNodes": { "type": "integer", "minimum": 10, "maximum": 200, "default": 50 }
}
```

Existing fields preserved unchanged: `routerMode`, `searchMode`, `autoRecall`, `autoCapture`, `maxRecallResults`, `maxRecallTokens`, `mmrLambda`, `halfLifeDays`, `graphEnabled`, `sessionSearch`.

Interaction: `graphEnabled: false` disables all graph features (multi-hop, evolution, expertise, entity extraction).

## Migration Path

1. Current `index.mjs` (789 lines) → decompose into module structure
2. `v2-index.mjs` (873 lines, unused by gateway) → delete after migration
3. All existing functionality preserved — no breaking changes to tool API
4. New capabilities activate based on config + runtime detection
5. `package.json` `main` stays `index.mjs` — no change needed

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| ESM import resolution | All relative imports (`./lib/...`), same directory tree |
| HyDE latency | 5s timeout, cached reachability probe, graceful fallback |
| Cosine dedup unavailable | 3 cheaper dedup levels always run first |
| A-MEM corrupts MEMORY.md | Dry-run default, mandatory backup, no-delete-on-failure |
| Graph explosion | visited set + maxNodes cap on multi-hop BFS |
| LCM schema changes | LosslessClient probes schema, no hardcoded SQL |
| LLM fact extraction garbage | Schema validation + regex fallback |
| Trajectory overhead | Best-effort, optional, never blocks search results |
