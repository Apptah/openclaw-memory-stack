# Install & Update UX Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify install to one curl command, make updates fully automatic, remove per-project init.

**Architecture:** Server gets a new `/api/install.sh` bootstrap endpoint. Email and manage page show curl command instead of download button. install.sh auto-restarts gateway. Plugin auto-updates silently with notification. Per-project init code removed.

**Tech Stack:** CF Worker (TypeScript), Bash (install.sh), ESM (plugin/index.mjs), Astro (manage page)

**Spec:** `docs/superpowers/specs/2026-03-22-install-ux-design.md`

**Safety constraint:** Do NOT modify any file under `skills/`, `lib/contracts.sh`, `lib/platform.sh`, `plugin/lib/`, `openclaw.plugin.json`, or the `combinedSearch`/hooks/`memory_search` sections of `plugin/index.mjs`.

---

### Task 1: Add `/api/install.sh` bootstrap endpoint

**Files:**
- Create: `server/src/install-script.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Create `server/src/install-script.ts`**

```typescript
import { Env } from "./utils";

export function handleInstallScript(request: Request, env: Env): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail
# OpenClaw Memory Stack — Bootstrap Installer
# Usage: curl -fsSL https://openclaw-license.busihoward.workers.dev/api/install.sh | bash -s -- --key=oc-starter-xxx

KEY=""
for arg in "$@"; do
  case "$arg" in
    --key=*) KEY="\${arg#--key=}" ;;
    --key)   shift; KEY="$1" ;;
  esac
done

if [ -z "$KEY" ]; then
  echo "Error: --key is required." >&2
  echo "Usage: curl -fsSL .../api/install.sh | bash -s -- --key=oc-starter-xxx" >&2
  exit 1
fi

TMP="/tmp/openclaw-install-$$"
TAR="$TMP.tar.gz"
trap 'rm -rf "$TMP" "$TAR"' EXIT

echo "Downloading OpenClaw Memory Stack..."
curl -fsSL "https://openclaw-license.busihoward.workers.dev/api/download/latest?key=$KEY" -o "$TAR"

if [ ! -s "$TAR" ]; then
  echo "Error: Download failed. Check your license key." >&2
  exit 1
fi

mkdir -p "$TMP"
tar -xzf "$TAR" -C "$TMP"

bash "$TMP/install.sh" "$@"
`;

  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
```

- [ ] **Step 2: Add route in `server/src/index.ts`**

Add import at top:
```typescript
import { handleInstallScript } from "./install-script";
```

Add route before the 404 catch-all:
```typescript
      } else if (method === "GET" && path === "/api/install.sh") {
        response = handleInstallScript(request, env);
```

- [ ] **Step 3: Build and verify**

Run: `cd server && npm run build --silent`
Expected: Build succeeds with no errors

- [ ] **Step 4: Deploy and test**

Run: `cd server && npx --yes --quiet wrangler deploy 2>&1 | tail -3`
Run: `curl -fsSL https://openclaw-license.busihoward.workers.dev/api/install.sh | head -5`
Expected: Returns the bootstrap script starting with `#!/usr/bin/env bash`

- [ ] **Step 5: Commit**

```bash
git add server/src/install-script.ts server/src/index.ts
git commit -m "feat: add /api/install.sh bootstrap endpoint"
```

---

### Task 2: Update email to show curl command

**Files:**
- Modify: `server/src/webhook.ts` (lines 107-248, email HTML only)

- [ ] **Step 1: Replace download button with curl command**

In `webhook.ts`, replace the "Download Button" section (lines 143-153) with:

```html
          <!-- Install Command -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#1a1a2e;border-radius:8px;overflow:hidden">
            <tr><td style="padding:16px 20px">
              <p style="margin:0 0 8px;font-size:12px;color:#a0aec0;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">📋 Install Command (copy & paste into terminal)</p>
              <code style="font-size:13px;color:#00e676;word-break:break-all;line-height:1.6">curl -fsSL https://openclaw-license.busihoward.workers.dev/api/install.sh | bash -s -- --key=${key}</code>
            </td></tr>
          </table>
```

Also remove the "⏳ This link expires" paragraph (line 151-153) since the curl command uses the license key directly, no token expiry.

