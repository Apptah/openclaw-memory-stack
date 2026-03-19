# OpenClaw Memory Stack: Full Benchmark Report

> **Pro-tier document** -- Complete performance data across all four backends.

---

## Test Environment

| Component | Detail |
|-----------|--------|
| Machine | MacBook Pro, Apple M2 Pro, 16GB RAM |
| OS | macOS 14.3 (Sonoma) |
| Disk | 512GB SSD (APFS) |
| Git | 2.43.0 |
| Bun | 1.1.38 |
| Python | 3.12.1 |
| SQLite | 3.43.2 (system) / Bun built-in with FTS5 |
| Test codebase | Medium TypeScript project, ~45K LOC, 380 files across 12 modules |
| Memory corpus | 200 stored memories (conversation decisions, code context, architecture notes) |

All benchmarks were run with no other significant processes competing for CPU or I/O. Numbers represent the median of 10 runs unless otherwise noted. Cold start numbers are single-run measurements taken after a fresh system reboot.

---

## Methodology

### Query Categories

We tested each backend with queries drawn from four categories, 25 queries per category (100 total):

1. **Exact symbol** -- Function names, class names, method names (e.g., `parseAuthToken`, `UserService.validate`, `handlePaymentRetry`)
2. **Semantic concept** -- Behavioral descriptions (e.g., "how does the retry logic work", "where is error handling for API calls")
3. **Relationship** -- Entity connection queries (e.g., "how does AuthMiddleware relate to SessionStore", "what depends on PaymentService")
4. **Decision recall** -- Past decision recovery (e.g., "why did we choose JWT over session cookies", "what was decided about the database schema")

### Measurement Approach

- **Latency**: Wall-clock time from query dispatch to response receipt, measured by the router's timing instrumentation (`router_duration_ms` and `backend_duration_ms` fields).
- **Accuracy**: Human-evaluated relevance on a 3-point scale (0 = irrelevant, 1 = partially relevant, 2 = highly relevant). Precision = (results scored 1 or 2) / (total results returned). Recall = (results scored 2) / (total relevant items in ground truth).
- **Storage**: Disk usage measured via `du -sh` on each backend's storage directory after indexing the full test codebase and memory corpus.

### Ground Truth

For accuracy benchmarks, we manually constructed a ground truth set: for each of the 100 test queries, we identified the ideal results by reading the codebase and memory corpus directly. This ground truth was built before running any backend queries to avoid bias.

---

## Latency Benchmarks

### Cold Start (First Query After Install)

Cold start includes any initialization the backend performs on first invocation: loading indexes into memory, initializing database connections, parsing configuration.

| Backend | Cold Start Latency | Notes |
|---------|--------------------|-------|
| **QMD** | 1,200 - 1,800ms | SQLite FTS5 index loaded into memory. Larger collections take longer. |
| **Total Recall** | 80 - 150ms | Git operations are fast; no index to load. First `git log --grep` on the memory branch is slightly slower due to pack file access. |
| **Cognee** | 2,500 - 4,000ms | Python interpreter startup + graph database initialization. This is the slowest cold start by a significant margin. |
| **Lossless** | 300 - 600ms | SQLite DAG file opened and schema verified. Faster than QMD because the DAG is typically smaller than a full code index. |

**Key takeaway**: Total Recall is the fastest to cold-start by an order of magnitude. Cognee's Python startup cost is noticeable and unavoidable. QMD and Lossless fall in the middle.

### Warm Query (Subsequent Queries, Index/DB in Memory)

