import { execSync } from "../exec.mjs";
import { existsSync, readFileSync, renameSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { GRAPH_PATH, GRAPH_DB } from "../constants.mjs";

const HOME = homedir();
const OLD_GRAPH_DB = resolve(HOME, ".openclaw/memory-stack/graph.sqlite");
import { extractEntities } from "../extract.mjs";
import { invalidateGraphCache as invalidateAlgorithmsCache } from "./algorithms.mjs";

// Re-export extractEntities so existing imports from graph/store.mjs keep working
export { extractEntities };

// ─── SQLite helpers ─────────────────────────────────────────────

function ensureDB() {
  const dir = resolve(GRAPH_DB, "..");
  mkdirSync(dir, { recursive: true });

  // One-time migration: copy graph.sqlite from old memory-stack location
  if (!existsSync(GRAPH_DB) && existsSync(OLD_GRAPH_DB)) {
    try { copyFileSync(OLD_GRAPH_DB, GRAPH_DB); } catch { /* best-effort */ }
  }

  const schema = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  mentions INTEGER DEFAULT 1,
  recorded_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT DEFAULT 'RELATES',
  context TEXT,
  recorded_at TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(name, type);
`;
  const safeSql = schema.replace(/"/g, '\\"');
  execSync(`sqlite3 "${GRAPH_DB}" "${safeSql}"`, { timeout: 5000 });
}

function sqlEscape(val) {
  if (val == null) return "NULL";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

/**
 * Migrate graph.json → SQLite on first run.
 * Renames graph.json to graph.json.bak afterwards.
 */
function migrateJsonIfNeeded() {
  if (!existsSync(GRAPH_PATH)) return;
  let data;
  try {
    data = JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
  } catch {
    // Corrupted JSON — just rename and move on
    try { renameSync(GRAPH_PATH, GRAPH_PATH + ".bak"); } catch { /* ignore */ }
    return;
  }

  const entities = data.entities || {};
  const edges = data.edges || [];

  // Batch insert entities
  if (Object.keys(entities).length > 0) {
    let sql = "";
    for (const [name, ent] of Object.entries(entities)) {
      const id = name.toLowerCase();
      const type = ent.type || "entity";
      const mentions = ent.mentions || 1;
      const now = new Date().toISOString();
      sql += `INSERT OR IGNORE INTO entities (id, name, type, mentions, recorded_at, updated_at) VALUES (${sqlEscape(id)}, ${sqlEscape(ent.name || name)}, ${sqlEscape(type)}, ${mentions}, ${sqlEscape(now)}, ${sqlEscape(now)});\n`;
      sql += `INSERT OR IGNORE INTO entities_fts (rowid, name, type) VALUES ((SELECT rowid FROM entities WHERE id = ${sqlEscape(id)}), ${sqlEscape(ent.name || name)}, ${sqlEscape(type)});\n`;
    }
    execSync(`sqlite3 "${GRAPH_DB}" "${sql.replace(/"/g, '\\"')}"`, { timeout: 10000 });
  }

  // Batch insert edges
  if (edges.length > 0) {
    let sql = "";
    for (const edge of edges) {
      const id = `${edge.from}|||${edge.to}`;
      const type = edge.type || "RELATES";
      const ts = edge.timestamp || new Date().toISOString();
      sql += `INSERT OR IGNORE INTO edges (id, from_id, to_id, type, context, recorded_at) VALUES (${sqlEscape(id)}, ${sqlEscape(edge.from)}, ${sqlEscape(edge.to)}, ${sqlEscape(type)}, ${sqlEscape(edge.context || "")}, ${sqlEscape(ts)});\n`;
    }
    execSync(`sqlite3 "${GRAPH_DB}" "${sql.replace(/"/g, '\\"')}"`, { timeout: 10000 });
  }

  // Rename old JSON file
  try { renameSync(GRAPH_PATH, GRAPH_PATH + ".bak"); } catch { /* ignore */ }
}

// ─── Public API (backward-compatible shape) ─────────────────────

let dbReady = false;

function initDB() {
  if (dbReady) return;
  ensureDB();
  migrateJsonIfNeeded();
  dbReady = true;
}

/**
 * Load graph from SQLite, returning the same { entities, edges } shape
 * that the rest of the codebase expects (entities as plain object keyed
 * by name, edges as array).
 */
export function loadGraph() {
  try {
    initDB();

    const entitiesRaw = execSync(
      `sqlite3 -json "${GRAPH_DB}" "SELECT id, name, type, mentions, recorded_at, updated_at FROM entities;"`,
      { encoding: "utf-8", timeout: 5000 }
    );
    const edgesRaw = execSync(
      `sqlite3 -json "${GRAPH_DB}" "SELECT id, from_id, to_id, type, context, recorded_at FROM edges;"`,
      { encoding: "utf-8", timeout: 5000 }
    );

    const entities = {};
    for (const row of JSON.parse(entitiesRaw || "[]")) {
      entities[row.name || row.id] = {
        name: row.name || row.id,
        type: row.type || "entity",
        mentions: row.mentions || 1,
      };
    }

    const edges = JSON.parse(edgesRaw || "[]").map(row => ({
      from: row.from_id,
      to: row.to_id,
      type: row.type || "RELATES",
      context: row.context || "",
      timestamp: row.recorded_at || "",
    }));

    return { entities, edges };
  } catch {
    return { entities: {}, edges: [] };
  }
}

