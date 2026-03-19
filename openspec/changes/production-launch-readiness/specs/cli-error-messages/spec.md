## ADDED Requirements

### Requirement: Unavailable backend returns error message
The CLI SHALL print a user-facing error when a query targets an unavailable backend.

#### Scenario: Query routed to unavailable backend
- **WHEN** a query is routed to a backend that is not installed
- **THEN** the CLI outputs a message containing "not available" and exits with non-zero code

### Requirement: Duplicate embed returns error message
The CLI SHALL print a user-facing error when `embed --background` is called while an embed job is already running.

#### Scenario: Embed while already running
- **WHEN** `openclaw-memory embed --background` is called and a background embed job is already in progress
- **THEN** the CLI outputs a message containing "already running" and exits with non-zero code

### Requirement: Revoked license re-verify returns error message
The CLI SHALL print a user-facing error when license re-verification discovers the key has been revoked.

#### Scenario: Re-verify revoked key
- **WHEN** the CLI performs periodic license re-verification and the server returns `reason: "revoked"`
- **THEN** the CLI outputs a message containing "revoked" and exits with non-zero code

### Requirement: Help lists backends with correct formatting
The CLI help output SHALL list starter backends with comma-space separation.

#### Scenario: Help shows backends
- **WHEN** `openclaw-memory --help` is run with only starter backends installed
- **THEN** the output contains `Backends: qmd, totalrecall` (with space after comma)

### Requirement: Router tier config
The router SHALL support tier-based configuration or the test expecting `router-config.starter.json` SHALL be updated to match actual behavior.

#### Scenario: Starter tier routing
- **WHEN** the router is invoked with starter tier
- **THEN** it routes queries only to starter-tier backends (qmd, totalrecall)