- [ ] **Step 2: Update "How to use" steps**

Replace the 4-step how-to (lines 164-199) with:

```html
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
            <tr>
              <td style="padding:10px 0;vertical-align:top;width:32px">
                <span style="display:inline-block;width:24px;height:24px;background:#ebf5ff;color:#2563eb;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700">1</span>
              </td>
              <td style="padding:10px 0 10px 12px;font-size:14px;color:#4a5568;line-height:1.5">
                Open your terminal and paste the install command above
              </td>
            </tr>
            <tr>
              <td style="padding:10px 0;vertical-align:top;width:32px">
                <span style="display:inline-block;width:24px;height:24px;background:#ebf5ff;color:#2563eb;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700">2</span>
              </td>
              <td style="padding:10px 0 10px 12px;font-size:14px;color:#4a5568;line-height:1.5">
                That's it — OpenClaw restarts automatically. Memory Stack works behind the scenes. ✨
              </td>
            </tr>
          </table>
```

- [ ] **Step 3: Remove download token generation from webhook**

Remove lines 92-103 (download token generation and session KV update with downloadUrl) since the curl command uses `/api/download/latest?key=` directly. Keep the `session:${sessionId}` KV put at line 88 but set `downloadUrl: ""`.

- [ ] **Step 4: Build, deploy, test**

Run: `cd server && npm run build --silent && npx --yes --quiet wrangler deploy 2>&1 | tail -3`

- [ ] **Step 5: Commit**

```bash
git add server/src/webhook.ts
git commit -m "feat: email shows one-line curl install command"
```

---

### Task 3: Auto-restart gateway in install.sh

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add gateway restart at end of fresh install**

Replace lines 674-678 (the manual restart hint) with:

```bash
echo ""
echo -e "  ${GREEN}Memory Stack is now active.${NC}"

# Auto-restart OpenClaw gateway
if command -v openclaw &>/dev/null; then
  echo -e "  Restarting OpenClaw gateway..."
  openclaw gateway restart 2>/dev/null &
  disown
  echo -e "  ${GREEN}OpenClaw gateway restarting.${NC}"
else
  echo -e "  ${YELLOW}OpenClaw not found — start it manually when ready.${NC}"
fi
echo ""
```

- [ ] **Step 2: Add gateway restart at end of upgrade (Phase 2)**

Replace line 254 (`echo "  Run: openclaw gateway restart"`) with:

```bash
if command -v openclaw &>/dev/null; then
  openclaw gateway restart 2>/dev/null &
  disown
  echo -e "  OpenClaw gateway restarting."
else
  echo "  Start OpenClaw when ready."
fi
```

- [ ] **Step 3: Test**

Run: `bash install.sh --help`
Expected: Help text displays (sanity check script parses)

- [ ] **Step 4: Commit**

```bash
git add install.sh
git commit -m "feat: auto-restart gateway after install/upgrade"
```

---

### Task 4: Remove per-project init (global-only)

**Files:**
- Modify: `bin/openclaw-memory`
- Modify: `lib/license.sh`

- [ ] **Step 1: Remove `find_repo_config`, `merge_backends`, `set_repo_context` from `lib/license.sh`**

Delete the `find_repo_config()` function (current lines ~218-234).
Delete the `merge_backends()` function (current lines ~237-276+).
Delete `set_repo_context()` if it exists.

- [ ] **Step 2: Remove `init` subcommand from `bin/openclaw-memory`**

Delete the `init` block (lines 74-195 in original, starting with `if [ "${1:-}" = "init" ]`).

- [ ] **Step 3: Remove `embed` subcommand from `bin/openclaw-memory`**

Delete the `embed` block (lines 198-267 in original, starting with `if [ "${1:-}" = "embed" ]`).

- [ ] **Step 4: Simplify search dispatch**

The search dispatch section (end of file) should become:

```bash
# ── Router dispatch: full license check ───────────────────────────
if [ -z "$QUERY" ]; then
  echo "Error: no query provided. Use --help for usage." >&2
  exit 1
fi

require_licensed

ROUTER_ARGS=("$QUERY")
[ -n "$HINT" ] && ROUTER_ARGS+=(--hint "$HINT")
ROUTER_ARGS+=(--backends-json "$HOME/.openclaw/state/backends.json")

exec bash "$ROUTER" "${ROUTER_ARGS[@]}"
```

