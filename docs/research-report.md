# OpenClaw Memory Stack: Backend Research Report

> **Pro-tier document** -- Full evaluation of 8 memory backends, architecture decisions, and technical analysis.

---

## Executive Summary

### The Memory Wall Problem

AI coding agents hit a fundamental constraint: the context window is finite, but projects are not. A typical Claude Code session on a medium codebase (50K-200K lines) generates 30-50K tokens of conversation within the first hour. By hour two, early decisions, architectural context, and code exploration results have been pushed out of the window or compressed beyond usefulness. This is the **memory wall**.

The consequences are predictable and well-documented across the AI-assisted development community:

- **Decision amnesia**: The agent forgets why a particular approach was chosen 40 minutes ago, leading to contradictory suggestions or re-litigating settled questions.
- **Redundant exploration**: Without memory of prior searches, the agent re-reads the same files, re-discovers the same patterns, and wastes tokens on ground already covered.
- **Context fragmentation**: Important relationships between code entities (e.g., "AuthMiddleware depends on JWTValidator which references UserSession") cannot be reconstructed once the original exploration leaves the window.
- **Conversation drift**: In long sessions, the agent gradually loses coherence with earlier work, producing suggestions that conflict with established patterns.

Default memory solutions (conversation history, basic RAG) address some of these issues but fail at scale. Simple vector search retrieves relevant snippets but cannot trace causal chains. Git history preserves changes but offers no semantic understanding. Knowledge graphs capture relationships but are poor at exact code lookup. No single backend solves the memory wall.

The OpenClaw Memory Stack takes a **multi-backend approach**: four specialized backends, each optimized for a different memory access pattern, coordinated by a deterministic router. This report documents how we arrived at this architecture, which backends we evaluated, and why we shipped the four we did.

---

## Backends Evaluated

We evaluated eight memory backends against six criteria (detailed in the next section). Four shipped in v1; four were evaluated and set aside for specific reasons.

### Shipped in v1

#### 1. QMD (BM25 + Vector Hybrid)

QMD is a local-first search engine that combines BM25 keyword matching with vector embeddings. It indexes files into named collections using glob patterns, stores everything in SQLite with FTS5, and supports three search modes: exact keyword (`search`), semantic vector (`vsearch`), and hybrid (`query`). QMD is the workhorse of the stack -- the backend that handles the broadest range of queries competently.

- **Runtime**: Bun (JavaScript/TypeScript)
- **Storage**: SQLite with FTS5
- **Key strength**: Three search modes cover exact symbols, semantic concepts, and ambiguous queries
- **Tier**: Starter

#### 2. Cognee (Knowledge Graph)

Cognee builds a structured graph of entities (classes, functions, modules, concepts) and relationships (depends_on, calls, implements, references) from code and documentation. It answers queries that no text-search backend can: "How does AuthMiddleware relate to UserSession?", "What depends on the payment module?", "Trace the call chain from controller to database." Graph traversal with configurable depth (up to 5 hops by default) reveals indirect relationships that flat search cannot surface.

- **Runtime**: Python 3.10+
- **Storage**: Local graph database
- **Key strength**: Relationship traversal between code entities
- **Tier**: Pro

#### 3. Total Recall (Git-Based)

Total Recall stores memories as timestamped markdown files on a dedicated orphan branch (`openclaw-memory`) in the project's git repository. Zero external dependencies -- just git. Retrieval uses `git log --grep` and `git grep`. Relevance is time-decayed: today's memories score 1.0, last week scores ~0.7, two weeks ago scores ~0.4, and anything older floors at 0.2.

- **Runtime**: Git (pre-installed on macOS/Linux)
- **Storage**: Git objects on an orphan branch
- **Key strength**: Zero dependencies, portable, auditable history
- **Tier**: Starter

#### 4. Lossless (DAG Compressor)

Lossless decomposes conversation turns into typed nodes (decisions, context, code changes, questions, answers, references) connected by causal and temporal edges in a directed acyclic graph. Stored in SQLite, the DAG preserves complete decision chains from conversations exceeding 50K tokens. When you need to reconstruct *why* a decision was made -- not just *what* was decided -- Lossless traces the causal path through the conversation graph.

