#!/usr/bin/env bash
# OpenClaw Memory Stack — Class-Based Memory Router
# Usage: router.sh "<query>" [--hint <hint>] [--backends-json <path>]
set -euo pipefail

ROUTER_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="${OPENCLAW_INSTALL_ROOT:-$HOME/.openclaw/memory-stack}"
source "$INSTALL_ROOT/lib/contracts.sh"
source "$INSTALL_ROOT/lib/tiered-loading.sh"

ROUTER_CONFIG="${OPENCLAW_ROUTER_CONFIG:-$ROUTER_DIR/router-config.json}"
BACKENDS_JSON="${OPENCLAW_BACKENDS_JSON:-$HOME/.openclaw/state/backends.json}"
LOG_PATH="$HOME/.openclaw/state/router.log"
SESSION_CACHE="/tmp/openclaw-router-$$.json"
trap 'rm -f "$SESSION_CACHE"' EXIT

# Parse arguments
QUERY="" HINT="" CUSTOM_BACKENDS=""
BM25_WEIGHT="1.0" VECTOR_WEIGHT="0.7"
TRAJECTORY_ENABLED=false
TIER_LEVEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hint) HINT="$2"; shift 2 ;;
    --backends-json) CUSTOM_BACKENDS="$2"; shift 2 ;;
    --bm25-weight) BM25_WEIGHT="$2"; shift 2 ;;
    --vector-weight) VECTOR_WEIGHT="$2"; shift 2 ;;
    --trajectory) TRAJECTORY_ENABLED=true; shift ;;
    --tier) TIER_LEVEL="$2"; shift 2 ;;
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

# ── Trajectory tracking ─────────────────────────────────────
TRAJECTORY_STEP=0
TRAJECTORY_DIR="$HOME/.openclaw/state"
TRAJECTORY_TMP="/tmp/openclaw-trajectory-$$.json"

trajectory_add() {
  # Usage: trajectory_add '{"action": "classify", ...}'
  local step_json="$1"
  TRAJECTORY_STEP=$((TRAJECTORY_STEP + 1))
  # Append step with step number to temp file (one JSON object per line)
  python3 -c "
import json, sys
step = json.loads(sys.argv[1])
step['step'] = int(sys.argv[2])
print(json.dumps(step))
" "$step_json" "$TRAJECTORY_STEP" >> "$TRAJECTORY_TMP" 2>/dev/null || true
}

