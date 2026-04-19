---
name: openclaw-memory-stack
description: "Total recall, 90% fewer tokens. Open source OpenClaw memory plugin — 5-engine local search, structured fact extraction, smart dedup, cross-agent sharing, and self-healing. Replace native memory with something that actually remembers. No cloud API, no subscription, MIT licensed and free."
version: "0.5.8"
license: mit
metadata:
  openclaw:
    requires:
      bins:
        - bash
        - python3
        - sqlite3
      anyBins:
        - bun
        - qmd
    emoji: "\U0001F9E0"
    homepage: https://github.com/Apptah/openclaw-memory-stack
    tags:
      - memory
      - search
      - rag
      - vector-search
      - code-search
      - knowledge-management
      - fact-extraction
      - entity-tracking
      - token-savings
      - long-term-memory
      - context-window
      - recall
      - local
      - offline
      - dedup
      - persistence
    pricing:
      model: free
      amount: 0
      currency: usd
      url: https://github.com/Apptah/openclaw-memory-stack
      note: "Free and open source under MIT license. No activation, no cloud dependency."
    network:
      - host: openclaw-api.apptah.com
        purpose: "Update check on manual upgrade. Sends only current_version."
      - host: localhost:8080
        purpose: "Local MLX LLM for fact extraction. Never leaves machine."
      - host: localhost:11434
        purpose: "Local Ollama LLM for fact extraction. Never leaves machine."
      - host: api.openai.com
        purpose: "Cloud LLM fallback for fact extraction. Only active if user sets API key. User-configurable endpoint."
    permissions:
      shell:
        - binary: sqlite3
          purpose: "Local database read/write for all 5 search engines. No arbitrary command execution."
        - binary: qmd
          purpose: "QMD CLI for vector search and collection management."
      fileAccess:
        read: ["~/.openclaw/memory-stack/", "~/.openclaw/memory/external/", ".openclaw/"]
        write: ["~/.openclaw/memory-stack/", "~/.openclaw/memory/"]
    envVars:
      - name: OPENCLAW_LLM_API_KEY
        purpose: "API key for cloud LLM fact extraction (optional)"
        sentTo: "user-configured llmEndpoint only"
      - name: OPENAI_API_KEY
        purpose: "Fallback API key for OpenAI (optional)"
        sentTo: "api.openai.com or user-configured llmEndpoint"
      - name: OPENCLAW_LCM_DB
        purpose: "Override lossless DB path (local only)"
      - name: OPENCLAW_ROUTER_CONFIG
        purpose: "Override router config path (local only)"
      - name: OPENCLAW_BACKENDS_JSON
        purpose: "Override backends config path (local only)"
    dataFlow:
      localOnly: "All search/storage (5 engines, sqlite3, markdown) runs on-device. Shell execution targets only local databases."
      remote: "License verify sends {key, device_id} only. LLM extraction sends conversation excerpts to user-configured endpoint."
      neverTransmitted: "Raw memory content never sent to apptah.com. No telemetry or analytics."
---

# OpenClaw Memory Stack

**Total recall. 90% fewer tokens.**

Your agent forgets past decisions and burns tokens re-reading the same context. Memory Stack runs 5 search engines locally, returns only what matters, and never loses a fact.