| Backend | Median Latency | P95 Latency | Notes |
|---------|---------------|-------------|-------|
| **QMD (search/BM25)** | 45ms | 120ms | Pure FTS5 query. Fast and consistent. |
| **QMD (vsearch/vector)** | 180ms | 350ms | Embedding generation for query + cosine similarity. Slower than BM25. |
| **QMD (query/hybrid)** | 220ms | 400ms | Runs both BM25 and vector, merges results. Slightly slower than vector alone due to merge step. |
| **Total Recall** | 35ms | 90ms | `git log --grep` + `git show` for content retrieval. Fastest warm query of any backend. |
| **Cognee** | 350ms | 800ms | Graph traversal time scales with traversal depth. Simple 1-hop queries are ~150ms; 3-5 hop queries reach 500-800ms. |
| **Lossless** | 40ms | 100ms | SQLite keyword query on DAG nodes. Comparable to Total Recall. |

**Key takeaway**: For sub-100ms responses, Total Recall, Lossless, and QMD BM25 all deliver. Cognee and QMD vector/hybrid trade latency for richer results. All backends are well within the router's 5-second timeout.

### Index / Build Time (One-Time Setup Cost)

| Backend | Initial Build Time | Incremental Update | Notes |
|---------|--------------------|--------------------|-------|
| **QMD (index only)** | 8 - 15 seconds | 2 - 5 seconds | `qmd collection add` + FTS5 indexing for 380 files. |
| **QMD (with embeddings)** | 3 - 6 minutes | 15 - 45 seconds | `qmd embed` generates vector embeddings. This is the dominant setup cost. Incremental updates only re-embed changed files. |
| **Total Recall** | < 1 second | N/A | Creating the orphan branch is nearly instantaneous. No index to build. |
| **Cognee** | 5 - 12 minutes | 1 - 3 minutes | Entity extraction and graph construction for 380 files. Highly variable depending on code structure complexity. Well-organized code with clear class boundaries processes faster. |
| **Lossless** | < 1 second | N/A | SQLite database created on first `lossless ingest`. No upfront build required -- the DAG grows incrementally. |

**Key takeaway**: Total Recall and Lossless have effectively zero setup cost. QMD's embedding generation and Cognee's graph building are the bottlenecks. Plan 5-15 minutes for first-time setup of QMD+Cognee on a medium codebase.

---

## Accuracy Benchmarks

### Exact Match Accuracy (25 queries)

Queries: specific function names, class names, and method signatures.

| Backend | Precision | Recall | F1 Score | Notes |
|---------|-----------|--------|----------|-------|
| **QMD (search)** | 94% | 88% | 0.91 | BM25 excels here. Missed results were due to camelCase tokenization edge cases (e.g., `XMLHTTPRequest` splitting poorly). |
| **QMD (vsearch)** | 72% | 65% | 0.68 | Vector search finds semantically related code but returns false positives for exact name queries. Not the right mode for this task. |
| **Total Recall** | 48% | 40% | 0.44 | Only finds matches if the exact symbol name appears in a stored memory. Most code symbols are not in conversation history. |
| **Cognee** | 35% | 28% | 0.31 | Can find entities by name but returns relationship paths, not code. Poor fit for exact code lookup. |
| **Lossless** | 30% | 22% | 0.26 | Keyword match on DAG nodes. Only finds symbols mentioned in conversation decisions. |

**Key takeaway**: QMD BM25 is the clear winner for exact symbol search. Other backends are not designed for this task -- their scores reflect that, not a quality problem.

### Semantic Match Accuracy (25 queries)

Queries: behavioral descriptions like "how does the retry logic work" or "where is input validation handled".

| Backend | Precision | Recall | F1 Score | Notes |
|---------|-----------|--------|----------|-------|
| **QMD (vsearch)** | 82% | 74% | 0.78 | Vector embeddings capture semantic similarity well. Best general-purpose semantic search. |
| **QMD (query)** | 85% | 78% | 0.81 | Hybrid mode slightly outperforms pure vector by catching keyword matches that vector misses. |
| **Cognee** | 58% | 45% | 0.51 | Finds entities related to the concept but returns graph paths, not code content. Useful as a pointer, not as a complete answer. |
| **Total Recall** | 18% | 12% | 0.14 | Literal text matching cannot bridge vocabulary gaps. "Retry logic" does not match a memory about "exponential backoff". |
| **Lossless** | 22% | 15% | 0.18 | Same limitation as Total Recall -- keyword matching only. |

