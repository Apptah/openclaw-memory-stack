# Benchmarks Summary — Starter Tier

Performance data for Total Recall and QMD on the Starter tier.

## Test methodology

- **Hardware**: MacBook Pro M2, 16GB RAM, APFS SSD
- **Test corpus**: 3 projects of varying size (small: 50 files, medium: 500 files, large: 2000 files)
- **Queries**: 50 queries per backend, mix of exact symbol lookups, concept searches, and ambiguous terms
- **Measurement**: Wall-clock time from query dispatch to result return, averaged over 3 runs
- **Total Recall memory set**: 200 stored memories spanning 30 days
- **QMD index**: Freshly built index with embeddings for each test corpus

## Key metrics

### Query latency

| Corpus size | Total Recall | QMD (search) | QMD (vsearch) | QMD (query) |
|-------------|-------------|--------------|----------------|-------------|
| Small (50 files) | ~30ms | ~80ms | ~150ms | ~200ms |
| Medium (500 files) | ~50ms | ~120ms | ~200ms | ~250ms |
| Large (2000 files) | ~120ms | ~180ms | ~280ms | ~350ms |

Total Recall is consistently faster because it runs git commands against a small set of memory files. QMD is slower due to SQLite FTS5 queries and vector similarity computation, but still well under the 5-second router timeout.

### Search accuracy

Tested against a curated set of 50 queries with known correct answers.

| Query type | Total Recall | QMD (best mode) |
|------------|-------------|-----------------|
| Exact symbol name | 45% | 92% (search) |
| Concept/behavior | 20% | 74% (vsearch) |
| Recent context | 85% | 30% (query) |
| File path pattern | 10% | 88% (search) |
| Ambiguous single word | 35% | 65% (query) |

Total Recall excels at recent context because its time-decay scoring naturally prioritizes what was stored recently. QMD excels at everything else because it has both keyword and vector search.

### Storage overhead

| Backend | Base overhead | Per-memory cost | Index for 2000-file project |
|---------|--------------|-----------------|----------------------------|
| Total Recall | ~0 (uses existing git) | ~1-2KB per memory file | N/A (no index) |
| QMD | ~5MB (SQLite + FTS5 base) | ~10KB per indexed file | ~20MB |

Total Recall adds negligible storage -- it is just markdown files on a git branch. QMD's index grows with the corpus but stays modest for typical projects.

## Comparison table

| Metric | Total Recall | QMD |
|--------|-------------|-----|
| First query latency | ~50ms | ~200ms |
| Search accuracy (exact) | Medium | High |
| Search accuracy (semantic) | Low | Medium-High |
| Storage overhead | Minimal (git) | ~20MB index |
| Setup complexity | Zero deps | Needs Bun |
| First-time setup time | Instant | 1-5 min (embedding) |
| Update cost | Instant (git commit) | Seconds (incremental) |
| Offline capable | Yes | Yes |
| Handles typos/synonyms | No | Partial (vsearch) |

## When to use which

**Total Recall is the right choice when:**

- You need zero-dependency memory that works everywhere git works.
- Your queries are about recent work ("what did we just discuss", "last change").
- You are storing decisions, context snapshots, or conversation history.
- You want guaranteed data durability with full version history.
- You are on a machine where installing Bun is impractical.

**QMD is the right choice when:**

- You need to find specific symbols, functions, or class names in code.
- Your queries are conceptual ("how does X work", "where is Y handled").
- You want to search across source files, not just stored memories.
- You need semantic understanding (matching "auth" to "login" context).
- You have Bun installed and can afford the index storage.

**Use both (recommended):**

The router combines both backends automatically. Store important decisions in Total Recall for durability. Keep your source code indexed in QMD for searchability. The router picks the right backend per query and falls back to the other if results are weak.

For most Starter users, running both backends gives the best coverage with no manual backend selection needed.

---

Full benchmarks with all 4 backends (including Cognee graph search and Lossless DAG) available in Pro tier.
