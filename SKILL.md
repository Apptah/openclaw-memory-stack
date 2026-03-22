---
name: openclaw-memory-stack
description: "Drop-in OpenClaw memory replacement. Multi-engine search with result fusion, automatic context recall, and entity tracking. Core functions run locally."
version: 0.1.9
license: free
metadata:
  openclaw:
    requires:
      bins:
        - bash
    emoji: "\U0001F9E0"
    homepage: https://openclaw-memory.apptah.com
    tags:
      - memory
      - search
      - rag
      - vector-search
      - code-search
      - knowledge-management
    pricing:
      model: free
      amount: 0
      currency: usd
      url: https://openclaw-memory.apptah.com
      note: "Early bird — free until 2026-03-29. $49 after."
---

# OpenClaw Memory Stack

**Drop-in memory replacement for OpenClaw.** Multi-engine search with result fusion, automatic recall, and entity tracking.

> **Free until March 29, 2026.** Full Starter license, yours forever.
> Get it at [openclaw-memory.apptah.com](https://openclaw-memory.apptah.com)

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  OPENCLAW MEMORY STACK                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  SEARCH PIPELINE (runs on every conversation turn)           │
│                                                              │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐               │
│  │  E1  │ │  E2  │ │  E3  │ │  E4  │ │  E5  │               │
│  │ Full │ │Vector│ │ DAG  │ │ Fact │ │  MD  │               │
│  │ Text │ │Search│ │Compr.│ │Store │ │Files │               │
│  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘               │
│     └────────┴────────┴────────┴────────┘                    │
│                        │                                     │
│                        ▼                                     │
│               ┌──────────────┐                               │
│               │ Result Fusion│                               │
│               │ + Reranking  │                               │
│               └──────────────┘                               │
│                        │                                     │
│              ┌─────────┼─────────┐                           │
│              ▼         ▼         ▼                           │
│          ┌──────┐  ┌──────┐  ┌──────┐                        │
│          │  T1  │  │  T2  │  │  T3  │  Token Budget           │
│          │~100t │  │~800t │  │ full │  Control                │
│          └──────┘  └──────┘  └──────┘                        │
│                                                              │
│  CAPTURE (runs after every conversation turn)                │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐                        │
│  │    Fact       │    │   Entity     │                        │
│  │  Extraction   │    │  Tracking    │                        │
│  └──────────────┘    └──────────────┘                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Search Pipeline

5 engines search in parallel on every conversation turn:

| Engine | What it does |
|--------|-------------|
| Full-text | Keyword matching with relevance ranking |
| Vector | Semantic search — understands meaning, not just words |
| DAG | Compressed conversation history with drill-down |
| Fact store | Searches previously extracted facts and decisions |
| Markdown | Scans memory files directly |

Results from all engines are merged with rank fusion, deduplicated, reranked for diversity, and scored with time decay (recent memories rank higher).

## Token Budget Control

| Tier | Tokens | When used |
|------|--------|-----------|
| T1 | ~100 | Auto-recall (every turn, minimal cost) |
| T2 | ~800 | On-demand search response |
| T3 | ~2000 | Full content on request |

## Automatic Capture

After every conversation, the plugin extracts:
- **Facts** — decisions, preferences, requirements, deadlines (works offline; optional API key improves quality)
- **Entities** — names, relationships, changes over time (queryable on demand)

## What Changes vs OpenClaw Native

| | Native | Memory Stack |
|---|--------|-------------|
| Search engines | 1 | 5 (parallel, fused) |
| Result fusion | — | Rank fusion + diversity reranking |
| Token control | All or nothing | 3 tiers |
| Fact extraction | — | Automatic every turn |
| Entity tracking | — | Automatic, queryable |
| Auto-recall | Basic | Multi-engine fused |
| Core execution | Local | Local (update checks are background, fail-silent) |

## Get Started

Visit [openclaw-memory.apptah.com](https://openclaw-memory.apptah.com) for setup.

## License

**Currently free** (early bird until 2026-03-29). After that, $49 one-time purchase.
