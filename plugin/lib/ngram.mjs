/**
 * ngram.mjs — N-gram indexing for fast regex candidate filtering
 *
 * Phase 1: Trigram (3-char) posting lists in SQLite
 * Phase 2: Frequency-weighted query pruning (select rarest trigrams)
 */

import { execSync } from "node:child_process";

// =============================================================================
// Trigram Extraction
// =============================================================================

/**
 * Extract all unique trigrams from text (lowercased).
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractTrigrams(text) {
  const lower = text.toLowerCase();
  const trigrams = new Set();
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.add(lower.slice(i, i + 3));
  }
  return trigrams;
}

// =============================================================================
// Regex Decomposition into AND/OR Query Tree
// =============================================================================

/**
 * @typedef {Object} QueryNode
 * @property {"AND"|"OR"|"SCAN"} type
 * @property {string[]} [literals] - (AND only) literal strings extracted
 * @property {QueryNode[]} [children] - (AND/OR) child nodes
 */

/**
 * Decompose a regex pattern into a query tree for trigram prefiltering.
 * @param {string} pattern
 * @returns {QueryNode}
 */
export function decomposeRegex(pattern) {
  const branches = splitTopLevelAlternation(pattern);
  if (branches.length > 1) {
    const children = branches.map(b => decomposeRegexBranch(b));
    if (children.some(c => c.type === "SCAN")) return { type: "SCAN" };
    return { type: "OR", children };
  }
  return decomposeRegexBranch(pattern);
}

function splitTopLevelAlternation(pattern) {
  const branches = [];
  let current = "";
  let parenDepth = 0;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") { current += ch + (pattern[i + 1] || ""); i++; continue; }
    if (ch === "[") {
      current += ch; i++;
      while (i < pattern.length && pattern[i] !== "]") { current += pattern[i]; i++; }
      if (i < pattern.length) current += "]";
      continue;
    }
    if (ch === "(") { parenDepth++; current += ch; continue; }
    if (ch === ")") { parenDepth--; current += ch; continue; }
    if (ch === "|" && parenDepth === 0) {
      branches.push(current); current = ""; continue;
    }
    current += ch;
  }
  branches.push(current);
  return branches;
}

function isZeroMinQuantifier(str, pos) {
  if (pos >= str.length) return false;
  const ch = str[pos];
  if (ch === "?" || ch === "*") return true;
  if (ch === "{") {
    let j = pos + 1;
    let numStr = "";
    while (j < str.length && /\d/.test(str[j])) { numStr += str[j]; j++; }
    if (numStr.length > 0 && parseInt(numStr, 10) === 0) return true;
  }
  return false;
}

function consumeQuantifier(str, pos) {
  if (pos >= str.length) return pos - 1;
  const ch = str[pos];
  if (ch === "?" || ch === "*" || ch === "+") return pos;
  if (ch === "{") {
    let j = pos + 1;
    while (j < str.length && str[j] !== "}") j++;
    return j;
  }
  return pos - 1;
}

