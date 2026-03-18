## ADDED Requirements

### Requirement: openclaw-memory health subcommand
The `bin/openclaw-memory` CLI SHALL support a `health` subcommand (NOT `status`) that iterates all backend wrappers' `cmd_health` and displays aggregated results.

#### Scenario: All backends healthy
- **WHEN** `openclaw-memory health` is invoked and all backends report ready
- **THEN** output lists each backend name with "ready" status

#### Scenario: Mixed health states
- **WHEN** some backends are ready, some degraded, some unavailable
- **THEN** output shows each backend with its state and reason for non-ready backends

#### Scenario: health does not conflict with native status
- **WHEN** `openclaw-memory --backend qmd status` is invoked
- **THEN** it passes through to `cmd_status` (native `qmd status` output), not `cmd_health`
