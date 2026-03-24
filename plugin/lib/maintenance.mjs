import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { MAINTENANCE_STATE, MEMORY_DB, RESCUE_DB, findQmdBin } from "./constants.mjs";
import { initRescueDB, rebuildFactsFTS } from "./rescue.mjs";
import { analyzeMemoryHealth } from "./quality.mjs";

/**
 * Ensure workspace QMD collection is ready.
 * Returns { engineSummary: string, healthNote: string|null }
 *
 * Gracefully degrades:
 * - No QMD binary → fts5-only mode
 * - QMD available but no collection → creates collection + schedules embed
 * - QMD available + collection exists → checks embed status
 */
export async function ensureWorkspaceQmdReady(cfg = {}, logger = null) {
  const log = (msg) => logger?.info?.(msg);

  const qmdBin = findQmdBin();
  if (!qmdBin) {
    log("QMD not available — running in FTS5-only mode");
    return { engineSummary: "fts5-only", healthNote: null };
  }

  // Check if workspace has a collection
  try {
    const cwd = cfg.workspaceDir || process.cwd();
    const status = execSync(`${qmdBin} status --json 2>/dev/null || echo '{}'`, {
      encoding: "utf-8",
      timeout: 5000,
      cwd,
    }).trim();

    const parsed = JSON.parse(status || "{}");

    if (!parsed.collection) {
      // No collection — try to create one
      log("No QMD collection found — creating workspace collection");
      try {
        execSync(`${qmdBin} collection add "${cwd}" 2>/dev/null`, {
          timeout: 10000,
          cwd,
        });
        // Schedule background embed
        execSync(`${qmdBin} embed --bg 2>/dev/null`, {
          timeout: 5000,
          cwd,
        });
        log("QMD collection created, embedding scheduled");
        return { engineSummary: "fts5+qmd(embedding)", healthNote: null };
      } catch {
        log("Failed to create QMD collection — falling back to FTS5-only");
        return { engineSummary: "fts5-only", healthNote: "QMD collection creation failed" };
      }
    }

    // Collection exists — check embed status
    if (parsed.embeddings === "pending" || parsed.embeddings === "stale") {
      try {
        execSync(`${qmdBin} embed --bg 2>/dev/null`, { timeout: 5000, cwd });
        log("QMD embeddings stale — background embed scheduled");
      } catch {}
      return { engineSummary: "fts5+qmd(embedding)", healthNote: null };
    }

    return { engineSummary: "fts5+qmd", healthNote: null };
  } catch (err) {
    log("QMD status check failed — falling back to FTS5-only");
    return { engineSummary: "fts5-only", healthNote: "QMD status check failed" };
  }
}

// ─── Throttled maintenance cycle ─────────────────────────────────

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Run maintenance tasks if last run was > 24h ago.
 * Tasks:
 *   1. FTS rebuild if facts rowcount != facts_fts rowcount
 *   2. Stale archive: move facts older than 90 days to facts_archive
 *   3. Health score check: alert note if score < 50
 *
 * Returns { ran: boolean, healthNote: string|null }
 * Never throws.
 */
export async function runMaintenanceIfDue(cfg = {}, logger = null) {
  const log = (msg) => logger?.info?.(msg);

  // Read last maintenance state
  let state = {};
  try {
    if (existsSync(MAINTENANCE_STATE)) {
      state = JSON.parse(readFileSync(MAINTENANCE_STATE, "utf-8"));
    }
  } catch {}

  const lastRun = state.lastRun || 0;
  const now = Date.now();

  if (now - lastRun < MAINTENANCE_INTERVAL_MS) {
    return { ran: false, healthNote: state.healthNote || null };
  }

  log("Running scheduled maintenance...");
  let healthNote = null;

  try {
    initRescueDB();

    // Task 1: FTS rebuild if rowcounts diverge
    try {
      const factsCount = execSync(
        `sqlite3 "${RESCUE_DB}" "SELECT COUNT(*) FROM facts;"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      const ftsCount = execSync(
        `sqlite3 "${RESCUE_DB}" "SELECT COUNT(*) FROM facts_fts;"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      if (factsCount !== ftsCount) {
        log(`FTS rowcount mismatch (facts=${factsCount}, fts=${ftsCount}) — rebuilding`);
        rebuildFactsFTS();
      }
    } catch {}

    // Task 2: Stale archive (facts older than 90 days)
    try {
      const cutoff = new Date(now - 90 * 86400000).toISOString();
      const staleCount = execSync(
        `sqlite3 "${RESCUE_DB}" "SELECT COUNT(*) FROM facts WHERE created_at < '${cutoff}';"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      if (parseInt(staleCount) > 0) {
        execSync(
          `sqlite3 "${RESCUE_DB}" "INSERT INTO facts_archive SELECT id, type, content, source, timestamp, created_at, key, value, scope, confidence, evidence, supersedes, entities, datetime('now'), 'stale' FROM facts WHERE created_at < '${cutoff}'; DELETE FROM facts WHERE created_at < '${cutoff}';"`,
          { timeout: 10000 }
        );
        log(`Archived ${staleCount} stale facts`);
        rebuildFactsFTS();
      }
    } catch {}

    // Task 3b: Trigram index full rebuild (safety net for missed updates)
    try {
      const { rebuildTrigramIndex, buildPostingFiles } = await import("./ngram.mjs");
      rebuildTrigramIndex(MEMORY_DB);
      buildPostingFiles(MEMORY_DB);
      log("Trigram index + posting files rebuilt");
    } catch { /* ngram.mjs may not exist in Phase 0 */ }

    // Task 3: Health score check
    try {
      const health = analyzeMemoryHealth();
      if (health.score < 50) {
        healthNote = `Memory health score is ${health.score}/100 — consider running memory_search("health") for details`;
        log(healthNote);
      }
    } catch {}

  } catch {}

  // Save state
  const newState = {
    lastRun: now,
    lastRunISO: new Date(now).toISOString(),
    healthNote,
  };
  try {
    mkdirSync(resolve(MAINTENANCE_STATE, ".."), { recursive: true });
    writeFileSync(MAINTENANCE_STATE, JSON.stringify(newState, null, 2));
  } catch {}

  return { ran: true, healthNote };
}