function decomposeRegexBranch(branch) {
  const literals = [];
  const children = [];
  let current = "";

  for (let i = 0; i < branch.length; i++) {
    const ch = branch[i];

    // Escape sequence
    if (ch === "\\" && i + 1 < branch.length) {
      const next = branch[i + 1];
      if (!/[dwsDWSbB]/.test(next)) {
        current += next;
      } else {
        if (current.length >= 3) literals.push(current);
        current = "";
      }
      i++;
      continue;
    }

    // Character class
    if (ch === "[") {
      if (current.length >= 3) literals.push(current);
      current = "";
      while (i < branch.length && branch[i] !== "]") i++;
      continue;
    }

    // Group
    if (ch === "(") {
      if (current.length >= 3) literals.push(current);
      current = "";

      let depth = 1;
      let groupContent = "";
      i++;
      while (i < branch.length && depth > 0) {
        if (branch[i] === "\\") { groupContent += branch[i] + (branch[i + 1] || ""); i += 2; continue; }
        if (branch[i] === "(") depth++;
        if (branch[i] === ")") { depth--; if (depth === 0) break; }
        groupContent += branch[i];
        i++;
      }

      const isOptional = isZeroMinQuantifier(branch, i + 1);
      const groupNode = decomposeRegex(groupContent);

      if (isOptional) {
        i = consumeQuantifier(branch, i + 1);
      } else if (groupNode.type !== "SCAN") {
        children.push(groupNode);
      }
      continue;
    }

    // Quantifiers that make preceding element optional
    if (ch === "?" || ch === "*") {
      if (current.length > 0) current = current.slice(0, -1);
      if (current.length >= 3) literals.push(current);
      current = "";
      continue;
    }

    // Bounded quantifier {n,m}
    if (ch === "{") {
      let braceContent = "";
      i++;
      while (i < branch.length && branch[i] !== "}") { braceContent += branch[i]; i++; }
      const minMatch = braceContent.match(/^(\d+)/);
      const minVal = minMatch ? parseInt(minMatch[1], 10) : 1;
      if (minVal === 0) {
        if (current.length > 0) current = current.slice(0, -1);
      }
      if (current.length >= 3) literals.push(current);
      current = "";
      continue;
    }

    // Wildcards
    if (ch === "." || ch === "+" || ch === "^" || ch === "$") {
      if (current.length >= 3) literals.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.length >= 3) literals.push(current);

  if (literals.length === 0 && children.length === 0) {
    return { type: "SCAN" };
  }

  return { type: "AND", literals, children };
}

// =============================================================================
// Trigram Index: Build & Query (SQLite-backed)
// =============================================================================

/**
 * Ensure trigram tables exist in the DB.
 * @param {string} dbPath
 */
export function ensureTrigramSchema(dbPath) {
  const sql = `CREATE TABLE IF NOT EXISTS trigrams (trigram TEXT NOT NULL, chunk_id TEXT NOT NULL, PRIMARY KEY (trigram, chunk_id)); CREATE INDEX IF NOT EXISTS idx_trigrams_trigram ON trigrams(trigram); CREATE TABLE IF NOT EXISTS trigram_meta (chunk_id TEXT PRIMARY KEY, indexed_hash TEXT NOT NULL);`;
  execSync(`sqlite3 "${dbPath}" "${sql}"`, { encoding: "utf-8", timeout: 5000 });
}

/**
 * Index a single chunk's trigrams.
 * @param {string} dbPath
 * @param {string} chunkId
 * @param {string} text
 * @param {string} hash
 */
export function indexChunkTrigrams(dbPath, chunkId, text, hash) {
  // Check if already indexed with same hash
  try {
    const checkSql = `SELECT indexed_hash FROM trigram_meta WHERE chunk_id = '${chunkId}'`;
    const existing = execSync(`sqlite3 -json "${dbPath}" "${checkSql}"`, { encoding: "utf-8", timeout: 3000 });
    const rows = JSON.parse(existing || "[]");
    if (rows.length > 0 && rows[0].indexed_hash === hash) return; // Already up to date
  } catch { /* table may not exist yet */ }

  const trigrams = extractTrigrams(text);

  // Always delete old entries first (handles shrunk/empty text clearing stale postings)
  const deleteSql = `DELETE FROM trigrams WHERE chunk_id = '${chunkId}'; DELETE FROM trigram_meta WHERE chunk_id = '${chunkId}';`;

  if (trigrams.size === 0) {
    // No trigrams — just clear old postings and record the hash so we don't revisit
    const metaSql = `INSERT OR REPLACE INTO trigram_meta (chunk_id, indexed_hash) VALUES ('${chunkId}','${hash}');`;
    execSync(`sqlite3 "${dbPath}" "${deleteSql} ${metaSql}"`, { encoding: "utf-8", timeout: 10000 });
    return;
  }

  // Insert new trigrams + meta
  const insertValues = [...trigrams].map(t =>
    `('${t.replace(/'/g, "''")}','${chunkId}')`
  ).join(",");
  const insertSql = `INSERT OR IGNORE INTO trigrams (trigram, chunk_id) VALUES ${insertValues}; INSERT OR REPLACE INTO trigram_meta (chunk_id, indexed_hash) VALUES ('${chunkId}','${hash}');`;

  execSync(`sqlite3 "${dbPath}" "${deleteSql} ${insertSql}"`, { encoding: "utf-8", timeout: 10000 });
}

/**
 * Build/refresh trigram index for all chunks.
 * @param {string} dbPath
 */
export function rebuildTrigramIndex(dbPath) {
  ensureTrigramSchema(dbPath);

  const rowsSql = `SELECT id, hash, text FROM chunks ORDER BY updated_at DESC`;
  let rows;
  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${rowsSql}"`, { encoding: "utf-8", timeout: 15000 });
    rows = JSON.parse(result || "[]");
  } catch { return; }

  for (const row of rows) {
    indexChunkTrigrams(dbPath, row.id, row.text || "", row.hash);
  }
}

