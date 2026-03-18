#!/usr/bin/env bash
# OpenClaw Memory Stack — Installer
# Usage: ./install.sh --key=oc-starter-xxxxxxxxxxxx
#
# Installs to ~/.openclaw/memory-stack/
# Does NOT touch any git repository or project directory.
#
# Exit codes:
#   0 — installed successfully
#   1 — activation failed
set -euo pipefail

# ── Resolve script location ─────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="$HOME/.openclaw/memory-stack"
STATE_DIR="$HOME/.openclaw/state"
BIN_DIR="$HOME/.openclaw/bin"
ACTIVATE_URL="${OPENCLAW_ACTIVATE_URL:-https://memory-stack.openclaw.dev/api/activate}"

# ── Color helpers (disabled when not a terminal) ────────────────────
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  BLUE='\033[0;34m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN='' YELLOW='' RED='' BLUE='' BOLD='' NC=''
fi

ok()   { printf "${GREEN}  [OK]${NC}    %s\n" "$1"; }
warn() { printf "${YELLOW}  [WARN]${NC}  %s\n" "$1"; }
fail() { printf "${RED}  [FAIL]${NC}  %s\n" "$1"; }
info() { printf "${BLUE}  [..]${NC}    %s\n" "$1"; }
header() { printf "\n${BOLD}%s${NC}\n" "$1"; }

# ── Parse arguments ─────────────────────────────────────────────────
LICENSE_KEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key=*) LICENSE_KEY="${1#--key=}"; shift ;;
    --key)   LICENSE_KEY="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: ./install.sh --key=oc-starter-xxxxxxxxxxxx"
      echo ""
      echo "  --key <key>    Your license key (received via email after purchase)"
      echo "  --help         Show this help"
      echo ""
      echo "Purchase: https://memory-stack.openclaw.dev"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: ./install.sh --key=oc-starter-xxxxxxxxxxxx" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$LICENSE_KEY" ]]; then
  echo "Error: license key required." >&2
  echo "Usage: ./install.sh --key=oc-starter-xxxxxxxxxxxx" >&2
  echo "" >&2
  echo "Purchase: https://memory-stack.openclaw.dev" >&2
  exit 1
fi

# ── Banner ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}=========================================${NC}"
echo -e "${BOLD}  OpenClaw Memory Stack — Installer${NC}"
echo -e "${BOLD}=========================================${NC}"
echo -e "  Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo ""

# ── Step 1: Generate device fingerprint ─────────────────────────────
header "Step 1/6 — Generating device fingerprint"

generate_device_id() {
  local raw=""
  if [[ "$(uname -s)" == "Darwin" ]]; then
    raw=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4}')
  fi
  if [[ -z "$raw" ]] && [[ -f /etc/machine-id ]]; then
    raw=$(cat /etc/machine-id)
  fi
  if [[ -z "$raw" ]]; then
    raw="$(hostname)$(whoami)$(uname -s)"
  fi
  echo -n "$raw" | shasum -a 256 | cut -c1-16
}

generate_device_name() {
  echo "$(hostname) ($(whoami))"
}

DEVICE_ID=$(generate_device_id)
DEVICE_NAME=$(generate_device_name)
ok "Device ID: ${DEVICE_ID:0:8}..."
ok "Device name: $DEVICE_NAME"

# ── Step 2: Activate license ────────────────────────────────────────
header "Step 2/6 — Activating license"

info "Contacting license server..."
ACTIVATE_RESPONSE=$(curl -sf -X POST "$ACTIVATE_URL" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"$LICENSE_KEY\",\"device_id\":\"$DEVICE_ID\",\"device_name\":\"$DEVICE_NAME\"}" \
  2>/dev/null) || {
  fail "Could not reach license server."
  echo "  Check your internet connection and try again." >&2
  echo "  If the problem persists, contact support." >&2
  exit 1
}

# Parse response
if command -v python3 &>/dev/null; then
  VALID=$(echo "$ACTIVATE_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('valid',''))" 2>/dev/null)
  REASON=$(echo "$ACTIVATE_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('reason',''))" 2>/dev/null)
  TIER=$(echo "$ACTIVATE_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tier','starter'))" 2>/dev/null)
elif command -v jq &>/dev/null; then
  VALID=$(echo "$ACTIVATE_RESPONSE" | jq -r '.valid // empty')
  REASON=$(echo "$ACTIVATE_RESPONSE" | jq -r '.reason // empty')
  TIER=$(echo "$ACTIVATE_RESPONSE" | jq -r '.tier // "starter"')
else
  fail "python3 or jq required to parse server response." >&2
  exit 1
fi

if [[ "$VALID" != "true" ]] && [[ "$VALID" != "True" ]]; then
  case "$REASON" in
    invalid_key)
      fail "Invalid license key."
      echo "  Check your key and try again." >&2
      echo "  Purchase: https://memory-stack.openclaw.dev" >&2
      ;;
    activation_limit_reached)
      fail "Device activation limit reached."
      echo "  Manage your devices: https://memory-stack.openclaw.dev/manage" >&2
      ;;
    revoked)
      fail "This license has been revoked."
      ;;
    *)
      fail "Activation failed: ${REASON:-unknown error}"
      ;;
  esac
  exit 1
fi

ok "License verified"

# ── Step 3: Detect platform capabilities ────────────────────────────
header "Step 3/6 — Checking platform"

