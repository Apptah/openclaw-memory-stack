# Beat Vertex: 5-Dimension Memory Upgrade

> Make Memory Stack better than Vertex AI Memory Bank plugin on every dimension Vertex currently wins.

## Context

A third-party OpenClaw plugin (by Shubham Saboo) connects to Google Vertex AI Memory Bank for managed cross-agent persistent memory. It costs ~$8/month, requires a GCP account, and sends all data to Google Cloud.

Memory Stack's core advantages (free, private, offline) are unchallenged. This spec targets the 5 dimensions where Vertex currently wins:

1. Out-of-box experience
2. Fact extraction quality
3. Deduplication / conflict resolution
4. Cross-agent memory
5. Zero maintenance

**Target user**: Memory Stack paid subscriber running OpenClaw.
**LLM strategy**: User supplies their own API key. No API key = enhanced regex fallback.

---

## Dimension 1: Out-of-Box Experience

### Problem
Users must manually run `qmd collection add` + `qmd embed` after installation. Vertex users just install the plugin and configure GCP credentials.

### Design

**install.sh changes:**
- After downloading and placing files, automatically run:
  1. `qmd collection add` for the user's project
  2. `qmd embed` to index existing files
  3. Verify with `qmd status`
- On failure: print clear error, don't block install

**plugin register() changes:**
- On startup, check if qmd collection exists for current workspace
- If missing: auto-create collection + trigger background embed
- If pending embeddings detected: trigger background `qmd embed`
- First successful init: log "Memory Stack ready — engines: FTS5 + QMD + Graph"

### Why this beats Vertex
- Vertex: install plugin → configure GCP project → set credentials → enable Memory Bank API → first conversation
- Memory Stack: `curl ... | bash` → first conversation
- One command vs four steps. Zero external accounts needed.

### Acceptance Tests
1. Fresh machine: run `install.sh` → start OpenClaw → `memory_search test` returns results without any manual setup
2. Existing install with no collection: restart OpenClaw → plugin auto-creates collection, next search works
3. Install with no qmd binary: plugin falls back to FTS5-only mode, still functional

---

## Dimension 2: Fact Extraction Quality

### Problem
Current `rescue.mjs` has two paths:
- **LLM path**: requires user-configured API key, uses a generic prompt
- **Regex fallback**: only catches 4 patterns (decision/deadline/requirement/entity), low recall

Vertex uses Google's LLM with automatic fact distillation. Quality is high but generic.

### Design

**Premium path (user has API key):**

Rewrite the extraction prompt in `extractFactsWithLLM()` to produce atomic key-value facts, not sentence summaries:

```
Current output:  { type: "decision", fact: "We decided to use PostgreSQL for the new service" }
Target output:   { type: "decision", key: "database_choice", value: "PostgreSQL", scope: "new-service", supersedes: null, evidence: "line 42" }
```

Expanded fact types (4 → 8):
- `decision` — architectural/tool choices
- `deadline` — dates and time constraints
- `requirement` — must-have constraints
- `entity` — projects, services, people
- `preference` — user workflow preferences (NEW)
- `workflow` — how user does things (NEW)
- `relationship` — connections between entities (NEW)
- `correction` — user corrected the AI, important to remember (NEW)

Each fact includes:
- `confidence`: 0.0-1.0
- `evidence`: source line reference
- `supersedes`: ID of old fact this replaces (for conflict resolution)

Prompt specialization: optimized for developer memory scenarios — code decisions, architecture choices, debug conclusions, tool preferences. Not generic.

**Free path (no API key):**

Enhance `extractKeyFacts()` with:

1. **TF-IDF keyword extraction**: compute term frequency across the conversation, identify high-weight terms that indicate important topics even without pattern matches
2. **Sentence boundary detection**: split on actual sentence boundaries (not just newlines) for cleaner fact extraction
3. **Negation handling**: detect "we decided NOT to use X" as a decision, not skip it
4. **Extended patterns**: add regex patterns for the 4 new fact types (preference, workflow, relationship, correction)
5. **Co-reference lite**: track "it/this/that" referring to recently mentioned entities within same paragraph

### Why this beats Vertex
- Vertex prompt is generic (pets, shopping, general assistant). Our prompt is developer-domain-specific.
- Vertex extracts facts as flat strings. We extract structured key-value with supersedes chain.
- Without API key: our enhanced regex still extracts more than nothing (Vertex requires GCP = no fallback).

