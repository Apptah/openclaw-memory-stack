# Changelog

All notable changes to OpenClaw Memory Stack are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/spec/v2.0.0.html).

## [0.6.1] — 2026-04-29

### Security
- `plugin/lib/ngram.mjs` — defense-in-depth SQL escape on `chunk_id` and `hash`
  before they reach inline SQL passed to `sqlite3`. Both already originate from
  the local `chunks` table, but escaping closes the path before any future
  writer that accepts arbitrary text could break the index. Centralized as
  `sqlQ()` helper at the top of the module.

### Fixed
- `install.sh:158` — `${ENCODED_EMAIL:-}` instead of `$ENCODED_EMAIL` so
  `--upgrade` doesn't abort under `set -u` when the optional email is unset.

### Changed — WSL2 reliability
- `install.sh` now detects WSL via `/proc/version` + `/proc/sys/kernel/osrelease`.
  WSL1 is refused with a `wsl --set-version 2` hint (its translation layer
  breaks SQLite locking and Bun). WSL2 is fully supported.
- WSL2 sessions running from `/mnt/<drive>/...` get a non-fatal warning about
  cross-filesystem IO performance and chmod/symlink quirks, with a 5s grace
  period before continuing.
- Step 1 also probes `$HOME/.bun/bin/bun` and adds it to PATH if found.
- Step 3 now actually invokes `install_bun()` when bun is missing, so qmd's
  `install_hint=bun install -g @tobilu/qmd` succeeds on a fresh Linux/WSL2
  install. Post-install verifies `command -v bun`.

### Notes for moderators
- This release targets the ClawHub `suspicious.dangerous_exec` appeal on
  `openclaw-memory-stack`. `child_process` usage remains bounded to local
  `sqlite3` and `qmd` invocations, declared in `openclaw.plugin.json`
  under `permissions.shellExecution` and audited at `plugin/lib/exec.mjs`.

## [0.6.0] — 2026-04-28

- `feat(install)`: refuse Windows native, point at WSL2 / Git Bash
- `docs`: align README + SKILL + landing with shipped behavior
- `feat(tier)`: agent-driven L0/L1 summaries via tier CLI
- `fix(router)`: repair detect_rule pipe+heredoc collision
- `test`: integration test verifying landing-page claims (20 checks)
