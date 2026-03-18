#!/usr/bin/env bash
# Total Recall Memory Backend — Full native API + Router Adapter
set -euo pipefail

WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="${OPENCLAW_INSTALL_ROOT:-$HOME/.openclaw/memory-stack}"
source "$INSTALL_ROOT/lib/contracts.sh"

BACKEND="totalrecall"
MEMORY_BRANCH="openclaw-memory"
MEMORY_DIR="_memory"

# ============================================================
# Layer A: Native API
# ============================================================
cmd_store() {
  # Usage: wrapper.sh store <slug> <content>
  local slug="$1" content="${*:2}"
  local filename
  filename="$(date -u +"%Y-%m-%dT%H-%M-%S")_${slug}.md"
  local filepath="$MEMORY_DIR/$filename"

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

  git checkout --quiet "$MEMORY_BRANCH"
  mkdir -p "$MEMORY_DIR"
  printf '%s\n' "$content" > "$filepath"
  git add "$filepath"
  git commit --quiet -m "memory: $slug"
  git checkout --quiet "$current_branch"
  echo "$filepath"
}

cmd_retrieve() {
  # Usage: wrapper.sh retrieve <query>
  git log "$MEMORY_BRANCH" --all --grep="$1" --format="%H %s" -- "$MEMORY_DIR/" 2>/dev/null
}

cmd_search() {
  # Usage: wrapper.sh search <pattern>
  git grep -l "$1" "$MEMORY_BRANCH" -- "$MEMORY_DIR/" 2>/dev/null || true
}

cmd_list() {
  git ls-tree --name-only "$MEMORY_BRANCH" -- "$MEMORY_DIR/" 2>/dev/null
}

cmd_forget() {
  # Usage: wrapper.sh forget <filename>
  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  git checkout --quiet "$MEMORY_BRANCH"
  git rm --quiet "$MEMORY_DIR/$1" 2>/dev/null || true
  git commit --quiet -m "memory: forget $1"
  git checkout --quiet "$current_branch"
}

cmd_status() {
  echo "branch: $MEMORY_BRANCH"
  echo "directory: $MEMORY_DIR"
  local count
  count=$(git ls-tree --name-only "$MEMORY_BRANCH" -- "$MEMORY_DIR/" 2>/dev/null | wc -l | tr -d ' ')
  echo "files: $count"
  echo "commits: $(git log "$MEMORY_BRANCH" --oneline 2>/dev/null | wc -l | tr -d ' ')"
}

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

  # Mock mode for simulation testing
  if [ "${OPENCLAW_MOCK:-}" = "1" ]; then
    cat "$INSTALL_ROOT/tests/fixtures/${BACKEND}-mock-response.json"
    return 0
  fi

  if ! has_command git; then
    contract_unavailable "$query" "$BACKEND" "git not found"
    return 1
  fi

  # Verify memory branch exists
  if ! git show-ref --verify --quiet "refs/heads/$MEMORY_BRANCH" 2>/dev/null; then
    contract_unavailable "$query" "$BACKEND" "Memory branch '$MEMORY_BRANCH' not found. Run setup.sh first."
    return 1
  fi

  local start_ms
  start_ms=$(now_ms)

  # Search in commit messages and file content
  local commit_results="" content_results=""
  commit_results=$(git log "$MEMORY_BRANCH" --all --grep="$query" --format="%H|||%s|||%aI" -- "$MEMORY_DIR/" 2>/dev/null || true)
  content_results=$(git grep -l "$query" "$MEMORY_BRANCH" -- "$MEMORY_DIR/" 2>/dev/null || true)

  local end_ms duration_ms
  end_ms=$(now_ms)
  duration_ms=$(( end_ms - start_ms ))

  if [ -z "$commit_results" ] && [ -z "$content_results" ]; then
    contract_empty "$query" "$BACKEND" "$duration_ms"
    return 0
  fi

  # Build results with time-decay relevance
  local results count normalized
  if has_command python3; then
    read -r results count normalized < <(python3 -c "
import json, sys
from datetime import datetime, timezone

now = datetime.now(timezone.utc)
results = []
seen = set()

# Process commit results
for line in '''$commit_results'''.strip().split('\n'):
    if not line or '|||' not in line: continue
    parts = line.split('|||')
    if len(parts) < 3: continue
    sha, msg, ts = parts[0], parts[1], parts[2]
    if sha in seen: continue
    seen.add(sha)
    try:
        dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
        days = (now - dt).days
        relevance = max(0.2, 1.0 - (days * 0.043))
    except:
        relevance = 0.3
    results.append({
        'content': msg,
        'relevance': round(relevance, 4),
        'source': 'totalrecall',
        'timestamp': ts
    })

# Process content results
for line in '''$content_results'''.strip().split('\n'):
    if not line: continue
    path = line.split(':',1)[-1] if ':' in line else line
    if path in seen: continue
    seen.add(path)
    results.append({
        'content': f'File match: {path}',
        'relevance': 0.5,
        'source': 'totalrecall',
        'timestamp': '$(now_iso)'
    })

results.sort(key=lambda r: r['relevance'], reverse=True)
results = results[:20]
best = max((r['relevance'] for r in results), default=0.0)
print(json.dumps(results), len(results), round(best, 4))
" 2>/dev/null)
  else
    results="[]"
    count=0
    normalized="0.0"
  fi

  [ -z "$count" ] && count=0
  [ -z "$normalized" ] && normalized="0.0"

  if [ "$count" -eq 0 ]; then
    contract_empty "$query" "$BACKEND" "$duration_ms"
  else
    contract_success "$query" "$BACKEND" "$results" "$count" "$duration_ms" "$normalized"
  fi
}

