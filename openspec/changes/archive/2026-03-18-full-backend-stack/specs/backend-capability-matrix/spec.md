## ADDED Requirements

### Requirement: Machine-readable capability declaration
Every backend wrapper directory SHALL contain a `capability.json` that is the single source of truth for that backend's capabilities. Router, installer, health checks, and tests MUST read from this file — no hardcoded capability assumptions elsewhere.

#### Scenario: capability.json schema
- **WHEN** a `skills/memory-<name>/capability.json` is read
- **THEN** it MUST contain all of the following fields:
```json
{
  "capability_version": 1,
  "backend": "string — backend name, matches directory suffix",
  "supported_modes": ["array of strings — query modes this backend handles: exact, semantic, relationship, timeline, decision, grep, association"],
  "requires_credentials": "boolean — true if external API key or auth needed",
  "requires_external_service": "boolean — true if depends on running service (not just local CLI/lib)",
  "cold_start_ms": "number — typical first-query latency",
  "probe": {
    "l1_install": "string — shell command for install check (exit 0 = pass)",
    "l2_runtime": "string — shell command for runtime check (exit 0 = pass)",
    "l3_functional": "string — shell command for functional probe (exit 0 = pass, MUST be read-only, timeout enforced)",
    "l3_deep": "string|null — optional high-cost probe (write+read round-trip, only run with --deep flag)"
  },
  "install_hint": "string — human-readable install instruction"
}
```

### Requirement: capability_version field for schema evolution
Every `capability.json` SHALL include a `capability_version` integer field. Consumers (router, installer, health, tests) SHALL check this field and fail with a clear error if the version is higher than what they support.

#### Scenario: version mismatch detected
- **WHEN** a consumer reads `capability.json` with `capability_version: 2` but only supports version 1
- **THEN** the consumer logs an error naming the backend and the unsupported version, and treats the backend as `unavailable` rather than crashing

#### Scenario: adding new fields in future versions
- **WHEN** a new field is added to the capability schema
- **THEN** `capability_version` is bumped, and consumers that don't recognize the new version skip the backend gracefully

#### Scenario: capability.json exists for every backend
- **WHEN** a directory `skills/memory-<name>/` contains `wrapper.sh`
- **THEN** it MUST also contain `capability.json`
- **WHEN** build-release.sh runs
- **THEN** it verifies every backend directory has both `wrapper.sh` and `capability.json`

### Requirement: Router uses capability.json for mode filtering
The router SHALL read each backend's `capability.json` at dispatch time (or cache on first load) and skip backends whose `supported_modes` does not include the rule's hint.

#### Scenario: exact hint skips semantic-only backend
- **WHEN** a rule matches with hint `exact` and backend `cognee` has `supported_modes: ["semantic", "relationship"]`
- **THEN** the router skips `cognee` in the dispatch chain for this query

#### Scenario: no mode match falls through to next backend
- **WHEN** all backends in the primary class lack the required mode
- **THEN** the router proceeds to the fallback class (standard fallback behavior)

### Requirement: cmd_health reads probe commands from capability.json
The `cmd_health` function in each wrapper SHALL read its `capability.json` `probe` section and execute `l1_install`, `l2_runtime`, `l3_functional` in sequence to determine state.

#### Scenario: probe commands are authoritative
- **WHEN** `cmd_health` runs
- **THEN** it executes `probe.l1_install` from `capability.json`, then `probe.l2_runtime` if L1 passed, then `probe.l3_functional` if L2 passed
- **THEN** the state is determined by the highest passing level per the three-level model

#### Scenario: updating probe logic only requires editing capability.json
- **WHEN** a backend's probe condition changes (e.g., new model directory)
- **THEN** only `capability.json` needs updating — `cmd_health` logic in `wrapper.sh` does not change

### Requirement: Installer reads install_hint from capability.json
The `install.sh` SHALL read `capability.json` from each backend to determine install commands, rather than hardcoding package names.

#### Scenario: new backend auto-discovered by installer
- **WHEN** a new `skills/memory-foo/` directory with `capability.json` is added
- **THEN** `install.sh` picks it up without code changes — it reads `install_hint` and `probe.l1_install` to determine what to install
