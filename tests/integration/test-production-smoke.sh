#!/usr/bin/env bash
# Production Smoke Test — validates live deployment
# Usage: OPENCLAW_PROD_URL=https://openclaw-license.busihoward.workers.dev bash test-production-smoke.sh
set -euo pipefail

PROD_URL="${OPENCLAW_PROD_URL:-https://openclaw-license.busihoward.workers.dev}"
PASS=0 FAIL=0 WARN=0

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
pass() { printf "${GREEN}PASS${NC}  %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "${RED}FAIL${NC}  %s\n" "$1"; FAIL=$((FAIL + 1)); }
warn() { printf "${YELLOW}WARN${NC}  %s\n" "$1"; WARN=$((WARN + 1)); }

http_check() {
  local url="$1" expect_status="$2" label="$3"
  local status
  status=$(python3 -c "
import urllib.request, urllib.error
try:
    r = urllib.request.urlopen('$url', timeout=10)
    print(r.status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception as e:
    print('ERR')
" 2>/dev/null)

  if [ "$status" = "$expect_status" ]; then
    pass "$label (HTTP $status)"
  else
    fail "$label (expected $expect_status, got $status)"
  fi
}

api_post() {
  local path="$1" body="$2" label="$3" expect_field="$4"
  local result
  result=$(python3 -c "
import urllib.request, urllib.error, json
data = json.dumps($body).encode()
req = urllib.request.Request('${PROD_URL}${path}', data=data, headers={'Content-Type':'application/json'}, method='POST')
try:
    r = urllib.request.urlopen(req, timeout=10)
    d = json.loads(r.read().decode())
    print(json.dumps({'status': r.status, 'body': d}))
except urllib.error.HTTPError as e:
    d = json.loads(e.read().decode())
    print(json.dumps({'status': e.code, 'body': d}))
except Exception as e:
    print(json.dumps({'status': 0, 'body': {'error': str(e)}}))
" 2>/dev/null)

  local has_field
  has_field=$(echo "$result" | python3 -c "
import json, sys
d = json.load(sys.stdin)
body = d.get('body', {})
print('yes' if '$expect_field' in body else 'no')
" 2>/dev/null)

  if [ "$has_field" = "yes" ]; then
    pass "$label"
  else
    fail "$label (missing field: $expect_field)"
  fi
}

echo "========================================="
echo "  Production Smoke Test"
echo "  Target: $PROD_URL"
echo "  Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "========================================="
echo ""

# ── 1. DNS Resolution ─────────────────────────────────
echo "-- DNS --"
DOMAIN=$(echo "$PROD_URL" | sed 's|https://||')
if dig +short "$DOMAIN" 2>/dev/null | grep -q .; then
  pass "DNS resolves for $DOMAIN"
else
  fail "DNS does not resolve for $DOMAIN"
fi
echo ""

# ── 2. Site Pages ──────────────────────────────────────
echo "-- Site Pages --"
http_check "$PROD_URL/" "200" "Landing page"
http_check "$PROD_URL/thanks" "200" "Thanks page"
http_check "$PROD_URL/manage" "200" "Manage page"
echo ""

# ── 3. API Endpoints ──────────────────────────────────
echo "-- API Endpoints --"

# 404 for unknown
http_check "$PROD_URL/api/nonexistent" "404" "Unknown endpoint returns 404"

# Activate with invalid key
api_post "/api/activate" '{"key":"oc-starter-invalid","device_id":"smoke-test"}' \
  "Activate rejects invalid key" "reason"

# Verify with invalid key
http_check "$PROD_URL/api/verify?key=oc-starter-invalid&device_id=smoke-test" "403" \
  "Verify rejects invalid key"

# Checkout creates Stripe session
api_post "/api/checkout" '{}' "Checkout returns Stripe URL" "checkout_url"

# Download with invalid token
http_check "$PROD_URL/api/download/invalid-token-abc" "404" \
  "Download rejects invalid token"

echo ""

# ── 4. Checkout URL Validation ─────────────────────────
echo "-- Stripe Integration --"
checkout_url=$(python3 -c "
import urllib.request, json
data = json.dumps({}).encode()
req = urllib.request.Request('${PROD_URL}/api/checkout', data=data, headers={'Content-Type':'application/json'}, method='POST')
try:
    r = urllib.request.urlopen(req, timeout=10)
    d = json.loads(r.read().decode())
    print(d.get('checkout_url', ''))
except:
    print('')
" 2>/dev/null)

if echo "$checkout_url" | grep -q "checkout.stripe.com"; then
  pass "Checkout URL points to Stripe ($checkout_url)"
else
  fail "Checkout URL invalid: $checkout_url"
fi
echo ""

# ── 5. CORS Headers ──────────────────────────────────
echo "-- CORS --"
cors_header=$(python3 -c "
import urllib.request
req = urllib.request.Request('${PROD_URL}/api/verify?key=test&device_id=test')
try:
    r = urllib.request.urlopen(req, timeout=10)
    print(r.headers.get('Access-Control-Allow-Origin', ''))
except urllib.error.HTTPError as e:
    print(e.headers.get('Access-Control-Allow-Origin', ''))
except:
    print('')
" 2>/dev/null)

if [ "$cors_header" = "*" ]; then
  pass "CORS header present"
else
  warn "CORS header missing or unexpected: $cors_header"
fi
echo ""

# ── Summary ───────────────────────────────────────────
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed, $WARN warnings"
echo "========================================="
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo "Production is GO."
  exit 0
else
  echo "Production NOT ready — fix failures above."
  exit 1
fi
