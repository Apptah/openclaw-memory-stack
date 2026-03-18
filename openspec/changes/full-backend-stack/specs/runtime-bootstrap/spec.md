## ADDED Requirements

### Requirement: install.sh bootstraps all runtimes automatically
The `install.sh` SHALL detect and install Bun (via bun.sh) and uv (via astral.sh) if not present, create a shared Python venv, and install all backend dependencies.

#### Scenario: Fresh machine install
- **WHEN** `install.sh` runs on a machine with only curl and bash
- **THEN** Bun and uv are installed, Python 3.12 venv is created, all Python/Bun packages are installed

#### Scenario: Skip models flag
- **WHEN** `install.sh --skip-models` is invoked
- **THEN** QMD model download (~2.1GB) is skipped, and a message tells the user how to download later

#### Scenario: Individual backend install failure is non-fatal
- **WHEN** a specific Python package fails to install (e.g., network error)
- **THEN** a warning is shown but installation continues with remaining backends

### Requirement: install.sh copies all 8 backend skill directories
The `install.sh` SHALL copy all 8 backend wrapper directories to `$INSTALL_ROOT/skills/`.

#### Scenario: All backends present after install
- **WHEN** installation completes
- **THEN** `skills/memory-{qmd,totalrecall,openviking,vertex,cognee,nowledge,lossless,brainx}/wrapper.sh` all exist in `$INSTALL_ROOT`