- **Runtime**: SQLite (built into macOS) + OpenClaw plugin (`lossless-claw`)
- **Storage**: SQLite DAG file
- **Key strength**: Causal decision chain reconstruction
- **Tier**: Pro

### Evaluated, Not Shipped

#### 5. BrainX

BrainX is an experimental memory framework with an ambitious multi-modal indexing approach combining embeddings, knowledge graphs, and temporal indexing in a single system. We evaluated it extensively.

- **Why not shipped**: Too early stage. The API changed three times during our evaluation period. Core features (temporal indexing, cross-session linking) were documented but not fully implemented. Error handling was inconsistent -- queries would silently return empty results instead of proper error codes. We could not build reliable router integration against a moving target. BrainX may be worth revisiting when it reaches a stable release, but shipping it in v1 would have created a maintenance burden disproportionate to its value.

#### 6. Nowledge

Nowledge is a cloud-hosted knowledge management platform with strong semantic search capabilities and a polished API.

- **Why not shipped**: Cloud-only architecture with no self-hosted option. Every query routes through Nowledge's servers, which introduces latency (200-400ms network overhead per query), requires an internet connection, and means user code context leaves the local machine. The OpenClaw Memory Stack is designed for local-first operation -- developers working on proprietary codebases need their memory layer to stay on-machine. Nowledge's cloud dependency is a fundamental architectural mismatch, not a temporary limitation.

#### 7. OpenViking

OpenViking is an open-source BM25 + embedding search engine similar in concept to QMD.

- **Why not shipped**: Significant feature overlap with QMD. OpenViking's BM25 implementation scored within 5% of QMD on our test queries, and its vector search was comparable. However, QMD had several advantages: more mature FTS5 integration, better camelCase tokenization for code (critical for code search quality), and an established CLI with collection management. Shipping two backends that serve the same purpose would confuse users and complicate routing rules without adding capability. We chose QMD for its edge in code-specific search and kept OpenViking as a potential replacement if QMD development stalls.

#### 8. Vertex

Vertex leverages Google Cloud's Vertex AI platform for embedding generation and vector search, offering high-quality embeddings and scalable infrastructure.

- **Why not shipped**: Hard dependency on Google Cloud Platform. Requires a GCP project, service account credentials, and network access to Google's API endpoints. This conflicts with the stack's local-first, dependency-minimal design philosophy. Additionally, the per-query cost (embedding generation + vector search) would add ongoing expenses beyond the Pro subscription. For teams already invested in GCP, Vertex is excellent -- but it cannot be a default backend in a tool that must work offline, on any machine, with no cloud accounts.

---

## Evaluation Criteria

Each backend was assessed on six dimensions, weighted by their importance to the target user (individual developers and small teams using AI coding agents):

### 1. Latency (Weight: High)

Response time for a typical query. AI agents issue memory queries mid-conversation; delays beyond 1-2 seconds are perceptible and disruptive. We measured cold start (first query after install/reboot), warm query (subsequent queries with caches populated), and index/build time (initial setup cost).

**Target**: Warm queries under 500ms. Cold start under 2 seconds. Index build time tolerable as a one-time cost.

### 2. Accuracy (Weight: High)

How well the backend returns relevant results for its intended query type. We tested exact symbol lookup, semantic concept matching, relationship traversal, and decision recall separately -- each backend is expected to excel at its specialty, not be a generalist.

**Target**: >80% precision for the backend's primary query type. Acceptable degradation for secondary types (handled by router fallback).

### 3. Setup Complexity (Weight: Medium)

Number of steps, external dependencies, and configuration required to go from zero to working. Every additional dependency is a potential failure point and a support burden. We counted: runtime dependencies, package installations, configuration files, and manual steps.

**Target**: Starter backends should work with under 3 commands. Pro backends may require up to 5 commands but should not require manual configuration editing.

### 4. Dependency Weight (Weight: Medium)

The size and fragility of the dependency tree. A backend that pulls in 200 npm packages or requires a specific Python minor version creates upgrade risk and installation failures. We evaluated: number of direct dependencies, total transitive dependency count, and known fragility (e.g., native compilation requirements).

