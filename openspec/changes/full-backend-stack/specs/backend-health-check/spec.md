## ADDED Requirements

### Requirement: contract_health helper in contracts.sh
The system SHALL provide a `contract_health()` function in `lib/contracts.sh` that outputs JSON with fields: `backend`, `status` (one of ready/degraded/unavailable), `reason`.

#### Scenario: Health check returns ready
- **WHEN** a backend is fully operational
- **THEN** `contract_health "qmd" "ready" ""` outputs `{"backend": "qmd", "status": "ready", "reason": ""}`

#### Scenario: Health check returns unavailable
- **WHEN** a backend's CLI tool is not installed
- **THEN** `contract_health "qmd" "unavailable" "qmd CLI not found"` outputs JSON with status "unavailable" and the reason message

### Requirement: Every wrapper implements cmd_health separate from cmd_status
Every backend wrapper SHALL implement `cmd_health()` for system-level probe (returns `contract_health` JSON). Existing `cmd_status()` functions (native tool status passthrough) SHALL NOT be modified.

#### Scenario: health and status are independent commands
- **WHEN** `wrapper.sh health` is invoked
- **THEN** the wrapper calls `cmd_health` and outputs `contract_health` JSON
- **WHEN** `wrapper.sh status` is invoked
- **THEN** the wrapper calls `cmd_status` and outputs native tool format (unchanged)

#### Scenario: Missing dependency reports unavailable with install hint
- **WHEN** the backend's primary CLI tool or Python package is not installed
- **THEN** `cmd_health` returns status `unavailable` with install instruction in `reason`

#### Scenario: Partial setup reports degraded
- **WHEN** the backend is installed but models/index/credentials are missing
- **THEN** `cmd_health` returns status `degraded` with remediation in `reason`
