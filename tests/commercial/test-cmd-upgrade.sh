#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env

write_license "oc-starter-test123" "starter" "testdevice1234"
write_backends

# Create a fake install.sh that records it was called with --upgrade
cat > "$OPENCLAW_INSTALL_ROOT/install.sh" <<'FAKE'
#!/usr/bin/env bash
echo "INSTALL_CALLED args=$*"
exit 0
FAKE
chmod +x "$OPENCLAW_INSTALL_ROOT/install.sh"

# Test 1: upgrade subcommand delegates to install.sh --upgrade
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" upgrade 2>&1)
assert_contains "$OUTPUT" "INSTALL_CALLED" "upgrade delegates to install.sh"
assert_contains "$OUTPUT" "upgrade" "passes --upgrade flag"

# Test 2: upgrade fails gracefully if install.sh is missing
rm "$OPENCLAW_INSTALL_ROOT/install.sh"
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" upgrade 2>&1) || true
assert_contains "$OUTPUT" "installer not found" "error when install.sh missing"

# Test 3: upgrade shows in --help
OUTPUT=$("$OPENCLAW_INSTALL_ROOT/bin/openclaw-memory" --help 2>&1)
assert_contains "$OUTPUT" "upgrade" "upgrade listed in help"

teardown_test_env
summary
