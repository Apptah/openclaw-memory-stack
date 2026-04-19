#!/usr/bin/env bash
# Build release artifact — all backends
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=$(grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' "$PROJECT_ROOT/bin/openclaw-memory" | head -1 | tr -d '"')
BUILD_DIR="$PROJECT_ROOT/dist/openclaw-memory-stack-v${VERSION}"
ARTIFACT="$PROJECT_ROOT/dist/openclaw-memory-stack-v${VERSION}.tar.gz"

echo "Building OpenClaw Memory Stack v${VERSION}"
echo ""

# Clean
rm -rf "$BUILD_DIR" "$ARTIFACT"
mkdir -p "$BUILD_DIR"

# Copy core files
cp -r "$PROJECT_ROOT/bin" "$BUILD_DIR/"
cp -r "$PROJECT_ROOT/lib" "$BUILD_DIR/"
cp "$PROJECT_ROOT/install.sh" "$BUILD_DIR/"
cp "$PROJECT_ROOT/README.md" "$BUILD_DIR/"
cp "$PROJECT_ROOT/LICENSE" "$BUILD_DIR/"
cp "$PROJECT_ROOT/openclaw.plugin.json" "$BUILD_DIR/"

# Rebuild plugin dist before copying — ensures shipped bundle matches source
echo "Rebuilding plugin dist..."
(cd "$PROJECT_ROOT/plugin" && node build.mjs)
if [ ! -f "$PROJECT_ROOT/plugin/dist/index.mjs" ]; then
  echo "ERROR: plugin/dist/index.mjs not found after build" >&2
  exit 1
fi
# Verify dist is not stale (must be newer than all plugin source files)
STALE_SOURCE=$(find "$PROJECT_ROOT/plugin" -name '*.mjs' -not -path '*/dist/*' -not -path '*/node_modules/*' -not -path '*/test/*' -newer "$PROJECT_ROOT/plugin/dist/index.mjs" 2>/dev/null | head -1)
if [ -n "$STALE_SOURCE" ]; then
  echo "ERROR: plugin/dist/index.mjs is older than $(basename "$STALE_SOURCE") — build may have failed" >&2
  exit 1
fi
echo "  plugin/dist/index.mjs rebuilt"

cp -r "$PROJECT_ROOT/plugin" "$BUILD_DIR/"

# Copy all backend skills dynamically
mkdir -p "$BUILD_DIR/skills"
for skill_dir in "$PROJECT_ROOT/skills/memory-"*; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  mkdir -p "$BUILD_DIR/skills/$skill_name"
  cp -r "$skill_dir/"* "$BUILD_DIR/skills/$skill_name/"
done

# Remove internal dev files
rm -f "$BUILD_DIR/skills/memory-router/backends.json"

# Write version.json (no tier field)
cat > "$BUILD_DIR/version.json" <<JSONEOF
{
  "version": "${VERSION}",
  "built_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
JSONEOF

# Verify artifact completeness
echo "Verifying artifact..."
MISSING=0
for skill_dir in "$PROJECT_ROOT/skills/memory-"*; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  [ "$skill_name" = "memory-router" ] && continue
  if [ ! -f "$BUILD_DIR/skills/$skill_name/wrapper.sh" ]; then
    echo "ERROR: Missing wrapper: $skill_name/wrapper.sh" >&2
    MISSING=$((MISSING + 1))
  fi
done

if [ "$MISSING" -gt 0 ]; then
  echo "ERROR: $MISSING backend(s) missing wrapper.sh" >&2
  exit 1
fi

# Verify capability.json presence
for skill_dir in "$PROJECT_ROOT/skills/memory-"*; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  [ "$skill_name" = "memory-router" ] && continue
  if [ ! -f "$BUILD_DIR/skills/$skill_name/capability.json" ]; then
    echo "WARNING: Missing capability.json: $skill_name" >&2
  fi
done

# Count backends
BACKEND_COUNT=$(ls -d "$BUILD_DIR/skills/memory-"*/wrapper.sh 2>/dev/null | wc -l | tr -d ' ')
echo "  $BACKEND_COUNT backends present (all with wrapper.sh)"

# Package
cd "$PROJECT_ROOT/dist"
COPYFILE_DISABLE=1 tar czf "openclaw-memory-stack-v${VERSION}.tar.gz" --no-xattrs "openclaw-memory-stack-v${VERSION}" 2>/dev/null || \
COPYFILE_DISABLE=1 tar czf "openclaw-memory-stack-v${VERSION}.tar.gz" "openclaw-memory-stack-v${VERSION}"

# Generate SHA-256 checksum (upload alongside tarball to R2)
SHA256=$(shasum -a 256 "$ARTIFACT" | cut -d' ' -f1)
echo "$SHA256" > "${ARTIFACT}.sha256"

# ── Cross-platform compatibility checks ──────────────────────────
echo "Cross-platform checks..."
COMPAT_FAIL=0

# No macOS extended attributes in tarball
if tar -tzf "$ARTIFACT" 2>&1 | grep -q "apple\.\|LIBARCHIVE\.xattr"; then
  echo "ERROR: tarball contains macOS extended attributes" >&2
  COMPAT_FAIL=$((COMPAT_FAIL + 1))
fi

# No CRLF line endings in shell scripts
for f in $(find "$BUILD_DIR" -name "*.sh" -type f); do
  if file "$f" | grep -q "CRLF"; then
    echo "ERROR: CRLF line endings in $(basename "$f")" >&2
    COMPAT_FAIL=$((COMPAT_FAIL + 1))
  fi
done

# No shasum without fallback in shipped scripts
for f in "$BUILD_DIR/install.sh" "$BUILD_DIR/bin/openclaw-memory"; do
  [ -f "$f" ] || continue
  if grep -q 'shasum' "$f" && ! grep -q 'sha256sum' "$f"; then
    echo "ERROR: $(basename "$f") uses shasum without sha256sum fallback" >&2
    COMPAT_FAIL=$((COMPAT_FAIL + 1))
  fi
done

if [ "$COMPAT_FAIL" -gt 0 ]; then
  echo "ERROR: $COMPAT_FAIL cross-platform issue(s) found — fix before release" >&2
  exit 1
fi
echo "  all checks passed"

echo ""
echo "Artifact: $ARTIFACT"
echo "SHA-256:  $SHA256"
echo "Size:     $(du -h "$ARTIFACT" | cut -f1)"
echo "Done."
