import { Env } from "./utils";

export function handleInstallScript(request: Request, env: Env): Response {
  const script = `#!/usr/bin/env bash
set -euo pipefail
# OpenClaw Memory Stack — Bootstrap Installer
# Usage: curl -fsSL https://openclaw-license.busihoward.workers.dev/api/install.sh | bash -s -- --key=oc-starter-xxx

KEY=""
for arg in "$@"; do
  case "$arg" in
    --key=*) KEY="\${arg#--key=}" ;;
  esac
done

if [ -z "$KEY" ]; then
  echo "Error: --key is required." >&2
  echo "Usage: curl -fsSL .../api/install.sh | bash -s -- --key=oc-starter-xxx" >&2
  exit 1
fi

TMP="/tmp/openclaw-install-$$"
TAR="$TMP.tar.gz"
trap 'rm -rf "$TMP" "$TAR"' EXIT

echo "Downloading OpenClaw Memory Stack..."
curl -fsSL "https://openclaw-license.busihoward.workers.dev/api/download/latest?key=$KEY" -o "$TAR"

if [ ! -s "$TAR" ]; then
  echo "Error: Download failed. Check your license key." >&2
  exit 1
fi

mkdir -p "$TMP"
tar -xzf "$TAR" -C "$TMP"

bash "$TMP/install.sh" "$@"
`;

  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
