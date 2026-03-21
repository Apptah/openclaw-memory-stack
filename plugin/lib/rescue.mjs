import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { RESCUE_DIR, RESCUE_DB } from "./constants.mjs";
import { llmGenerate } from "./llm.mjs";
import { extractEntities as extractEntitiesUnified } from "./extract.mjs";

// ─── SQLite helpers ─────────────────────────────────────────────

function sqlEscape(val) {
  if (val == null) return "NULL";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

let rescueDBReady = false;

function ensureRescueDB() {
  if (rescueDBReady) return;
  const dir = resolve(RESCUE_DB, "..");
  mkdirSync(dir, { recursive: true });

  const schema = `
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  timestamp TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, type);
`;
  const safeSql = schema.replace(/"/g, '\\"');
  execSync(`sqlite3 "${RESCUE_DB}" "${safeSql}"`, { timeout: 5000 });
  rescueDBReady = true;
}

/**
 * Migrate existing JSON fact files into SQLite.
 * Run once on startup; renames .json files to .json.bak.
 */
function migrateJsonFactsIfNeeded() {
  if (!existsSync(RESCUE_DIR)) return;
  let files;
  try {
    files = readdirSync(RESCUE_DIR).filter(f => f.endsWith(".json"));
  } catch { return; }
  if (files.length === 0) return;

  let sql = "";
  for (const file of files) {
    const filepath = resolve(RESCUE_DIR, file);
    try {
      const data = JSON.parse(readFileSync(filepath, "utf-8"));
      const facts = data.facts || [];
      const sessionKey = data.sessionKey || "unknown";
      const fileTimestamp = data.timestamp || new Date().toISOString();

      for (const fact of facts) {
        const content = fact.text || fact.fact || "";
        if (!content) continue;
        const type = fact.type || fact.category || "unknown";
        const ts = fact.timestamp || fileTimestamp;
        sql += `INSERT INTO facts (type, content, source, timestamp) VALUES (${sqlEscape(type)}, ${sqlEscape(content)}, ${sqlEscape("rescue:" + sessionKey)}, ${sqlEscape(ts)});\n`;
      }
      // Rename migrated file
      try { renameSync(filepath, filepath + ".bak"); } catch { /* ignore */ }
    } catch { /* skip bad files */ }
  }

  if (sql) {
    try {
      execSync(`sqlite3 "${RESCUE_DB}" "${sql.replace(/"/g, '\\"')}"`, { timeout: 10000 });
      // Rebuild FTS after migration
      rebuildFactsFTS();
    } catch { /* best-effort migration */ }
  }
}

function rebuildFactsFTS() {
  try {
    const sql = "DELETE FROM facts_fts; INSERT INTO facts_fts (rowid, content, type) SELECT id, content, type FROM facts;";
    execSync(`sqlite3 "${RESCUE_DB}" "${sql}"`, { timeout: 5000 });
  } catch { /* FTS rebuild is best-effort */ }
}

export function initRescueDB() {
  ensureRescueDB();
  migrateJsonFactsIfNeeded();
}

// ─── Entity extraction (delegates to extract.mjs) ───────────────

/**
 * Extract entities from a single line of text.
 * Thin wrapper over the unified extractor for per-line use.
 */
function extractEntitiesFromLine(line) {
  const { entities } = extractEntitiesUnified(line);
  return [...entities.values()].map(e => e.name);
}

// ─── LLM-based fact extraction ──────────────────────────────────

/**
 * Extract facts using user's LLM API.
 */
async function extractFactsWithLLM(text, cfg) {
  const prompt = `Extract key facts from the following conversation text. Return a JSON array of objects with this schema:
{ "type": "decision"|"deadline"|"requirement"|"entity"|"insight", "fact": "the fact text", "confidence": 0.0-1.0, "entities": ["referenced entity names"] }

Only include facts that are explicitly stated. Be concise.

Text:
${text.slice(0, 3000)}

Return ONLY a JSON array, no other text:`;

  try {
    const response = await llmGenerate(prompt, cfg);
    if (!response) return null;

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;

    const facts = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(facts)) return null;

    const validTypes = ["decision", "deadline", "requirement", "entity", "insight"];
    const validated = [];
    for (const f of facts) {
      if (!f.type || !validTypes.includes(f.type)) continue;
      if (!f.fact || typeof f.fact !== "string") continue;
      validated.push({
        type: f.type,
        fact: f.fact,
        confidence: typeof f.confidence === "number" ? Math.min(1, Math.max(0, f.confidence)) : 0.5,
        entities: Array.isArray(f.entities) ? f.entities.filter(e => typeof e === "string") : [],
      });
    }
    return validated.length > 0 ? validated : null;
  } catch {
    return null;
  }
}

// ─── Regex-based fact extraction ────────────────────────────────

/**
 * Extract key facts using regex patterns (fallback path).
 */
export function extractKeyFacts(text) {
  const facts = [];
  const lines = text.split("\n").filter(l => l.trim());

  for (const line of lines) {
    const entities = extractEntitiesFromLine(line);

    if (/\b(decided|agreed|confirmed|chose|selected|approved)\b/i.test(line)) {
      facts.push({ type: "decision", fact: line.trim(), confidence: 0.9, entities });
    }
    else if (/\b(deadline|due|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d)/i.test(line)) {
      facts.push({ type: "deadline", fact: line.trim(), confidence: 0.95, entities });
    }
    else if (/\b(must|shall|require|need to|should|important)\b/i.test(line) && line.length > 30) {
      facts.push({ type: "requirement", fact: line.trim(), confidence: 0.7, entities });
    }
    else if (/\b(project|client|team|api|endpoint|database|service)\s+[A-Z]/i.test(line)) {
      facts.push({ type: "entity", fact: line.trim(), confidence: 0.6, entities });
    }
  }

  // Dedupe and keep top facts
  const seen = new Set();
  return facts.filter(f => {
    const key = f.fact.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.confidence - a.confidence).slice(0, 20);
}

// ─── Main extraction (LLM first, regex fallback) ────────────────

/**
 * Main extraction function: tries LLM first, falls back to regex.
 */
export async function extractFacts(text, cfg = {}) {
  const llmFacts = await extractFactsWithLLM(text, cfg);
  if (llmFacts) return llmFacts;

  return extractKeyFacts(text);
}

// ─── Save facts to SQLite ───────────────────────────────────────

/**
 * Save extracted facts to rescue SQLite store.
 */
export function saveRescueFacts(facts, sessionKey) {
  if (facts.length === 0) return;
  try {
    initRescueDB();
    const source = "rescue:" + ((sessionKey || "default").replace(/[^a-z0-9]/gi, "_").slice(0, 30));
    const now = new Date().toISOString();

    let sql = "";
    for (const f of facts) {
      const content = f.text || f.fact || "";
      if (!content) continue;
      const type = f.type || "unknown";
      sql += `INSERT INTO facts (type, content, source, timestamp) VALUES (${sqlEscape(type)}, ${sqlEscape(content)}, ${sqlEscape(source)}, ${sqlEscape(now)});\n`;
    }

    if (sql) {
      execSync(`sqlite3 "${RESCUE_DB}" "${sql.replace(/"/g, '\\"')}"`, { timeout: 5000 });
      // Update FTS for new facts
      rebuildFactsFTS();
    }
  } catch { /* best-effort save */ }
}

// ─── Cleanup ────────────────────────────────────────────────────

/**
 * Clean up rescue facts older than maxAgeDays.
 */
export function cleanupOldRescueFiles(maxAgeDays) {
  // Clean old JSON files (legacy)
  if (existsSync(RESCUE_DIR)) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    try {
      const files = readdirSync(RESCUE_DIR).filter(f => f.endsWith(".json"));
      for (const file of files) {
        const ts = parseInt(file.split("-")[0], 10);
        if (ts && ts < cutoff) {
          try { execSync(`rm "${resolve(RESCUE_DIR, file)}"`); } catch { /* ignore */ }
        }
      }
    } catch { /* no files */ }
  }

  // Clean old facts from SQLite
  if (existsSync(RESCUE_DB)) {
    try {
      const cutoffDate = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
      execSync(`sqlite3 "${RESCUE_DB}" "DELETE FROM facts WHERE created_at < '${cutoffDate}';"`, { timeout: 5000 });
      rebuildFactsFTS();
    } catch { /* best-effort cleanup */ }
  }
}