### Acceptance Tests
1. **LLM path**: Feed a conversation containing "We decided to use PostgreSQL" then "Actually, let's switch to MySQL" → extract two facts, second has `supersedes` pointing to first
2. **LLM path**: Feed a conversation with "I prefer small PRs over large ones" → extracts a `preference` type fact
3. **Regex path**: Feed "We will NOT use MongoDB" → extracts a `decision` fact with negation preserved
4. **Regex path**: Feed a conversation with no explicit decision keywords but heavy discussion of Redis → TF-IDF identifies "Redis" as key term, extracts an `entity` fact
5. **Both paths**: Run same 10 real conversation samples through both → LLM path extracts ≥ 2x more facts with ≥ 80% precision (manually verified)

---

## Dimension 3: Deduplication / Conflict Resolution

### Problem
The 4-level dedup algorithm exists in `quality.mjs` but only runs on **search results**. The `agent_end` hook writes facts to SQLite without checking for duplicates or contradictions.

Vertex handles dedup and conflict resolution automatically at write time.

### Design

**New module: `lib/dedup-gate.mjs`**

Called from `saveRescueFacts()` before INSERT:

```
New fact arrives
  → Level 1-3 check against existing facts in SQLite
    → Exact/normalized/substring match → SKIP (don't write)
  → Level 4 cosine check (if embedding available)
    → similarity > 0.9 → KEEP NEWER, archive older
  → Conflict detection
    → Same entity + same fact type + different value → SUPERSEDE
    → Old fact moves to facts_archive table
    → New fact written with supersedes reference
  → No match → INSERT normally
```

**Schema changes:**

```sql
-- New archive table
CREATE TABLE IF NOT EXISTS facts_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_id INTEGER,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  timestamp TEXT,
  archived_at TEXT DEFAULT (datetime('now')),
  archived_reason TEXT  -- 'superseded' | 'duplicate' | 'stale'
);
```

**Conflict detection logic:**
1. Extract entity names from the new fact (reuse `extractEntitiesFromLine`)
2. Query existing facts with same entity + same type
3. If found and value differs → supersede
4. If found and value same → skip (duplicate)

### Why this beats Vertex
- Vertex dedup is async (post-session). Ours is synchronous at write time — duplicates never enter the store.
- Vertex conflict resolution is opaque. Ours keeps an archive with reason, so users can review what was replaced.
- The `facts_archive` table provides an audit trail that Vertex doesn't offer.

### Acceptance Tests
1. Insert "database_choice: PostgreSQL" twice in two sessions → only one fact in `facts` table, zero in archive
2. Insert "database_choice: PostgreSQL" then "database_choice: MySQL" → one fact (MySQL) in `facts`, one (PostgreSQL) in `facts_archive` with reason "superseded"
3. Insert 100 random facts with 30% duplicates → run `memory_search health` → duplicate count = 0
4. Insert a fact, then insert a semantically identical but differently worded fact (with API key for cosine) → Level 4 catches it, only one fact stored

---

## Dimension 4: Cross-Agent Memory

### Problem
Memory Stack stores data in `~/.openclaw/memory-stack/` private paths. Other OpenClaw tools (Cursor, Windsurf integrations) can't read or write to it. Vertex shares memory across all agents in the same GCP project automatically.

### Design

**Unified storage path: `~/.openclaw/memory/`**

All memory artifacts move to the OpenClaw standard location:
- `~/.openclaw/memory/facts.db` — fact store (SQLite)
- `~/.openclaw/memory/graph.db` — knowledge graph (SQLite)
- `~/.openclaw/memory/MEMORY.md` — human-readable index
- `~/.openclaw/memory/rescue/` — rescue fact files (legacy compat)

Migration: on first run, detect old paths → move files → leave a symlink for backward compatibility.

**CLI interface: `openclaw-memory`**

A standalone CLI that any tool can shell-out to:

```bash
# Query memories
openclaw-memory query "PostgreSQL" --format json --limit 5

# Write a fact
openclaw-memory add --type decision --key database_choice --value PostgreSQL

# Health check
openclaw-memory health

# List recent facts
openclaw-memory recent --days 7
```

No plugin API dependency. Any tool that can run a shell command can read/write memory.

**Cross-session continuity:**

Already works via `before_agent_start` hook + SQLite. Unifying the storage path ensures new sessions read the latest facts regardless of which tool wrote them.

**File watcher for external writes:**

When plugin starts, scan `~/.openclaw/memory/` for `.md` files not yet indexed in `facts.db` → auto-ingest. This allows other tools to drop memory files without needing the CLI.

### Why this beats Vertex
- Vertex: locked to GCP project, only works with agents using Vertex AI Agent Development Kit
- Memory Stack: open file format + CLI, works with any tool that can run a shell command or write a file
- Cross-device: user syncs `~/.openclaw/memory/` via any file sync tool (iCloud, Dropbox, git) — their choice, not ours to dictate