**Key takeaway**: QMD hybrid mode is the best semantic search backend. Total Recall and Lossless are fundamentally incapable of semantic matching due to their keyword-only search.

### Relationship Query Accuracy (25 queries)

Queries: entity connection questions like "how does AuthMiddleware relate to SessionStore" or "what depends on PaymentService".

| Backend | Precision | Recall | F1 Score | Notes |
|---------|-----------|--------|----------|-------|
| **Cognee** | 86% | 72% | 0.78 | Graph traversal finds direct and indirect relationships. Missed results were due to incomplete entity extraction (entities in procedural code not identified). |
| **QMD (vsearch)** | 32% | 25% | 0.28 | Finds code that mentions both entities but cannot determine the relationship *type*. Returns relevant code, not relationship paths. |
| **QMD (query)** | 35% | 28% | 0.31 | Slightly better than pure vector due to keyword matching on entity names. |
| **Lossless** | 28% | 20% | 0.23 | Can find decision nodes that mention relationships, but only if the relationship was explicitly discussed in conversation. |
| **Total Recall** | 15% | 10% | 0.12 | Literal grep can find memories mentioning both entity names but cannot determine the relationship. |

**Key takeaway**: Cognee is the only backend that genuinely answers relationship queries. Other backends can find text that mentions the entities, but they cannot trace the actual dependency path. This is the core Pro-tier differentiator.

### Decision Recall Accuracy (25 queries)

Queries: past decision recovery like "why did we choose JWT over session cookies" or "what was the rationale for the microservice split".

| Backend | Precision | Recall | F1 Score | Notes |
|---------|-----------|--------|----------|-------|
| **Lossless** | 88% | 80% | 0.84 | DAG traversal reconstructs the full decision chain: the question, alternatives considered, and final choice. Highest precision for this query type. |
| **Total Recall** | 62% | 55% | 0.58 | Finds memory files containing decision keywords. Returns the decision itself but not the causal chain leading to it. |
| **QMD (query)** | 40% | 32% | 0.36 | Hybrid search finds indexed content mentioning decisions. No causal reconstruction -- just text snippets. |
| **Cognee** | 30% | 22% | 0.26 | Can find decision entities in the graph but the relationship paths describe code structure, not decision rationale. |

**Key takeaway**: Lossless excels at decision recall because it is specifically designed for it. The DAG structure preserves causal chains that flat search cannot reconstruct. Total Recall is a reasonable fallback (it stores decisions as memories) but lacks the "why" context.

---

## Storage Footprint

Disk usage after indexing the full test codebase (45K LOC, 380 files) plus 200 stored memories.

| Backend | Storage Used | Per 1,000 Memories (Estimated) | Notes |
|---------|-------------|-------------------------------|-------|
| **QMD (FTS5 only)** | 12 MB | N/A (indexes files, not memories) | FTS5 index for 380 source files. |
| **QMD (FTS5 + embeddings)** | 85 MB | N/A | Vector embeddings dominate storage. Proportional to file count and average file size. |
| **Total Recall** | 1.2 MB | ~6 MB | Git objects are compressed and deduplicated. Extremely space-efficient. Stored on an orphan branch so they do not inflate the working tree. |
| **Cognee** | 45 MB | N/A (stores graph, not individual memories) | Graph storage scales with entity and edge count, not memory count directly. A codebase with many classes/functions produces a larger graph. |
| **Lossless** | 3.5 MB | ~17 MB | SQLite DAG with 200 nodes. Growth is linear with conversation length. |

**Key takeaway**: Total Recall is the most storage-efficient backend by far, thanks to git's compression. QMD's embeddings are the largest storage consumer. Cognee's graph and Lossless's DAG fall in between.

