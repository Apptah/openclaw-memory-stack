# OpenClaw Memory Stack — Ideal Architecture Upgrade

**Date:** 2026-03-20
**Updated:** 2026-03-22
**Status:** Largely Shipped (see gap status below)
**Scope:** Close all 10 gaps between current v2 plugin and ideal 12-capability architecture

## Context

The plugin has been modularized from a 789-line monolith into a thin entry (`index.mjs`, 348 lines) + `lib/` modules. The old `v2-index.mjs` has been deleted. True RRF, bi-temporal filtering, retrieval trajectory, and all graph algorithms are implemented and live.

This spec retains the original design contracts as the reference. Sections below note what shipped vs what remains.

## Module Architecture (Shipped)

```
plugin/
  index.mjs              (348 lines) ← Thin entry: imports, tool registration, command dispatch, hooks
  lib/
    constants.mjs         ( 59 lines) ← Shared paths, config defaults
    pipeline.mjs          (224 lines) ← Fan-out → RRF → temporal filter → dedup → MMR → token budget → trajectory
    rescue.mjs            (251 lines) ← Fact extraction (regex + LLM via llm.mjs), SQLite storage, cleanup
    quality.mjs           (342 lines) ← Health analysis, tiered dedup (L1-L3), cosine dedup (L4), consolidation, organize
    tiered.mjs            (137 lines) ← L0/L1/L2 formatters, --full suffix parser
    extract.mjs           (197 lines) ← Unified entity extraction (used by rescue + graph)
    llm.mjs               (146 lines) ← LLM abstraction (Ollama/OpenAI endpoint, reachability probe, timeout)
    engines/
      index.mjs           (  7 lines) ← Barrel export: [fts5, qmd, memorymd, rescue, lossless]
      fts5.mjs            ( 49 lines) ← SQLite FTS5 full-text search
      qmd.mjs             (286 lines) ← QMD search/vsearch/query (3 modes, probe-gated)
      memorymd.mjs        ( 31 lines) ← MEMORY.md keyword search
      rescue.mjs          (109 lines) ← Rescue fact store search
      lossless.mjs        ( 64 lines) ← LCM DAG search via schema-probing LosslessClient
    graph/
      store.mjs           (279 lines) ← Load/save/merge graph.json, edge types, entity merge
      algorithms.mjs      (306 lines) ← Multi-hop BFS, evolution extraction, community detection, PageRank
```

**Changes from original spec:**
- `sessions.mjs` was removed (session data folded into FTS5 engine)
- `tiered.mjs`, `extract.mjs`, `llm.mjs` added (not in original spec but emerged as clean separations)
- `index.mjs` is 348 lines (larger than the ~150 target due to command dispatch formatters + hooks), but all business logic lives in `lib/`

### Design Rationale (unchanged)