**Target**: Minimal dependency trees. Prefer backends that leverage existing system tools (git, sqlite) over those requiring language-specific ecosystems.

### 5. Self-Hosted Capability (Weight: High)

Whether the backend operates entirely on the local machine without network calls to external services. This is a hard requirement for the core stack -- developers working on proprietary code cannot have their memory layer phone home.

**Target**: 100% local operation for all shipped backends. No exceptions.

### 6. Maintenance Burden (Weight: Medium)

Ongoing effort required to keep the backend functional: reindexing frequency, cache invalidation, database compaction, version upgrades. A backend that works perfectly on day one but degrades without regular maintenance creates a poor long-term experience.

**Target**: Minimal ongoing maintenance. Auto-reindex hooks preferred. Manual intervention should be rare and well-documented.

---

## Detailed Analysis: Shipped Backends

### QMD -- The Versatile Generalist

**Strengths**:
- Three search modes (BM25, vector, hybrid) cover the full spectrum from exact symbol lookup to fuzzy concept matching.
- Collection-based organization allows per-project or per-layer indexing with appropriate glob patterns.
- SQLite FTS5 provides fast, reliable full-text search with no external services.
- BM25 scores, while inherently low for code (0.1-0.3 raw), are well-understood and predictable after normalization.
- Incremental updates via `qmd update` keep the index fresh without full rebuilds.

**Weaknesses**:
- Bun runtime dependency. While Bun is free and open source, it is not pre-installed on any OS. Every user must install it, and Bun's release cadence means occasional breaking changes.
- First-time embedding generation (`qmd embed`) on large collections can take several minutes. This is a one-time cost but creates a poor first impression.
- No real-time file watching. Index staleness is a real issue unless shell hooks (like `qx-auto-evolve.sh`) are configured.
- camelCase tokenization quirk: BM25 splits `handleAuthCallback` into tokens, producing low raw scores that can confuse users unfamiliar with the normalization formula.

**Ideal Use Cases**:
- Finding specific functions, classes, or symbols by name.
- Exploring unfamiliar codebases with broad conceptual queries.
- Searching documentation and code comments.
- Any query where you know roughly what words to look for.

**Gotchas**:
- Never set `minScore` above 0.3 for BM25 `search` mode -- you will miss valid results due to inherently low raw scores.
- Always specify `-c collection` when multiple collections exist; without it, search quality degrades on cross-collection queries.
- The `query` (hybrid) mode is the safest default but slightly slower than pure BM25 or pure vector search.

### Cognee -- The Relationship Mapper

**Strengths**:
- Unique capability in the stack: graph traversal for entity relationships. No other backend can answer "how does X relate to Y" with a traversal path.
- Automatic entity extraction from code (classes, functions, modules) and relationship inference (calls, depends_on, implements).
- Configurable traversal depth (default 5 hops) balances thoroughness against query time.
- Binary relevance for direct edges (1.0) and partial paths (0.5) gives the router clear signals.

**Weaknesses**:
- Python 3.10+ dependency adds a second runtime to the stack (alongside Bun for QMD). Most developers have Python installed, but version requirements can cause friction.
- Initial graph building is slow -- ingesting a large codebase takes minutes. This is the highest cold-start cost of any backend.
- Entity extraction quality depends heavily on code structure. Well-organized code with clear class/function boundaries extracts cleanly. Deeply nested, procedural code produces noisy graphs with low-value nodes.
- Graph noise compounds over time. Ingesting too much unstructured content (conversation logs, free-form notes) creates edges that slow traversal without adding value.
- Requires identifiable entities in queries. Vague queries like "how does stuff work" produce poor results -- Cognee needs at least one concrete entity name to anchor the traversal.

**Ideal Use Cases**:
- Understanding dependency chains between modules.
- Tracing call paths from entry points to data layers.
- Mapping architecture: which components connect and how.
- Answering "what would break if I change X" questions.

**Gotchas**:
- Cognee is not a text search engine. "Find code that mentions auth" should go to QMD, not Cognee.
- Graph quality is garbage-in, garbage-out. If you feed it unstructured prose, expect noisy results.
- The 5-hop default depth is a tradeoff. Increasing it improves recall but can dramatically slow queries on large graphs.