- [ ] **Step 5: Update --help text**

Remove `init` and `embed` from the help text. Remove "Run this command from within your project directory."

- [ ] **Step 6: Test CLI**

Run: `cd /tmp && ~/.openclaw/bin/openclaw-memory --help`
Expected: Help text without init/embed, no "project directory" mention

Run: `cd /tmp && ~/.openclaw/bin/openclaw-memory --version`
Expected: `openclaw-memory v0.1.4`

- [ ] **Step 7: Commit**

```bash
git add bin/openclaw-memory lib/license.sh
git commit -m "feat: remove per-project init, memory-stack is global-only"
```

---

### Task 5: Auto-update in plugin

**Files:**
- Modify: `plugin/index.mjs` (ONLY `checkForUpdates` function and plugin init notification — do NOT touch combinedSearch, hooks, or memory_search)

- [ ] **Step 1: Add `execFile` import**

Add at top of file:
```javascript
import { execFile } from "node:child_process";
```

- [ ] **Step 2: Replace `checkForUpdates` function**

Replace the existing `checkForUpdates` function (lines 32-86) with:

```javascript
function checkForUpdates(api) {
  (async () => {
    try {
      const stateDir = resolve(HOME, ".openclaw/memory-stack");
      const statePath = resolve(stateDir, "update-state.json");

      // Throttle: 24hr
      let state = {};
      try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
      if (Date.now() - (state.last_check || 0) < 86_400_000) return;

      // Read local version + license
      const versionFile = resolve(stateDir, "version.json");
      const licenseFile = resolve(HOME, ".openclaw/state/license.json");
      if (!existsSync(versionFile) || !existsSync(licenseFile)) return;

      const version = JSON.parse(readFileSync(versionFile, "utf8"));
      const license = JSON.parse(readFileSync(licenseFile, "utf8"));

      // Check update (5s timeout)
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `https://openclaw-license.busihoward.workers.dev/api/check-update?key=${encodeURIComponent(license.key)}&current=${encodeURIComponent(version.version)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);

      if (!res.ok) {
        atomicWrite(statePath, { last_check: Date.now(), latest: null });
        return;
      }

      const data = await res.json();

      if (data.update_available) {
        // Auto-update: run install.sh --upgrade in background
        const installSh = resolve(stateDir, "install.sh");
        if (existsSync(installSh)) {
          execFile("bash", [installSh, "--upgrade"], {
            detached: true,
            stdio: "ignore",
          }, (err) => {
            const result = {
              last_check: Date.now(),
              latest: data.latest,
              auto_updated: !err,
              updated_at: new Date().toISOString(),
              error: err ? err.message : null,
            };
            atomicWrite(statePath, result);
          }).unref();
        } else {
          atomicWrite(statePath, { last_check: Date.now(), latest: data.latest });
        }
      } else {
        atomicWrite(statePath, { last_check: Date.now(), latest: data.latest || null });
      }
    } catch {
      // Silent — never block normal startup
    }
  })();
}

function atomicWrite(path, data) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}
```

- [ ] **Step 3: Add post-update notification at plugin init**

In the `setup` function (after the `checkForUpdates(api)` call), add:

```javascript
    // Post-update notification
    try {
      const updateState = resolve(HOME, ".openclaw/memory-stack/update-state.json");
      if (existsSync(updateState)) {
        const us = JSON.parse(readFileSync(updateState, "utf8"));
        if (us.auto_updated === true) {
          api.logger.info(`\u{2705} Memory Stack auto-updated to v${us.latest}`);
          us.auto_updated = false;
          atomicWrite(updateState, us);
        }
      }
    } catch {}
