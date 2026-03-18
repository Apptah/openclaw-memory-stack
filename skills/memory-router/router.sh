#!/usr/bin/env bash
# OpenClaw Memory Stack — Class-Based Memory Router
# Usage: router.sh "<query>" [--hint <hint>] [--backends-json <path>]
set -euo pipefail

ROUTER_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="${OPENCLAW_INSTALL_ROOT:-$HOME/.openclaw/memory-stack}"
source "$INSTALL_ROOT/lib/contracts.sh"

ROUTER_CONFIG="${OPENCLAW_ROUTER_CONFIG:-$ROUTER_DIR/router-config.json}"
BACKENDS_JSON="${OPENCLAW_BACKENDS_JSON:-$HOME/.openclaw/state/backends.json}"
LOG_PATH="$HOME/.openclaw/state/router.log"
SESSION_CACHE="/tmp/openclaw-router-$$.json"
trap 'rm -f "$SESSION_CACHE"' EXIT

# Parse arguments
QUERY="" HINT="" CUSTOM_BACKENDS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hint) HINT="$2"; shift 2 ;;
    --backends-json) CUSTOM_BACKENDS="$2"; shift 2 ;;
    *) QUERY="$1"; shift ;;
  esac
done

[ -n "$CUSTOM_BACKENDS" ] && BACKENDS_JSON="$CUSTOM_BACKENDS"

if [ -z "$QUERY" ]; then
  echo '{"status":"error","error_code":"BACKEND_ERROR","error_message":"No query provided"}' >&2
  exit 1
fi

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_PATH")"

# ── Helpers ──────────────────────────────────────────────────
log_event() {
  local level="$1" msg="$2"
  echo "[$(now_iso)] $level query=$(json_escape "$QUERY") $msg" >> "$LOG_PATH" 2>/dev/null || true
}

# Resolve which class a backend belongs to
resolve_class() {
  local backend="$1"
  [ -z "$backend" ] && echo "null" && return
  python3 - "$ROUTER_CONFIG" "$backend" << 'PYEOF' 2>/dev/null || echo "null"
import json, sys
config_path, backend = sys.argv[1], sys.argv[2]
with open(config_path) as f:
    config = json.load(f)
for cls, info in config.get('classes', {}).items():
    if backend in info.get('backends', []):
        print('"' + cls + '"')
        sys.exit(0)
print('null')
PYEOF
}

# Resolve the hint/mode from the matched rule
resolve_mode() {
  local rule_id="$1"
  [ -z "$rule_id" ] && echo "null" && return
  python3 - "$ROUTER_CONFIG" "$rule_id" << 'PYEOF' 2>/dev/null || echo "null"
import json, sys
config_path, rule_id = sys.argv[1], sys.argv[2]
with open(config_path) as f:
    config = json.load(f)
for rule in config.get('rules', []):
    if rule['id'] == rule_id:
        hint = rule.get('hint', '')
        if hint:
            print('"' + hint + '"')
        else:
            print('null')
        sys.exit(0)
print('null')
PYEOF
}

# Read config values
FALLBACK_THRESHOLD=$(json_field "$ROUTER_CONFIG" "fallback_threshold" 2>/dev/null || echo "0.4")
TIMEOUT_MS=$(json_field "$ROUTER_CONFIG" "timeout_ms" 2>/dev/null || echo "5000")

# ── Phase 1: Signal Detection → Rule Matching ───────────────
detect_rule() {
  local query_lower
  query_lower=$(echo "$QUERY" | tr '[:upper:]' '[:lower:]')

  # Rules checked in order (first match wins, except ambiguous_default is last)
  echo "$query_lower" | python3 - "$ROUTER_CONFIG" << 'PYEOF' 2>/dev/null
import json, re, sys

config_path = sys.argv[1]
query = sys.stdin.read().strip()

with open(config_path) as f:
    config = json.load(f)

rules = config['rules']

for rule in rules:
    if rule['id'] == 'ambiguous_default':
        continue  # check last
    for signal in rule['signals']:
        try:
            if re.search(signal, query, re.IGNORECASE):
                print(rule['id'])
                sys.exit(0)
        except re.error:
            if signal.lower() in query:
                print(rule['id'])
                sys.exit(0)

# Default rule
print('ambiguous_default')
PYEOF
}

