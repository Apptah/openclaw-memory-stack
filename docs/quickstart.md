# Quickstart — OpenClaw Memory Stack

Get memory working in under 5 minutes.

## Requirements

- **macOS** (primary platform) or **Linux** (documented, not fully validated)
- **OpenClaw** installed and running
- **git** >= 2.20 (ships with macOS; verify with `git --version`)
- **Bun** (optional, for QMD backend; install from https://bun.sh)
- **python3** (used for JSON processing)

## Step 1: Download

After purchase, you'll receive an email with your license key and a download link.

```bash
# Download and extract
unzip openclaw-memory-stack-v0.1.0.zip
cd openclaw-memory-stack-v0.1.0
```

## Step 2: Install

```bash
./install.sh --key=oc-starter-xxxxxxxxxxxx
```

This will:
1. Verify your license key with the server
2. Register this device (up to 3 devices per license)
3. Install files to `~/.openclaw/memory-stack/`
4. Copy plugin files to `~/.openclaw/extensions/openclaw-memory-stack/`
5. Register Memory Stack as OpenClaw's memory provider via `plugins.slots.memory`
6. Symlink `openclaw-memory` to `~/.openclaw/bin/`

If `~/.openclaw/bin` is not in your PATH, add it:

```bash
echo 'export PATH="$HOME/.openclaw/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Step 3: Restart OpenClaw

```bash
openclaw gateway restart
```

That's it. Memory Stack is now active as OpenClaw's memory backend.

## Step 4: Test it

Just have a conversation with OpenClaw. Memory works automatically — no extra commands needed. OpenClaw will store and recall context through Memory Stack behind the scenes.

To confirm it's working:

```bash
openclaw-memory --version    # Should show v0.1.0
openclaw-memory --help       # Show all commands
```

## Advanced: Per-project code search

The basic install gives you conversation memory out of the box. If you also want to search your codebase by keyword or meaning, initialize Memory Stack in a specific project:

```bash
cd /path/to/your/project
openclaw-memory init
```

This creates:
- An `openclaw-memory` orphan branch in your repo (Total Recall storage)
- A QMD collection for BM25 search (if Bun is installed)
- `.openclaw-memory.json` config at your repo root

BM25 search is available immediately after init:

```bash
openclaw-memory "find function parseAuthToken"
openclaw-memory "how does error handling work"
```

## Advanced: Enable vector search

```bash
openclaw-memory embed
```

This generates vector embeddings for your codebase. May take a few minutes for large repos. For background processing:

```bash
openclaw-memory embed --background
```

Check progress:

```bash
jq .backends.qmd.embed_job .openclaw-memory.json
```

## Direct backend access

Skip the router and talk directly to a backend:

```bash
# QMD search
openclaw-memory --backend qmd search "parseAuth"

# Total Recall store
openclaw-memory --backend totalrecall store auth-decision "We chose JWT over sessions"

# Total Recall retrieve
openclaw-memory --backend totalrecall search "JWT"
```

## Troubleshooting

**"License not found"** — Run `install.sh` first.

**"Memory Stack not active after restart"** — Check that the plugin registered correctly: look for `openclaw-memory-stack` in `~/.openclaw/extensions/`. If missing, re-run `install.sh`.

**"This repo hasn't been initialized"** — This means per-project search isn't set up. Run `openclaw-memory init` in your project directory. (Basic memory still works without this.)

**"QMD skipped (bun not installed)"** — Install Bun from https://bun.sh, then re-run `openclaw-memory init` in a new repo (or manually run `qmd collection add`).

**"License verification required"** — Connect to the internet. The CLI re-verifies your license every 7 days with a 3-day offline grace period.

**"Device activation limit reached"** — Manage devices at https://openclaw-site-53r.pages.dev/manage

## Device management

Your license allows up to 3 devices. To free up a slot:

1. Visit https://openclaw-site-53r.pages.dev/manage
2. Enter your license key and purchase email
3. Remove old devices (up to 2 resets per month)
