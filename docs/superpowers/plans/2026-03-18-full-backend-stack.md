# Full 8-Backend Stack Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 8 memory backends real, fully functional, and auto-installed from a blank machine.

**Architecture:** Each backend wraps an open-source tool via a standardized adapter (Layer A: native API, Layer B: router adapter, Layer C: health check). `install.sh` bootstraps Bun + uv/Python, installs all tools, downloads models. Router config updated to dispatch to all 8 backends with no tier restrictions.

**Tech Stack:** Bash (wrappers, installer), QMD/Bun, Python/uv, OpenViking, sqlite-memory, Cognee, kuzu-memory, OneContext, A-MEM

**Spec:** `docs/superpowers/specs/2026-03-18-full-backend-stack-design.md`

**Scope:** This plan covers backend wrappers, installer, router, and build. The subscription/update system (Stripe recurring, `/api/version`, `openclaw-memory update`, pricing page) is a **separate plan** to be written after this one ships.

---

## File Structure

### New files:
- `skills/memory-openviking/wrapper.sh` — OpenViking retrieval adapter
- `skills/memory-vertex/wrapper.sh` — sqlite-memory adapter
- `skills/memory-cognee/wrapper.sh` — Cognee knowledge graph adapter
- `skills/memory-nowledge/wrapper.sh` — kuzu-memory graph adapter
- `skills/memory-lossless/wrapper.sh` — OneContext session context adapter
- `skills/memory-brainx/wrapper.sh` — A-MEM associative memory adapter
- `tests/integration/test-all-backends-health.sh` — health check for all 8

### Modified files:
- `install.sh` — add runtime bootstrap + 8 backend installs
- `skills/memory-router/router-config.json` — remove tier limits, add associative_recall rule, all 8 backends
- `skills/memory-qmd/wrapper.sh` — add `cmd_health` (Layer C)
- `skills/memory-totalrecall/wrapper.sh` — add `cmd_health` (Layer C)
- `scripts/build-release.sh` — include all 8 skill directories
- `bin/openclaw-memory` — add `status` subcommand showing all backend health

### Key existing files (reference, reuse patterns):
- `lib/contracts.sh` — `contract_success`, `contract_error`, `contract_unavailable`, `contract_empty`, `result_entry`
- `lib/platform.sh` — `now_ms`, `json_escape`, `has_command`
- `skills/memory-qmd/wrapper.sh` — reference wrapper pattern (Layer A + B)
- `skills/memory-totalrecall/wrapper.sh` — reference wrapper pattern

---

## Task 1: Add Layer C (Health Check) to Existing Wrappers

**Files:**
- Modify: `skills/memory-qmd/wrapper.sh`
- Modify: `skills/memory-totalrecall/wrapper.sh`
- Modify: `lib/contracts.sh` — add `contract_health` helper

- [ ] **Step 1: Add `contract_health` helper to `lib/contracts.sh`**

Append to `lib/contracts.sh`:
```bash
# Build a health check response
# Usage: contract_health <backend> <status> [reason]
contract_health() {
  local backend="$1" status="$2" reason="${3:-}"
  local escaped_reason
  escaped_reason=$(json_escape "$reason")
  cat <<ENDJSON
{"backend": "$backend", "status": "$status", "reason": "$escaped_reason"}
ENDJSON
}
```

- [ ] **Step 2: Add `cmd_health` to `skills/memory-qmd/wrapper.sh`**

Add after the Layer A section:
```bash
# Layer C: Health Check
cmd_health() {
  if ! has_command qmd; then
    contract_health "$BACKEND" "unavailable" "qmd CLI not found. Install: bun install -g @tobilu/qmd"
    return 0
  fi
  local model_dir="$HOME/.cache/qmd/models"
  if [ ! -d "$model_dir" ] || [ -z "$(ls -A "$model_dir" 2>/dev/null)" ]; then
    contract_health "$BACKEND" "degraded" "Models not downloaded. Run: qmd embed --download-models"
    return 0
  fi
  contract_health "$BACKEND" "ready" ""
}
```

- [ ] **Step 3: Add `cmd_health` to `skills/memory-totalrecall/wrapper.sh`**