# ── Phase 2: Build dispatch chain ────────────────────────────
build_dispatch_chain() {
  local rule_id="$1"
  # Returns: backend1:hint backend2:hint ...
  python3 - "$ROUTER_CONFIG" "$BACKENDS_JSON" "$rule_id" << 'PYEOF' 2>/dev/null
import json, sys

config_path, backends_path, rule_id = sys.argv[1], sys.argv[2], sys.argv[3]

with open(config_path) as f:
    config = json.load(f)

# Load backends.json for availability — split into ready and degraded sets
ready_set = None    # None = no backends.json
degraded_set = set()
try:
    with open(backends_path) as f:
        backends_state = json.load(f)
    ready_set = set()
    for k, v in backends_state.get('backends', {}).items():
        st = v.get('status', '')
        if st == 'ready':
            ready_set.add(k)
        elif st == 'degraded':
            degraded_set.add(k)
except:
    pass

classes = config.get('classes', {})
rule = None
for r in config['rules']:
    if r['id'] == rule_id:
        rule = r
        break

if not rule:
    rule = config['rules'][-1]  # ambiguous_default

hint = rule.get('hint', '')

# Build raw dispatch chain (before availability filtering)
raw_chain = []

if 'dispatch_order' in rule:
    # Co-primary: explicit dispatch order
    for entry in rule['dispatch_order']:
        cls = entry['class']
        pos = entry['position']
        backends = classes.get(cls, {}).get('backends', [])
        if pos == 'primary' and backends:
            raw_chain.append((backends[0], hint))
        elif pos == 'secondary' and len(backends) > 1:
            raw_chain.append((backends[1], hint))
else:
    # Standard: primary class → fallback class
    primary_cls = rule.get('primary_class', 'retrieval_engine')
    fallback_cls = rule.get('fallback_class', 'memory_store')

    for b in classes.get(primary_cls, {}).get('backends', []):
        raw_chain.append((b, hint))
    for b in classes.get(fallback_cls, {}).get('backends', []):
        raw_chain.append((b, hint))

# Filter by capability: skip backends that don't support the current hint
if hint:
    import os
    install_root = os.environ.get('OPENCLAW_INSTALL_ROOT', os.path.expanduser('~/.openclaw/memory-stack'))
    filtered_chain = []
    for b, h in raw_chain:
        cap_path = os.path.join(install_root, 'skills', f'memory-{b}', 'capability.json')
        try:
            with open(cap_path) as cf:
                cap = json.load(cf)
            modes = cap.get('supported_modes', [])
            if hint in modes or not modes:
                filtered_chain.append((b, h))
            # else: skip — backend doesn't support this hint
        except:
            filtered_chain.append((b, h))  # no capability.json = allow
    raw_chain = filtered_chain

# Apply four-state dispatch ordering:
#   1. ready backends (preserving raw_chain order)
#   2. degraded backends (preserving raw_chain order)
#   Exclude: installed, unavailable, unknown
if ready_set is not None:
    chain_ready = [(b, h) for b, h in raw_chain if b in ready_set]
    chain_degraded = [(b, h) for b, h in raw_chain if b in degraded_set]
    chain = chain_ready + chain_degraded
else:
    # No backends.json — allow all (legacy/first-run behavior)
    chain = raw_chain

# Output
for b, h in chain:
    print(f'{b}:{h}')
PYEOF
}

# ── Dispatch to a single backend ─────────────────────────────
dispatch_backend() {
  local backend="$1" hint="$2"
  local wrapper="$INSTALL_ROOT/skills/memory-${backend}/wrapper.sh"

  if [ ! -x "$wrapper" ]; then
    contract_unavailable "$QUERY" "$backend" "Wrapper not found: $wrapper"
    return 1
  fi

  local hint_args=""
  [ -n "$hint" ] && hint_args="--hint $hint"

  # Run with timeout
  local output=""
  output=$(run_with_timeout "$TIMEOUT_MS" bash "$wrapper" --adapter "$QUERY" $hint_args 2>/dev/null) || true

  if [ -z "$output" ]; then
    contract_error "$QUERY" "$backend" "QUERY_TIMEOUT" "Backend exceeded ${TIMEOUT_MS}ms timeout"
    return 1
  fi

  echo "$output"
}

# ── Main routing loop ────────────────────────────────────────
RULE_ID=$(detect_rule)
CHAIN=$(build_dispatch_chain "$RULE_ID")

if [ -z "$CHAIN" ]; then
  # No backends available
  log_event "ERROR" "rule=$RULE_ID no_backends_available"
  escaped_query=$(json_escape "$QUERY")
  cat <<ENDJSON
{
  "query_echo": "$escaped_query",
  "routed_to": null,
  "routed_class": null,
  "routed_mode": $(resolve_mode "$RULE_ID"),
  "fallback_chain": [],
  "fallbacks_used": 0,
  "results": [],
  "result_count": 0,
  "status": "error",
  "error_code": "ALL_BACKENDS_FAILED",
  "error_message": "No backends available for rule $RULE_ID",
  "normalized_relevance": 0.0,
  "router_duration_ms": 0,
  "backend_duration_ms": 0
}
ENDJSON
  exit 1