### Acceptance Tests
1. OpenClaw session A writes a fact → OpenClaw session B auto-recalls it (cross-session)
2. Run `openclaw-memory add --type preference --key pr_size --value small` from terminal → OpenClaw session auto-recalls it (cross-tool write via CLI)
3. Drop a file `~/.openclaw/memory/cursor-notes.md` with content → OpenClaw session finds it via `memory_search` (cross-tool write via file)
4. Run `openclaw-memory query "PostgreSQL" --format json` → returns structured JSON with fact details (CLI read interface)

---

## Dimension 5: Zero Maintenance

### Problem
Users need to manually run `qmd embed` for pending embeddings, and there's no automatic cleanup or index repair. Vertex is fully managed.

### Design

**Auto-maintenance cycle in `register()`:**

On every plugin startup, run a maintenance check (throttled to once per 24 hours via `last_maintenance` timestamp in `~/.openclaw/memory/maintenance-state.json`):

```
register() startup
  → Read last_maintenance timestamp
  → If < 24hr ago → skip
  → Else run (all background, non-blocking):
    1. Auto-embed: qmd embed (timeout: 30s)
    2. Auto-cleanup: DELETE facts WHERE created_at < 90 days ago → archive
    3. Auto-dedup sweep: scan facts table with Level 1-3, remove accumulated duplicates
    4. Auto-FTS rebuild: compare facts rowcount vs FTS rowcount, rebuild if mismatched
    5. Auto-graph prune: remove entities with 0 edges and mentions = 1 (noise)
    6. Update last_maintenance timestamp
```

**Failure isolation:**
- Each task runs independently with its own timeout
- Any task failure → log warning, continue to next task
- Never blocks plugin startup or normal operation

**Health-based alerting:**
- After maintenance, compute health score
- If score < 70: append a one-line note to next auto-recall: `⚠ Memory health: {score}/100 — auto-repair in progress`
- If score < 50 after repair attempt: suggest user run `memory_search health` for details

### Why this beats Vertex
- Vertex is zero-maintenance but you pay $8/month for Google to manage it
- Memory Stack is zero-maintenance AND free — the plugin maintains itself
- Users get a health score and transparency into what's happening (Vertex is opaque)

### Acceptance Tests
1. Add 50 facts, manually delete FTS index → restart OpenClaw → FTS auto-rebuilds, search works normally
2. Insert 20 duplicate facts across multiple sessions → wait for next maintenance cycle → duplicates removed, archive contains originals
3. Use Memory Stack daily for 7 days without any manual commands → health score stays > 80
4. Kill `qmd embed` mid-run (simulate crash) → next startup detects pending, re-runs embed
5. Check `maintenance-state.json` shows timestamps → confirm cycle doesn't run more than once per 24hr

---

## Implementation Priority

| Order | Dimension | Effort | Impact |
|-------|-----------|--------|--------|
| 1 | Out-of-box (D1) | Small | Unblocks everything — users need working setup first |
| 2 | Dedup/conflict (D3) | Medium | Prevents garbage accumulation before we improve extraction |
| 3 | Fact extraction (D2) | Medium | Better facts + dedup gate = clean, high-quality memory |
| 4 | Cross-agent (D4) | Medium | Path migration + CLI, depends on D3 schema changes |
| 5 | Zero maintenance (D5) | Small | Wires together D1-D4 into self-sustaining system |

## Files to Change

| File | Changes |
|------|---------|
| `install.sh` | Add auto qmd init + collection + embed |
| `plugin/index.mjs` | Auto-init on startup, maintenance cycle, unified paths |
| `plugin/lib/constants.mjs` | New paths under `~/.openclaw/memory/` |
| `plugin/lib/rescue.mjs` | Rewrite extraction prompt, add 8 fact types, TF-IDF fallback |
| `plugin/lib/dedup-gate.mjs` | **NEW** — write-time dedup + conflict resolution |
| `plugin/lib/quality.mjs` | Add `facts_archive` schema, integrate dedup-gate |
| `plugin/lib/graph/store.mjs` | Update paths to unified location |
| `bin/openclaw-memory` | **NEW** — standalone CLI for cross-tool access |
| `tests/integration/test-dedup.sh` | **NEW** — dedup acceptance tests |
| `tests/integration/test-cross-agent.sh` | **NEW** — cross-agent acceptance tests |
| `tests/integration/test-maintenance.sh` | **NEW** — zero-maintenance acceptance tests |