- `engines/` directory: one file per engine, barrel export via `engines/index.mjs`
- `graph/` split by responsibility: store (CRUD) vs algorithms (traversal, analysis)
- `pipeline.mjs` does orchestration only, never touches storage directly
- `index.mjs` is thin: registration + hooks, imports everything from `lib/`
- All relative ESM imports (`./lib/...`), no resolution risk for gateway
- `pipeline.mjs` stayed under 300 lines (224). No `postprocess.mjs` split needed

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
| `qmd` | No | Post-filter by pipeline `fallbackTemporalFilter` |
| `memorymd` | No | No timestamps in MEMORY.md lines; results pass through (no timestamp = not filtered) |
| `rescue` | Partial | Use `facts[].timestamp` from JSON content; fallback to file timestamp |
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
      cosineDedupUsed: boolean;
      tier: "L0" | "L1" | "L2";
    };
  };
}
```

**`meta.trajectory` is best-effort.** It may be partially populated or absent. Not every engine guarantees complete timing or candidate detail. Consumers MUST NOT depend on trajectory completeness for correctness — it is observability-only.

### RRF (Reciprocal Rank Fusion) — SHIPPED

Implemented in `pipeline.mjs` as `computeRRF(engineResults, K = 60)`. Per-engine results are scored by rank position (`weight / (K + rank + 1)`), merged by content key (first 80 chars), with longer content preferred on collision. Replaces the old naive concat+sort.

## Gap Implementations

### Gap 1: HyDE Query Expansion — DESIGN CHANGED

**Module:** `pipeline.mjs`
**Status:** Shipped differently. QMD's built-in `query` mode (local 1.7B model + reranking) handles query expansion internally. No separate HyDE LLM call in the pipeline. The pipeline passes `searchMode` to the qmd engine, which selects `search`/`vsearch`/`query` accordingly.

LLM abstraction (`llm.mjs`) exists for fact extraction but is not used for HyDE expansion.

### Gap 2: Retrieval Trajectory — SHIPPED

**Module:** `pipeline.mjs`

Implemented as designed. `combinedSearch()` returns `{ results, meta: { trajectory } }` with:
- Per-engine timing via `performance.now()`
- `candidates`, `afterRRF`, `afterDedup`, `afterMMR` counts
- `cosineDedupUsed` flag, `tier` classification
- Engine errors recorded as `timing[name] = -1`, never block results

### Gap 3: Bi-temporal Query Filter — SHIPPED

**Module:** `pipeline.mjs` (`fallbackTemporalFilter`), engines pass through `after`/`before` options

Implemented as designed. Pipeline parses `cfg.after`/`cfg.before` into Date objects, passes to engines. `fallbackTemporalFilter()` catches results from engines that don't push down (results with no timestamp pass through). Sessions engine removed; push-down table updated accordingly.

### Gap 4: Lossless Engine Integration — SHIPPED

**Module:** `engines/lossless.mjs` (64 lines)

Implemented as designed. `probeSchema()` uses `PRAGMA table_info(nodes)` to detect columns (`hasKind`, `hasCreatedAt`). Graceful degrade: missing DB or missing `content` column returns `[]`. Registered in `engines/index.mjs`. Pure sqlite3 CLI execution.

### Gap 5: Thread Distillation Upgrade — SHIPPED

**Module:** `rescue.mjs` (251 lines), `llm.mjs` (146 lines), `extract.mjs` (197 lines)

Implemented with the designed dual-path strategy. `llm.mjs` provides a unified LLM abstraction (supports Ollama/OpenAI endpoints, reachability probe, timeout). `extract.mjs` provides unified entity extraction shared by rescue and graph. `rescue.mjs` stores extracted facts in SQLite (`facts.sqlite`) instead of flat JSON files, with the designed schema (`type`, `content`, `source`, `timestamp`).

### Gap 6: Cosine Deduplication — SHIPPED

**Module:** `quality.mjs` (exports `deduplicateResults` for L1-L3, `applyCosineDedup` for L4)
**Pipeline position:** After RRF merge, before MMR (as designed)

All four dedup levels implemented. Pipeline calls `deduplicateResults()` then `applyCosineDedup()`. Trajectory records `cosineDedupUsed` flag.

### Gap 7: Evolution Chains — SHIPPED

**Module:** `graph/algorithms.mjs` (extraction patterns + timeline query), `graph/store.mjs` (edge structure)

Implemented as designed. `EVOLUTION_PATTERNS` in `algorithms.mjs` with all five regex patterns. `extractEvolutionEdges()` exported and called from `index.mjs` agent_end hook. `getEvolutionTimeline()` provides the query interface. Edge migration handled gracefully (missing `type` defaults to `"RELATES"`).

### Gap 8: Multi-hop Graph Traversal — SHIPPED

**Module:** `graph/algorithms.mjs`

Implemented as designed. `multiHopQuery(graph, entity, depth, maxNodes)` with BFS, visited set, maxNodes cap. Command dispatch in `index.mjs` parses `graph:Entity depth:N` and passes `cfg.graphMaxNodes`.

### Gap 9: Expertise Graph (Community Detection + PageRank) — SHIPPED

**Module:** `graph/algorithms.mjs`

Both `detectCommunities(graph)` and `rankByPageRank(graph)` implemented as designed. Results cached in memory, invalidated on graph merge. Query via `memory_search("expertise")`.

### Gap 10: A-MEM Self-Organizing Memory — SHIPPED

**Module:** `quality.mjs` (`organizeMemories()`)

Implemented with dry-run default and `--apply` flag as designed. Command dispatch in `index.mjs` handles both `organize` and `organize --apply`. Backup policy implemented. `cfg.autoOrganize` defaults to `false`.

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

## Rescue Storage Migration (Complete)

Rescue storage moved from flat JSON files to SQLite (`facts.sqlite`). Old JSON files still cleaned up via 30-day retention. New schema stores `type`, `content`, `source`, `timestamp`, `created_at`.

## Config Schema (Shipped)

Actual `DEFAULT_CONFIG` in `constants.mjs`:

```json
{
  "llmEndpoint": "https://api.openai.com/v1",
  "llmModel": "gpt-4o-mini",
  "autoOrganize": false,
  "losslessEnabled": true,
  "graphDepth": 2,
  "graphMaxNodes": 50,
  "mmrLambda": 0.7,
  "halfLifeDays": 30,
  "maxRecallResults": 5,
  "maxRecallTokens": 1500,
  "searchMode": "hybrid",
  "autoRecallTier": "L0",
  "toolResponseTier": "L1",
  "qmdCollection": null,
  "qmdProbeQuery": null
}
```

**Changes from original spec:** `hyde`/`hydeEndpoint`/`hydeModel` replaced by `llmEndpoint`/`llmModel` (used for fact extraction, not HyDE). Added `autoRecallTier`, `toolResponseTier`, `qmdCollection`, `qmdProbeQuery`.

`graphEnabled: false` still disables all graph features (multi-hop, evolution, expertise, entity extraction).

## Migration Path (Complete)

1. ~~Current `index.mjs` (789 lines) → decompose into module structure~~ DONE — 348-line thin entry + `lib/` modules
2. ~~`v2-index.mjs` (873 lines, unused by gateway) → delete~~ DONE — deleted
3. All existing functionality preserved — no breaking changes to tool API
4. New capabilities activate based on config + runtime detection
5. `package.json` `main` stays `index.mjs` — no change needed

## Risk Mitigations (validated in implementation)

| Risk | Mitigation | Status |
|------|-----------|--------|
| ESM import resolution | All relative imports (`./lib/...`), same directory tree | Confirmed working |
| LLM latency | Timeout + reachability probe in `llm.mjs`, graceful fallback to regex | Shipped |
| Cosine dedup unavailable | 3 cheaper dedup levels always run first | Shipped |
| A-MEM corrupts MEMORY.md | Dry-run default, mandatory backup, no-delete-on-failure | Shipped |
| Graph explosion | visited set + maxNodes cap on multi-hop BFS | Shipped |
| LCM schema changes | LosslessClient probes schema, no hardcoded SQL | Shipped |
| LLM fact extraction garbage | Schema validation + regex fallback | Shipped |
| Trajectory overhead | Best-effort, optional, never blocks search results | Shipped |
| QMD runtime availability | Probe-gated: engine returns `[]` if qmd binary not found | Shipped |