Add after the Layer A section:
```bash
# Layer C: Health Check
cmd_health() {
  if ! has_command git; then
    contract_health "$BACKEND" "unavailable" "git not found"
    return 0
  fi
  contract_health "$BACKEND" "ready" ""
}
```

- [ ] **Step 4: Test health checks manually**

Run:
```bash
OPENCLAW_INSTALL_ROOT="$HOME/.openclaw/memory-stack" \
  bash skills/memory-qmd/wrapper.sh health
```
Expected: `{"backend": "qmd", "status": "ready", "reason": ""}`

```bash
OPENCLAW_INSTALL_ROOT="$HOME/.openclaw/memory-stack" \
  bash skills/memory-totalrecall/wrapper.sh health
```
Expected: `{"backend": "totalrecall", "status": "ready", "reason": ""}`

- [ ] **Step 5: Commit**

```bash
git add lib/contracts.sh skills/memory-qmd/wrapper.sh skills/memory-totalrecall/wrapper.sh
git commit -m "feat: add Layer C health checks to existing backends"
```

---

## Task 2: Create OpenViking Wrapper (retrieval_engine)

**Files:**
- Create: `skills/memory-openviking/wrapper.sh`

- [ ] **Step 1: Create `skills/memory-openviking/wrapper.sh`**

```bash
#!/usr/bin/env bash
# OpenViking Memory Backend — Context DB Adapter
set -euo pipefail

WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="${OPENCLAW_INSTALL_ROOT:-$HOME/.openclaw/memory-stack}"
source "$INSTALL_ROOT/lib/contracts.sh"

BACKEND="openviking"
VENV="$HOME/.openclaw/venv"

_activate_venv() { [ -f "$VENV/bin/activate" ] && source "$VENV/bin/activate"; }

# ============================================================
# Layer A: Native API
# ============================================================
cmd_search()  { _activate_venv; openviking search "$@"; }
cmd_index()   { _activate_venv; openviking index "$@"; }
cmd_status()  { _activate_venv; openviking status "$@"; }

# ============================================================
# Layer B: Router Adapter
# ============================================================
adapter() {
  local query="" hint=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --hint) hint="$2"; shift 2 ;;
      *)      query="$1"; shift ;;
    esac
  done

  if [ -z "$query" ]; then
    contract_error "" "$BACKEND" "BACKEND_ERROR" "No query provided"
    return 1
  fi

  if [ "${OPENCLAW_MOCK:-}" = "1" ]; then
    cat "$INSTALL_ROOT/tests/fixtures/${BACKEND}-mock-response.json"
    return 0
  fi

  _activate_venv
  if ! has_command openviking; then
    contract_unavailable "$query" "$BACKEND" "openviking CLI not found"
    return 1
  fi

  local start_ms
  start_ms=$(now_ms)

  local raw_output
  raw_output=$(openviking search "$query" --json --limit 20 2>/dev/null) || true

  local end_ms duration_ms
  end_ms=$(now_ms)
  duration_ms=$((end_ms - start_ms))

  if [ -z "$raw_output" ] || [ "$raw_output" = "[]" ] || [ "$raw_output" = "null" ]; then
    contract_empty "$query" "$BACKEND" "$duration_ms"
    return 0
  fi

  # Parse results and build contract
  local results count relevance
  if has_command python3; then
    read -r results count relevance < <(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
items = data if isinstance(data, list) else data.get('results', [])
out = []
max_score = 0.0
for item in items[:20]:
    score = float(item.get('score', item.get('relevance', 0.5)))
    content = str(item.get('content', item.get('snippet', '')))[:500]
    path = item.get('path', item.get('source', item.get('file', '')))
    out.append({'content': content, 'relevance': round(score, 3), 'source': path, 'timestamp': ''})
    if score > max_score: max_score = score
print(json.dumps(out), len(out), round(max_score, 3))
" <<< "$raw_output" 2>/dev/null)
  else
    contract_error "$query" "$BACKEND" "PARSE_ERROR" "python3 required for result parsing"
    return 1
  fi

  contract_success "$query" "$BACKEND" "$results" "$count" "$duration_ms" "$relevance"
}

# ============================================================
# Layer C: Health Check
# ============================================================
cmd_health() {
  _activate_venv
  if ! has_command openviking; then
    contract_health "$BACKEND" "unavailable" "openviking not found. Install: uv pip install openviking"
    return 0
  fi
  contract_health "$BACKEND" "ready" ""
}

# ============================================================
# Dispatch
# ============================================================
case "${1:-}" in
  --adapter) shift; adapter "$@" ;;
  health)    cmd_health ;;
  search)    shift; cmd_search "$@" ;;
  index)     shift; cmd_index "$@" ;;
  status)    cmd_status ;;
  *)         echo "Usage: wrapper.sh {--adapter|health|search|index|status}" >&2; exit 1 ;;
esac
```

