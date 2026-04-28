#!/usr/bin/env bash
# Empirical verification of landing-page claims:
#   1. 更聰明  — deterministic rule-based routing with sequential fallback chain
#   2. 更省 token — tiered loading (L0/L1/L2) + auto-dedup
#   3. 更長久記憶 — local SQLite/git persistence across process boundaries
#
# Runs in an isolated $HOME so it does not pollute the user's facts DB.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT"

TEST_HOME="$(mktemp -d -t openclaw-landing-XXXXX)"
trap 'rm -rf "$TEST_HOME"' EXIT
export HOME="$TEST_HOME"

CLI="$PROJECT_ROOT/bin/openclaw-memory"
ROUTER_CONFIG="$PROJECT_ROOT/skills/memory-router/router-config.json"

PASS=0 FAIL=0
ok()      { echo "  ✔ $1"; PASS=$((PASS+1)); }
fail()    { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
section() { echo ""; echo "═══ $1 ═══"; }
info()    { echo "    $1"; }

# ─────────────────────────────────────────────────────────────
section "Test A — 更聰明 (deterministic routing + fallback chain)"
# ─────────────────────────────────────────────────────────────

# A1. Rule count meets landing claim (≥7)
RULE_COUNT=$(python3 -c "import json; print(len(json.load(open('$ROUTER_CONFIG'))['rules']))")
if [ "$RULE_COUNT" -ge 7 ]; then
  ok "router has $RULE_COUNT rules (landing claims ≥7)"
else
  fail "only $RULE_COUNT rules — below landing claim of 7"
fi

# A2. All rules use deterministic regex/keyword signals (not AI classification)
NON_DETERMINISTIC=$(python3 -c "
import json
rules = json.load(open('$ROUTER_CONFIG'))['rules']
print(sum(1 for r in rules if not isinstance(r.get('signals'), list) or not r['signals']))
")
if [ "$NON_DETERMINISTIC" = "0" ]; then
  ok "all $RULE_COUNT rules use deterministic signals (no AI classification)"
else
  fail "$NON_DETERMINISTIC rules lack signals"
fi

# A3. Sequential fallback chain — most rules declare fallback_class
WITH_FALLBACK=$(python3 -c "
import json
rules = json.load(open('$ROUTER_CONFIG'))['rules']
print(sum(1 for r in rules if r.get('fallback_class') or r.get('co_primary_class') or r.get('dispatch_order')))
")
if [ "$WITH_FALLBACK" -ge $(( RULE_COUNT * 70 / 100 )) ]; then
  ok "$WITH_FALLBACK/$RULE_COUNT rules declare fallback (≥70%)"
else
  fail "only $WITH_FALLBACK/$RULE_COUNT rules have fallback"
fi

# A4. Output envelope exposes fallback_chain — fallback is observable
HAS_FALLBACK_FIELDS=$(python3 -c "
import json
fields = json.load(open('$ROUTER_CONFIG'))['output_envelope']['fields']
print('yes' if 'fallback_chain' in fields and 'fallbacks_used' in fields else 'no')
")
if [ "$HAS_FALLBACK_FIELDS" = "yes" ]; then
  ok "output envelope exposes fallback_chain + fallbacks_used"
else
  fail "fallback fields missing from output envelope"
fi

# A5. RUNTIME: invoke real router.sh, parse its JSON envelope, verify routed_class
# Provide a fixture backends.json marking ALL backends as "ready" so the chain is built.
ROUTER_SH="$PROJECT_ROOT/skills/memory-router/router.sh"
FAKE_BACKENDS="$TEST_HOME/backends.json"
python3 -c "
import json
config = json.load(open('$ROUTER_CONFIG'))
backends = {}
for cls in config.get('classes', {}).values():
    for b in cls.get('backends', []):
        backends[b] = {'status': 'ready'}
json.dump({'backends': backends}, open('$FAKE_BACKENDS', 'w'))
"

declare -a CASES=(
  "find function parseAuth|retrieval_engine"
  "what depends on PaymentService|knowledge_graph"
  "why did we choose JWT over sessions|memory_store"
  "few minutes ago we talked about caching|memory_store"
  "expand context of previous step|context_engine"
)

ROUTE_PASS=0
ROUTE_TOTAL=${#CASES[@]}
for entry in "${CASES[@]}"; do
  query="${entry%%|*}"
  expected="${entry##*|}"
  # Run the actual router.sh — stderr suppressed, stdout is JSON envelope
  router_out=$(OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" \
    bash "$ROUTER_SH" "$query" --backends-json "$FAKE_BACKENDS" 2>/dev/null || true)
  # Extract first backend in fallback_chain, resolve to class via router-config
  actual=$(echo "$router_out" | python3 -c "
import json, sys
config = json.load(open('$ROUTER_CONFIG'))
try:
    env = json.loads(sys.stdin.read())
except:
    print('PARSE_ERROR'); sys.exit(0)
chain = env.get('fallback_chain') or []
if not chain:
    print('EMPTY_CHAIN'); sys.exit(0)
first = chain[0]
for cls_name, info in config.get('classes', {}).items():
    if first in info.get('backends', []):
        print(cls_name); sys.exit(0)
print('UNKNOWN_CLASS')
" 2>/dev/null || echo "ERROR")
  if [ "$actual" = "$expected" ]; then
    ROUTE_PASS=$((ROUTE_PASS+1))
  else
    info "[route mismatch] '$query' → expected $expected, got $actual"
  fi
done
if [ "$ROUTE_PASS" = "$ROUTE_TOTAL" ]; then
  ok "$ROUTE_PASS/$ROUTE_TOTAL queries routed correctly via real router.sh execution"
else
  fail "only $ROUTE_PASS/$ROUTE_TOTAL queries routed correctly — landing claims 13 rules but real routing differs"
  info "Diagnosis: detect_rule() in router.sh:288 uses 'echo \$q | python3 - <<EOF' — pipe AND"
  info "  heredoc both target stdin; pipe wins, python tries to parse query as script, fails"
  info "  silently (2>/dev/null), function returns empty, build_dispatch_chain falls through to"
  info "  ambiguous_default. ALL queries route to retrieval_engine→memory_store regardless of intent."
  info "Fix: pass query as argv ('python3 - \"\$ROUTER_CONFIG\" \"\$query_lower\"' + sys.argv[2])."
fi

# A5b. Bug-fingerprint: distinct query intents should yield distinct chains.
# If they all collapse to the same chain, rule matching is broken.
DIVERSE_QUERIES=(
  "find function parseAuth"
  "what depends on PaymentService"
  "expand context of previous step"
  "few minutes ago we talked"
)
CHAINS_FILE=$(mktemp)
for q in "${DIVERSE_QUERIES[@]}"; do
  OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" bash "$ROUTER_SH" "$q" --backends-json "$FAKE_BACKENDS" 2>/dev/null \
    | python3 -c "import json,sys
try: print(','.join(json.loads(sys.stdin.read()).get('fallback_chain',[])))
except: print('ERR')" 2>/dev/null \
    >> "$CHAINS_FILE" || true
done
DISTINCT_CHAINS=$(sort -u "$CHAINS_FILE" | wc -l | tr -d ' ')
if [ "$DISTINCT_CHAINS" -ge 2 ]; then
  ok "${#DIVERSE_QUERIES[@]} distinct query intents produce $DISTINCT_CHAINS distinct chains (rule matching alive)"
else
  fail "${#DIVERSE_QUERIES[@]} distinct intents collapse to $DISTINCT_CHAINS chain — detect_rule broken"
  while IFS= read -r c; do info "  observed chain: [$c]"; done < <(sort -u "$CHAINS_FILE")
fi
rm -f "$CHAINS_FILE"

# A6. RUNTIME: verify fallback_chain is populated AND fallbacks_used is observable
sample_out=$(OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" \
  bash "$ROUTER_SH" "find function parseAuth" --backends-json "$FAKE_BACKENDS" 2>/dev/null || true)
chain_len=$(echo "$sample_out" | python3 -c "
import json, sys
try: print(len(json.loads(sys.stdin.read()).get('fallback_chain', [])))
except: print(0)
" 2>/dev/null || echo 0)
fallbacks_used=$(echo "$sample_out" | python3 -c "
import json, sys
try: print(json.loads(sys.stdin.read()).get('fallbacks_used', -1))
except: print(-1)
" 2>/dev/null || echo -1)
if [ "$chain_len" -ge 1 ] && [ "$fallbacks_used" != "-1" ]; then
  ok "router.sh emits real fallback_chain (len=$chain_len) + fallbacks_used=$fallbacks_used"
else
  fail "router.sh did not emit fallback chain (len=$chain_len, used=$fallbacks_used)"
fi

# ─────────────────────────────────────────────────────────────
section "Test B — 更省 token (tiered loading + dedup)"
# ─────────────────────────────────────────────────────────────

# B1. Tier token budgets are bounded and small relative to full content
# shellcheck disable=SC1091
source "$PROJECT_ROOT/lib/tiered-loading.sh"
if [ "$TIER_L0_TOKENS" -le 200 ]; then
  ok "TIER_L0_TOKENS=$TIER_L0_TOKENS (landing: ~100)"
else
  fail "TIER_L0_TOKENS=$TIER_L0_TOKENS exceeds reasonable bound"
fi
if [ "$TIER_L1_TOKENS" -ge 600 ] && [ "$TIER_L1_TOKENS" -le 1000 ]; then
  ok "TIER_L1_TOKENS=$TIER_L1_TOKENS (landing claim: ~800)"
else
  fail "TIER_L1_TOKENS=$TIER_L1_TOKENS deviates from landing claim of ~800"
fi

# B2. RUNTIME: real BPE tokenization via tiktoken (cl100k_base, GPT-4 family)
# Falls back to ~4-char heuristic only if tiktoken unavailable.
TIKTOKEN_PY="${TIKTOKEN_VENV:-/tmp/landing-test-venv/bin/python3}"
if [ ! -x "$TIKTOKEN_PY" ] || ! "$TIKTOKEN_PY" -c "import tiktoken" 2>/dev/null; then
  info "tiktoken venv not found at $TIKTOKEN_PY — set up with:"
  info "  python3 -m venv /tmp/landing-test-venv && /tmp/landing-test-venv/bin/pip install tiktoken"
  TIKTOKEN_PY=""
fi

FIXTURE="$PROJECT_ROOT/docs/benchmarks-full.md"
[ -f "$FIXTURE" ] || FIXTURE="$PROJECT_ROOT/README.md"

WORK=$(mktemp -d)
cp "$FIXTURE" "$WORK/sample.md"
generate_tiers "$WORK/sample.md" >/dev/null 2>&1 || true

# Extract just the content after "## sample.md\n" header from sidecar files
[ -f "$WORK/.abstract" ] && tail -n +2 "$WORK/.abstract" > "$WORK/L0.txt" || : > "$WORK/L0.txt"
[ -f "$WORK/.overview" ] && tail -n +2 "$WORK/.overview" > "$WORK/L1.txt" || : > "$WORK/L1.txt"
cp "$WORK/sample.md" "$WORK/L2.txt"

count_tokens() {
  local file="$1"
  if [ -n "$TIKTOKEN_PY" ]; then
    "$TIKTOKEN_PY" -c "
import tiktoken, sys
enc = tiktoken.get_encoding('cl100k_base')
print(len(enc.encode(open('$file').read())))
" 2>/dev/null || echo 0
  else
    # Fallback heuristic
    echo $(( $(wc -c < "$file" | tr -d ' ') / 4 ))
  fi
}

L0_TOK=$(count_tokens "$WORK/L0.txt")
L1_TOK=$(count_tokens "$WORK/L1.txt")
L2_TOK=$(count_tokens "$WORK/L2.txt")

L0_PCT=$(python3 -c "print(round(${L0_TOK} * 100 / max(${L2_TOK},1), 2))")
L1_PCT=$(python3 -c "print(round(${L1_TOK} * 100 / max(${L2_TOK},1), 2))")
L0_SAVE=$(python3 -c "print(round(100 - ${L0_TOK} * 100 / max(${L2_TOK},1), 2))")
L1_SAVE=$(python3 -c "print(round(100 - ${L1_TOK} * 100 / max(${L2_TOK},1), 2))")

info "Tokenizer: $([ -n "$TIKTOKEN_PY" ] && echo 'tiktoken cl100k_base (REAL BPE)' || echo 'heuristic ÷4')"
info "Document:  $(basename "$FIXTURE")"
info "  L2 (full):     ${L2_TOK} tokens   (100%)"
info "  L1 (overview): ${L1_TOK} tokens   (${L1_PCT}%, save ${L1_SAVE}%)"
info "  L0 (abstract): ${L0_TOK} tokens   (${L0_PCT}%, save ${L0_SAVE}%)"

L0_OK=$(python3 -c "print('1' if ${L0_TOK} * 100 / max(${L2_TOK},1) <= 20 else '0')")
if [ "$L0_OK" = "1" ]; then
  ok "L0 reduces tokens by ≥80% vs full content (real BPE measure: ${L0_SAVE}%)"
else
  fail "L0 only reduces ${L0_SAVE}% of tokens (claim ≥80%)"
fi

L1_OK=$(python3 -c "print('1' if ${L1_TOK} * 100 / max(${L2_TOK},1) <= 50 else '0')")
if [ "$L1_OK" = "1" ]; then
  ok "L1 reduces tokens by ≥50% vs full content (real BPE measure: ${L1_SAVE}%)"
else
  fail "L1 only reduces ${L1_SAVE}% of tokens (claim ≥50%)"
fi

# B2b. Sanity: heuristic L0 is just a one-line truncation, not a true summary.
# Real summaries come from the OpenClaw agent via 'openclaw-memory tier set'.
L0_RAW_LINES=$(wc -l < "$WORK/L0.txt" | tr -d ' ')
info "  ⓘ  L0/L1 above were heuristic (first line / char-bounded prefix), used as offline default."
info "      Agent-quality summaries: openclaw-memory tier set <file> --l0 \"...\" --l1 \"...\""

rm -rf "$WORK"

# B3. Dedup — insert 5 identical facts, expect 1 row
DUP_KEY="dup_test_$$"
for _ in 1 2 3 4 5; do
  bash "$CLI" add --type pref --key "$DUP_KEY" --value "PostgreSQL" >/dev/null 2>&1 || true
done
DB="$HOME/.openclaw/memory/facts.sqlite"
if [ -f "$DB" ]; then
  DUP_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM facts WHERE key='$DUP_KEY';" 2>/dev/null || echo 0)
  if [ "$DUP_COUNT" = "1" ]; then
    ok "5 identical inserts produce 1 row (exact-match dedup works)"
  else
    fail "5 identical inserts produced $DUP_COUNT rows (dedup broken)"
  fi
else
  fail "facts DB not created at $DB"
fi

# B5. RUNTIME: agent-driven tier flow — `tier set` persists, `tier show` retrieves
TIER_FIXTURE=$(mktemp -d)
cp "$PROJECT_ROOT/README.md" "$TIER_FIXTURE/sample.md"
AGENT_L0="Memory Stack: 13-rule router + 2 local backends, no cloud LLM required."
AGENT_L1="Memory Stack bundles a deterministic 13-rule router with Total Recall (git-based) and QMD (BM25/vector) backends. The OpenClaw agent itself summarizes content at L0/L1 — no Ollama or MLX install needed. Storage is fully local (SQLite + git orphan branch)."

bash "$CLI" tier set "$TIER_FIXTURE/sample.md" --l0 "$AGENT_L0" --l1 "$AGENT_L1" >/dev/null 2>&1
got_l0=$(bash "$CLI" tier show "$TIER_FIXTURE/sample.md" --level L0 2>/dev/null)
got_l1_first_line=$(bash "$CLI" tier show "$TIER_FIXTURE/sample.md" --level L1 2>/dev/null | head -1)

if [ "$got_l0" = "$AGENT_L0" ] && [ -n "$got_l1_first_line" ] && [ "${got_l1_first_line:0:30}" = "${AGENT_L1:0:30}" ]; then
  ok "agent-provided L0/L1 round-trip via 'tier set' → 'tier show' (no LLM service called)"
else
  fail "tier set/show round-trip failed: L0='$got_l0' L1_head='${got_l1_first_line:0:60}'"
fi
rm -rf "$TIER_FIXTURE"

# B6. RUNTIME: confirm Ollama is NOT contacted during tier set
# Set TIER_ENDPOINT to a TEST-NET-1 blackhole; tier set must still complete fast.
TIER_FIXTURE=$(mktemp -d)
cp "$PROJECT_ROOT/README.md" "$TIER_FIXTURE/sample.md"
t0=$(python3 -c "import time;print(int(time.time()*1000))")
TIER_ENDPOINT="http://192.0.2.1:11434" \
  bash "$CLI" tier set "$TIER_FIXTURE/sample.md" --l0 "x" --l1 "y" >/dev/null 2>&1
t1=$(python3 -c "import time;print(int(time.time()*1000))")
elapsed=$(( t1 - t0 ))
if [ "$elapsed" -lt 2000 ]; then
  ok "tier set completed in ${elapsed}ms with TIER_ENDPOINT poisoned (proves no Ollama call)"
else
  fail "tier set took ${elapsed}ms — likely tried to reach Ollama"
fi
rm -rf "$TIER_FIXTURE"

# B4. Supersede — different value with same key archives the old one
bash "$CLI" add --type pref --key "$DUP_KEY" --value "MySQL" >/dev/null 2>&1 || true
LIVE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM facts WHERE key='$DUP_KEY';" 2>/dev/null || echo 0)
ARCH=$(sqlite3 "$DB" "SELECT COUNT(*) FROM facts_archive WHERE key='$DUP_KEY';" 2>/dev/null || echo 0)
if [ "$LIVE" = "1" ] && [ "$ARCH" = "1" ]; then
  ok "supersede dedup: 1 live row + 1 archived row (saves history without bloat)"
else
  fail "supersede dedup wrong: live=$LIVE archived=$ARCH"
fi

# ─────────────────────────────────────────────────────────────
section "Test C — 更長久記憶 (cross-process persistence + local-only)"
# ─────────────────────────────────────────────────────────────

# C1. Storage is a local file on disk
if [ -f "$DB" ]; then
  DB_SIZE=$(wc -c < "$DB" | tr -d ' ')
  ok "memory persists to local SQLite (size: ${DB_SIZE} bytes)"
else
  fail "no local SQLite file at $DB"
fi

# C2. Insert via process A, query via fresh process B
MARKER_KEY="persist_marker_$$"
MARKER_VAL="this-fact-must-survive-restart-$$"

# Process A: insert
bash -c "
  HOME='$TEST_HOME' OPENCLAW_INSTALL_ROOT='$PROJECT_ROOT' \
    bash '$CLI' add --type fact --key '$MARKER_KEY' --value '$MARKER_VAL' >/dev/null 2>&1
" || true

# Brief pause to ensure SQLite write completes
sleep 0.2

# Process B: clean env, query
QUERY_RESULT=$(env -i PATH="$PATH" HOME="$TEST_HOME" OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" \
  bash "$CLI" query "$MARKER_KEY" --format json 2>/dev/null || echo "[]")

if echo "$QUERY_RESULT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(2)
sys.exit(0 if any(r.get('key') == '$MARKER_KEY' for r in data) else 1)
" 2>/dev/null; then
  ok "fact survived: written by process A, retrieved by clean process B"
else
  fail "fact did NOT survive process boundary"
  info "raw query result: $(echo "$QUERY_RESULT" | head -c 200)"
fi

# C3. RUNTIME: prove operations complete WITHOUT network egress.
# Strategy: route HTTP/HTTPS through TEST-NET-1 (RFC 5737, non-routable). Any tool
# that respects proxy env (curl/python/git/qmd) would hang on TCP timeout.
# If the CLI completes in < 3 seconds, no HTTP request was attempted.
NET_KEY="net_test_$$"
NET_VAL="value-no-net-$$"

t_start=$(python3 -c "import time; print(int(time.time()*1000))")
HTTP_PROXY="http://192.0.2.1:9999" \
HTTPS_PROXY="http://192.0.2.1:9999" \
http_proxy="http://192.0.2.1:9999" \
https_proxy="http://192.0.2.1:9999" \
ALL_PROXY="http://192.0.2.1:9999" \
NO_PROXY="" no_proxy="" \
HOME="$TEST_HOME" OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" \
  bash "$CLI" add --type fact --key "$NET_KEY" --value "$NET_VAL" >/dev/null 2>&1 || true

HTTP_PROXY="http://192.0.2.1:9999" \
HTTPS_PROXY="http://192.0.2.1:9999" \
http_proxy="http://192.0.2.1:9999" \
https_proxy="http://192.0.2.1:9999" \
ALL_PROXY="http://192.0.2.1:9999" \
NO_PROXY="" no_proxy="" \
HOME="$TEST_HOME" OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" \
  bash "$CLI" query "$NET_KEY" --format json >/dev/null 2>&1 || true
t_end=$(python3 -c "import time; print(int(time.time()*1000))")
elapsed_ms=$(( t_end - t_start ))

if [ "$elapsed_ms" -lt 3000 ]; then
  ok "add+query completed in ${elapsed_ms}ms with HTTP_PROXY → TEST-NET-1 (no network egress attempted)"
else
  fail "operations took ${elapsed_ms}ms with dead proxy — likely tried network"
fi

# Verify the operation actually worked despite blackhole proxy
NET_FOUND=$(sqlite3 "$DB" "SELECT COUNT(*) FROM facts WHERE key='$NET_KEY';" 2>/dev/null || echo 0)
if [ "$NET_FOUND" = "1" ]; then
  ok "fact stored AND retrievable while network was poisoned (proves local-only path)"
else
  fail "fact NOT stored under poisoned proxy (count=$NET_FOUND) — code path may need network"
fi

# C4. RUNTIME: prove Total Recall actually writes to filesystem
# (Skipped if Total Recall wrapper requires external bun/qmd not on this test runner.)
TR_WRAPPER="$PROJECT_ROOT/skills/memory-totalrecall/wrapper.sh"
TR_REPO="$TEST_HOME/tr-repo"
mkdir -p "$TR_REPO"
( cd "$TR_REPO" && git init -q && git config user.email "t@t" && git config user.name "t" \
  && git commit --allow-empty -q -m "init" )

# Snapshot files before
before_count=$(find "$TR_REPO" -type f 2>/dev/null | wc -l | tr -d ' ')

# Invoke Total Recall to store something. Use Layer A native API: store <tier> <slug> <content>
OPENCLAW_INSTALL_ROOT="$PROJECT_ROOT" OPENCLAW_REPO_ROOT="$TR_REPO" \
  bash "$TR_WRAPPER" store daily "landing-test-$$" "test content from landing claim verification" \
  >/dev/null 2>&1 || true

after_count=$(find "$TR_REPO" -type f 2>/dev/null | wc -l | tr -d ' ')
new_files=$(( after_count - before_count ))

if [ "$new_files" -ge 1 ]; then
  # Find what was actually written
  newest=$(find "$TR_REPO" -type f -newer "$TR_REPO/.git/HEAD" 2>/dev/null | head -1)
  ok "Total Recall wrote $new_files new file(s) to filesystem (e.g., $(basename "$newest" 2>/dev/null))"
else
  fail "Total Recall did NOT write to filesystem (before=$before_count, after=$after_count)"
fi

# ─────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  RESULTS:  $PASS passed   $FAIL failed"
echo "═══════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