### Total Recall -- The Zero-Dependency Workhorse

**Strengths**:
- Truly zero dependencies beyond git. Works on any machine with a git repository. No runtime installations, no package managers, no configuration files to edit.
- Memories are git objects -- they inherit git's integrity guarantees, deduplication, and compression.
- Full audit trail: every memory is a commit with a timestamp, message, and diff. `git log` shows the complete memory history.
- Portable: clone the repo and the memories come with it. No separate database export/import.
- Time-decay relevance is simple and predictable. No tuning required.

**Weaknesses**:
- No semantic search whatsoever. `git grep` is literal text matching. "Authentication" will not match "login" unless both terms appear in the memory content.
- No relationship queries. Cannot answer "what decisions led to X" unless those links are explicitly written into the memory text.
- Time-based relevance is content-blind. A critical architecture decision from two weeks ago (score: 0.4) ranks lower than a trivial note from today (score: 1.0).
- Branch switching overhead during store operations. While `git worktree` mitigates this, it adds complexity.
- Linear scaling: search performance degrades linearly with memory count. Git grep is fast, but thousands of files will eventually slow down.
- No concurrent write safety. Multiple agents storing simultaneously can cause git conflicts.

**Ideal Use Cases**:
- Quick-start projects where installing Bun/Python is not worth the overhead.
- Storing conversation history and context snapshots during active development.
- Environments where only git is available (CI/CD, restricted servers, containers).
- Audit-trail requirements where every memory must be traceable and immutable.

**Gotchas**:
- The `openclaw-memory` orphan branch must be initialized before first use. `setup.sh` handles this, but manual setup requires `git checkout --orphan openclaw-memory`.
- Case-sensitive search by default. Use `-i` flags for case-insensitive matching.
- Large binary content should not be stored as memories -- git is not designed for binary blob management.

### Lossless -- The Decision Archaeologist

**Strengths**:
- Unique capability: causal chain reconstruction. Lossless can trace a decision back through the conversation that produced it -- the questions asked, the alternatives considered, the context that informed the choice.
- Typed nodes (decision, context, code_change, question, answer, reference) provide structured access to conversation history.
- Auto-decomposition: feed raw conversation text and the plugin extracts and classifies nodes automatically.
- SQLite storage is robust, portable, and well-understood. No exotic database engines.
- DAG integrity enforcement (no cycles) ensures traversal always terminates.

**Weaknesses**:
- Binary relevance (found = 1.0, not found = 0.0) provides no ranking. If 10 nodes match a query, the agent must read all of them to determine which is most useful.
- Keyword-based matching only. Like Total Recall, Lossless cannot bridge vocabulary gaps ("authentication" vs. "login").
- Plugin dependency (`lossless-claw`) ties the backend to the OpenClaw plugin registry. If the registry is unavailable or the plugin version is incompatible, the backend is entirely non-functional.
- No cross-conversation linking. Decisions from conversation A are invisible in conversation B. For cross-session memory, use QMD or Cognee.
- DAG growth in very long conversations (100K+ tokens) can slow queries. SQLite handles this reasonably well, but it is a known scaling limit.
- Circular real-world causality must be modeled as linear chains due to the DAG constraint (no cycles). This occasionally produces slightly artificial causal models.

**Ideal Use Cases**:
- Long-running architecture discussions where early decisions inform later work.
- Compliance or audit scenarios where the reasoning behind each decision must be recoverable.
- Multi-session projects where decisions made in session 1 need to be recalled in session 5.
- "Why did we choose X over Y?" questions that require reconstructing the decision context.

**Gotchas**:
- Lossless is a *conversation* memory backend, not a *code* search backend. Do not use it to find functions or search files.
- Auto-decomposition quality depends on conversation structure. Clear, well-articulated decisions decompose cleanly. Stream-of-consciousness conversation produces noisy nodes.
- The router treats Lossless as a supplementary source -- its binary relevance score is not compared numerically against gradient-scored backends (QMD, Cognee).

---

## Architecture Decision: Rule-Based Routing

### Why Not ML-Based Selection?

