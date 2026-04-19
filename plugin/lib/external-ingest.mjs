/**
 * external-ingest.mjs — Drop-zone ingest for external markdown memory files.
 *
 * Scans EXTERNAL_MEMORY_DIR for *.md files (no subdirs), SHA-256 hashes each,
 * skips unchanged files via ingested_files table, extracts facts and saves them
 * through the dedup gate.
 */

import { createHash } from "node:crypto";
import { execSync } from "./exec.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EXTERNAL_MEMORY_DIR, RESCUE_DB } from "./constants.mjs";
import { extractFacts, saveRescueFacts, initRescueDB } from "./rescue.mjs";

// ─── ingested_files table ─────────────────────────────────────────

function ensureIngestedFilesTable() {
  const sql =
    "CREATE TABLE IF NOT EXISTS ingested_files (" +
    "path TEXT PRIMARY KEY, " +
    "sha256 TEXT NOT NULL, " +
    "ingested_at TEXT DEFAULT (datetime('now'))" +
    ");";
  execSync(`sqlite3 "${RESCUE_DB}" "${sql}"`, { timeout: 5000 });
}

function sqlEscape(val) {
  if (val == null) return "NULL";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function getStoredHash(filePath) {
  try {
    const row = execSync(
      `sqlite3 "${RESCUE_DB}" "SELECT sha256 FROM ingested_files WHERE path = ${sqlEscape(filePath)};"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    return row || null;
  } catch {
    return null;
  }
}

function upsertIngestedFile(filePath, sha256) {
  const sql =
    `INSERT INTO ingested_files (path, sha256) VALUES (${sqlEscape(filePath)}, ${sqlEscape(sha256)}) ` +
    `ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, ingested_at = datetime('now');`;
  execSync(`sqlite3 "${RESCUE_DB}" "${sql}"`, { timeout: 5000 });
}

// ─── Content splitting ────────────────────────────────────────────

/**
 * Split markdown content into fact candidates.
 * Skips headings (# ...) and empty lines.
 * Keeps bullet lines (- ..., * ...) and text lines longer than 10 chars.
 */
function splitIntoFactCandidates(content) {
  const lines = content.split("\n");
  const candidates = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue; // skip headings
    if (line.startsWith("- ") || line.startsWith("* ")) {
      // Strip bullet marker
      const text = line.replace(/^[-*]\s+/, "").trim();
      if (text.length > 10) candidates.push(text);
    } else if (line.length > 10) {
      candidates.push(line);
    }
  }
  return candidates;
}

// ─── Main export ──────────────────────────────────────────────────

/**
 * Scan EXTERNAL_MEMORY_DIR for *.md files, ingest new/changed ones.
 *
 * @param {object} cfg - Plugin config (passed to extractFacts for LLM path)
 * @returns {{ ingested: number, skipped: number }}
 */
export async function ingestExternalMarkdown(cfg = {}) {
  let ingested = 0;
  let skipped = 0;

  // Ensure external dir exists
  if (!existsSync(EXTERNAL_MEMORY_DIR)) {
    try { mkdirSync(EXTERNAL_MEMORY_DIR, { recursive: true }); } catch { /* best-effort */ }
    return { ingested, skipped };
  }

  // Ensure DB and ingested_files table are ready
  try {
    initRescueDB();
    ensureIngestedFilesTable();
  } catch {
    return { ingested, skipped };
  }

  // List *.md files in top-level only (no subdirs)
  let files;
  try {
    files = readdirSync(EXTERNAL_MEMORY_DIR, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith(".md"))
      .map(e => resolve(EXTERNAL_MEMORY_DIR, e.name));
  } catch {
    return { ingested, skipped };
  }

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const sha256 = createHash("sha256").update(content).digest("hex");

      const storedHash = getStoredHash(filePath);
      if (storedHash === sha256) {
        skipped++;
        continue;
      }

      // New or changed file — extract and save facts
      const candidates = splitIntoFactCandidates(content);
      if (candidates.length > 0) {
        const combinedText = candidates.join("\n");
        const facts = await extractFacts(combinedText, cfg);
        if (facts.length > 0) {
          const sessionKey = "external:" + filePath.split("/").pop().replace(/[^a-z0-9]/gi, "_").slice(0, 30);
          await saveRescueFacts(facts, sessionKey);
        }
      }

      // Record ingestion hash regardless of whether facts were extracted,
      // so we don't re-process empty/unparseable files on every startup.
      upsertIngestedFile(filePath, sha256);
      ingested++;
    } catch {
      // Skip files that can't be read or processed; don't block other files
    }
  }

  return { ingested, skipped };
}