trajectory_finalize() {
  # Build complete trajectory JSON object and write to state files
  local query="$1" timestamp="$2"
  mkdir -p "$TRAJECTORY_DIR"

  python3 -c "
import json, sys, os

query = sys.argv[1]
timestamp = sys.argv[2]
tmp_path = sys.argv[3]
state_dir = sys.argv[4]

# Read accumulated steps
steps = []
try:
    with open(tmp_path) as f:
        for line in f:
            line = line.strip()
            if line:
                steps.append(json.loads(line))
except FileNotFoundError:
    pass

trajectory = {
    'query': query,
    'timestamp': timestamp,
    'trajectory': steps
}

# Write latest trajectory
latest_path = os.path.join(state_dir, 'trajectory-latest.json')
with open(latest_path, 'w') as f:
    json.dump(trajectory, f, indent=2)
    f.write('\n')

# Append to history log (one JSON per line)
log_path = os.path.join(state_dir, 'trajectory.log')
with open(log_path, 'a') as f:
    f.write(json.dumps(trajectory) + '\n')

# Output the trajectory JSON for embedding in response
print(json.dumps(trajectory))
" "$query" "$timestamp" "$TRAJECTORY_TMP" "$TRAJECTORY_DIR" 2>/dev/null || echo "{}"
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

# ── RRF Fusion: Hybrid BM25 + Vector Search ─────────────────
rrf_fusion() {
  local query="$1"
  local bm25_weight="${2:-1.0}"
  local vector_weight="${3:-0.7}"
  local top_k="${4:-20}"

  if ! has_command qmd; then
    contract_error "$query" "qmd" "BACKEND_UNAVAILABLE" "qmd CLI not found (required for hybrid search)"
    return 1
  fi

  local start_ms
  start_ms=$(now_ms)

  # Run BM25 and vector searches in parallel
  local bm25_output="" vector_output=""
  local bm25_tmp="/tmp/openclaw-rrf-bm25-$$.json"
  local vector_tmp="/tmp/openclaw-rrf-vector-$$.json"
  trap "rm -f '$bm25_tmp' '$vector_tmp'" RETURN

  qmd search "$query" --json > "$bm25_tmp" 2>/dev/null &
  local bm25_pid=$!
  qmd vsearch "$query" --json > "$vector_tmp" 2>/dev/null &
  local vector_pid=$!
  wait "$bm25_pid" || true
  wait "$vector_pid" || true

  bm25_output=$(cat "$bm25_tmp" 2>/dev/null)
  vector_output=$(cat "$vector_tmp" 2>/dev/null)

  local end_ms duration_ms
  end_ms=$(now_ms)
  duration_ms=$(( end_ms - start_ms ))

  # Merge with RRF scoring
  local results count normalized
  read -r results count normalized < <(python3 -c "
import json, sys

K = 60  # RRF constant

def parse_results(raw):
    if not raw or raw in ('null', '[]', ''):
        return []
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return data
        elif isinstance(data, dict) and 'results' in data:
            return data['results']
        return [data]
    except:
        return []

bm25_items = parse_results(open('$bm25_tmp').read() if True else '')
vector_items = parse_results(open('$vector_tmp').read() if True else '')

bm25_weight = float('$bm25_weight')
vector_weight = float('$vector_weight')
top_k = int('$top_k')

# Build doc_id → rank maps
def doc_key(item):
    return item.get('path', item.get('source', item.get('content', str(item))))[:200]

bm25_ranks = {}
for i, item in enumerate(bm25_items):
    key = doc_key(item)
    if key not in bm25_ranks:
        bm25_ranks[key] = i + 1

vector_ranks = {}
for i, item in enumerate(vector_items):
    key = doc_key(item)
    if key not in vector_ranks:
        vector_ranks[key] = i + 1

# Collect all unique docs
all_docs = {}
for item in bm25_items + vector_items:
    key = doc_key(item)
    if key not in all_docs:
        all_docs[key] = item

# Compute RRF scores
scored = []
for key, item in all_docs.items():
    score = 0.0
    if key in bm25_ranks:
        score += bm25_weight * (1.0 / (K + bm25_ranks[key]))
    if key in vector_ranks:
        score += vector_weight * (1.0 / (K + vector_ranks[key]))
    scored.append((score, item))

scored.sort(key=lambda x: x[0], reverse=True)
scored = scored[:top_k]

results = []
for score, item in scored:
    content = item.get('content', item.get('text', item.get('path', str(item))))
    results.append({
        'content': str(content)[:500],
        'relevance': round(score, 6),
        'source': 'qmd',
        'timestamp': item.get('timestamp', '$(now_iso)'),
        'rrf_score': round(score, 6)
    })

# Normalize relevance to 0-1 range
if results:
    max_score = results[0]['relevance']
    if max_score > 0:
        for r in results:
            r['relevance'] = round(r['relevance'] / max_score, 4)

best = results[0]['relevance'] if results else 0.0
print(json.dumps(results), len(results), round(best, 4))
" 2>/dev/null) || true

  [ -z "$count" ] && count=0
  [ -z "$normalized" ] && normalized="0.0"

  if [ "$count" -eq 0 ]; then
    contract_empty "$query" "qmd" "$duration_ms"
  else
    contract_success "$query" "qmd" "$results" "$count" "$duration_ms" "$normalized"
  fi
}

# ── Phase 1: Signal Detection → Rule Matching ───────────────
detect_rule() {
  local query_lower
  query_lower=$(echo "$QUERY" | tr '[:upper:]' '[:lower:]')

  # Rules checked in order (first match wins, except ambiguous_default is last).
  # Query passed as argv[2] — NOT via stdin — because heredoc and pipe both target
  # stdin, and pipe wins, which would feed the query in as the Python script.
  python3 - "$ROUTER_CONFIG" "$query_lower" << 'PYEOF' 2>/dev/null
import json, re, sys

config_path = sys.argv[1]
query = sys.argv[2].strip()

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

# Record classify step in trajectory
if $TRAJECTORY_ENABLED; then
  # Get matched signals for the rule
  _matched_signals=$(python3 -c "
import json, re, sys
config_path, rule_id, query = sys.argv[1], sys.argv[2], sys.argv[3].lower()
with open(config_path) as f:
    config = json.load(f)
for rule in config['rules']:
    if rule['id'] == rule_id:
        matched = [s for s in rule.get('signals', []) if re.search(s, query, re.IGNORECASE)]
        print(json.dumps(matched[:5]))
        sys.exit(0)
print('[]')
" "$ROUTER_CONFIG" "$RULE_ID" "$QUERY" 2>/dev/null || echo "[]")

  trajectory_add "{\"action\": \"classify_query\", \"matched_rule\": \"$RULE_ID\", \"signals_matched\": $_matched_signals, \"confidence\": 0.85}"
fi

# Intercept hybrid search: bypass normal dispatch, use RRF fusion
if [ "$RULE_ID" = "hybrid_search" ] || [ "$HINT" = "hybrid" ]; then
  ROUTER_START=$(now_ms)
  FUSION_RESULT=$(rrf_fusion "$QUERY" "$BM25_WEIGHT" "$VECTOR_WEIGHT")
  ROUTER_END=$(now_ms)
  ROUTER_DURATION=$(( ROUTER_END - ROUTER_START ))

  # Extract fields from fusion result
  # Extract all fusion fields in one python3 call
  _fusion_parsed=$(echo "$FUSION_RESULT" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  print(d.get('status','error'))
  print(json.dumps(d.get('results',[])))
  print(d.get('result_count',0))
  print(d.get('normalized_relevance',0.0))
  print(d.get('backend_duration_ms',0))
except:
  print('error'); print('[]'); print('0'); print('0.0'); print('0')
" 2>/dev/null || printf 'error\n[]\n0\n0.0\n0')
  fusion_status=$(echo "$_fusion_parsed" | sed -n '1p')
  fusion_results=$(echo "$_fusion_parsed" | sed -n '2p')
  fusion_count=$(echo "$_fusion_parsed" | sed -n '3p')
  fusion_relevance=$(echo "$_fusion_parsed" | sed -n '4p')
  fusion_duration=$(echo "$_fusion_parsed" | sed -n '5p')

  escaped_query=$(json_escape "$QUERY")
  log_event "SUCCESS" "rule=hybrid_search backend=qmd(rrf) relevance=$fusion_relevance"

  cat <<ENDJSON
{
  "query_echo": "$escaped_query",
  "routed_to": "qmd",
  "routed_class": "retrieval_engine",
  "routed_mode": "hybrid",
  "fallback_chain": ["qmd"],
  "fallbacks_used": 0,
  "results": $fusion_results,
  "result_count": $fusion_count,
  "status": "$fusion_status",
  "normalized_relevance": $fusion_relevance,
  "router_duration_ms": $ROUTER_DURATION,
  "backend_duration_ms": $fusion_duration,
  "fusion": {"bm25_weight": $BM25_WEIGHT, "vector_weight": $VECTOR_WEIGHT}
}
ENDJSON
  exit 0
fi

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

  dispatch_start_ms=$(now_ms)

  result=$(dispatch_backend "$backend" "$hint")

  dispatch_end_ms=$(now_ms)
  dispatch_latency=$(( dispatch_end_ms - dispatch_start_ms ))

  # Extract status, relevance, duration, count in one python3 call
  _parsed=$(echo "$result" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  print(d.get('status','error'))
  print(d.get('normalized_relevance',0.0))
  print(d.get('backend_duration_ms',0))
  print(d.get('result_count',0))
except:
  print('error'); print('0.0'); print('0'); print('0')
" 2>/dev/null || printf 'error\n0.0\n0\n0')
  status=$(echo "$_parsed" | sed -n '1p')
  relevance=$(echo "$_parsed" | sed -n '2p')
  duration=$(echo "$_parsed" | sed -n '3p')
  result_count=$(echo "$_parsed" | sed -n '4p')

  # Record dispatch/fallback step in trajectory
  if $TRAJECTORY_ENABLED; then
    _backend_class=$(resolve_class "$backend" | tr -d '"')
    if [ "$i" -eq 0 ]; then
      trajectory_add "{\"action\": \"dispatch\", \"backend\": \"$backend\", \"class\": \"$_backend_class\", \"role\": \"primary\", \"latency_ms\": $dispatch_latency, \"results_count\": $result_count, \"top_score\": $relevance}"
    else
      _fallback_reason="score below threshold ($FALLBACK_THRESHOLD)"
      [ "$status" = "error" ] && _fallback_reason="backend error"
      trajectory_add "{\"action\": \"fallback\", \"reason\": \"$_fallback_reason\", \"backend\": \"$backend\", \"class\": \"$_backend_class\", \"role\": \"fallback\", \"latency_ms\": $dispatch_latency, \"results_count\": $result_count, \"top_score\": $relevance}"
    fi
  fi

  # Track best result + check if good enough (single python3 call)
  _cmp=$(python3 -c "
r,br,ft,st=float('$relevance'),float('$BEST_RELEVANCE'),float('$FALLBACK_THRESHOLD'),'$status'
print('yes' if r>br else 'no')
print('yes' if r>=ft and st=='success' else 'no')
" 2>/dev/null || printf 'no\nno')
  is_better=$(echo "$_cmp" | sed -n '1p')
  is_good=$(echo "$_cmp" | sed -n '2p')
  if [ "$is_better" = "yes" ]; then
    BEST_RESULT="$result"
    BEST_RELEVANCE="$relevance"
    BEST_BACKEND="$backend"
    BEST_DURATION="$duration"
  fi

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
if [ -z "$BEST_RESULT" ]; then
  FINAL_STATUS="error"
else
  FINAL_STATUS=$(python3 -c "
r,t=float('$BEST_RELEVANCE'),float('$FALLBACK_THRESHOLD')
print('success' if r>=t else 'partial' if r>0 else 'empty')
" 2>/dev/null || echo "error")
fi

# Extract results from best backend response
RESULTS_JSON="[]"
RESULT_COUNT=0
if [ -n "$BEST_RESULT" ]; then
  RESULTS_JSON=$(echo "$BEST_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('results',[])))" 2>/dev/null || echo "[]")
  RESULT_COUNT=$(echo "$BEST_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result_count',0))" 2>/dev/null || echo "0")
fi

# ── Tiered loading: L0/L1/L2 ────────────────────────────────
# If --tier is set, apply tiered loading to results.
# Default (no --tier): return full results as-is.
# L0: auto-expand to L1 if score > threshold.
EFFECTIVE_TIER=""
if [ -n "$TIER_LEVEL" ]; then
  EFFECTIVE_TIER="$TIER_LEVEL"
elif [ "$RESULT_COUNT" -gt 0 ] && [ -z "$TIER_LEVEL" ]; then
  # Default behavior: auto-expand based on score
  EFFECTIVE_TIER=$(auto_expand_tier "$QUERY" "$BEST_RELEVANCE" 2>/dev/null || echo "")
fi

# Record merge step and finalize trajectory
TRAJECTORY_JSON=""
if $TRAJECTORY_ENABLED; then
  # Build sources map from dispatch results
  _sources_json="{\"$BEST_BACKEND\": $RESULT_COUNT}"
  trajectory_add "{\"action\": \"merge_results\", \"final_count\": $RESULT_COUNT, \"sources\": $_sources_json}"

  TRAJECTORY_JSON=$(trajectory_finalize "$(json_escape "$QUERY")" "$(now_iso)")
  rm -f "$TRAJECTORY_TMP"
fi

if $TRAJECTORY_ENABLED && [ -n "$TRAJECTORY_JSON" ]; then
  # Include trajectory in response
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
  "backend_duration_ms": $BEST_DURATION,
  "tier": $([ -n "$EFFECTIVE_TIER" ] && echo "\"$EFFECTIVE_TIER\"" || echo "null"),
  "trajectory": $(echo "$TRAJECTORY_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('trajectory',[])))" 2>/dev/null || echo "[]")
}
ENDJSON
else
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
  "backend_duration_ms": $BEST_DURATION,
  "tier": $([ -n "$EFFECTIVE_TIER" ] && echo "\"$EFFECTIVE_TIER\"" || echo "null")
}
ENDJSON
fi