- [ ] **Step 2: Make executable and test health check**

```bash
chmod +x skills/memory-openviking/wrapper.sh
OPENCLAW_INSTALL_ROOT="$HOME/.openclaw/memory-stack" \
  bash skills/memory-openviking/wrapper.sh health
```

- [ ] **Step 3: Commit**

```bash
git add skills/memory-openviking/
git commit -m "feat: add OpenViking retrieval_engine wrapper"
```

---

## Task 3: Create Vertex Wrapper (memory_store — sqlite-memory)

**Files:**
- Create: `skills/memory-vertex/wrapper.sh`

- [ ] **Step 1: Create wrapper following same pattern as Task 2**

Same structure as openviking wrapper but:
- `BACKEND="vertex"`
- Layer A: `cmd_store()`, `cmd_search()`, `cmd_recall()`, `cmd_status()`
- Calls: `sqlite-memory` CLI (or `python3 -m sqlite_memory`)
- Health check: verify `sqlite-memory` importable
- Adapter: parse sqlite-memory JSON output, normalize relevance

```bash
#!/usr/bin/env bash
# Vertex Memory Backend — sqlite-memory Adapter
set -euo pipefail

WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="${OPENCLAW_INSTALL_ROOT:-$HOME/.openclaw/memory-stack}"
source "$INSTALL_ROOT/lib/contracts.sh"

BACKEND="vertex"
VENV="$HOME/.openclaw/venv"
DB_PATH="${OPENCLAW_VERTEX_DB:-$HOME/.openclaw/state/vertex.db}"

_activate_venv() { [ -f "$VENV/bin/activate" ] && source "$VENV/bin/activate"; }

# Layer A — uses stdin to pass queries safely (no shell injection)
cmd_store() {
  _activate_venv
  python3 -c "
import sys
from sqlite_memory import Memory
m = Memory('$DB_PATH')
m.add(sys.stdin.read().strip())
print('stored')
" <<< "$*"
}

cmd_search() {
  _activate_venv
  python3 -c "
import sys, json
from sqlite_memory import Memory
m = Memory('$DB_PATH')
q = sys.stdin.read().strip()
results = m.search(q, limit=20)
print(json.dumps([{'content': r.content[:500], 'score': r.score, 'source': r.id} for r in results]))
" <<< "$*"
}

# Layer B
adapter() {
  local query="" hint=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --hint) hint="$2"; shift 2 ;;
      *)      query="$1"; shift ;;
    esac
  done

  [ -z "$query" ] && { contract_error "" "$BACKEND" "BACKEND_ERROR" "No query provided"; return 1; }

  [ "${OPENCLAW_MOCK:-}" = "1" ] && { cat "$INSTALL_ROOT/tests/fixtures/${BACKEND}-mock-response.json"; return 0; }

  _activate_venv
  if ! python3 -c "import sqlite_memory" 2>/dev/null; then
    contract_unavailable "$query" "$BACKEND" "sqlite-memory not installed"
    return 1
  fi

  local start_ms end_ms duration_ms
  start_ms=$(now_ms)

  local raw_output
  raw_output=$(python3 -c "
import sys, json
from sqlite_memory import Memory
m = Memory('$DB_PATH')
q = sys.stdin.read().strip()
results = m.search(q, limit=20)
out = []
max_s = 0.0
for r in results:
    s = float(getattr(r, 'score', 0.5))
    out.append({'content': str(getattr(r, 'content', ''))[:500], 'relevance': round(s,3), 'source': str(getattr(r, 'id', '')), 'timestamp': ''})
    if s > max_s: max_s = s
print(json.dumps(out) + ' ' + str(len(out)) + ' ' + str(round(max_s,3)))
" <<< "$query" 2>/dev/null) || true

  end_ms=$(now_ms)
  duration_ms=$((end_ms - start_ms))

  if [ -z "$raw_output" ]; then
    contract_empty "$query" "$BACKEND" "$duration_ms"
    return 0
  fi

  local results count relevance
  read -r results count relevance <<< "$raw_output"
  contract_success "$query" "$BACKEND" "$results" "$count" "$duration_ms" "$relevance"
}

# Layer C
cmd_health() {
  _activate_venv
  if ! python3 -c "import sqlite_memory" 2>/dev/null; then
    contract_health "$BACKEND" "unavailable" "sqlite-memory not installed. Install: uv pip install sqlite-memory"
    return 0
  fi
  contract_health "$BACKEND" "ready" ""
}

case "${1:-}" in
  --adapter) shift; adapter "$@" ;;
  health)    cmd_health ;;
  store)     shift; cmd_store "$@" ;;
  search)    shift; cmd_search "$@" ;;
  status)    cmd_status ;;
  *)         echo "Usage: wrapper.sh {--adapter|health|store|search|status}" >&2; exit 1 ;;
esac
```

