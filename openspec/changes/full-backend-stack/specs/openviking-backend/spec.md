## ADDED Requirements

### Requirement: OpenViking wrapper implements 3-Layer architecture
The `skills/memory-openviking/wrapper.sh` SHALL implement Layer A (native API passthrough), Layer B (router adapter returning contract JSON), and Layer C (health check).

#### Scenario: Adapter returns contract JSON on successful search
- **WHEN** `wrapper.sh --adapter "search query"` is invoked and openviking is available
- **THEN** the wrapper returns valid 9-field contract JSON with results from openviking

#### Scenario: Adapter returns unavailable when CLI missing
- **WHEN** `wrapper.sh --adapter "query"` is invoked and `openviking` command is not found
- **THEN** the wrapper returns contract JSON with status "error" and error_code "BACKEND_UNAVAILABLE"

#### Scenario: Mock mode returns fixture data
- **WHEN** `OPENCLAW_MOCK=1` environment variable is set
- **THEN** the adapter reads from `tests/fixtures/openviking-mock-response.json`

#### Scenario: Health check reports status
- **WHEN** `wrapper.sh health` is invoked
- **THEN** the wrapper returns health JSON with status "ready" or "unavailable"
