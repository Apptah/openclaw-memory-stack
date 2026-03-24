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
ACTIVATE_URL="${OPENCLAW_ACTIVATE_URL:-https://openclaw-api.apptah.com/api/activate}"

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
SKIP_MODELS=false
UPGRADE=false
FROM_SELF=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key=*) LICENSE_KEY="${1#--key=}"; shift ;;
    --key)   LICENSE_KEY="$2"; shift 2 ;;
    --upgrade) UPGRADE=true; shift ;;
    --from-self) FROM_SELF=true; shift ;;
    --skip-models) SKIP_MODELS=true; shift ;;
    -h|--help)
      echo "Usage: ./install.sh --key=oc-starter-xxxxxxxxxxxx"
      echo ""
      echo "  --key <key>    Your license key (received via email after purchase)"
      echo "  --upgrade      Upgrade to latest version (reads key from license.json)"
      echo "  --help         Show this help"
      echo ""
      echo "Purchase: https://openclaw-site-53r.pages.dev"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: ./install.sh --key=oc-starter-xxxxxxxxxxxx" >&2
      exit 1
      ;;
  esac
done

# ── Guards ─────────────────────────────────────────────────────────
if [[ "$FROM_SELF" == true && "$UPGRADE" != true ]]; then
  echo "Error: --from-self is an internal flag. Use --upgrade instead." >&2
  exit 1
fi

if [[ "$UPGRADE" == true && -n "$LICENSE_KEY" ]]; then
  echo "Error: --upgrade and --key are mutually exclusive. --upgrade reads key from license.json." >&2
  exit 1
fi