- [ ] **Step 2: Test + commit**

```bash
chmod +x skills/memory-vertex/wrapper.sh
git add skills/memory-vertex/
git commit -m "feat: add Vertex memory_store wrapper (sqlite-memory)"
```

---

## Task 4: Create Cognee Wrapper (knowledge_graph)

**Files:**
- Create: `skills/memory-cognee/wrapper.sh`

- [ ] **Step 1: Create wrapper**

```bash
#!/usr/bin/env bash
# Cognee Memory Backend — Knowledge Graph Adapter
set -euo pipefail

WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="${OPENCLAW_INSTALL_ROOT:-$HOME/.openclaw/memory-stack}"
source "$INSTALL_ROOT/lib/contracts.sh"

BACKEND="cognee"
VENV="$HOME/.openclaw/venv"

_activate_venv() { [ -f "$VENV/bin/activate" ] && source "$VENV/bin/activate"; }

_safe_query() {
  # Pass query via stdin to avoid shell injection
  printf '%s' "$1"
}

# Layer A
cmd_add()     { _activate_venv; python3 -c "import asyncio, cognee; asyncio.run(cognee.add(open('/dev/stdin').read()))" <<< "$*"; }
cmd_cognify() { _activate_venv; python3 -c "import asyncio, cognee; asyncio.run(cognee.cognify())"; }
cmd_search()  { _activate_venv; python3 -c "
import asyncio, cognee, json, sys
q = sys.stdin.read().strip()
results = asyncio.run(cognee.search(q))
print(json.dumps([{'content': str(r)[:500], 'score': 0.7} for r in results]))
" <<< "$*"; }

# Layer B
adapter() {
  local query="" hint=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --hint) hint="$2"; shift 2 ;;
      *)      query="$1"; shift ;;
    esac
  done

  [ -z "$query" ] && { contract_error "" "$BACKEND" "BACKEND_ERROR" "No query provided"; return 1; }
  [ "\${OPENCLAW_MOCK:-}" = "1" ] && { cat "$INSTALL_ROOT/tests/fixtures/\${BACKEND}-mock-response.json"; return 0; }

  _activate_venv
  if ! python3 -c "import cognee" 2>/dev/null; then
    contract_unavailable "$query" "$BACKEND" "cognee not installed"
    return 1
  fi

  local start_ms end_ms duration_ms
  start_ms=\$(now_ms)

  local raw_output
  raw_output=\$(python3 -c "
import asyncio, cognee, json, sys
q = sys.stdin.read().strip()
try:
    results = asyncio.run(cognee.search(q))
    out = []
    max_s = 0.0
    for r in results[:20]:
        s = float(getattr(r, 'score', getattr(r, 'relevance', 0.6)))
        content = str(getattr(r, 'content', str(r)))[:500]
        source = str(getattr(r, 'source', getattr(r, 'id', '')))
        out.append({'content': content, 'relevance': round(s,3), 'source': source, 'timestamp': ''})
        if s > max_s: max_s = s
    print(json.dumps(out) + ' ' + str(len(out)) + ' ' + str(round(max_s,3)))
except Exception as e:
    print('[] 0 0.0', file=sys.stderr)
    print('[] 0 0.0')
" <<< "$query" 2>/dev/null) || true

  end_ms=\$(now_ms)
  duration_ms=\$((end_ms - start_ms))

  if [ -z "\$raw_output" ] || [[ "\$raw_output" == "[] 0 0.0" ]]; then
    contract_empty "$query" "$BACKEND" "\$duration_ms"
    return 0
  fi

  local results count relevance
  read -r results count relevance <<< "\$raw_output"
  contract_success "$query" "$BACKEND" "\$results" "\$count" "\$duration_ms" "\$relevance"
}

# Layer C
cmd_health() {
  _activate_venv
  if ! python3 -c "import cognee" 2>/dev/null; then
    contract_health "$BACKEND" "unavailable" "cognee not installed. Install: uv pip install cognee"
    return 0
  fi
  contract_health "$BACKEND" "ready" ""
}

case "\${1:-}" in
  --adapter) shift; adapter "\$@" ;;
  health)    cmd_health ;;
  add)       shift; cmd_add "\$@" ;;
  cognify)   cmd_cognify ;;
  search)    shift; cmd_search "\$@" ;;
  *)         echo "Usage: wrapper.sh {--adapter|health|add|cognify|search}" >&2; exit 1 ;;
esac
```

