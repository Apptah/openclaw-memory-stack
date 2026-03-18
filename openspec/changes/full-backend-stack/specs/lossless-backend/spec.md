## ADDED Requirements

### Requirement: Lossless wrapper wraps lossless-claw OpenClaw plugin with 3-Layer architecture
The `skills/memory-lossless/wrapper.sh` SHALL wrap @martian-engineering/lossless-claw (DAG-based context engine) with Layer A (search/expand/describe), Layer B (router adapter), and Layer C (health check).

#### Scenario: Adapter searches compacted context
- **WHEN** `wrapper.sh --adapter "recent decision query"` is invoked and lossless-claw is installed
- **THEN** the wrapper calls `lcm_grep` or `lcm_describe` tools and returns valid contract JSON

#### Scenario: Health check verifies plugin installation
- **WHEN** `wrapper.sh health` is invoked
- **THEN** L1 checks the plugin is installed (`openclaw plugins list` contains lossless-claw), L2 checks SQLite DAG exists, L3 probes lcm_describe

#### Scenario: Plugin not installed reports unavailable
- **WHEN** lossless-claw plugin is not installed
- **THEN** `cmd_health` returns `unavailable` with reason "Install: openclaw plugins install @martian-engineering/lossless-claw"
