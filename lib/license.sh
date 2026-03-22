#!/usr/bin/env bash
# OpenClaw Memory Stack — License management
# Sourced by bin/openclaw-memory for license checks.

SCRIPT_LIB_DIR_LICENSE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_LIB_DIR_LICENSE/platform.sh"

LICENSE_FILE="$HOME/.openclaw/state/license.json"
VERIFY_URL="${OPENCLAW_VERIFY_URL:-https://openclaw-license.busihoward.workers.dev/api/verify}"
ACTIVATE_URL="${OPENCLAW_ACTIVATE_URL:-https://openclaw-license.busihoward.workers.dev/api/activate}"

# ── Device Fingerprint ─────────────────────────────────────────────

generate_device_id() {
  local raw=""
  # macOS: hardware UUID (stable across OS reinstalls, not affected by hostname)
  if [[ "$(uname -s)" == "Darwin" ]]; then
    raw=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4}')
  fi
  # Linux: machine-id (systemd-generated, stable until reinstall)
  if [[ -z "$raw" ]] && [[ -f /etc/machine-id ]]; then
    raw=$(cat /etc/machine-id)
  fi
  # Fallback: hostname + whoami + uname
  if [[ -z "$raw" ]]; then
    raw="$(hostname)$(whoami)$(uname -s)"
  fi
  echo -n "$raw" | shasum -a 256 | cut -c1-16
}

generate_device_name() {
  echo "$(hostname) ($(whoami))"
}

# ── License JSON Helpers ───────────────────────────────────────────

license_field() {
  local field="$1"
  json_field "$LICENSE_FILE" "$field"
}

license_exists() {
  [[ -f "$LICENSE_FILE" ]]
}

license_is_revoked() {
  local revoked
  revoked=$(license_field "revoked" 2>/dev/null)
  [[ "$revoked" == "true" ]]
}

# Get last_verified as epoch seconds
license_last_verified() {
  local ts
  ts=$(license_field "last_verified" 2>/dev/null)
  if [[ -z "$ts" ]]; then
    echo "0"
    return
  fi
  # Convert ISO timestamp to epoch
  if has_command python3; then
    python3 -c "
from datetime import datetime, timezone
ts = '$ts'
try:
    dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
    print(int(dt.timestamp()))
except:
    print(0)
" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

update_last_verified() {
  local now_iso
  now_iso=$(now_iso)
  if has_command python3; then
    python3 -c "
import json
with open('$LICENSE_FILE') as f: d = json.load(f)
d['last_verified'] = '$now_iso'
with open('$LICENSE_FILE', 'w') as f: json.dump(d, f, indent=2); f.write('\n')
" 2>/dev/null
  fi
}

# ── License Checks ─────────────────────────────────────────────────

# init/embed use: don't call /api/verify, but block revoked + expired grace
require_installed() {
  if ! license_exists; then
    echo "License not found. Run install.sh first." >&2
    echo "  Download: https://openclaw-site-53r.pages.dev" >&2
    exit 1
  fi

  if license_is_revoked; then
    echo "License has been revoked." >&2
    exit 1
  fi

  # Grace period check: if last_verified + 10 days < now → block
  local last_verified now_epoch age grace_limit
  last_verified=$(license_last_verified)
  now_epoch=$(date +%s)
  age=$((now_epoch - last_verified))
  grace_limit=864000  # 10 days in seconds

  if [[ "$last_verified" -gt 0 ]] && [[ "$age" -gt "$grace_limit" ]]; then
    echo "License expired. Please reconnect to the internet and run:" >&2
    echo "  openclaw-memory \"test\"  (to trigger re-verification)" >&2
    exit 1
  fi
}

# query/--backend use: full license check with re-verify + device match
require_licensed() {
  if ! license_exists; then
    echo "License not found. Run install.sh first." >&2
    echo "  Download: https://openclaw-site-53r.pages.dev" >&2
    exit 1
  fi

  if license_is_revoked; then
    echo "License has been revoked." >&2
    exit 1
  fi

  check_reverify
}

# ── Re-verify Logic ───────────────────────────────────────────────

check_reverify() {
  local last_verified now_epoch age
  last_verified=$(license_last_verified)
  now_epoch=$(date +%s)
  age=$((now_epoch - last_verified))

  local verify_interval=604800  # 7 days
  local grace_total=864000      # 10 days (7 + 3 grace)

  # Fresh enough — skip API call
  if [[ "$age" -lt "$verify_interval" ]]; then
    return 0
  fi

  # Need to re-verify — try API
  local key device_id response
  key=$(license_field "key")
  device_id=$(license_field "device_id")

  response=$(curl -s "${VERIFY_URL}?key=${key}&device_id=${device_id}" 2>/dev/null) || {
    # Network failure — check grace period
    if [[ "$age" -lt "$grace_total" ]]; then
      return 0  # Within grace period
    fi
    echo "License verification required. Please connect to the internet." >&2
    exit 1
  }

  # Empty response = network failure
  if [[ -z "$response" ]]; then
    if [[ "$age" -lt "$grace_total" ]]; then
      return 0
    fi
    echo "License verification required. Please connect to the internet." >&2
    exit 1
  fi

  # Parse response
  local valid reason
  if has_command python3; then
    valid=$(echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('valid',''))" 2>/dev/null)
    reason=$(echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('reason',''))" 2>/dev/null)
  elif has_command jq; then
    valid=$(echo "$response" | jq -r '.valid // empty')
    reason=$(echo "$response" | jq -r '.reason // empty')
  fi

  if [[ "$valid" == "true" ]] || [[ "$valid" == "True" ]]; then
    update_last_verified
    return 0
  fi

  # Specific error messages
  case "$reason" in
    revoked)
      echo "License has been revoked." >&2
      # Mark locally as revoked
      if has_command python3; then
        python3 -c "
import json
with open('$LICENSE_FILE') as f: d = json.load(f)
d['revoked'] = True
with open('$LICENSE_FILE', 'w') as f: json.dump(d, f, indent=2); f.write('\n')
" 2>/dev/null
      fi
      ;;
    device_not_activated)
      echo "This device is not activated for this license." >&2
      echo "You may need to reset a device at: https://openclaw-site-53r.pages.dev/manage" >&2
      ;;
    invalid_key)
      echo "License key is invalid." >&2
      ;;
    *)
      echo "License error: ${reason:-unknown}" >&2
      ;;
  esac
  exit 1
}

