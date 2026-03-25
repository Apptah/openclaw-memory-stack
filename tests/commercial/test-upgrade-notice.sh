#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
setup_test_env

# Test the getUpdateAvailableNotice function via Node
NODE_CMD="node --input-type=module"

# Test 1: notice shown when update_available is true
mkdir -p "$TEST_HOME/.openclaw/memory-stack"
cat > "$TEST_HOME/.openclaw/memory-stack/update-state.json" <<'EOF'
{"last_check":1711324800000,"latest":"0.3.0","update_available":true}
EOF

OUTPUT=$($NODE_CMD <<SCRIPT
import { getUpdateAvailableNotice } from "$PROJECT_ROOT/plugin/lib/update-check.mjs";
const msg = getUpdateAvailableNotice("$TEST_HOME");
console.log(msg || "NULL");
SCRIPT
2>&1)
assert_contains "$OUTPUT" "openclaw-memory upgrade" "notice says openclaw-memory upgrade"
assert_contains "$OUTPUT" "0.3.0" "notice includes version"

# Test 2: no notice when update_available is false
cat > "$TEST_HOME/.openclaw/memory-stack/update-state.json" <<'EOF'
{"last_check":1711324800000,"latest":"0.2.0","update_available":false}
EOF

OUTPUT=$($NODE_CMD <<SCRIPT
import { getUpdateAvailableNotice } from "$PROJECT_ROOT/plugin/lib/update-check.mjs";
const msg = getUpdateAvailableNotice("$TEST_HOME");
console.log(msg || "NULL");
SCRIPT
2>&1)
assert_eq "NULL" "$OUTPUT" "no notice when no update available"

# Test 3: no notice when state file missing
rm -f "$TEST_HOME/.openclaw/memory-stack/update-state.json"

OUTPUT=$($NODE_CMD <<SCRIPT
import { getUpdateAvailableNotice } from "$PROJECT_ROOT/plugin/lib/update-check.mjs";
const msg = getUpdateAvailableNotice("$TEST_HOME");
console.log(msg || "NULL");
SCRIPT
2>&1)
assert_eq "NULL" "$OUTPUT" "no notice when state file missing"

teardown_test_env
summary