> **$49 one-time purchase.** No subscription, no cloud API costs.
> All search and storage runs on your machine. One-time license activation requires internet.
> Buy at [openclaw-memory.apptah.com](https://openclaw-memory.apptah.com)

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
│          │  L0  │  │  L1  │  │  L2  │  Token Budget           │
│          │~100t │  │~800t │  │ full │  Control                │
│          └──────┘  └──────┘  └──────┘                        │
│                                                              │
│  CAPTURE (runs after every conversation turn)                │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │    Fact       │  │   Entity     │  │   Dedup &    │        │
│  │  Extraction   │  │  Tracking    │  │  Supersede   │        │
│  │  (8 types)    │  │  (queryable) │  │  (3-level)   │        │
│  └──────────────┘  └──────────────┘  └──────────────┘        │
│                                                              │
│  CROSS-AGENT SHARING                                         │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │   CLI API    │  │  Drop Zone   │  │   Unified    │        │
│  │ query/add/   │  │  ~/.openclaw │  │   Global     │        │
│  │   recent     │  │  /external/  │  │   Memory     │        │
│  └──────────────┘  └──────────────┘  └──────────────┘        │
│         ▲                 ▲                 ▲                 │
│  Claude Code       Cursor / Windsurf    Any MCP client       │
│                                                              │
│  SELF-HEALING MAINTENANCE (24h cycle, zero config)           │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │  Auto-Init   │  │   Graceful   │  │   Health     │        │
│  │  workspace   │  │   Fallback   │  │   Monitor    │        │
│  │  + indexing   │  │  FTS5-only   │  │  + alerting  │        │
│  └──────────────┘  └──────────────┘  └──────────────┘        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Built-in Code Search

Find function names, variable names, or any pattern across your entire memory — instantly. No extra tools needed, works offline, gets faster the more you use it.

## 5-Engine Search

Five engines search in parallel on every conversation turn:

| Engine | What it does |
|--------|-------------|
| Full-text | Keyword matching with relevance ranking |
| Vector | Semantic search — understands meaning, not just words |
| Compressed history | Conversation DAG with drill-down |
| Fact store | Structured facts — decisions, deadlines, requirements |
| Markdown | Scans memory files directly |

Results are merged with rank fusion, deduplicated, reranked for diversity, and scored with time decay.

## 3-Tier Token Control

Every wasted token is money burned. Memory Stack eliminates the waste.

| Tier | Tokens | When used |
|------|--------|-----------|
| L0 | ~100 | Auto-recall every turn — minimal cost |
| L1 | ~800 | On-demand search summary |
| L2 | full | Full content on request |

## Structured Fact Memory

Extracts 8 fact types automatically: decisions, deadlines, requirements, entities, preferences, workflows, relationships, corrections.

- Structured key/value storage with confidence scores
- Negation-aware — "We will NOT use MongoDB" preserved correctly
- Automatic supersede — when a fact changes, old version archived, new one takes over

## Smart Dedup & Conflict Resolution

- 3-level write-time dedup: exact match, normalized text, structured key match
- Full audit trail via archive table
- Removes duplicates before sending — you never pay twice for the same memory

## Cross-Agent Memory Sharing

Works across Claude Code, Cursor, Windsurf, and any MCP-compatible client.

- CLI commands: `openclaw-memory query/add/recent` — any tool can read/write facts
- Drop zone: drop `.md` files into `~/.openclaw/memory/external/` — auto-ingested, no duplicates
- Unified global memory under `~/.openclaw/memory/` — your memory follows you across workspaces

## Self-Healing Maintenance

Zero maintenance. The plugin takes care of itself.

- Auto-init: detects workspace, creates search index, schedules embedding — no manual setup
- Graceful fallback: if vector search unavailable, runs in keyword-only mode — always functional
- 24h maintenance cycle: rebuilds index on corruption, archives stale facts, alerts on health issues

## OpenClaw Native vs Memory Stack

| | Native | Memory Stack |
|---|--------|-------------|
| Search engines | 2 | 5 (parallel, fused) |
| Token efficiency | Full text every time | Up to 90% fewer |
| Output tiers | Full text | 3 tiers (~100 / ~800 / full) |
| Fact extraction | No | 8 types, structured, negation-aware |
| Duplicate handling | Can pay twice | 3-level dedup, auto-supersede |
| Entity tracking | No | Yes, queryable |
| Cross-agent | No | CLI + drop zone, works with any tool |
| Memory across projects | Separate per workspace | Unified global memory — follows you everywhere |
| Self-healing | No | Auto-maintain, auto-fallback |
| Runs locally | Yes | Yes — all search local, one-time activation online |

## Install

```bash
npx clawhub@latest package install openclaw-memory-stack
```

Then run `./install.sh --key=oc-starter-xxxxxxxxxxxx` to activate with your license key.

Purchase at [openclaw-memory.apptah.com](https://openclaw-memory.apptah.com).

Runs on macOS, Linux, and Windows (WSL2). Requires bash, python3, and OpenClaw 2026.3.2 or later. Bun is optional (enables QMD vector search).

## What the installer does

The included `install.sh` performs the following actions:

- **Files**: Copies plugin and backend files to `~/.openclaw/memory-stack/`, registers plugin in `~/.openclaw/extensions/openclaw-memory-stack/`, updates `~/.openclaw/openclaw.json`
- **License activation**: Sends your license key and a device fingerprint (SHA-256 of machine ID) to `openclaw-api.apptah.com/api/activate` — one-time, at install
- **Periodic verification**: Re-verifies license every 7 days (background, non-blocking). Sends only `{ key, device_id }`. 10-day offline grace period
- **Upgrade downloads**: `install.sh --upgrade` downloads new versions from `openclaw-api.apptah.com` with mandatory SHA-256 checksum verification
- **No telemetry**: No usage data, memory content, or analytics are ever sent. Only license key and device ID leave your machine
- **Optional LLM**: `OPENCLAW_LLM_API_KEY` / `OPENAI_API_KEY` env vars are optional, used only for LLM-powered fact extraction. If not set, falls back to local Ollama/MLX. These keys are sent only to the endpoint you configure (default: api.openai.com), never to our servers

All search and storage runs entirely on your machine.

## License

Proprietary. $49 one-time purchase. All features included. No subscription.
See full terms at [openclaw-memory.apptah.com](https://openclaw-memory.apptah.com).

## Support

Questions or issues? Contact us at **support@apptah.com**.
