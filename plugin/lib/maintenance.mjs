import { execSync } from "node:child_process";
import { MAINTENANCE_STATE, findQmdBin } from "./constants.mjs";

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
