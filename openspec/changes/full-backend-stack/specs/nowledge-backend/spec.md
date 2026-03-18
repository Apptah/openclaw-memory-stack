## ADDED Requirements

### Requirement: Nowledge wrapper wraps Nowledge Mem REST API with 3-Layer architecture
The `skills/memory-nowledge/wrapper.sh` SHALL wrap Nowledge Mem (local REST API on port 14242) with Layer A (search/store/threads), Layer B (router adapter), and Layer C (health check).

#### Scenario: Adapter searches via REST API
- **WHEN** `wrapper.sh --adapter "query"` is invoked and Nowledge Mem server is running
- **THEN** the wrapper calls `http://127.0.0.1:14242/api/memories/search` and returns valid contract JSON

#### Scenario: Health check verifies local server
- **WHEN** `wrapper.sh health` is invoked
- **THEN** L1 checks curl/wget available, L2 checks port 14242 is listening, L3 probes the API endpoint

#### Scenario: Server not running reports unavailable
- **WHEN** Nowledge Mem server is not running on port 14242
- **THEN** `cmd_health` returns `unavailable` with reason "Nowledge Mem server not running on :14242"