OS="unknown"
case "$(uname -s)" in
  Darwin*) OS="macOS" ;;
  Linux*)  OS="Linux" ;;
  *)       OS="$(uname -s)" ;;
esac
ok "Platform: $OS"

# Check runtime capabilities for backends
GIT_READY=false
BUN_READY=false

if command -v git &>/dev/null; then
  ok "git: $(git --version 2>/dev/null | head -1)"
  GIT_READY=true
else
  warn "git not found. Total Recall will not be available."
fi

if command -v bun &>/dev/null; then
  ok "bun: v$(bun --version 2>/dev/null)"
  BUN_READY=true
else
  warn "bun not found. QMD will not be available."
  warn "Install: https://bun.sh/docs/installation"
fi

command -v python3 &>/dev/null && ok "python3: $(python3 --version 2>/dev/null)" || warn "python3 not found."

# ── Step 4: Install files ──────────────────────────────────────────
header "Step 4/6 — Installing files"

mkdir -p "$INSTALL_ROOT" "$STATE_DIR" "$BIN_DIR"

# Copy bin/, lib/
cp -r "$SCRIPT_DIR/bin" "$INSTALL_ROOT/"
cp -r "$SCRIPT_DIR/lib" "$INSTALL_ROOT/"

# Copy all backend skills dynamically
mkdir -p "$INSTALL_ROOT/skills"
for skill_dir in "$SCRIPT_DIR/skills/memory-"*; do
  [[ -d "$skill_dir" ]] || continue
  skill_name=$(basename "$skill_dir")
  rm -rf "$INSTALL_ROOT/skills/$skill_name"
  cp -r "$skill_dir" "$INSTALL_ROOT/skills/"
done

# Make CLI executable
chmod +x "$INSTALL_ROOT/bin/openclaw-memory"

ok "Files installed to $INSTALL_ROOT"

# ── Step 5: Create symlink ─────────────────────────────────────────
header "Step 5/6 — Setting up PATH"

ln -sf "$INSTALL_ROOT/bin/openclaw-memory" "$BIN_DIR/openclaw-memory"
ok "Symlinked: $BIN_DIR/openclaw-memory"

# Check if ~/.openclaw/bin is in PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "$BIN_DIR is not in your PATH."
  echo ""
  echo "  Add to your shell profile (~/.zshrc or ~/.bashrc):"
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
fi

# ── Step 6: Write state files ──────────────────────────────────────
header "Step 6/6 — Writing configuration"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# version.json
cat > "$INSTALL_ROOT/version.json" <<JSONEOF
{
  "version": "0.1.0",
  "installed_at": "$NOW"
}
JSONEOF
ok "version.json"

# license.json
cat > "$STATE_DIR/license.json" <<JSONEOF
{
  "key": "$LICENSE_KEY",
  "tier": "$TIER",
  "device_id": "$DEVICE_ID",
  "device_name": "$DEVICE_NAME",
  "activated_at": "$NOW",
  "last_verified": "$NOW",
  "verify_interval_s": 604800,
  "revoked": false
}
JSONEOF
ok "license.json"

# backends.json — dynamic discovery from installed wrappers
_gen_backends() {
  echo '{'
  echo '  "version": "2.0",'
  echo "  \"installed_at\": \"$NOW\","
  echo '  "backends": {'
  local first=true bname bstatus
  for skill_dir in "$INSTALL_ROOT/skills/memory-"*; do
    [[ -f "$skill_dir/wrapper.sh" ]] || continue
    bname=$(basename "$skill_dir" | sed 's/memory-//')
    [[ "$bname" == "router" ]] && continue
    bstatus="installed"
    if bash "$skill_dir/wrapper.sh" health &>/dev/null; then
      bstatus=$(OPENCLAW_INSTALL_ROOT="$INSTALL_ROOT" bash "$skill_dir/wrapper.sh" health 2>/dev/null \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','installed'))" 2>/dev/null || echo "installed")
    fi
    $first || echo ','
    printf '    "%s": { "status": "%s" }' "$bname" "$bstatus"
    first=false
  done
  echo ''
  echo '  }'
  echo '}'
}
_gen_backends > "$STATE_DIR/backends.json"
ok "backends.json"

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}=========================================${NC}"
echo -e "${BOLD}  Installation Complete${NC}"
echo -e "${BOLD}=========================================${NC}"
echo ""
echo -e "  Install path: ${BOLD}${INSTALL_ROOT}${NC}"
echo -e "  License:      ${GREEN}activated${NC}"
echo ""
echo "  Backends:"
for skill_dir in "$INSTALL_ROOT/skills/memory-"*; do
  [[ -f "$skill_dir/wrapper.sh" ]] || continue
  bname=$(basename "$skill_dir" | sed 's/memory-//')
  [[ "$bname" == "router" ]] && continue
  # Read status from backends.json we just wrote
  bstatus=$(python3 -c "import json; d=json.load(open('$STATE_DIR/backends.json')); print(d['backends'].get('$bname',{}).get('status','unknown'))" 2>/dev/null || echo "unknown")
  case "$bstatus" in
    ready)    echo -e "    $bname: ${GREEN}$bstatus${NC}" ;;
    degraded) echo -e "    $bname: ${YELLOW}$bstatus${NC}" ;;
    *)        echo -e "    $bname: ${YELLOW}$bstatus${NC}" ;;
  esac
done

echo ""
echo -e "  ${BOLD}Next step:${NC}"
echo "    cd /path/to/your/project"
echo "    openclaw-memory init"
echo ""