# ── Upgrade flow ───────────────────────────────────────────────────
if [[ "$UPGRADE" == true && "$FROM_SELF" != true ]]; then
  header "Upgrade — Phase 1: Download"

  if [[ ! -f "$STATE_DIR/license.json" ]]; then
    fail "No license.json found at $STATE_DIR/license.json"
    echo "  Run a fresh install with --key instead." >&2
    exit 1
  fi

  LICENSE_KEY=$(python3 -c "import json; print(json.load(open('$STATE_DIR/license.json'))['key'])" 2>/dev/null)
  CURRENT_VERSION=$(python3 -c "import json; print(json.load(open('$INSTALL_ROOT/version.json'))['version'])" 2>/dev/null || echo "0.0.0")

  if [[ -z "$LICENSE_KEY" ]]; then
    fail "Could not read license key from $STATE_DIR/license.json"
    exit 1
  fi

  info "Current version: $CURRENT_VERSION"
  info "Downloading latest release..."

  DOWNLOAD_URL="${ACTIVATE_URL%/activate}/download/latest?key=$LICENSE_KEY"
  TMP_TAR="/tmp/openclaw-update-$$.tar.gz"
  TMP_DIR="/tmp/openclaw-update-$$"

  HTTP_CODE=$(curl -sL -w "%{http_code}" -o "$TMP_TAR" "$DOWNLOAD_URL")
  if [[ "$HTTP_CODE" != "200" ]]; then
    fail "Download failed (HTTP $HTTP_CODE)"
    rm -f "$TMP_TAR"
    exit 1
  fi

  # Verify tarball integrity
  if ! tar -tzf "$TMP_TAR" > /dev/null 2>&1; then
    fail "Downloaded file is corrupt"
    rm -f "$TMP_TAR"
    exit 1
  fi

  if ! tar -tzf "$TMP_TAR" | grep -q 'install.sh'; then
    fail "Invalid package: no installer found"
    rm -f "$TMP_TAR"
    exit 1
  fi

  # Extract and check version
  mkdir -p "$TMP_DIR"
  tar -xzf "$TMP_TAR" -C "$TMP_DIR"
  rm -f "$TMP_TAR"

  # Find the extracted directory
  EXTRACTED_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d -name "openclaw-memory-stack-*" | head -1)
  if [[ -z "$EXTRACTED_DIR" ]]; then
    EXTRACTED_DIR="$TMP_DIR"
  fi

  if [[ ! -f "$EXTRACTED_DIR/install.sh" ]]; then
    fail "Extracted package missing install.sh"
    rm -rf "$TMP_DIR"
    exit 1
  fi

  # Version check: new must be strictly greater than current
  NEW_VERSION=$(python3 -c "import json; print(json.load(open('$EXTRACTED_DIR/version.json'))['version'])" 2>/dev/null || echo "")
  if [[ -z "$NEW_VERSION" ]]; then
    fail "Could not read version from downloaded package"
    rm -rf "$TMP_DIR"
    exit 1
  fi

  IS_NEWER=$(python3 -c "
cv = list(map(int, '$CURRENT_VERSION'.split('.')))
nv = list(map(int, '$NEW_VERSION'.split('.')))
print('yes' if nv > cv else 'no')
" 2>/dev/null || echo "no")

  if [[ "$IS_NEWER" != "yes" ]]; then
    ok "Already up to date (v$CURRENT_VERSION)"
    rm -rf "$TMP_DIR"
    exit 0
  fi

  info "Upgrading v$CURRENT_VERSION → v$NEW_VERSION"
  ok "Download verified"

  chmod +x "$EXTRACTED_DIR/install.sh"
  exec "$EXTRACTED_DIR/install.sh" --upgrade --from-self
fi

if [[ "$UPGRADE" == true && "$FROM_SELF" == true ]]; then
  header "Upgrade — Phase 2: Install"

  LICENSE_KEY=$(python3 -c "import json; print(json.load(open('$STATE_DIR/license.json'))['key'])" 2>/dev/null)
  DEVICE_ID=$(python3 -c "import json; print(json.load(open('$STATE_DIR/license.json'))['device_id'])" 2>/dev/null)
  NEW_VERSION=$(python3 -c "import json; print(json.load(open('$SCRIPT_DIR/version.json'))['version'])" 2>/dev/null || echo "unknown")

  # Copy files
  info "Copying files..."
  for dir in bin lib skills; do
    if [[ -d "$SCRIPT_DIR/$dir" ]]; then
      cp -R "$SCRIPT_DIR/$dir/" "$INSTALL_ROOT/$dir/"
    fi
  done
  # Ensure qmd-compat shim is executable
  [[ -f "$INSTALL_ROOT/bin/openclaw-memory-qmd" ]] && chmod +x "$INSTALL_ROOT/bin/openclaw-memory-qmd"
  # Ensure symlink exists
  ln -sf "$INSTALL_ROOT/bin/openclaw-memory-qmd" "$BIN_DIR/openclaw-memory-qmd" 2>/dev/null || true
  ok "Files updated"

  # Copy plugin
  EXT_DIR="$HOME/.openclaw/extensions/openclaw-memory-stack"
  mkdir -p "$EXT_DIR"
  if [[ -f "$SCRIPT_DIR/plugin/dist/index.mjs" ]]; then
    mkdir -p "$EXT_DIR/dist"
    cp "$SCRIPT_DIR/plugin/dist/index.mjs" "$EXT_DIR/dist/"
  else
    cp "$SCRIPT_DIR/plugin/index.mjs" "$EXT_DIR/"
  fi
  cp "$SCRIPT_DIR/plugin/package.json" "$EXT_DIR/"
  [[ -f "$SCRIPT_DIR/plugin/openclaw.plugin.json" ]] && cp "$SCRIPT_DIR/plugin/openclaw.plugin.json" "$EXT_DIR/"
  [[ -f "$SCRIPT_DIR/openclaw.plugin.json" ]] && cp "$SCRIPT_DIR/openclaw.plugin.json" "$EXT_DIR/"
  # Copy lib/ modules (engines, grep, pipeline, etc.) — needed by CLI shim
  if [[ -d "$SCRIPT_DIR/plugin/lib" ]]; then
    rm -rf "$EXT_DIR/lib"
    cp -R "$SCRIPT_DIR/plugin/lib" "$EXT_DIR/lib"
  fi
  ok "Plugin updated"

  # Update version.json
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  OLD_VERSION=$(python3 -c "import json; print(json.load(open('$INSTALL_ROOT/version.json')).get('version','unknown'))" 2>/dev/null || echo "unknown")
  cat > "$INSTALL_ROOT/version.json" <<JSONEOF
{
  "version": "$NEW_VERSION",
  "installed_at": "$NOW",
  "upgraded_from": "$OLD_VERSION"
}
JSONEOF
  ok "version.json → v$NEW_VERSION"

  # Update openclaw.json plugin install record
  OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
  if [[ -f "$OPENCLAW_JSON" ]] && command -v python3 &>/dev/null; then
    python3 -c "
import json, datetime
config_path = '$OPENCLAW_JSON'
with open(config_path) as f:
    config = json.load(f)
installs = config.get('plugins', {}).get('installs', {})
if 'openclaw-memory-stack' in installs:
    installs['openclaw-memory-stack']['version'] = '$NEW_VERSION'
    installs['openclaw-memory-stack']['resolvedVersion'] = '$NEW_VERSION'
    installs['openclaw-memory-stack']['resolvedSpec'] = 'openclaw-memory-stack@$NEW_VERSION'
    installs['openclaw-memory-stack']['updatedAt'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')
with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
" 2>/dev/null && ok "openclaw.json updated" || warn "Could not update openclaw.json version"
  fi

  # Update Python deps if venv exists
  if [[ -d "$INSTALL_ROOT/.venv" && -f "$SCRIPT_DIR/requirements.txt" ]]; then
    info "Updating Python dependencies..."
    "$INSTALL_ROOT/.venv/bin/pip" install -r "$SCRIPT_DIR/requirements.txt" --quiet 2>/dev/null && ok "Python deps updated" || warn "Python deps update failed (non-fatal)"
  fi

  # Verify license still valid
  VERIFY_URL="${ACTIVATE_URL%/activate}/verify?key=$LICENSE_KEY&device_id=$DEVICE_ID"
  VERIFY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$VERIFY_URL" 2>/dev/null || echo "000")
  if [[ "$VERIFY_STATUS" == "200" ]]; then
    ok "License verified"
  else
    warn "License verification returned HTTP $VERIFY_STATUS (non-fatal)"
  fi

  # Clean up tmp dir if we were exec'd from Phase 1
  PARENT_TMP=$(dirname "$SCRIPT_DIR")
  if [[ "$PARENT_TMP" == /tmp/openclaw-update-* ]]; then
    rm -rf "$PARENT_TMP"
  fi

  echo ""
  echo -e "${BOLD}=========================================${NC}"
  echo -e "${GREEN}  ✅ Updated to v$NEW_VERSION${NC}"
  echo -e "${BOLD}=========================================${NC}"
  echo ""
  if command -v openclaw &>/dev/null; then
    openclaw gateway restart 2>/dev/null &
    disown
    echo "  OpenClaw gateway restarting."
  else
    echo "  Start OpenClaw when ready."
  fi
  echo ""
  exit 0
fi

if [[ -z "$LICENSE_KEY" ]]; then
  echo "Error: license key required." >&2
  echo "Usage: ./install.sh --key=oc-starter-xxxxxxxxxxxx" >&2
  echo "" >&2
  echo "Purchase: https://openclaw-site-53r.pages.dev" >&2
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
      echo "  Purchase: https://openclaw-site-53r.pages.dev" >&2
      ;;
    activation_limit_reached)
      fail "Device activation limit reached."
      echo "  Manage your devices: https://openclaw-site-53r.pages.dev/manage" >&2
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

# ── Runtime bootstrap helpers ────────────────────────────────────────
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
  uv venv "$venv_dir" --python 3.12 2>/dev/null || python3 -m venv "$venv_dir" 2>/dev/null
  ok "Python venv: $venv_dir"
}

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
chmod +x "$INSTALL_ROOT/bin/openclaw-memory-qmd"

