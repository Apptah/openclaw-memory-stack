# OpenClaw Memory Stack: Decision Matrix

> **Pro-tier document** -- Backend selection guide for choosing the right configuration for your workflow.

---

## How to Use This Matrix

This document helps you choose which backends to prioritize based on your specific scenario. The OpenClaw Memory Stack includes four backends, each optimized for a different type of memory query. You do not need to configure all four -- the router automatically skips backends that are not installed and falls back to alternatives.

**Read your scenario in the first table below, note the recommended Primary and Secondary backends, then cross-reference with the capability matrix to understand the tradeoffs.**

Starter tier includes QMD and Total Recall. Pro tier adds Cognee and Lossless. If a recommended backend is Pro-only and you are on Starter, the router automatically falls back to the best available Starter alternative.

---

## Scenario-Based Recommendations

| Scenario | Primary | Secondary | Why |
|----------|---------|-----------|-----|
| Solo dev, small project (<10K LOC) | Total Recall | QMD | Minimal overhead. Total Recall needs zero setup beyond git. QMD adds code search when you need to find specific symbols. Small projects rarely need relationship mapping or decision archaeology. |
| Team project, large codebase (50K+ LOC) | QMD | Cognee | Large codebases demand strong code search (QMD) plus relationship understanding (Cognee). When someone asks "what depends on the auth module?", Cognee traces the graph while QMD finds the code. |
| Long-running conversations (2+ hours) | Lossless | Total Recall | Conversations that exceed context window limits lose early decisions. Lossless preserves the full causal chain in a DAG. Total Recall provides time-stamped snapshots as a complementary safety net. |
| Architecture exploration | Cognee | QMD | Understanding how components connect is Cognee's core strength. QMD fills in the details -- once Cognee reveals that AuthMiddleware depends on JWTValidator, QMD finds the actual implementation code. |
| Quick prototyping | Total Recall | -- | When speed matters more than sophistication. Total Recall works immediately in any git repo with zero installation. Add other backends later if the prototype becomes a real project. |
| Compliance / audit trail | Total Recall | Lossless | Total Recall's git-based storage provides an immutable, timestamped audit trail for every memory. Lossless adds causal chain reconstruction -- not just *what* was decided, but the full reasoning path that led to each decision. |
| Polyglot / multi-language project | QMD | Cognee | QMD's BM25 tokenization works across languages. Cognee's entity extraction handles classes and functions regardless of source language. Total Recall's literal text search struggles with cross-language concept matching. |
| CI/CD or restricted environment | Total Recall | -- | When you cannot install Bun (QMD) or Python (Cognee), Total Recall is the only backend that works with just git. Lossless requires the OpenClaw plugin but only needs SQLite (built into macOS/most Linux). |
| Onboarding new team members | Cognee | QMD | New developers need to understand *relationships* between components, not just find individual files. Cognee maps the architecture; QMD lets them search for specific code once they know what to look for. |
| Debugging production issues | QMD | Lossless | Fast exact search (QMD) finds the relevant code. Lossless reconstructs the decision context -- why was this code written this way? What alternatives were considered? |

---

## Backend Capability Matrix

Ratings reflect each backend's effectiveness for a specific capability. Five stars means the backend excels at this task; one star means it can technically do it but poorly; no stars means the capability is absent.

| Capability | QMD | Total Recall | Cognee | Lossless |
|------------|-----|--------------|--------|----------|
| **Exact search** (find symbol by name) | ★★★★★ | ★★☆☆☆ | ★☆☆☆☆ | ★★★☆☆ |
| **Semantic search** (find by concept) | ★★★★☆ | ☆☆☆☆☆ | ★★★☆☆ | ☆☆☆☆☆ |
| **Relationship query** (how X relates to Y) | ☆☆☆☆☆ | ☆☆☆☆☆ | ★★★★★ | ★★☆☆☆ |
| **Decision recall** (why we chose X) | ★★☆☆☆ | ★★★☆☆ | ★★☆☆☆ | ★★★★★ |
| **Recent context** (what just happened) | ★★☆☆☆ | ★★★★★ | ☆☆☆☆☆ | ★★★☆☆ |
| **Cross-session memory** | ★★★★★ | ★★★★☆ | ★★★★★ | ☆☆☆☆☆ |
| **Setup ease** | ★★☆☆☆ | ★★★★★ | ★★☆☆☆ | ★★★☆☆ |
| **Zero dependencies** | ☆☆☆☆☆ | ★★★★★ | ☆☆☆☆☆ | ★★★☆☆ |
| **Audit trail** | ★☆☆☆☆ | ★★★★★ | ☆☆☆☆☆ | ★★★★☆ |
| **Scales to large codebases** | ★★★★☆ | ★★☆☆☆ | ★★★☆☆ | ★★★★☆ |

### Reading the Matrix