---

## Scaling Characteristics

How each backend behaves as the amount of data grows.

### QMD

| Data Size | BM25 Query Time | Vector Query Time | Index Size |
|-----------|----------------|-------------------|------------|
| 100 files | 20ms | 80ms | 5 MB |
| 500 files | 50ms | 200ms | 90 MB |
| 2,000 files | 120ms | 500ms | 350 MB |
| 5,000 files | 250ms | 1,100ms | 850 MB |

QMD scales sub-linearly for BM25 (FTS5 is well-optimized) but linearly for vector search (brute-force cosine similarity). At 5,000+ files, vector query time approaches the router's 5-second timeout. **Recommendation**: split large codebases into multiple focused collections rather than one monolithic collection.

### Total Recall

| Memory Count | Search Time | Storage |
|--------------|-------------|---------|
| 50 | 25ms | 0.3 MB |
| 200 | 40ms | 1.2 MB |
| 1,000 | 120ms | 6 MB |
| 5,000 | 500ms | 30 MB |

Linear scaling. Git grep scans every memory file sequentially. At 5,000 memories, search time is still comfortable. Beyond 10,000, consider archiving old memories to a separate branch.

### Cognee

| Entity Count | 1-Hop Query | 3-Hop Query | 5-Hop Query | Graph Size |
|-------------|-------------|-------------|-------------|------------|
| 200 | 80ms | 200ms | 400ms | 15 MB |
| 1,000 | 120ms | 450ms | 900ms | 50 MB |
| 5,000 | 200ms | 1,200ms | 3,500ms | 200 MB |
| 10,000 | 350ms | 2,800ms | 5,000ms+ | 400 MB |

Multi-hop traversal scales poorly with entity count. At 10,000 entities and 5 hops, queries approach timeout. **Recommendation**: keep `max_traversal_depth` at 3 for large codebases, increase to 5 only when you need deep relationship chains.

### Lossless

| Node Count | Query Time | DAG Size |
|------------|------------|----------|
| 50 | 20ms | 0.8 MB |
| 200 | 40ms | 3.5 MB |
| 1,000 | 100ms | 18 MB |
| 5,000 | 350ms | 90 MB |

Linear scaling, similar to Total Recall. SQLite handles node counts well into the thousands. The main concern is not query time but DAG complexity -- at 5,000 nodes, the causal chains become difficult for the agent to interpret meaningfully.

---

## Router Overhead

The router adds dispatch and evaluation logic on top of backend query time.

| Scenario | Router Overhead | Total Time | Breakdown |
|----------|----------------|------------|-----------|
| Primary backend succeeds | 5 - 15ms | Backend time + 5-15ms | Signal matching + JSON wrapping |
| One fallback triggered | 10 - 25ms | Backend1 + Backend2 + 10-25ms | Two dispatches + relevance evaluation |
| Two fallbacks triggered | 15 - 35ms | B1 + B2 + B3 + 15-35ms | Three dispatches + two relevance evaluations |
| Backend timeout + fallback | 5,010 - 5,030ms | 5s (timeout) + Backend2 + overhead | Timeout is the dominant cost |

**Key takeaway**: Router overhead is negligible (under 35ms) in all non-timeout scenarios. The router adds value through backend selection and fallback, not latency.

### Fallback Frequency (observed over 100 test queries)

| Metric | Value |
|--------|-------|
| Primary backend sufficient (no fallback) | 78% |
| One fallback triggered | 18% |
| Two fallbacks triggered | 3% |
| Full chain exhaustion (partial result) | 1% |
| All backends failed | 0% |

Most queries are resolved by the primary backend. Fallbacks occur most often for ambiguous queries (rule 7) where QMD hybrid search returns low-confidence results and Total Recall provides a complementary time-based match.

---

## Comparison: Starter vs. Pro

What does Pro tier add quantitatively?

