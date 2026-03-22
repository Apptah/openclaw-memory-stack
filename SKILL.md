---
name: openclaw-memory-stack
description: "Multi-backend memory system for Claude Code — BM25, vector search, HyDE query expansion, RRF rank fusion, bi-temporal filtering, and intelligent routing across 6 engines."
version: 0.1.3
license: commercial
metadata:
  openclaw:
    requires:
      env:
        - OPENCLAW_LICENSE_KEY
      bins:
        - bash
        - curl
      primaryEnv: OPENCLAW_LICENSE_KEY
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
      model: license-key
      amount: 49
      currency: usd
      url: https://openclaw-memory.apptah.com
---

# OpenClaw Memory Stack

A multi-backend memory system that gives Claude Code persistent, searchable memory across conversations.

## What It Does

- **6 search backends** — QMD (BM25 + vector), Lossless (DAG summarization), TotalRecall (full history), Nowledge (bi-temporal graph), OpenViking (tiered loading), Vertex (fact extraction)
- **Intelligent router** — automatically picks the best backend based on your query type
- **HyDE query expansion** — generates hypothetical documents to improve semantic search
- **RRF rank fusion** — merges results from multiple backends into one ranked list
- **Bi-temporal filtering** — search by both "when it happened" and "when you learned it"
- **Multi-provider LLM** — works with OpenAI, Anthropic, and local models for embeddings

## Quick Start

1. **Purchase a license** at [openclaw-memory.apptah.com](https://openclaw-memory.apptah.com) ($49 one-time)
2. **Install (one command — installs, registers, restarts OpenClaw):**
   ```bash
   curl -fsSL https://openclaw-license.busihoward.workers.dev/api/install.sh | bash -s -- --key=oc-starter-YOUR_KEY
   ```
3. **Done.** Memory Stack works globally — no per-project setup needed. Updates are automatic.

## Requirements

| Dependency | Required | Notes |
|------------|----------|-------|
| bash | Yes | macOS/Linux shell |
| curl | Yes | For license activation and install |
| Bun | Recommended | Required for QMD backend (vector search) |
| Python 3 | Optional | Used by some backends for JSON processing |

## Backends

| Backend | Type | Best For |
|---------|------|----------|
| QMD | BM25 + vector | Code search, symbol lookup, concept queries |
| Lossless | DAG summarization | Hierarchical drill-down into large codebases |
| TotalRecall | Full history | Complete conversation and edit history |
| Nowledge | Bi-temporal graph | Time-aware queries, expertise tracking |
| OpenViking | Tiered loading | Token-efficient retrieval (91% reduction) |
| Vertex | Fact extraction | Distilled facts, deduplication |

## How It Works

The router receives your query and selects the best backend based on the hint you provide (or auto-detects). If the first backend returns low-relevance results, it falls back to the next one. All results are normalized to a 0-1 relevance scale and merged via Reciprocal Rank Fusion when multiple backends respond.

## License

Commercial license. One-time purchase of $49 includes activation on up to 3 devices. See [LICENSE](LICENSE) for full terms.

Purchase at: https://openclaw-memory.apptah.com