- **QMD** dominates search (exact and semantic) and cross-session memory. It is the default backend for a reason -- the broadest capability coverage. The cost is setup complexity (requires Bun) and no relationship understanding.
- **Total Recall** wins on simplicity and auditability. If your primary need is "remember what happened and make it searchable", Total Recall does it with zero friction. It falls short on any query requiring semantic understanding.
- **Cognee** is the only backend that handles relationship queries. If you need to understand architecture, trace dependencies, or map how components connect, Cognee is irreplaceable. It is poor at everything else -- text search, recent context, and decision recall are not its job.
- **Lossless** is the only backend optimized for decision reconstruction. It captures the *why* behind decisions, not just the *what*. Its weakness is isolation: each conversation's DAG is independent, so it provides no cross-session memory.

---

## Recommended Configurations by Team Size

### Solo Developer

**Starter tier is usually sufficient.**

| Configuration | Backends | Cost | Best for |
|---------------|----------|------|----------|
| Minimal | Total Recall only | Free (MIT) | Side projects, experiments, quick prototypes |
| Standard | QMD + Total Recall | Free (MIT) | Active development on a single project |
| Full | All four | Free (MIT) | Long-running projects where architecture decisions accumulate |

**Upgrade signal**: If you find yourself re-explaining past decisions to the agent or asking "how does X connect to Y" frequently, Pro tier pays for itself in saved context tokens.

### Small Team (2-5 developers)

**Pro tier recommended.**

| Configuration | Backends | Why |
|---------------|----------|-----|
| Recommended | QMD (primary) + Cognee + Total Recall | Code search for daily work, relationship mapping for architecture discussions, git-based history for shared context |
| With decision tracking | All four | Add Lossless when the team makes architectural decisions in AI-assisted sessions and needs to recall the reasoning later |

**Key consideration**: Cognee's relationship mapping becomes significantly more valuable in team settings. When developer A asks "what depends on the module developer B refactored last week?", Cognee provides the answer that no text search can.

### Larger Team (5+ developers)

**Pro tier strongly recommended.**

| Configuration | Backends | Why |
|---------------|----------|-----|
| Recommended | All four | At scale, all four memory access patterns occur regularly. The router handles dispatch automatically -- the cost of having all four installed is negligible compared to the cost of missing a memory type. |

**Key consideration**: Larger teams generate more architectural decisions, more cross-component dependencies, and longer conversation histories. All four backends earn their keep.

---

## Configuration by Project Type

### Web Application (frontend + backend)

- **Primary**: QMD -- index frontend (`**/*.tsx`, `**/*.css`) and backend (`**/*.ts`, `**/*.py`) as separate collections
- **Secondary**: Cognee -- map relationships between API routes, middleware, and data models
- **Tertiary**: Total Recall -- conversation history and context snapshots

### Library / Framework

- **Primary**: QMD -- index source, tests, and docs as separate collections
- **Secondary**: Cognee -- map public API surface to internal implementation
- **Tertiary**: Lossless -- preserve design decisions and API evolution rationale

### Mobile Application (Swift / Kotlin)

- **Primary**: QMD -- index source and UI files
- **Secondary**: Cognee -- map view hierarchy, navigation flow, and data layer dependencies
- **Tertiary**: Total Recall -- track iterative UI/UX decisions

### Data Pipeline / Infrastructure

- **Primary**: QMD -- index configuration, scripts, and pipeline definitions
- **Secondary**: Lossless -- preserve infrastructure decisions (why this region, why this instance type, why this retry policy)
- **Tertiary**: Cognee -- map pipeline stage dependencies

### Monorepo

- **Primary**: QMD -- create per-package collections with targeted glob patterns
- **Secondary**: Cognee -- map cross-package dependencies (critical in monorepos)
- **Tertiary**: Total Recall -- shared memory branch accessible from any package

---

## Quick-Start Decision Flowchart

```
START
  |
  v
Do you need to understand how code entities connect?
  |
  YES --> Install Cognee (Pro tier)
  NO  --> Continue
  |
  v
Do you have long conversations where early decisions get lost?
  |
  YES --> Install Lossless (Pro tier)
  NO  --> Continue
  |
  v
Do you need to search code by symbol names or concepts?
  |
  YES --> Install QMD (Starter tier, requires Bun)
  NO  --> Continue
  |
  v
Do you just need basic memory with zero setup?
  |
  YES --> Use Total Recall only (Starter tier, git only)
  |
  v
DONE -- The router handles dispatch automatically.
```

---

## A Note on the Router

You do not need to manually choose which backend to query. The Memory Router reads your query, detects signals (exact symbol names, relationship keywords, decision recall phrases, recency indicators), and dispatches to the appropriate backend automatically. If the primary backend returns poor results, the router falls through to alternatives.

The recommendations in this document help you decide **which backends to install**, not which to query. Once installed, the router does the rest.