```

- [ ] **Step 4: Commit**

```bash
git add plugin/index.mjs
git commit -m "feat: auto-update with background install and notification"
```

---

### Task 6: Update manage page

**Files:**
- Modify: `site/src/pages/manage.astro`

- [ ] **Step 1: Update download button handler**

Replace the `downloadBtn` click handler's `installCmd` line to use the new format:

```javascript
const installCmd = `curl -fsSL https://openclaw-license.busihoward.workers.dev/api/install.sh | bash -s -- --key=${currentKey}`;
```

(This no longer uses a download token URL — it uses the key directly via the bootstrap script.)

- [ ] **Step 2: Also update the form submit handler**

The lookup form's success handler should show the same format if it currently shows a different install command.

- [ ] **Step 3: Build and deploy**

Run: `cd site && npm run build --silent`
Run: `npx --yes --quiet wrangler pages deploy dist/ --project-name openclaw-site 2>&1 | tail -3`
Run: `npx --yes --quiet wrangler pages deploy dist/ --project-name openclaw-memory-stack 2>&1 | tail -3`

- [ ] **Step 4: Commit**

```bash
git add site/src/pages/manage.astro
git commit -m "feat: manage page uses curl bootstrap command"
```

---

### Task 7: Build, package, upload v0.1.5

**Files:**
- Modify: `bin/openclaw-memory` (version bump)

- [ ] **Step 1: Bump version to 0.1.5**

In `bin/openclaw-memory`, change `VERSION="0.1.4"` to `VERSION="0.1.5"`.

- [ ] **Step 2: Copy updated files to installed location**

```bash
cp bin/openclaw-memory ~/.openclaw/memory-stack/bin/
cp lib/license.sh ~/.openclaw/memory-stack/lib/
cp install.sh ~/.openclaw/memory-stack/
cp plugin/index.mjs ~/.openclaw/extensions/openclaw-memory-stack/
cp skills/memory-router/router-config.json ~/.openclaw/memory-stack/skills/memory-router/
```

- [ ] **Step 3: Build tarball**

```bash
VERSION="0.1.5"
DIST_DIR="dist/openclaw-memory-stack-v${VERSION}"
rm -rf "$DIST_DIR" && mkdir -p "$DIST_DIR"
cp -r bin/ "$DIST_DIR/bin/"
cp -r lib/ "$DIST_DIR/lib/"
cp -r skills/ "$DIST_DIR/skills/"
cp install.sh "$DIST_DIR/"
mkdir -p "$DIST_DIR/plugin" && cp -r plugin/ "$DIST_DIR/plugin/" 2>/dev/null
echo "{\"version\":\"${VERSION}\",\"released_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$DIST_DIR/version.json"
cd dist && tar -czf "openclaw-memory-stack-v${VERSION}.tar.gz" -C "openclaw-memory-stack-v${VERSION}" .
```

- [ ] **Step 4: Upload to R2 and update manifests**

```bash
cd server
npx --yes --quiet wrangler r2 object put "openclaw-releases/v0.1.5/openclaw-memory-stack-v0.1.5.tar.gz" --file ../dist/openclaw-memory-stack-v0.1.5.tar.gz --content-type application/gzip
echo '{"version":"0.1.5","released_at":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' | npx --yes --quiet wrangler r2 object put "openclaw-releases/latest.json" --pipe --content-type application/json
echo '{"version":"0.1.5","released_at":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' | npx --yes --quiet wrangler r2 object put "openclaw-releases/v0.1/latest-patch.json" --pipe --content-type application/json
```

- [ ] **Step 5: Commit**

```bash
git add bin/openclaw-memory
git commit -m "chore: bump to v0.1.5 — simplified install UX"
```

---

### Task 8: End-to-end verification

- [ ] **Step 1: Test bootstrap script**

Run: `curl -fsSL https://openclaw-license.busihoward.workers.dev/api/install.sh | head -10`
Expected: Returns bash script

- [ ] **Step 2: Test manage page**

Open: `https://openclaw-memory.apptah.com/manage`
Enter license key and email → click "Request New Download Link"
Expected: Shows curl command with `/api/install.sh` format, auto-copies to clipboard

- [ ] **Step 3: Test via Telegram (龍蝦)**

Send: `搜索記憶中關於「install」的內容`
Expected: Returns results from memory engines (confirms core functionality intact)

- [ ] **Step 4: Verify gateway restart worked**

Run: `tail -5 ~/.openclaw/logs/gateway.log`
Expected: Shows Memory Stack v2 registered with all engines