# ============================================================
# Layer C: Health Check (three-level probe from capability.json)
# ============================================================
cmd_health() {
  local deep=false
  [[ "${1:-}" == "--deep" ]] && deep=true

  local cap_file="$WRAPPER_DIR/capability.json"
  if [[ ! -f "$cap_file" ]]; then
    contract_health "$BACKEND" "unavailable" "capability.json not found"
    return 0
  fi

  # Read probe commands from capability.json
  local probe_l1 probe_l2 probe_l3
  probe_l1=$(python3 -c "import json; print(json.load(open('$cap_file'))['probe']['l1_install'])" 2>/dev/null) || true
  probe_l2=$(python3 -c "import json; print(json.load(open('$cap_file'))['probe']['l2_runtime'])" 2>/dev/null) || true
  if $deep; then
    probe_l3=$(python3 -c "import json; d=json.load(open('$cap_file')); print(d['probe'].get('l3_deep') or d['probe']['l3_functional'])" 2>/dev/null) || true
  else
    probe_l3=$(python3 -c "import json; print(json.load(open('$cap_file'))['probe']['l3_functional'])" 2>/dev/null) || true
  fi

  # L1: install check
  if ! eval "$probe_l1" &>/dev/null; then
    local hint
    hint=$(python3 -c "import json; print(json.load(open('$cap_file'))['install_hint'])" 2>/dev/null || echo "")
    contract_health "$BACKEND" "unavailable" "$BACKEND not found. Install: $hint"
    return 0
  fi

  # L2: runtime check
  if ! eval "$probe_l2" &>/dev/null; then
    contract_health "$BACKEND" "installed" "Runtime dependencies missing"
    return 0
  fi

  # L3: functional probe (with timeout)
  local timeout_sec="${OPENCLAW_PROBE_TIMEOUT:-5}"
  if ! timeout "$timeout_sec" bash -c "$probe_l3" 2>/dev/null; then
    if [[ $? -eq 124 ]]; then
      contract_health "$BACKEND" "degraded" "Functional probe timed out (${timeout_sec}s)"
    else
      contract_health "$BACKEND" "degraded" "Functional probe failed"
    fi
    return 0
  fi

  contract_health "$BACKEND" "ready" ""
}

# ============================================================
# Dispatch
# ============================================================
case "${1:-}" in
  --adapter) shift; adapter "$@" ;;
  --mock)    shift; cat "$INSTALL_ROOT/tests/fixtures/totalrecall-mock-response.json" 2>/dev/null || contract_empty "${2:-test}" "$BACKEND" 0 ;;
  health)    shift; cmd_health "$@" ;;
  "")        echo "Usage: wrapper.sh [--adapter \"query\" [--hint X] | <native-command> [args...]]"; exit 1 ;;
  *)         cmd_name="${1//-/_}"; shift; "cmd_$cmd_name" "$@" ;;
esac