fi

# Convert chain to arrays
BACKEND_LIST=()
HINT_LIST=()
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  BACKEND_LIST+=("${entry%%:*}")
  HINT_LIST+=("${entry#*:}")
done <<< "$CHAIN"

ROUTER_START=$(now_ms)
BEST_RESULT=""
BEST_RELEVANCE="0.0"
BEST_BACKEND=""
BEST_DURATION="0"
FALLBACKS_USED=0

for i in "${!BACKEND_LIST[@]}"; do
  backend="${BACKEND_LIST[$i]}"
  hint="${HINT_LIST[$i]}"

  result=$(dispatch_backend "$backend" "$hint")

  # Extract status and relevance
  status=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','error'))" 2>/dev/null || echo "error")
  relevance=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('normalized_relevance',0.0))" 2>/dev/null || echo "0.0")
  duration=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('backend_duration_ms',0))" 2>/dev/null || echo "0")

  # Track best result
  is_better=$(python3 -c "print('yes' if float('$relevance') > float('$BEST_RELEVANCE') else 'no')" 2>/dev/null || echo "no")
  if [ "$is_better" = "yes" ]; then
    BEST_RESULT="$result"
    BEST_RELEVANCE="$relevance"
    BEST_BACKEND="$backend"
    BEST_DURATION="$duration"
  fi

  # Check if good enough
  is_good=$(python3 -c "print('yes' if float('$relevance') >= float('$FALLBACK_THRESHOLD') and '$status' == 'success' else 'no')" 2>/dev/null || echo "no")

  if [ "$is_good" = "yes" ]; then
    break
  fi

  # Log fallback
  if [ "$i" -gt 0 ] || [ "$status" = "error" ]; then
    next_backend="${BACKEND_LIST[$((i+1))]:-none}"
    log_event "FALLBACK" "rule=$RULE_ID backend=$backend status=$status relevance=$relevance next=$next_backend"
  fi

  [ "$i" -gt 0 ] && FALLBACKS_USED=$((FALLBACKS_USED + 1))
done

log_event "SUCCESS" "rule=$RULE_ID backend=$BEST_BACKEND relevance=$BEST_RELEVANCE fallbacks=$FALLBACKS_USED"

ROUTER_END=$(now_ms)
ROUTER_DURATION=$(( ROUTER_END - ROUTER_START ))

# Build router envelope
escaped_query=$(json_escape "$QUERY")
chain_json=$(printf '"%s",' "${BACKEND_LIST[@]}" | sed 's/,$//')

# Determine final status
FINAL_STATUS="success"
if [ -z "$BEST_RESULT" ]; then
  FINAL_STATUS="error"
elif python3 -c "exit(0 if float('$BEST_RELEVANCE') >= float('$FALLBACK_THRESHOLD') else 1)" 2>/dev/null; then
  FINAL_STATUS="success"
elif python3 -c "exit(0 if float('$BEST_RELEVANCE') > 0 else 1)" 2>/dev/null; then
  FINAL_STATUS="partial"
else
  FINAL_STATUS="empty"
fi

# Extract results from best backend response
RESULTS_JSON="[]"
RESULT_COUNT=0
if [ -n "$BEST_RESULT" ]; then
  RESULTS_JSON=$(echo "$BEST_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('results',[])))" 2>/dev/null || echo "[]")
  RESULT_COUNT=$(echo "$BEST_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result_count',0))" 2>/dev/null || echo "0")
fi

cat <<ENDJSON
{
  "query_echo": "$escaped_query",
  "routed_to": $([ -n "$BEST_BACKEND" ] && echo "\"$BEST_BACKEND\"" || echo "null"),
  "routed_class": $(resolve_class "$BEST_BACKEND"),
  "routed_mode": $(resolve_mode "$RULE_ID"),
  "fallback_chain": [$chain_json],
  "fallbacks_used": $FALLBACKS_USED,
  "results": $RESULTS_JSON,
  "result_count": $RESULT_COUNT,
  "status": "$FINAL_STATUS",
  "normalized_relevance": $BEST_RELEVANCE,
  "router_duration_ms": $ROUTER_DURATION,
  "backend_duration_ms": $BEST_DURATION
}
ENDJSON