# ── Repo Context Discovery ────────────────────────────────────────

find_repo_config() {
  local git_root
  git_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
    return 1
  }

  local config_file="$git_root/.openclaw-memory.json"
  if [[ ! -f "$config_file" ]]; then
    return 1
  fi

  echo "$config_file"
}

# Merge global runtime + per-repo dispatch into effective backends
merge_backends() {
  local repo_config="$1"
  local global_backends="$HOME/.openclaw/state/backends.json"
  local effective="/tmp/openclaw-effective-$$.json"

  if has_command python3; then
    python3 -c "
import json, sys

repo_path = '$repo_config'
global_path = '$global_backends'
out_path = '$effective'

# Load per-repo config (authoritative for dispatch)
with open(repo_path) as f:
    repo = json.load(f)

# Load global config (runtime capability)
try:
    with open(global_path) as f:
        glb = json.load(f)
except:
    glb = {'backends': {}}

# Merge: effective = global.runtime == 'ready' AND per-repo.status in DISPATCHABLE
DISPATCHABLE = {'ready', 'bm25_ready'}
effective = {'version': '2.0', 'backends': {}}

for name, repo_info in repo.get('backends', {}).items():
    repo_status = repo_info.get('status', '')
    global_runtime = glb.get('backends', {}).get(name, {}).get('runtime', 'unavailable')

    if global_runtime == 'ready' and repo_status in DISPATCHABLE:
        effective['backends'][name] = {
            'status': repo_status,
            'collection': repo_info.get('collection', ''),
            'branch': repo_info.get('branch', '')
        }

with open(out_path, 'w') as f:
    json.dump(effective, f, indent=2)
    f.write('\n')

print(out_path)
" 2>/dev/null
  else
    echo ""
  fi
}

# Set repo context environment variables
set_repo_context() {
  local repo_config="$1"

  export OPENCLAW_REPO_ROOT
  OPENCLAW_REPO_ROOT=$(dirname "$repo_config")

  if has_command python3; then
    local qmd_collection tr_branch
    qmd_collection=$(json_nested "$repo_config" "backends.qmd.collection" 2>/dev/null)
    tr_branch=$(json_nested "$repo_config" "backends.totalrecall.branch" 2>/dev/null)

    [[ -n "$qmd_collection" ]] && export OPENCLAW_QMD_COLLECTION="$qmd_collection" || true
    [[ -n "$tr_branch" ]] && export OPENCLAW_TR_BRANCH="$tr_branch" || true
  fi
}
