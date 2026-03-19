# Quickstart — OpenClaw Memory Stack

Get your first memory query running in under 5 minutes.

## Requirements

- **macOS** (primary platform) or **Linux** (documented, not fully validated)
- **git** >= 2.20 (ships with macOS; verify with `git --version`)
- **Bun** (optional, for QMD backend; install from https://bun.sh)
- **python3** (used for JSON processing)

## Step 1: Download

After purchase, you'll receive an email with your license key and a download link.

```bash
# Download and extract
tar xzf openclaw-memory-stack-v0.1.0.tar.gz
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
4. Symlink `openclaw-memory` to `~/.openclaw/bin/`

If `~/.openclaw/bin` is not in your PATH, add it:

```bash
echo 'export PATH="$HOME/.openclaw/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Step 3: Initialize your project

```bash
cd /path/to/your/project
openclaw-memory init
```

This creates:
- A `openclaw-memory` orphan branch in your repo (Total Recall storage)
- A QMD collection for BM25 search (if Bun is installed)
- `.openclaw-memory.json` config at your repo root

## Step 4: Query

BM25 search is available immediately after init:

```bash
openclaw-memory "find function parseAuthToken"
openclaw-memory "how does error handling work"
openclaw-memory "what did we just discuss"
```

## Step 5 (Optional): Enable vector search

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

## Verify installation

```bash
openclaw-memory --version    # Should show v0.1.0
openclaw-memory --help       # Show all commands
```

## Troubleshooting

**"License not found"** — Run `install.sh` first.

**"This repo hasn't been initialized"** — Run `openclaw-memory init` in your project directory.

**"QMD skipped (bun not installed)"** — Install Bun from https://bun.sh, then re-run `openclaw-memory init` in a new repo (or manually run `qmd collection add`).

**"License verification required"** — Connect to the internet. The CLI re-verifies your license every 7 days with a 3-day offline grace period.

**"Device activation limit reached"** — Manage devices at https://openclaw-site-53r.pages.dev/manage

## Device management

Your license allows up to 3 devices. To free up a slot:

1. Visit https://openclaw-site-53r.pages.dev/manage
2. Enter your license key and purchase email
3. Remove old devices (up to 2 resets per month)
