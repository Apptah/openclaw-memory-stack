## ADDED Requirements

### Requirement: Vertex wrapper wraps openclaw-vertexai-memorybank with 3-Layer architecture
The `skills/memory-vertex/wrapper.sh` SHALL wrap the openclaw-vertexai-memorybank npm plugin (Google Vertex AI Memory Bank) with Layer A (search/store/forget), Layer B (router adapter), and Layer C (health check).

#### Scenario: Adapter searches Vertex AI Memory Bank
- **WHEN** `wrapper.sh --adapter "query"` is invoked and GCP is configured
- **THEN** the wrapper calls the plugin's `memorybank_search` tool and returns valid contract JSON

#### Scenario: Health check verifies GCP connectivity
- **WHEN** `wrapper.sh health` is invoked
- **THEN** L1 checks npm package installed, L2 checks GCP credentials present, L3 probes Memory Bank API

#### Scenario: Missing GCP credentials reports installed
- **WHEN** the npm package is installed but GCP credentials are not configured
- **THEN** `cmd_health` returns `installed` with reason "GCP credentials not configured"
