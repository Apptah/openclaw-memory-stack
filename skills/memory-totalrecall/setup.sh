#!/usr/bin/env bash
# Total Recall setup — create 4-tier markdown memory directory structure
# Exit codes: 0=success, 1=failure
set -euo pipefail

# --- Parse arguments ---
TARGET_PATH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET_PATH="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# --- Helpers ---
info()  { printf "\033[0;34m[totalrecall]\033[0m %s\n" "$1"; }
ok()    { printf "\033[0;32m[totalrecall]\033[0m %s\n" "$1"; }
err()   { printf "\033[0;31m[totalrecall]\033[0m %s\n" "$1" >&2; }

# --- Determine root directory ---
if [ -n "$TARGET_PATH" ]; then
  cd "$TARGET_PATH" || { err "Cannot cd to $TARGET_PATH"; exit 1; }
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$ROOT"
info "Setting up Total Recall in: $ROOT"

# --- Create 4-tier directory structure ---
info "Creating memory directory structure..."
mkdir -p memory/registers memory/daily memory/archive

if [ ! -f CLAUDE.local.md ]; then
  touch CLAUDE.local.md
  ok "Created CLAUDE.local.md (counter tier)"
else
  ok "CLAUDE.local.md already exists"
fi

ok "Created memory/registers/ (pantry tier)"
ok "Created memory/daily/ (daily tier)"
ok "Created memory/archive/ (archive tier)"

# --- Verification ---
info "Verifying structure..."
local_ok=true
for d in memory/registers memory/daily memory/archive; do
  if [ ! -d "$d" ]; then
    err "Missing directory: $d"
    local_ok=false
  fi
done

if [ ! -f CLAUDE.local.md ]; then
  err "Missing file: CLAUDE.local.md"
  local_ok=false
fi

if [ "$local_ok" = false ]; then
  err "Setup verification failed."
  exit 1
fi

# --- Done ---
echo ""
ok "========================================="
ok "  Total Recall setup complete!"
ok "========================================="
info "Root:     $ROOT"
info "Counter:  CLAUDE.local.md"
info "Pantry:   memory/registers/"
info "Daily:    memory/daily/"
info "Archive:  memory/archive/"
echo ""
info "Next steps:"
info "  1. The AI agent can now store/retrieve memories as plain markdown files."
info "  2. See SKILL.md for usage instructions."
echo ""

exit 0