/**
 * Save (upsert) graph into SQLite. Accepts the same { entities, edges }
 * shape produced by loadGraph / mergeIntoGraph.
 */
export function saveGraph(graph) {
  try {
    initDB();
    const now = new Date().toISOString();
    let sql = "";

    // Upsert entities
    for (const [name, ent] of Object.entries(graph.entities)) {
      const id = name.toLowerCase();
      const type = ent.type || "entity";
      const mentions = ent.mentions || 1;
      sql += `INSERT INTO entities (id, name, type, mentions, recorded_at, updated_at) VALUES (${sqlEscape(id)}, ${sqlEscape(ent.name || name)}, ${sqlEscape(type)}, ${mentions}, ${sqlEscape(now)}, ${sqlEscape(now)}) ON CONFLICT(id) DO UPDATE SET mentions = ${mentions}, type = COALESCE(${sqlEscape(type)}, type), updated_at = ${sqlEscape(now)};\n`;
    }

    // Upsert edges (no 500-edge hard cap)
    for (const edge of graph.edges) {
      const id = `${edge.from}|||${edge.to}`;
      const type = edge.type || "RELATES";
      const ts = edge.timestamp || now;
      sql += `INSERT OR IGNORE INTO edges (id, from_id, to_id, type, context, recorded_at) VALUES (${sqlEscape(id)}, ${sqlEscape(edge.from)}, ${sqlEscape(edge.to)}, ${sqlEscape(type)}, ${sqlEscape((edge.context || "").slice(0, 500))}, ${sqlEscape(ts)});\n`;
    }

    if (sql) {
      execSync(`sqlite3 "${GRAPH_DB}" "${sql.replace(/"/g, '\\"')}"`, { timeout: 10000 });
    }

    // Rebuild FTS index
    rebuildFTS(graph);

    invalidateGraphCache();
  } catch { /* best-effort save */ }
}

function rebuildFTS(graph) {
  try {
    let sql = "DELETE FROM entities_fts;\n";
    for (const [name, ent] of Object.entries(graph.entities)) {
      const id = name.toLowerCase();
      sql += `INSERT OR IGNORE INTO entities_fts (rowid, name, type) SELECT rowid, name, type FROM entities WHERE id = ${sqlEscape(id)};\n`;
    }
    execSync(`sqlite3 "${GRAPH_DB}" "${sql.replace(/"/g, '\\"')}"`, { timeout: 10000 });
  } catch { /* FTS rebuild is best-effort */ }
}

// ─── mergeIntoGraph (unchanged logic, no 500-edge cap) ──────────

export function mergeIntoGraph(graph, extracted) {
  for (const [name, entity] of extracted.entities) {
    if (graph.entities[name]) {
      graph.entities[name].mentions = (graph.entities[name].mentions || 1) + (entity.mentions || 1);
      if (!graph.entities[name].type && entity.type) {
        graph.entities[name].type = entity.type;
      }
    } else {
      graph.entities[name] = { ...entity };
    }
  }

  const existingEdgeKeys = new Set(
    graph.edges.map(e => `${e.from}|||${e.to}`)
  );

  for (const edge of extracted.edges) {
    const key = `${edge.from}|||${edge.to}`;
    if (!existingEdgeKeys.has(key)) {
      graph.edges.push({
        ...edge,
        type: edge.type || "RELATES",
        timestamp: edge.timestamp || new Date().toISOString(),
      });
      existingEdgeKeys.add(key);
    }
  }

  // No 500-edge hard cap — SQLite handles large datasets fine.

  invalidateGraphCache();
}

// ─── queryGraph (unchanged) ─────────────────────────────────────

export function queryGraph(graph, query, maxResults = 10) {
  const entityNames = Object.keys(graph.entities);
  if (entityNames.length === 0) return [];

  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return [];

  const scored = [];

  for (const name of entityNames) {
    const entity = graph.entities[name];
    const nameLower = name.toLowerCase();
    const matchCount = words.filter(w => nameLower.includes(w)).length;
    if (matchCount === 0) continue;

    const relatedEdges = graph.edges.filter(
      e => e.from === name || e.to === name
    );

    let content = `[Entity] ${name} (${entity.type || "unknown"}, mentions: ${entity.mentions || 1})`;
    if (relatedEdges.length > 0) {
      const edgeDescriptions = relatedEdges.slice(0, 5).map(e => {
        const edgeType = e.type || "RELATES";
        return e.from === name ? `${name} -[${edgeType}]-> ${e.to}` : `${e.from} -[${edgeType}]-> ${name}`;
      });
      content += `\nRelationships: ${edgeDescriptions.join(", ")}`;
    }

    scored.push({
      content,
      source: "knowledge-graph",
      relevance: Math.min(1, 0.4 + matchCount * 0.15 + (entity.mentions || 1) * 0.05),
      engine: "graph",
    });
  }

  return scored
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxResults);
}

// ─── Cache invalidation ─────────────────────────────────────────

/**
 * Invalidate both store-level and algorithms-level caches.
 * Call after any graph mutation (merge, save, edge add).
 */
export function invalidateGraphCache() {
  invalidateAlgorithmsCache();
}