ok "Files installed to $INSTALL_ROOT"

# ── Step 4b/6 — Installing backend dependencies ─────────────────────
header "Step 4b/6 — Installing backend dependencies"

# Bootstrap Python venv + ensure PATH includes openclaw bins
install_uv
setup_python_venv
export PATH="$BIN_DIR:$INSTALL_ROOT/bin:$PATH"

for skill_dir in "$INSTALL_ROOT/skills/memory-"*; do
  [[ -f "$skill_dir/capability.json" ]] || continue
  bname=$(basename "$skill_dir" | sed 's/memory-//')
  [[ "$bname" == "router" ]] && continue

  # Skip optional backends
  is_optional=$(python3 -c "import json; d=json.load(open('$skill_dir/capability.json')); print(d.get('optional', False))" 2>/dev/null || echo "False")
  [[ "$is_optional" == "True" ]] && { info "Skipping $bname (optional — install manually)"; continue; }

  install_hint=$(python3 -c "import json; print(json.load(open('$skill_dir/capability.json'))['install_hint'])" 2>/dev/null || echo "")
  [[ -z "$install_hint" ]] && continue

  info "Installing $bname..."
  if eval "$install_hint" 2>&1 | tail -3; then
    ok "$bname installed"
  else
    warn "$bname: install failed (non-fatal)"
    warn "  hint: $install_hint"
  fi