/**
 * Incrementally update trigram index for changed chunks.
 * Called on every agent_end to keep index fresh.
 * Only processes chunks whose hash differs from last indexed hash.
 * @param {string} dbPath
 */
export function incrementalIndexUpdate(dbPath) {
  ensureTrigramSchema(dbPath);

  const sql = `SELECT c.id, c.hash, c.text FROM chunks c LEFT JOIN trigram_meta tm ON tm.chunk_id = c.id WHERE tm.chunk_id IS NULL OR tm.indexed_hash != c.hash LIMIT 200`;
  let rows;
  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, { encoding: "utf-8", timeout: 10000 });
    rows = JSON.parse(result || "[]");
  } catch { return; }

  if (rows.length === 0) return;

  for (const row of rows) {
    indexChunkTrigrams(dbPath, row.id, row.text || "", row.hash);
  }
}

/**
 * Query trigram index with a decomposed query tree.
 * Returns candidate chunk IDs.
 * @param {string} dbPath
 * @param {QueryNode} tree
 * @returns {Set<string>|null} null means full scan needed
 */
export function queryTrigramIndex(dbPath, tree) {
  if (tree.type === "SCAN") return null;

  if (tree.type === "AND") {
    let result = null;

    for (const literal of (tree.literals || [])) {
      const trigrams = extractTrigrams(literal.toLowerCase());
      for (const trigram of trigrams) {
        const ids = lookupTrigram(dbPath, trigram);
        if (result === null) {
          result = ids;
        } else {
          result = new Set([...result].filter(id => ids.has(id)));
        }
        if (result.size === 0) return result;
      }
    }

    for (const child of (tree.children || [])) {
      const childIds = queryTrigramIndex(dbPath, child);
      if (childIds === null) return null;
      if (result === null) {
        result = childIds;
      } else {
        result = new Set([...result].filter(id => childIds.has(id)));
      }
    }

    return result || new Set();
  }

  if (tree.type === "OR") {
    const result = new Set();
    for (const child of tree.children) {
      const childIds = queryTrigramIndex(dbPath, child);
      if (childIds === null) return null;
      for (const id of childIds) result.add(id);
    }
    return result;
  }

  return null;
}

function lookupTrigram(dbPath, trigram) {
  const safeTrigram = trigram.replace(/'/g, "''");
  try {
    const sql = `SELECT chunk_id FROM trigrams WHERE trigram = '${safeTrigram}'`;
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, { encoding: "utf-8", timeout: 3000 });
    const rows = JSON.parse(result || "[]");
    return new Set(rows.map(r => r.chunk_id));
  } catch {
    return new Set();
  }
}
