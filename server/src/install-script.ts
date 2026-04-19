import { Env } from "./utils";

export function handleInstallScript(request: Request, env: Env): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail
# OpenClaw Memory Stack — Bootstrap Installer
# Usage: curl -fsSL https://openclaw-api.apptah.com/api/install.sh | bash -s -- --key=oc-starter-xxx --email=you@example.com

KEY=""
EMAIL=""
for arg in "$@"; do
  case "$arg" in
    --key=*) KEY="\${arg#--key=}" ;;
    --email=*) EMAIL="\${arg#--email=}" ;;
  esac
done

if [ -z "$KEY" ] || [ -z "$EMAIL" ]; then
  echo "Error: --key and --email are required." >&2
  echo "Usage: curl -fsSL .../api/install.sh | bash -s -- --key=oc-starter-xxx --email=you@example.com" >&2
  exit 1
fi

# URL-encode email
ENCODED_EMAIL=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$EMAIL'))" 2>/dev/null || echo "$EMAIL")

TMP="/tmp/openclaw-install-$$"
TAR="$TMP.tar.gz"
trap 'rm -rf "$TMP" "$TAR"' EXIT

echo "Downloading OpenClaw Memory Stack..."
curl -fsSL "https://openclaw-api.apptah.com/api/download/latest?key=$KEY&email=$ENCODED_EMAIL" -o "$TAR"

if [ ! -s "$TAR" ]; then
  echo "Error: Download failed. Check your license key and email." >&2
  exit 1
fi

# Verify integrity
EXPECTED_SHA=$(curl -fsSL "https://openclaw-api.apptah.com/api/download/latest/sha256?key=$KEY&email=$ENCODED_EMAIL")
if command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA=$(shasum -a 256 "$TAR" | cut -d' ' -f1)
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA=$(sha256sum "$TAR" | cut -d' ' -f1)
else
  echo "Warning: no shasum/sha256sum — skipping checksum verification" >&2
  ACTUAL_SHA="$EXPECTED_SHA"
fi
if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  echo "Error: Checksum mismatch — download may be corrupted." >&2
  exit 1
fi

mkdir -p "$TMP"
tar -xzf "$TAR" -C "$TMP"

# Find install.sh (may be inside a subdirectory)
INSTALLER=$(find "$TMP" -maxdepth 2 -name "install.sh" -type f | head -1)
if [ -z "$INSTALLER" ]; then
  echo "Error: install.sh not found in downloaded package." >&2
  exit 1
fi

bash "$INSTALLER" "$@"
`;

  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