### Accuracy Improvement (Pro over Starter)

| Query Category | Starter Best Score (F1) | Pro Best Score (F1) | Improvement |
|----------------|------------------------|--------------------:|------------:|
| Exact symbol | 0.91 (QMD search) | 0.91 (QMD search) | 0% |
| Semantic concept | 0.81 (QMD hybrid) | 0.81 (QMD hybrid) | 0% |
| Relationship query | 0.31 (QMD hybrid) | 0.78 (Cognee) | +152% |
| Decision recall | 0.58 (Total Recall) | 0.84 (Lossless) | +45% |

**Pro tier does not improve search or semantic queries** -- QMD handles those well on Starter. Pro tier's value is in the two capabilities Starter fundamentally lacks: relationship traversal (+152% improvement) and decision chain reconstruction (+45% improvement).

### Latency Impact

| Scenario | Starter (Median) | Pro (Median) | Delta |
|----------|----------------:|-------------:|------:|
| Exact symbol query | 45ms | 45ms | 0ms |
| Semantic query | 220ms | 220ms | 0ms |
| Relationship query | 220ms (QMD fallback) | 350ms (Cognee direct) | +130ms |
| Decision recall | 35ms (Total Recall fallback) | 40ms (Lossless direct) | +5ms |

Pro tier is slightly slower for relationship queries (Cognee graph traversal vs. QMD text search) but the accuracy improvement far outweighs the latency cost. Decision recall is essentially the same speed.

### Fallback Reduction

| Metric | Starter | Pro |
|--------|--------:|----:|
| Queries requiring fallback | 32% | 22% |
| Queries with partial results | 8% | 1% |

Pro tier reduces fallback frequency because relationship and decision queries route to purpose-built backends (Cognee, Lossless) rather than falling through to text search approximations.

---

## Limitations and Honest Caveats

1. **Benchmarks are codebase-dependent.** A TypeScript monorepo, a Swift iOS app, and a Python data pipeline will produce different numbers. Our test codebase (45K LOC TypeScript) is representative of medium web projects but may not reflect your workload.

2. **Accuracy is human-evaluated.** Two reviewers scored each result independently and resolved disagreements by discussion. This is more reliable than automated metrics but still subjective.

3. **Cold start numbers are environment-sensitive.** SSD speed, available RAM, and background processes all affect cold start. The numbers here are from a clean-boot development machine.

4. **Cognee accuracy depends heavily on entity extraction quality.** Well-structured object-oriented code produces clean graphs. Procedural code, deeply nested closures, or dynamically typed languages produce noisier results.

5. **Lossless accuracy depends on conversation quality.** If past conversations were stream-of-consciousness rather than structured decision-making, Lossless's auto-decomposition produces lower-quality nodes.

6. **Vector embedding quality may vary.** QMD's semantic search accuracy depends on the embedding model. Different models or model updates could shift these numbers.

7. **Scaling numbers are extrapolated.** We measured at 380 files / 200 memories and extrapolated larger sizes based on algorithmic complexity (O(n) for grep, O(n log n) for FTS5, O(n^d) for graph traversal). Real-world performance at scale may differ.

---

## Summary

| Backend | Best At | Warm Latency | Setup Cost | Storage | Tier |
|---------|---------|-------------|------------|---------|------|
| **QMD** | Exact + semantic search | 45-220ms | 3-6 min | 85 MB | Starter |
| **Total Recall** | Recent context, zero setup | 35ms | <1 sec | 1.2 MB | Starter |
| **Cognee** | Relationship queries | 350ms | 5-12 min | 45 MB | Pro |
| **Lossless** | Decision reconstruction | 40ms | <1 sec | 3.5 MB | Pro |

The four backends are complementary, not competitive. Each dominates its specialty and underperforms outside it. The router's job is to dispatch queries to the right specialist -- and these benchmarks confirm that when it does, the results are strong.