- [ ] **Step 2: Test + commit**

```bash
chmod +x skills/memory-cognee/wrapper.sh
OPENCLAW_INSTALL_ROOT="$HOME/.openclaw/memory-stack" bash skills/memory-cognee/wrapper.sh health
git add skills/memory-cognee/
git commit -m "feat: add Cognee knowledge_graph wrapper"
```

---

## Task 5: Create Nowledge Wrapper (knowledge_graph — kuzu-memory)

**Files:**
- Create: `skills/memory-nowledge/wrapper.sh`

- [ ] **Step 1: Create wrapper**

Same structure as Cognee wrapper. Key differences:
- `BACKEND="nowledge"`
- Layer A calls: `kuzu-memory recall`, `kuzu-memory store`, `kuzu-memory search`
- If `kuzu-memory` CLI not available, fallback to `python3 -c "from kuzu_memory import ..."`
- Health: check `kuzu-memory` CLI or `python3 -c "import kuzu_memory"`
- Layer B adapter: pipe query via stdin to Python, parse JSON results
- Use `<<< "$query"` stdin pattern (not string interpolation) to avoid injection

- [ ] **Step 2: Test + commit**

```bash
chmod +x skills/memory-nowledge/wrapper.sh
OPENCLAW_INSTALL_ROOT="$HOME/.openclaw/memory-stack" bash skills/memory-nowledge/wrapper.sh health
git add skills/memory-nowledge/
git commit -m "feat: add Nowledge knowledge_graph wrapper (kuzu-memory)"
```

---

## Task 6: Create Lossless Wrapper (context_engine — OneContext)

**Files:**
- Create: `skills/memory-lossless/wrapper.sh`

- [ ] **Step 1: Create wrapper**

Same structure. Key differences:
- `BACKEND="lossless"`
- OneContext is a Bun/Node package — CLI is `onecontext`
- Layer A: `cmd_record()` captures session, `cmd_search()` queries recorded sessions
- If `onecontext` CLI not found, try `npx onecontext-ai`
- Health: check `has_command onecontext || has_command npx`
- Layer B adapter: call `onecontext search --json` with query via args (OneContext is JS-based, no stdin injection risk)
- Use `<<< "$query"` stdin pattern for any Python parsing

- [ ] **Step 2: Test + commit**

```bash
chmod +x skills/memory-lossless/wrapper.sh
OPENCLAW_INSTALL_ROOT="$HOME/.openclaw/memory-stack" bash skills/memory-lossless/wrapper.sh health
git add skills/memory-lossless/
git commit -m "feat: add Lossless context_engine wrapper (OneContext)"
```

---

## Task 7: Create BrainX Wrapper (experimental — A-MEM)

**Files:**
- Create: `skills/memory-brainx/wrapper.sh`

- [ ] **Step 1: Create wrapper**

