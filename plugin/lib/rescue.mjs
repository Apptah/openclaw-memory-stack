import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, readdirSync, renameSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOME, RESCUE_DIR, RESCUE_DB } from "./constants.mjs";
import { gateFactInsert, archiveFact } from "./dedup-gate.mjs";

// Old location before path consolidation (Task 1 migration)
const OLD_RESCUE_DB = resolve(HOME, ".openclaw/memory-stack/rescue/facts.sqlite");
import { llmGenerate } from "./llm.mjs";
import { extractEntities as extractEntitiesUnified } from "./extract.mjs";

// ─── SQLite helpers ─────────────────────────────────────────────

function sqlEscape(val) {
  if (val == null) return "NULL";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

let rescueDBReady = false;

// Columns added in the structured facts schema upgrade
const SCHEMA_V2_COLUMNS = [
  { name: "key",        def: "TEXT" },
  { name: "value",      def: "TEXT" },
  { name: "scope",      def: "TEXT DEFAULT 'global'" },
  { name: "confidence", def: "REAL DEFAULT 0.5" },
  { name: "evidence",   def: "TEXT" },
  { name: "supersedes", def: "INTEGER" },
  { name: "entities",   def: "TEXT" },
];

function ensureRescueDB() {
  if (rescueDBReady) return;
  const dir = resolve(RESCUE_DB, "..");
  mkdirSync(dir, { recursive: true });

  // One-time file-level migration: copy old DB path to new consolidated location
  if (!existsSync(RESCUE_DB) && existsSync(OLD_RESCUE_DB)) {
    try { copyFileSync(OLD_RESCUE_DB, RESCUE_DB); } catch { /* best-effort */ }
  }

  // Create base tables (original schema + archive, idempotent)
  const baseSchema = `
CREATE TABLE IF NOT EXISTS facts_archive (
  id INTEGER PRIMARY KEY,
  type TEXT, content TEXT, source TEXT, timestamp TEXT, created_at TEXT,
  key TEXT, value TEXT, scope TEXT, confidence REAL, evidence TEXT, supersedes INTEGER, entities TEXT,
  archived_at TEXT DEFAULT (datetime('now')), archived_reason TEXT DEFAULT 'superseded'
);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  timestamp TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;
  execSync(`sqlite3 "${RESCUE_DB}" "${baseSchema.replace(/"/g, '\\"')}"`, { timeout: 5000 });

  // In-place migration: add any missing v2 columns
  migrateFactsSchema();

  // Ensure FTS virtual table exists with full column set
  ensureFactsFTS();

  rescueDBReady = true;
}

/**
 * Add any missing structured-facts columns to the facts table (idempotent).
 */
