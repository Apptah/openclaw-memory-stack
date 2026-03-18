## MODIFIED Requirements

### Requirement: Build artifact includes all backends dynamically
The `scripts/build-release.sh` SHALL dynamically discover and include all `skills/memory-*/` directories (excluding `memory-router` internals) and verify completeness.

#### Scenario: All backends in artifact
- **WHEN** `build-release.sh` runs
- **THEN** every `skills/memory-*/wrapper.sh` from the source tree is present in the build directory

#### Scenario: Missing backend fails build
- **WHEN** a `skills/memory-*/wrapper.sh` exists in source but not in build
- **THEN** the build script exits with error code 1

### Requirement: No tier-specific logic in build
The build script SHALL NOT reference starter, tier, `.starter.json`, or validate class counts. `version.json` SHALL NOT contain a `tier` field.

#### Scenario: version.json has no tier
- **WHEN** build completes
- **THEN** `version.json` contains `version` and `built_at` but no `tier` field

#### Scenario: No config swap
- **WHEN** build completes
- **THEN** `router-config.json` in artifact is identical to source (no `.starter.json` swap)