done

if ! $SKIP_MODELS && command -v qmd &>/dev/null; then
  info "Downloading QMD models (~2.1GB)..."
  qmd embed --download-models 2>/dev/null && ok "QMD models downloaded" || warn "Model download failed (retry: qmd embed --download-models)"
fi

# ── Step 5: Create symlink ─────────────────────────────────────────
header "Step 5/6 — Setting up PATH"

ln -sf "$INSTALL_ROOT/bin/openclaw-memory" "$BIN_DIR/openclaw-memory"
ln -sf "$INSTALL_ROOT/bin/openclaw-memory-qmd" "$BIN_DIR/openclaw-memory-qmd"
ok "Symlinked: $BIN_DIR/openclaw-memory"
ok "Symlinked: $BIN_DIR/openclaw-memory-qmd (OpenClaw qmd-compat shim)"

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
  "version": "$VERSION",
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

# ── Step 6b/6 — Register as OpenClaw memory plugin ──────────────────
header "Step 6b/6 — Connecting to OpenClaw"

# Copy plugin to OpenClaw extensions directory (same structure as npm-installed plugins)
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
EXT_DIR="$HOME/.openclaw/extensions/openclaw-memory-stack"

if [[ -f "$OPENCLAW_JSON" ]] && command -v python3 &>/dev/null; then
  # 1. Install plugin files to extensions dir
  mkdir -p "$EXT_DIR"
  # Copy bundled plugin (minified)
  if [[ -f "$SCRIPT_DIR/plugin/dist/index.mjs" ]]; then
    mkdir -p "$EXT_DIR/dist"
    cp "$SCRIPT_DIR/plugin/dist/index.mjs" "$EXT_DIR/dist/"
  else
    cp "$SCRIPT_DIR/plugin/index.mjs" "$EXT_DIR/"
  fi
  cp "$SCRIPT_DIR/plugin/package.json" "$EXT_DIR/"
  if [[ -f "$SCRIPT_DIR/plugin/openclaw.plugin.json" ]]; then
    cp "$SCRIPT_DIR/plugin/openclaw.plugin.json" "$EXT_DIR/"
  elif [[ -f "$SCRIPT_DIR/openclaw.plugin.json" ]]; then
    cp "$SCRIPT_DIR/openclaw.plugin.json" "$EXT_DIR/"
  fi
  # Copy lib/ modules (engines, pipeline, graph, etc.)
  if [[ -d "$SCRIPT_DIR/plugin/lib" ]]; then
    rm -rf "$EXT_DIR/lib"
    cp -R "$SCRIPT_DIR/plugin/lib" "$EXT_DIR/lib"
  fi
  ok "Plugin files → $EXT_DIR"

  # 2. Register in openclaw.json (matching native openclaw plugins install format)
  python3 -c "