function migrateFactsSchema() {
  let existingColumns;
  try {
    const raw = execSync(`sqlite3 "${RESCUE_DB}" "PRAGMA table_info(facts);"`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    existingColumns = new Set(
      raw.split("\n").filter(Boolean).map(row => row.split("|")[1])
    );
  } catch {
    return; // Can't inspect schema — skip migration
  }

  for (const col of SCHEMA_V2_COLUMNS) {
    if (existingColumns.has(col.name)) continue;
    try {
      execSync(
        `sqlite3 "${RESCUE_DB}" "ALTER TABLE facts ADD COLUMN ${col.name} ${col.def};"`,
        { timeout: 5000 }
      );
    } catch { /* best-effort column add */ }
  }
}

/**
 * Create or recreate facts_fts to include all structured columns.
 * Drops the old narrow FTS if it exists, then recreates and rehydrates.
 */
function ensureFactsFTS() {
  try {
    // Drop, recreate, and rehydrate in one spawn to reduce process overhead
    const ftsSql = [
      "DROP TABLE IF EXISTS facts_fts;",
      "CREATE VIRTUAL TABLE facts_fts USING fts5(content, type, key, value, scope, entities);",
      "INSERT INTO facts_fts (rowid, content, type, key, value, scope, entities) SELECT id, content, type, key, value, scope, entities FROM facts;",
    ].join(" ");
    execSync(`sqlite3 "${RESCUE_DB}" "${ftsSql}"`, { timeout: 5000 });
  } catch { /* best-effort FTS setup */ }
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
    const sql = "DELETE FROM facts_fts; INSERT INTO facts_fts (rowid, content, type, key, value, scope, entities) SELECT id, content, type, key, value, scope, entities FROM facts;";
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
{ "type": "decision"|"deadline"|"requirement"|"entity"|"preference"|"workflow"|"relationship"|"correction", "key": "short label", "value": "the fact text", "scope": "global"|"project"|"session", "confidence": 0.0-1.0, "evidence": "the source text", "supersedes": null, "entities": ["referenced entity names"] }

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

    const validTypes = ["decision", "deadline", "requirement", "entity", "preference", "workflow", "relationship", "correction"];
    const validated = [];
    for (const f of facts) {
      if (!f.type || !validTypes.includes(f.type)) continue;
      // Accept both old format (fact field) and new format (key+value fields)
      const factText = f.fact || f.value;
      if (!factText || typeof factText !== "string") continue;
      validated.push({
        type: f.type,
        fact: factText,
        key: typeof f.key === "string" ? f.key : null,
        value: typeof f.value === "string" ? f.value : factText,
        scope: ["global", "project", "session"].includes(f.scope) ? f.scope : "global",
        confidence: typeof f.confidence === "number" ? Math.min(1, Math.max(0, f.confidence)) : 0.5,
        evidence: typeof f.evidence === "string" ? f.evidence : null,
        supersedes: f.supersedes != null ? f.supersedes : null,
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
 * Classify and push a single sentence into facts array.
 * Returns true if a fact was matched.
 */
function classifySentence(sentence, facts) {
  const s = sentence.trim();
  if (!s) return false;

  const entities = extractEntitiesFromLine(s);
  const isNegated = /\b(NOT|don't|shouldn't|never|no longer)\b/.test(s);

  // Correction: lines that explicitly correct or negate something
  if (/\bactually\b/i.test(s) || (isNegated && /\b(NOT|don't|shouldn't)\b/.test(s) && !/\b(decided|agreed|confirmed|chose|selected|approved|will)\b/i.test(s))) {
    facts.push({ type: "correction", fact: s, confidence: 0.85, entities });
    return true;
  }

  // Decision: includes negated decisions (e.g. "We will NOT use MongoDB")
  if (/\b(decided|agreed|confirmed|chose|selected|approved|will)\b/i.test(s)) {
    facts.push({ type: "decision", fact: s, confidence: 0.9, entities });
    return true;
  }

  // Deadline
  if (/\b(deadline|due|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d)/i.test(s)) {
    facts.push({ type: "deadline", fact: s, confidence: 0.95, entities });
    return true;
  }

  // Requirement
  if (/\b(must|shall|require|need to|important)\b/i.test(s) && s.length > 30) {
    facts.push({ type: "requirement", fact: s, confidence: 0.7, entities });
    return true;
  }

  // Workflow: habitual patterns
  if (/\b(always|typically|usually|our process|we tend to|I always|we always)\b/i.test(s)) {
    facts.push({ type: "workflow", fact: s, confidence: 0.75, entities });
    return true;
  }

  // Preference
  if (/\b(prefer|like to|favor|rather|instead of)\b/i.test(s)) {
    facts.push({ type: "preference", fact: s, confidence: 0.75, entities });
    return true;
  }

  // Relationship
  if (/\b(works with|reports to|depends on|integrates with|owned by|part of)\b/i.test(s)) {
    facts.push({ type: "relationship", fact: s, confidence: 0.8, entities });
    return true;
  }

  // Entity
  if (/\b(project|client|team|api|endpoint|database|service)\s+[A-Z]/i.test(s)) {
    facts.push({ type: "entity", fact: s, confidence: 0.6, entities });
    return true;
  }

  return false;
}

/**
 * Extract key facts using regex patterns (fallback path).
 */
export function extractKeyFacts(text) {
  const facts = [];
  const lines = text.split("\n").filter(l => l.trim());

  for (const line of lines) {
    // Split each line into sentences and process each independently
    const sentences = line.split(/(?<=\. )|(?<=; )/).flatMap(s => s.split(/\. |; /));
    const unique = [...new Set(sentences.map(s => s.trim()).filter(Boolean))];

    if (unique.length > 1) {
      // Multi-sentence line: process each sentence independently
      for (const sentence of unique) {
        classifySentence(sentence, facts);
      }
    } else {
      // Single sentence: process the whole line
      classifySentence(line, facts);
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
 * Routes each fact through the dedup gate before inserting.
 * Persists all structured columns (key, value, scope, confidence, evidence, supersedes, entities).
 */
export async function saveRescueFacts(facts, sessionKey) {
  if (facts.length === 0) return;
  try {
    initRescueDB();
    const source = "rescue:" + ((sessionKey || "default").replace(/[^a-z0-9]/gi, "_").slice(0, 30));
    const now = new Date().toISOString();

    let sql = "";
    for (const f of facts) {
      const content = f.text || f.fact || f.value || "";
      if (!content) continue;

      const gate = gateFactInsert(f);
      if (gate.action === "skip") continue;
      if (gate.action === "archive") archiveFact(gate.archivedId);

      const type = f.type || "unknown";
      const key = f.key || null;
      const value = f.value || null;
      const scope = f.scope || "global";
      const confidence = typeof f.confidence === "number" ? f.confidence : 0.5;
      const evidence = f.evidence || null;
      const supersedes = gate.archivedId || null;
      const entities = Array.isArray(f.entities) ? JSON.stringify(f.entities) : null;

      sql += `INSERT INTO facts (type, content, source, timestamp, key, value, scope, confidence, evidence, supersedes, entities) VALUES (${sqlEscape(type)}, ${sqlEscape(content)}, ${sqlEscape(source)}, ${sqlEscape(now)}, ${sqlEscape(key)}, ${sqlEscape(value)}, ${sqlEscape(scope)}, ${confidence}, ${sqlEscape(evidence)}, ${supersedes !== null ? supersedes : "NULL"}, ${sqlEscape(entities)});\n`;
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
