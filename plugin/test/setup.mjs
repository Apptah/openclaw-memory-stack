// Test isolation: give each worker its own SQLite DB so concurrent test files don't conflict.
// Loaded via `node --test --import ./test/setup.mjs` before any test file imports run.
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCLAW_TEST_DB = join(tmpdir(), `openclaw-test-${process.pid}-${Date.now()}.sqlite`);
// Skip license gate in tests — avoids network calls and expired-license early returns
process.env.OPENCLAW_TEST_MODE = "1";
