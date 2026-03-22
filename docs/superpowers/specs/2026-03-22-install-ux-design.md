# Install & Update UX Simplification — Design Spec

**Date:** 2026-03-22
**Status:** Approved
**Constraint:** Core functionality (router, wrappers, contracts, plugin combinedSearch, hooks) MUST NOT be modified.

## Problem

New users face too many manual steps: manage page → download tarball → unzip → run installer → restart gateway → per-project init. Updates require manual intervention.

## Requirements

1. Email includes a single curl install command (with license key embedded)
2. QMD model download retained (required for search)
3. install.sh auto-restarts OpenClaw gateway without blocking
4. Memory Stack is global-only — no per-project init
5. Auto-update: detect → download → install → restart → notify
6. Simplified update flow (fully automatic)

## Design

### 1. One-Line Install via Email

**New API endpoint:** `GET /api/install.sh`

Returns a bootstrap shell script that:
1. Downloads latest tarball from R2 to `/tmp`
2. Extracts it
3. Runs `install.sh` with forwarded args (`--key=xxx`)
4. Cleans up temp files

```bash
#!/usr/bin/env bash
set -euo pipefail
TMP="/tmp/openclaw-install-$$"
TAR="$TMP.tar.gz"
trap 'rm -rf "$TMP" "$TAR"' EXIT
curl -fsSL "https://openclaw-license.busihoward.workers.dev/api/download/latest?key=$1" -o "$TAR"
mkdir -p "$TMP" && tar -xzf "$TAR" -C "$TMP"
bash "$TMP/install.sh" "$@"
```

**Email change (webhook.ts):**
- Replace "Download Now" button with a copyable `<code>` block containing:
  `curl -fsSL https://openclaw-license.busihoward.workers.dev/api/install.sh | bash -s -- --key=oc-starter-xxx`
- Keep license key box, help links, and footer unchanged

**Manage page (manage.astro):**
- "Request New Download Link" button generates the same curl command instead of a download URL

**Files changed:**
- `server/src/index.ts` — add route for `GET /api/install.sh`
- `server/src/webhook.ts` — email HTML: replace download button with curl command
- `site/src/pages/manage.astro` — generate curl command instead of download redirect

### 2. Auto-Restart Gateway

**install.sh** — append after summary banner:

```bash
if command -v openclaw &>/dev/null; then
  openclaw gateway restart 2>/dev/null &
  disown
  ok "OpenClaw gateway restarting"
fi
```

- Backgrounded with `& disown` to avoid blocking
- Skipped silently if `openclaw` not installed
- Applied to both fresh install (end of script) and upgrade (Phase 2 end)

**Files changed:**
- `install.sh` — add gateway restart at end of fresh install and upgrade flows

### 3. Global-Only (Remove Per-Project Init)

**Remove from `bin/openclaw-memory`:**
- `init` subcommand (lines 74-195)
- `embed` subcommand (lines 198-267)
- All references to `find_repo_config`, `merge_backends`, `set_repo_context`
- Search dispatch uses `~/.openclaw/state/backends.json` directly

**Remove from `lib/license.sh`:**
- `find_repo_config()` function
- `merge_backends()` function
- `set_repo_context()` function (if exists)

**`.openclaw-memory.json`** — no longer created or referenced. Existing files in user repos are ignored.

**Files changed:**
- `bin/openclaw-memory` — remove init, embed; simplify search dispatch
- `lib/license.sh` — remove repo context functions

### 4. Auto-Update

**Modify `plugin/index.mjs` `checkForUpdates()`:**

Current behavior: check version → log a message if update available.

New behavior:
1. Check version (existing logic, 24hr throttle)
2. If `data.update_available === true`:
   a. Run `~/.openclaw/memory-stack/install.sh --upgrade` via `child_process.execFile`
   b. Background execution, non-blocking
   c. `install.sh --upgrade` handles download → install → gateway restart
   d. On next gateway boot, plugin logs: `Memory Stack auto-updated to v{version}`
3. On failure: log warning, do not retry until next 24hr cycle
4. Write update result to `~/.openclaw/memory-stack/update-state.json`:
   ```json
   {
     "last_check": 1711108800000,
     "latest": "0.1.5",
     "auto_updated": true,
     "updated_at": "2026-03-22T12:00:00Z"
   }
   ```

**Post-update notification:**
On plugin init, check `update-state.json`. If `auto_updated === true` and version matches current:
```
api.logger.info(`Memory Stack auto-updated to v${version}`)
```
Then set `auto_updated = false`.

**Files changed:**
- `plugin/index.mjs` — modify `checkForUpdates`, add post-update notification on init

### 5. Manage Page Update

The "Request New Download Link" button already generates a curl command (implemented earlier today). Update it to use the new `/api/install.sh` endpoint format:

```
curl -fsSL https://openclaw-license.busihoward.workers.dev/api/install.sh | bash -s -- --key=oc-starter-xxx
```

**Files changed:**
- `site/src/pages/manage.astro` — update generated command format

## Safety Guarantees

**NOT modified (core functionality):**
- `skills/memory-router/router.sh` — routing logic unchanged
- `skills/memory-*/wrapper.sh` — all backend wrappers unchanged
- `lib/contracts.sh` — contract helpers unchanged
- `lib/platform.sh` — platform helpers unchanged
- `plugin/index.mjs` `combinedSearch()` — search pipeline unchanged
- `plugin/index.mjs` hooks (`before_agent_start`, `agent_end`) — unchanged
- `plugin/index.mjs` `memory_search` tool — unchanged
- `plugin/lib/*` — all engine modules unchanged
- `openclaw.plugin.json` — plugin manifest unchanged

**Regression test:** After implementation, verify:
1. `memory_search` tool returns results in OpenClaw
2. Auto-recall injects context before agent turns
3. Auto-capture extracts facts after agent turns
4. Cross-session memory recall works after gateway restart
