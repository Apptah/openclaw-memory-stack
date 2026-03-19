#!/usr/bin/env bash
# QMD setup — verify Bun, install qmd globally, verify FTS5
# Exit codes: 0=success, 1=retry failure, 2=missing OS dependency
set -euo pipefail

echo "=== QMD Memory Backend Setup ==="
echo ""

# ------------------------------------------------------------------
# 1. Check Bun runtime
# ------------------------------------------------------------------
if ! command -v bun &>/dev/null; then
  echo "ERROR: Bun runtime is not installed."
  echo ""
  echo "QMD requires Bun. Install it from: https://bun.sh/docs/installation"
  echo ""
  echo "  Quick install:  curl -fsSL https://bun.sh/install | bash"
  echo ""
  echo "After installing Bun, re-run this setup script."
  exit 2
fi

BUN_VERSION=$(bun --version 2>/dev/null)
echo "[OK] Bun found: v${BUN_VERSION}"

# ------------------------------------------------------------------
# 2. Install qmd globally (idempotent)
# ------------------------------------------------------------------
if command -v qmd &>/dev/null; then
  echo "[OK] qmd already installed."
else
  echo "[..] Installing qmd globally via Bun..."
  if bun install -g qmd 2>&1; then
    echo "[OK] qmd installed successfully."
  else
    echo "ERROR: Failed to install qmd via 'bun install -g qmd'."
    echo "Check your network connection and Bun configuration, then retry."
    exit 1
  fi
fi

# ------------------------------------------------------------------
# 3. Verify qmd CLI works
# ------------------------------------------------------------------
if ! qmd status &>/dev/null; then
  echo "ERROR: 'qmd status' failed. The qmd binary may not be on your PATH."
  echo ""
  echo "Try adding Bun's global bin to your PATH:"
  echo "  export PATH=\"\$HOME/.bun/bin:\$PATH\""
  echo ""
  echo "Then re-run this setup script."
  exit 1
fi

echo "[OK] qmd CLI verified."

# ------------------------------------------------------------------
# 4. Verify FTS5 support via qmd status
# ------------------------------------------------------------------
echo "[..] Verifying SQLite FTS5 support..."
QMD_STATUS_OUTPUT=$(qmd status 2>&1) || true

if echo "${QMD_STATUS_OUTPUT}" | grep -qi "fts5.*not\|no fts5\|fts5.*error\|fts5.*missing"; then
  echo "ERROR: SQLite FTS5 extension is not available."
  echo "Bun's built-in SQLite should include FTS5. Try updating Bun:"
  echo "  bun upgrade"
  exit 1
fi

echo "[OK] FTS5 support confirmed."

# ------------------------------------------------------------------
# 5. Success
# ------------------------------------------------------------------
echo ""
echo "=== QMD Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Index a project:    qmd collection add myproject --pattern '**/*.ts' --path /your/project"
echo "  2. Generate embeddings: qmd embed myproject"
echo "  3. Search:              qmd search 'your query' -c myproject"
echo ""
echo "For more details, see SKILL.md in this directory."
exit 0