An early design considered using a lightweight classifier to route queries to the optimal backend based on learned patterns. We rejected this approach for three reasons:

**1. Predictability over optimization.** A rule-based router produces the same output for the same input, every time. An ML router might route the same query differently based on training data drift, model updates, or subtle feature changes. When debugging "why did the agent give a bad answer?", deterministic routing eliminates an entire class of hypotheses.

**2. Debuggability.** The rule table is a readable document. Any user can look at the seven rules, understand the signal detection patterns, and predict where their query will go. An ML model is a black box -- even if it achieves higher accuracy on average, individual misroutes are harder to diagnose and impossible to fix without retraining.

**3. Simplicity of implementation.** The rule-based router is approximately 200 lines of logic: read `backends.json`, match signals top-to-bottom, dispatch, evaluate relevance, fallback if needed. An ML router requires: training data collection, model training infrastructure, embedding generation for queries, inference latency, model versioning, and graceful degradation when the model is unavailable. The complexity cost far exceeds the accuracy benefit for a v1 product with four backends.

**The fallback chain compensates for routing errors.** Even when the rule-based router picks the wrong primary backend, the sequential fallback mechanism tries alternatives. This means the *worst case* for rule-based routing is slightly higher latency (one extra backend call), not a wrong answer. An ML router might avoid that extra call, but the saved 200-500ms is not worth the architectural complexity.

### Limitations of the Current Approach

- **Rule order sensitivity**: Rules are evaluated top-to-bottom. A query matching both rule 2 (relationship) and rule 4 (concept) always routes to rule 2. This is occasionally suboptimal but predictable.
- **No learning from outcomes**: The router does not track which backends produce the best results for different query patterns. Over time, a learning router could adapt to a user's specific codebase and query style. The current router cannot.
- **No multi-backend merging**: Results come from a single backend. In some cases, combining QMD text results with Cognee relationship paths would produce a richer answer. The current router does not merge results across backends.

---

## Future Directions

### v2 Candidates

**ML-Assisted Routing**: Rather than replacing rule-based routing entirely, v2 may add a lightweight confidence estimator that adjusts the fallback threshold based on query characteristics. The rule table stays as the primary dispatch mechanism, but the threshold for triggering fallback becomes adaptive.

**Cross-Backend Deduplication**: When fallback occurs and multiple backends return results, v2 could merge and deduplicate across backends. A QMD text result about `AuthMiddleware` combined with a Cognee relationship path for the same entity would produce a richer response than either alone.

**Memory Consolidation**: Periodic background process that identifies redundant or overlapping memories across backends and consolidates them. For example, if Total Recall and Lossless both store a decision about JWT auth, consolidation would link them or merge the content.

**Cross-Conversation Memory**: Currently, Lossless DAGs are per-conversation. A v2 feature could link related decisions across conversations, building a project-level decision history that persists across sessions.

**Additional Backend Candidates**: BrainX and Nowledge remain on the watchlist. If BrainX stabilizes its API, its multi-modal indexing could replace the need for separate QMD and Cognee backends. If Nowledge adds a self-hosted option, its semantic search quality could complement or replace QMD's vector mode.

**Performance Telemetry**: Anonymous, opt-in telemetry on routing outcomes (which backends produce accepted results, fallback frequency, query latency distributions) would inform both routing rule improvements and backend prioritization for v2.

---

## Conclusion

The OpenClaw Memory Stack ships four backends because the memory wall is not a single problem -- it is four distinct problems (exact search, relationship mapping, time-ordered history, causal chain reconstruction) that each require a specialized solution. The rule-based router coordinates these backends with predictable, debuggable dispatch and sequential fallback.

Pro tier unlocks the two backends (Cognee and Lossless) that address the most sophisticated memory access patterns: entity relationship traversal and causal decision reconstruction. These capabilities are fundamentally impossible with text search alone, which is why they represent the core value proposition of the Pro upgrade.

The architecture is deliberately conservative for v1 -- deterministic routing, single-backend results, no ML. This conservatism trades marginal accuracy improvements for reliability, debuggability, and maintainability. v2 will layer adaptive capabilities on top of this stable foundation.