Same structure as Cognee wrapper. Key differences:
- `BACKEND="brainx"`
- Layer A calls Python: `from a_mem import AMemory` (or tool's actual import path — verify at implementation time via `pip show a-mem`)
- `cmd_memorize()` stores a memory with auto-generated Zettelkasten tags
- `cmd_associate()` finds related memories
- `cmd_recall()` retrieves by query
- Health: check `python3 -c "import a_mem"` or appropriate import
- Layer B adapter: stdin pattern, parse JSON, normalize relevance
- **Implementation note:** A-MEM's actual Python API may differ from expectations. At implementation time, install the package first (`uv pip install a-mem`), check `pip show a-mem` for the correct import path, and read its README before writing Layer A.

- [ ] **Step 2: Test + commit**

```bash
chmod +x skills/memory-brainx/wrapper.sh
OPENCLAW_INSTALL_ROOT="$HOME/.openclaw/memory-stack" bash skills/memory-brainx/wrapper.sh health
git add skills/memory-brainx/
git commit -m "feat: add BrainX experimental wrapper (A-MEM)"
```

---

## Task 8: Update Router Config

**Files:**
- Modify: `skills/memory-router/router-config.json`

- [ ] **Step 1: Update router-config.json**

Remove `router-config.starter.json` distinction. Single config with all 8 backends:

Update `classes` — already correct in current file.

Add new rule `associative_recall` after `ambiguous_default`:
```json
{
  "id": "associative_recall",
  "signals": ["reminds me of", "related to", "connected", "associated", "similar to", "linked"],
  "primary_class": "experimental",
  "fallback_class": "knowledge_graph",
  "hint": "association"
}
```

Remove tier field from all rules if present.

- [ ] **Step 1b: Verify `router.sh` handles new backends**

Check `skills/memory-router/router.sh` dispatch logic. It resolves backends from `router-config.json` classes dynamically, so no code changes should be needed — it iterates `classes[primary_class].backends` and looks for `skills/memory-{backend}/wrapper.sh`. Verify this by reading the dispatch function. If it hardcodes backend names instead of reading from config, add the new backends.

- [ ] **Step 2: Test router dispatch with new config**

```bash
OPENCLAW_MOCK=1 bash skills/memory-router/router.sh "what reminds me of the auth refactor"
```
Expected: routes to `brainx` (experimental class)

- [ ] **Step 3: Commit**

```bash
git add skills/memory-router/router-config.json
git commit -m "feat: update router config — all 8 backends, add associative_recall rule"
```

---

## Task 9: Overhaul install.sh

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add runtime bootstrap functions**

After the color helpers section, add:
```bash
# ── Runtime Bootstrap ────────────────────────────────────────
install_bun() {
  if command -v bun &>/dev/null; then
    ok "bun: v$(bun --version 2>/dev/null)"
    return 0
  fi
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash 2>/dev/null
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  ok "bun: v$(bun --version 2>/dev/null)"
}

install_uv() {
  if command -v uv &>/dev/null; then
    ok "uv: $(uv --version 2>/dev/null)"
    return 0
  fi
  info "Installing uv (Python manager)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh 2>/dev/null
  export PATH="$HOME/.local/bin:$PATH"
  ok "uv: $(uv --version 2>/dev/null)"
}

setup_python_venv() {
  local venv_dir="$HOME/.openclaw/venv"
  if [ -f "$venv_dir/bin/activate" ]; then
    ok "Python venv: $venv_dir (exists)"
    return 0
  fi
  info "Creating Python venv..."
  uv venv "$venv_dir" --python 3.12 2>/dev/null
  ok "Python venv: $venv_dir"
}

install_python_backend() {
  local name="$1" package="$2"
  local venv_dir="$HOME/.openclaw/venv"
  info "Installing $name..."
  VIRTUAL_ENV="$venv_dir" uv pip install "$package" --quiet 2>/dev/null && \
    ok "$name installed" || \
    warn "$name failed to install (non-fatal)"
}

install_bun_backend() {
  local name="$1" package="$2"
  info "Installing $name..."
  bun install -g "$package" 2>/dev/null && \
    ok "$name installed" || \
    warn "$name failed to install (non-fatal)"
}
```

- [ ] **Step 2: Replace Step 3 (platform check) with runtime bootstrap**

Replace the current platform check section with:
```bash
header "Step 3/7 — Bootstrapping runtimes"
install_bun
install_uv
setup_python_venv
```

- [ ] **Step 3: Add Step 4b — Install all backends**

After copying skill files, add:
```bash
header "Step 4b/7 — Installing backend dependencies"

# Bun backends
install_bun_backend "QMD" "@tobilu/qmd"
install_bun_backend "OneContext" "onecontext-ai"

# Python backends
install_python_backend "OpenViking" "openviking"
install_python_backend "sqlite-memory" "sqlite-memory"
install_python_backend "Cognee" "cognee"
install_python_backend "kuzu-memory" "kuzu-memory"
install_python_backend "A-MEM" "a-mem"

# Download QMD models
if command -v qmd &>/dev/null; then
  info "Downloading QMD AI models (~2.1GB, this may take a few minutes)..."
  qmd embed --download-models 2>/dev/null && \
    ok "QMD models downloaded" || \
    warn "QMD model download failed (can retry: qmd embed --download-models)"
fi
```

- [ ] **Step 4: Update backends.json generation**

Replace the current backends.json section to check all 8:
```bash
# Check each backend health (wrap in function to allow `local`)
generate_backends_json() {
  local skill_dir backend_name health_json bstatus
  local backends_json="{"
  local first=true

  for skill_dir in "$INSTALL_ROOT/skills/memory-"*; do
    [ -f "$skill_dir/wrapper.sh" ] || continue
    backend_name=$(basename "$skill_dir" | sed 's/memory-//')
    [ "$backend_name" = "router" ] && continue
    health_json=$(OPENCLAW_INSTALL_ROOT="$INSTALL_ROOT" bash "$skill_dir/wrapper.sh" health 2>/dev/null) || health_json='{"status":"error"}'
    bstatus=$(echo "$health_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")
    $first || backends_json+=","
    backends_json+="\"$backend_name\":{\"runtime\":\"$bstatus\"}"
    first=false
  done

  backends_json+="}"
  echo "$backends_json"
}
```

- [ ] **Step 5: Update all skill copy to include 8 directories**

```bash
for skill in memory-router memory-totalrecall memory-qmd memory-openviking memory-vertex memory-cognee memory-nowledge memory-lossless memory-brainx; do
  if [[ -d "$SCRIPT_DIR/skills/$skill" ]]; then
    rm -rf "$INSTALL_ROOT/skills/$skill"
    cp -r "$SCRIPT_DIR/skills/$skill" "$INSTALL_ROOT/skills/"
  fi
done
```

- [ ] **Step 6: Test install.sh on current machine**

```bash
bash install.sh --key=oc-starter-test-key-here
```
Verify: all 8 backends show status in summary.

- [ ] **Step 7: Commit**

```bash
git add install.sh
git commit -m "feat: overhaul installer — auto-install runtimes + all 8 backends"
```

---

## Task 10: Update build-release.sh

**Files:**
- Modify: `scripts/build-release.sh`

- [ ] **Step 1: Include all 8 skill directories in artifact**

Replace the skill copy section:
```bash
# Copy all skills
for skill in memory-router memory-totalrecall memory-qmd memory-openviking memory-vertex memory-cognee memory-nowledge memory-lossless memory-brainx; do
  mkdir -p "$BUILD_DIR/skills/$skill"
  cp -r "$PROJECT_ROOT/skills/$skill/"* "$BUILD_DIR/skills/$skill/"
done
```

Remove the Starter-specific `router-config.starter.json` swap since we no longer have tiers.

- [ ] **Step 2: Update tier verification to check for 8 backends**

Replace the Tier 2/3 residue check with a completeness check:
```bash
echo "Verifying artifact..."
EXPECTED_BACKENDS=("memory-router" "memory-totalrecall" "memory-qmd" "memory-openviking" "memory-vertex" "memory-cognee" "memory-nowledge" "memory-lossless" "memory-brainx")
for dir in "${EXPECTED_BACKENDS[@]}"; do
  if [ ! -d "$BUILD_DIR/skills/$dir" ]; then
    echo "ERROR: Missing backend: $dir" >&2
    exit 1
  fi
done
echo "  All 9 skill directories present (router + 8 backends)"
```

- [ ] **Step 3: Test build**

```bash
bash scripts/build-release.sh
```
Expected: artifact includes all 9 skill directories, passes completeness check.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-release.sh
git commit -m "feat: build-release includes all 8 backends, no tier split"
```

---

## Task 11: Integration Test — All Backends Health

**Files:**
- Create: `tests/integration/test-all-backends-health.sh`

- [ ] **Step 1: Create integration test**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT"

PASS=0
FAIL=0
BACKENDS=("qmd" "openviking" "totalrecall" "vertex" "cognee" "nowledge" "lossless" "brainx")

for backend in "${BACKENDS[@]}"; do
  wrapper="$PROJECT_ROOT/skills/memory-$backend/wrapper.sh"
  if [ ! -f "$wrapper" ]; then
    echo "FAIL: $backend — wrapper.sh not found"
    FAIL=$((FAIL + 1))
    continue
  fi

  health=$(bash "$wrapper" health 2>/dev/null) || health='{"status":"error"}'
  status=$(echo "$health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")

  if [ "$status" = "ready" ] || [ "$status" = "degraded" ]; then
    echo "PASS: $backend — $status"
    PASS=$((PASS + 1))
  else
    reason=$(echo "$health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reason','unknown'))" 2>/dev/null || echo "unknown")
    echo "FAIL: $backend — $status ($reason)"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "Results: $PASS passed, $FAIL failed out of ${#BACKENDS[@]} backends"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
```

- [ ] **Step 2: Run integration test**

```bash
chmod +x tests/integration/test-all-backends-health.sh
bash tests/integration/test-all-backends-health.sh
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/
git commit -m "test: add all-backends health integration test"
```

---

---

## Task 12: Add `status` Subcommand to CLI

**Files:**
- Modify: `bin/openclaw-memory`

- [ ] **Step 1: Add status subcommand**

In the case dispatch section of `bin/openclaw-memory`, add:
```bash
status)
  echo "OpenClaw Memory Stack — Backend Status"
  echo ""
  for skill_dir in "$INSTALL_ROOT/skills/memory-"*; do
    [ -f "$skill_dir/wrapper.sh" ] || continue
    backend_name=$(basename "$skill_dir" | sed 's/memory-//')
    [ "$backend_name" = "router" ] && continue
    health_json=$(OPENCLAW_INSTALL_ROOT="$INSTALL_ROOT" bash "$skill_dir/wrapper.sh" health 2>/dev/null) || health_json='{"status":"error","reason":"wrapper failed"}'
    bstatus=$(echo "$health_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','error'))" 2>/dev/null || echo "error")
    reason=$(echo "$health_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('reason',''))" 2>/dev/null || echo "")
    case "$bstatus" in
      ready)       printf "  %-15s %s\n" "$backend_name" "ready" ;;
      degraded)    printf "  %-15s %s (%s)\n" "$backend_name" "degraded" "$reason" ;;
      *)           printf "  %-15s %s (%s)\n" "$backend_name" "unavailable" "$reason" ;;
    esac
  done
  ;;
```

- [ ] **Step 2: Test**

```bash
openclaw-memory status
```
Expected: lists all 8 backends with ready/degraded/unavailable status.

- [ ] **Step 3: Commit**

```bash
git add bin/openclaw-memory
git commit -m "feat: add openclaw-memory status subcommand"
```

---

## Task Summary

| Task | Component | Estimated Effort |
|------|-----------|-----------------|
| 1 | Layer C health checks (existing) | Small |
| 2 | OpenViking wrapper | Medium |
| 3 | Vertex wrapper | Medium |
| 4 | Cognee wrapper | Medium |
| 5 | Nowledge wrapper | Medium |
| 6 | Lossless wrapper | Medium |
| 7 | BrainX wrapper | Medium |
| 8 | Router config update | Small |
| 9 | install.sh overhaul | Large |
| 10 | build-release.sh update | Small |
| 11 | Integration test | Small |
| 12 | CLI status subcommand | Small |

**Execution order:**
1. Task 1 first (establishes Layer C pattern)
2. Tasks 2-7 in parallel (6 new wrappers, independent — but avoid concurrent `uv pip install` to same venv)
3. Tasks 8, 12 after wrappers exist
4. Task 9 (installer) after all backends ready
5. Tasks 10-11 last (build + integration test)

**Deferred to separate plan:** Subscription system, `/api/version` endpoint, `openclaw-memory update` command, pricing page updates.
