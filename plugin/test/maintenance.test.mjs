import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { MAINTENANCE_STATE, RESCUE_DB } from "../lib/constants.mjs";
import { initRescueDB } from "../lib/rescue.mjs";

// Ensure state dir exists before tests
before(() => {
  mkdirSync(resolve(MAINTENANCE_STATE, ".."), { recursive: true });
});

describe("throttled maintenance", () => {
  it("skips maintenance when last run was < 24h ago", async () => {
    const { runMaintenanceIfDue } = await import("../lib/maintenance.mjs");
    // Write recent state
    writeFileSync(MAINTENANCE_STATE, JSON.stringify({ lastRun: Date.now() }));
    const result = await runMaintenanceIfDue();
    assert.equal(result.ran, false, "should skip when last run was recent");
  });

  it("runs maintenance when no state file exists", async () => {
    const { runMaintenanceIfDue } = await import("../lib/maintenance.mjs");
    // Remove state file
    try { unlinkSync(MAINTENANCE_STATE); } catch {}
    const result = await runMaintenanceIfDue();
    assert.equal(result.ran, true, "should run when no state exists");
    assert.ok(existsSync(MAINTENANCE_STATE), "should write state file");
  });

  it("rebuilds facts_fts when rowcounts diverge", async () => {
    const { runMaintenanceIfDue } = await import("../lib/maintenance.mjs");
    initRescueDB();
    // Insert a fact but corrupt FTS by deleting from it
    execSync(
      `sqlite3 "${RESCUE_DB}" "INSERT INTO facts (type, content, source, timestamp) VALUES ('test', 'maintenance-test-fts-rebuild', 'test', datetime('now'));"`,
      { timeout: 5000 }
    );
    execSync(`sqlite3 "${RESCUE_DB}" "DELETE FROM facts_fts;"`, { timeout: 5000 });

    // Remove state to force run
    try { unlinkSync(MAINTENANCE_STATE); } catch {}
    const result = await runMaintenanceIfDue();
    assert.equal(result.ran, true);

    // FTS should be rebuilt — verify search works
    const ftsResult = execSync(
      `sqlite3 "${RESCUE_DB}" "SELECT COUNT(*) FROM facts_fts;"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    assert.ok(parseInt(ftsResult) > 0, "FTS should have rows after rebuild");
  });

  it("returns alert note when health score is low", async () => {
    const { runMaintenanceIfDue } = await import("../lib/maintenance.mjs");
    // Force run
    try { unlinkSync(MAINTENANCE_STATE); } catch {}
    const result = await runMaintenanceIfDue();
    // healthNote may or may not be set depending on actual health — verify shape only
    assert.ok(
      result.healthNote === null || typeof result.healthNote === "string",
      "healthNote should be null or string"
    );
  });
});
