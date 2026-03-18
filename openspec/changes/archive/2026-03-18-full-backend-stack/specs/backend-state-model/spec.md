## ADDED Requirements

### Requirement: Four-state backend model
The system SHALL define four backend states: `ready`, `degraded`, `unavailable`, `installed`. Each state SHALL have defined router dispatch semantics.

#### Scenario: ready backend participates in dispatch
- **WHEN** a backend's health probe returns `ready`
- **THEN** the router includes it in the dispatch chain at normal priority

#### Scenario: degraded backend participates as deprioritized fallback
- **WHEN** a backend's health probe returns `degraded`
- **THEN** the router includes it in the dispatch chain but only after all `ready` backends across ALL classes in the chain have been exhausted

#### Scenario: unavailable backend is excluded
- **WHEN** a backend's health probe returns `unavailable`
- **THEN** the router excludes it from the dispatch chain

#### Scenario: installed backend is excluded
- **WHEN** a backend's state is `installed` (wrapper exists but probe not passed)
- **THEN** the router excludes it from the dispatch chain

### Requirement: Dispatch chain ordering is deterministic
The `router.sh` `build_dispatch_chain` function SHALL order the dispatch chain as follows, with no ambiguity:

1. Primary class `ready` backends (in config order)
2. Fallback class `ready` backends (in config order)
3. Primary class `degraded` backends (in config order)
4. Fallback class `degraded` backends (in config order)

This means the router exhausts ALL `ready` options (primary + fallback) before attempting ANY `degraded` backend.

#### Scenario: primary ready → fallback ready → primary degraded → fallback degraded
- **WHEN** rule `exact_symbol` has primary_class `retrieval_engine` [qmd(ready), openviking(degraded)] and fallback_class `memory_store` [totalrecall(ready), vertex(degraded)]
- **THEN** the dispatch chain is: `qmd → totalrecall → openviking → vertex`

#### Scenario: all ready backends fail threshold before degraded tried
- **WHEN** `qmd` (ready) returns relevance 0.1 and `totalrecall` (ready) returns relevance 0.2, both below fallback_threshold 0.4
- **THEN** the router tries `openviking` (degraded) next, before giving up

#### Scenario: co-primary dispatch_order respects degraded demotion
- **WHEN** a rule uses `dispatch_order` with explicit positions and some backends are degraded
- **THEN** degraded backends from dispatch_order are moved to the end of the chain, preserving their relative order

### Requirement: Three-level health probe
Each backend's `cmd_health` SHALL perform three sequential checks. The reported state is the LOWEST passing level:

| Level | Check | Pass → state | Fail → state |
|-------|-------|-------------|-------------|
| L1: install | wrapper exists, CLI/package importable | `installed` | `unavailable` |
| L2: runtime | runtime dependencies present (models, DB, venv) | `degraded` (if L3 fails) | `installed` |
| L3: functional | execute a real probe (trivial query, write+read, connection test) | `ready` | `degraded` |

A backend that passes L1 but fails L2 reports `installed`.
A backend that passes L1+L2 but fails L3 reports `degraded`.
A backend that passes all three reports `ready`.

#### Scenario: QMD with CLI but no models
- **WHEN** `qmd` command exists (L1 pass) but `~/.cache/qmd/models/` is empty (L2 fail)
- **THEN** `cmd_health` returns `installed` with reason "Models not downloaded"

#### Scenario: QMD with CLI and models but index corrupt
- **WHEN** `qmd` command exists (L1 pass), models present (L2 pass), but `qmd status --json` shows 0 collections or errors (L3 fail)
- **THEN** `cmd_health` returns `degraded` with reason "No collections indexed"

#### Scenario: QMD fully operational
- **WHEN** `qmd` command exists (L1 pass), models present (L2 pass), `qmd status` reports collections (L3 pass)
- **THEN** `cmd_health` returns `ready`

#### Scenario: Cognee importable but no API connection
- **WHEN** `python3 -c "import cognee"` succeeds (L1 pass), venv exists (L2 pass), but `cognee.search("test")` raises ConnectionError (L3 fail)
- **THEN** `cmd_health` returns `degraded` with reason "Cognee API unreachable"

#### Scenario: health probe reason includes remediation
- **WHEN** any probe level fails
- **THEN** the `reason` field includes both what failed and how to fix it (e.g., "Models not downloaded. Run: qmd embed --download-models")

### Requirement: L3 functional probe cost and side-effect constraints
L3 probes SHALL be low-cost and side-effect-free by default. High-cost probes (write+read, remote API calls) are only permitted behind an explicit `--deep` flag.

#### Scenario: default L3 probe is read-only
- **WHEN** `wrapper.sh health` is invoked without flags
- **THEN** the L3 probe (`probe.l3_functional` from capability.json) MUST NOT write data, create indexes, or call paid external APIs
- **THEN** acceptable L3 operations are: reading existing state, listing collections, checking local DB existence, verifying local socket/port

#### Scenario: L3 probe has enforced timeout
- **WHEN** `cmd_health` executes the L3 probe
- **THEN** the probe command is wrapped with a 5-second timeout (configurable via `OPENCLAW_PROBE_TIMEOUT`)
- **THEN** if the probe exceeds the timeout, the backend reports `degraded` with reason "probe timed out"

#### Scenario: deep probe for write+read validation
- **WHEN** `wrapper.sh health --deep` is invoked
- **THEN** the wrapper executes `probe.l3_deep` from capability.json (if present), which MAY perform a write+read round-trip
- **THEN** any data written by a deep probe MUST use a dedicated temp namespace (e.g., `__openclaw_probe_*`) and be cleaned up after the probe

#### Scenario: CLI health supports --deep flag
- **WHEN** `openclaw-memory health --deep` is invoked
- **THEN** the CLI passes `--deep` to each wrapper's `cmd_health`, triggering `l3_deep` probes where available
