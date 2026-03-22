---
name: openclaw-memory-stack
description: "Multi-backend memory system for OpenClaw — 5 search engines with RRF rank fusion, knowledge graph, 3-tier token control. 90% token reduction. Free early bird until 2026-03-29."
version: 0.1.5
license: free
metadata:
  openclaw:
    requires:
      bins:
        - bash
        - curl
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

> **🎁 Early bird — free until March 29, 2026.** Full Starter license, yours forever.
> Get it now at [openclaw-memory.apptah.com](https://openclaw-memory.apptah.com)

A multi-backend memory system that replaces OpenClaw's built-in memory. 5 search engines, knowledge graph, 90% token reduction. One command to install.

## Get It (Free)

1. Go to [openclaw-memory.apptah.com](https://openclaw-memory.apptah.com)
2. Enter your email and click **Get Free — Early Bird**
3. Check your email for the install command
4. Paste it into your terminal — done. OpenClaw restarts automatically.

No credit card. No account. Just your email.

## What It Does

- **5 search engines** — BM25 full-text, vector semantic, knowledge graph (PageRank), DAG compression, fact extraction
- **RRF rank fusion** — merges results from all engines into one ranked list
- **3-tier token control** — L0 ~100 tokens, L1 ~800, L2 full content
- **Auto-recall** — relevant memories injected before every conversation turn
- **Auto-capture** — facts extracted and stored after every turn
- **Knowledge graph** — entity relationships with PageRank scoring
- **Fully offline** — your data never leaves your machine
- **Auto-updates** — new versions install in the background

## Requirements

| Dependency | Required | Notes |
|------------|----------|-------|
| bash | Yes | macOS/Linux shell |
| curl | Yes | For install |
| Bun | Recommended | Required for vector search |
| Python 3 | Optional | Used by some backends |

## How It Works

One command installs it as OpenClaw's memory provider. Every conversation, the plugin automatically:

1. Searches 5 engines for relevant memories
2. Merges results with Reciprocal Rank Fusion
3. Injects the best matches at your chosen token tier
4. Extracts new facts from the conversation and stores them

No per-project setup. No manual commands. It just works.

## License

**Currently free** (early bird until 2026-03-29). After that, $49 one-time purchase.

Get it now: [openclaw-memory.apptah.com](https://openclaw-memory.apptah.com)
