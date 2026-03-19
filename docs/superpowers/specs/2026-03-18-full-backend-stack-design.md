# OpenClaw Memory Stack — Full 8-Backend Architecture

## Context

The memory stack defines 8 backends across 5 classes in `router-config.json`, but only 3 skill directories exist (qmd wrapper, totalrecall, router). The remaining 5 backends have no implementation. QMD itself is an external dependency with no auto-install — users must manually install Bun + qmd + hope models download correctly.

This spec redesigns the system so that all 8 backends are real, fully functional, and auto-installed by `install.sh` from a blank machine.

## Requirements

- All 8 backends operational after `./install.sh --key=oc-xxx`
- User has nothing installed (just shell + internet)
- Single SKU: all backends included
- Subscription model for ongoing updates
- Total install footprint: ~4.5GB approximate (runtimes + packages + models)
- Fully offline after install (except license checks every 7 days)
- Platform: macOS + Linux. Windows via WSL2 (WSL2 treated as Linux — no special handling in v1)

---

## Architecture

### Runtime Bootstrap

`install.sh` auto-installs two runtimes before any backend:

1. **Bun** — `curl -fsSL https://bun.sh/install | bash`
   - Used by: QMD, OneContext
2. **uv (Python manager)** — `curl -LsSf https://astral.sh/uv/install.sh | sh`
   - Provides Python 3.12+ without touching system Python
   - Used by: OpenViking, sqlite-memory, Cognee, kuzu-memory, A-MEM

**Python isolation strategy:** All Python backends install into a single shared venv at `~/.openclaw/venv/`. Created via `uv venv ~/.openclaw/venv --python 3.12`. All `uv pip install` commands target this venv: `VIRTUAL_ENV=~/.openclaw/venv uv pip install <pkg>`. Wrapper scripts activate this venv before calling any Python tool: `source ~/.openclaw/venv/bin/activate`.

If dependency conflicts arise between backends, escalation path: split into per-backend venvs (`~/.openclaw/venv-cognee/`, etc.) in a future version.

**Minimum versions:** Bun >= 1.1, uv >= 0.5.

### Backend Mapping