import json, datetime

config_path = '$OPENCLAW_JSON'
ext_dir = '$EXT_DIR'

with open(config_path) as f:
    config = json.load(f)

plugins = config.setdefault('plugins', {})

# allow list
allow = plugins.setdefault('allow', [])
if 'openclaw-memory-stack' not in allow:
    allow.append('openclaw-memory-stack')

# slots — register as memory provider
slots = plugins.setdefault('slots', {})
slots['memory'] = 'openclaw-memory-stack'

# entries — plugin config
entries = plugins.setdefault('entries', {})
entries['openclaw-memory-stack'] = {
    'enabled': True,
    'config': {
        'routerMode': 'auto',
        'searchMode': 'hybrid',
        'autoRecall': True,
        'autoCapture': True,
        'maxRecallResults': 5,
        'maxRecallTokens': 1500
    }
}

# Configure OpenClaw to use memory-stack as the qmd backend
memory_cfg = config.setdefault('memory', {})
memory_cfg['backend'] = 'qmd'
qmd_cfg = memory_cfg.setdefault('qmd', {})
qmd_cfg['command'] = 'openclaw-memory-qmd'
qmd_cfg.setdefault('searchMode', 'query')
qmd_cfg.setdefault('includeDefaultMemory', True)

# installs — required by OpenClaw plugin validator
installs = plugins.setdefault('installs', {})
now = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')
pkg_version = '0.1.3'
try:
    import os
    pkg_json = os.path.join('$SCRIPT_DIR', 'plugin', 'package.json')
    with open(pkg_json) as pf:
        pkg_version = json.load(pf).get('version', pkg_version)
except:
    pass
installs['openclaw-memory-stack'] = {
    'source': 'path',
    'spec': ext_dir,
    'installPath': ext_dir,
    'version': pkg_version,
    'resolvedName': 'openclaw-memory-stack',
    'resolvedVersion': pkg_version,
    'resolvedSpec': f'openclaw-memory-stack@{pkg_version}',
    'installedAt': now
}

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
" 2>/dev/null && ok "Registered as OpenClaw memory plugin" || warn "Could not update openclaw.json (configure manually)"
else
  if [[ ! -f "$OPENCLAW_JSON" ]]; then
    warn "openclaw.json not found — is OpenClaw installed?"
  else
    warn "python3 not found — please register manually"
  fi
  echo "  Run: openclaw plugins install $EXT_DIR" >&2
fi

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}=========================================${NC}"
echo -e "${BOLD}  Installation Complete${NC}"
echo -e "${BOLD}=========================================${NC}"
echo ""
echo -e "  Install path: ${BOLD}${INSTALL_ROOT}${NC}"
echo -e "  License:      ${GREEN}activated${NC}"
echo -e "  OpenClaw:     ${GREEN}memory plugin registered${NC}"
echo ""
echo "  Backends:"
for skill_dir in "$INSTALL_ROOT/skills/memory-"*; do
  [[ -f "$skill_dir/wrapper.sh" ]] || continue
  bname=$(basename "$skill_dir" | sed 's/memory-//')
  [[ "$bname" == "router" ]] && continue
  bstatus=$(python3 -c "import json; d=json.load(open('$STATE_DIR/backends.json')); print(d['backends'].get('$bname',{}).get('status','unknown'))" 2>/dev/null || echo "unknown")
  case "$bstatus" in
    ready)    echo -e "    $bname: ${GREEN}$bstatus${NC}" ;;
    degraded) echo -e "    $bname: ${YELLOW}$bstatus${NC}" ;;
    *)        echo -e "    $bname: ${YELLOW}$bstatus${NC}" ;;
  esac
done

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