| # | Backend ID | Class | Tool | Install Command | Disk |
|---|-----------|-------|------|-----------------|------|
| 1 | `qmd` | retrieval_engine | [QMD](https://github.com/tobi/qmd) | `bun install -g @tobilu/qmd` | ~2.1GB (3 GGUF models) |
| 2 | `openviking` | retrieval_engine | [OpenViking](https://github.com/volcengine/OpenViking) | `uv pip install openviking` | ~500MB |
| 3 | `totalrecall` | memory_store | Self-contained | None (git only) | ~0 |
| 4 | `vertex` | memory_store | [sqlite-memory](https://github.com/sqliteai/sqlite-memory) | `uv pip install sqlite-memory` | ~300MB |
| 5 | `cognee` | knowledge_graph | [Cognee](https://github.com/topoteretes/cognee) | `uv pip install cognee` | ~500MB |
| 6 | `nowledge` | knowledge_graph | [kuzu-memory](https://github.com/bobmatnyc/kuzu-memory) | `uv pip install kuzu-memory` | ~50MB |
| 7 | `lossless` | context_engine | [OneContext](https://github.com/AlexMikhalev/onecontext) | `bun install -g onecontext-ai` | ~100MB |
| 8 | `brainx` | experimental | [A-MEM](https://github.com/WujiangXu/A-mem) | `uv pip install a-mem` | ~300MB |

### Installer Flow

```
install.sh --key=oc-xxx
  1. Parse args + validate key format
  2. Generate device fingerprint
  3. Activate license (POST /api/activate)
  4. Detect platform (macOS/Linux)
  5. Bootstrap runtimes:
     a. Install Bun (if not present)
     b. Install uv (if not present)
     c. uv python install 3.12 (if no python)
  6. Install backends:
     a. QMD: bun install -g @tobilu/qmd
     b. QMD models: qmd embed --download-models (downloads 3 GGUF, ~2.1GB)
     c. OpenViking: uv pip install openviking
     d. sqlite-memory: uv pip install sqlite-memory
     e. Cognee: uv pip install cognee
     f. kuzu-memory: uv pip install kuzu-memory
     g. OneContext: bun install -g onecontext-ai
     h. A-MEM: uv pip install a-mem
  7. Copy skill files (bin/, lib/, skills/)
  8. Create symlink ~/.openclaw/bin/openclaw-memory
  9. Write state files:
     - version.json
     - license.json
     - backends.json (status for all 8)
  10. Summary + next steps
```

Each backend install step has error handling: if a backend fails to install, mark it as `unavailable` in `backends.json` and continue. The system degrades gracefully — router skips unavailable backends in the fallback chain.

### Skill Directory Structure

```
skills/
├── memory-router/
│     ├── router.sh              # Dispatch + fallback logic
│     └── router-config.json     # All 8 backends, no tier restriction
├── memory-qmd/
│     └── wrapper.sh             # QMD adapter (BM25/vector/hybrid)
├── memory-openviking/           # NEW
│     └── wrapper.sh             # OpenViking context DB adapter
├── memory-totalrecall/
│     └── wrapper.sh             # Git-based memory (unchanged)
├── memory-vertex/               # NEW
│     └── wrapper.sh             # sqlite-memory adapter
├── memory-cognee/               # NEW
│     └── wrapper.sh             # Cognee knowledge graph adapter
├── memory-nowledge/             # NEW
│     └── wrapper.sh             # kuzu-memory graph adapter
├── memory-lossless/             # NEW
│     └── wrapper.sh             # OneContext session context adapter
└── memory-brainx/               # NEW
      └── wrapper.sh             # A-MEM associative memory adapter
```

### Wrapper Contract

Every `wrapper.sh` implements 3 layers:

**Layer A — Native API**: Direct pass-through to the tool's CLI.
```bash
cmd_search()  { qmd search "$@"; }
cmd_store()   { ... }
cmd_status()  { ... }
```

**Layer B — Router Adapter**: Standardizes output for the router.
```bash
adapter() {
  # 1. Parse --hint → select tool-specific mode
  # 2. Execute tool command
  # 3. Normalize relevance to 0.0-1.0
  # 4. Build contract JSON (query_echo, results, status, etc.)
  # 5. Return within 5000ms timeout
}
```

**Layer C — Health Check**: Reports backend readiness.
```bash
cmd_health() {
  # Check: is the tool binary available?
  # Check: are required models downloaded?
  # Check: is the database initialized?
  # Return: { "status": "ready|unavailable|degraded", "reason": "..." }
}
```

**Contract JSON schema** (defined in `lib/contracts.sh`, all wrappers must conform):
```json
{
  "query_echo": "original query string",
  "results": [
    {
      "path": "src/auth/token.ts:42",
      "content": "first 500 chars of matching content...",
      "score": 0.72
    }
  ],
  "result_count": 3,
  "status": "success|empty|error|partial",
  "error_message": null,
  "error_code": null,
  "backend_duration_ms": 230,
  "normalized_relevance": 0.72,
  "backend": "qmd"
}
```
- `normalized_relevance`: float 0.0-1.0. Each wrapper is responsible for mapping its tool's native score range to this range.
- `results[].score`: per-item score, also 0.0-1.0.
- `results[].content`: max 500 chars. Truncate with `...` if longer.
- `status`: `success` = relevance >= 0.4 with results. `partial` = results found but relevance < 0.4. `empty` = no results. `error` = tool failed.

### Routing Rules (Updated)

All 10 rules dispatch to real backends:

| Rule ID | Signal Examples | Primary → Fallback |
|---------|----------------|-------------------|
| `exact_symbol` | "find function", "class X" | qmd(search) → openviking → totalrecall → vertex |
| `relationship` | "depends on", "call chain" | cognee → nowledge → qmd(vsearch) → totalrecall |
| `recent_decision` | "just decided", "this session" | lossless → totalrecall → vertex |
| `historical_decision` | "last week decided" | totalrecall → vertex → lossless |
| `unscoped_decision` | "decision" (no time signal) | totalrecall → lossless → vertex → qmd |

**Note on `unscoped_decision`:** Previously described as "co-primary." Simplified to sequential fallback like all other rules — totalrecall first, then lossless if relevance < 0.4. No parallel fan-out.
| `concept_behavior` | "how does X work" | qmd(vsearch) → openviking → totalrecall |
| `recent_context` | "just discussed" | totalrecall → vertex → qmd(search) |
| `file_path_pattern` | "path /", "glob *" | qmd(search) → openviking → totalrecall |
| `associative_recall` | "reminds me of", "related to" | brainx → cognee → nowledge → qmd(query) |
| `ambiguous_default` | (catch-all) | qmd(query) → openviking → totalrecall → vertex |

### Subscription & Update System

**Pricing:**
- $49 one-time → current version, no updates
- $9/month → always latest + priority support
- $79/year → 2 months free

**Server-side additions:**

New endpoint: `GET /api/version`
```json
// Request: ?key=oc-xxx&current=0.1.0
// Response:
{
  "latest": "0.2.0",
  "update_available": true,
  "subscription_active": true,
  "download_url": "/api/download/token123"
}
```

License schema update:
```json
{
  "tier": "full",
  "subscription_status": "active|expired|cancelled|lifetime",
  "subscription_end_date": "2027-03-18T00:00:00Z",
  "version_entitled": "latest|0.1.0"
}
```

Stripe checkout update: add `mode: "subscription"` option with `price_data.recurring`.

**Client-side update command:**
```bash
openclaw-memory update
  → GET /api/version?key=...&current=...
  → Download new artifact if available
  → Extract + replace files
  → Re-check backend dependencies (upgrade pip/bun packages if needed)
  → Write updated version.json
```

---

## Files to Create/Modify

### New files:
- `skills/memory-openviking/wrapper.sh`
- `skills/memory-vertex/wrapper.sh`
- `skills/memory-cognee/wrapper.sh`
- `skills/memory-nowledge/wrapper.sh`
- `skills/memory-lossless/wrapper.sh`
- `skills/memory-brainx/wrapper.sh`
- `server/src/version.ts` (new endpoint)

### Modified files:
- `install.sh` — add runtime bootstrap + 8 backend installs
- `skills/memory-router/router-config.json` — remove tier limits, add associative_recall rule
- `skills/memory-router/router.sh` — handle new backends in dispatch
- `scripts/build-release.sh` — include all 8 skill directories
- `server/src/index.ts` — add /api/version route
- `server/src/checkout.ts` — add subscription mode
- `server/src/webhook.ts` — handle subscription events
- `bin/openclaw-memory` — add `update` subcommand
- `lib/license.sh` — add subscription status checking
- `site/src/pages/index.astro` — update pricing section

---

## Verification

1. **Clean machine test**: Run `install.sh` on a fresh macOS/Linux VM with nothing installed. Verify all 8 backends report `ready` in `backends.json`.
2. **Router test**: For each of the 10 routing rules, send a matching query and verify it dispatches to the correct primary backend.
3. **Fallback test**: Disable a primary backend (rename its binary), send a query, verify fallback chain activates.
4. **Health check test**: Run `openclaw-memory status` and verify all 8 backends report health.
5. **Update test**: Deploy v0.2.0 to R2, run `openclaw-memory update`, verify files updated.
6. **Subscription test**: Create Stripe subscription checkout, verify recurring billing + license status.
7. **Offline test**: Disconnect internet, run queries against all backends, verify they work (except license re-verification which should use grace period).
