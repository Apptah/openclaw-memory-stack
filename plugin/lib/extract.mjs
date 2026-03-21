/**
 * Unified entity and fact extraction.
 *
 * Merges the overlapping pattern sets that previously lived in
 * rescue.mjs (extractEntitiesFromLine + extractKeyFacts) and
 * graph/store.mjs (extractEntities).
 *
 * Both modules now import from here so patterns stay in one place.
 */

// ─── Entity patterns ────────────────────────────────────────────

const ENTITY_PATTERNS = [
  { pattern: /\b(project|app|service|system)\s+([A-Z][A-Za-z0-9_-]+)/g, type: "project" },
  { pattern: /\b(api|endpoint)\s+([/A-Za-z0-9._-]+)/g, type: "api" },
  { pattern: /\b(function|method|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g, type: "code" },
  { pattern: /\b(client|customer|team)\s+([A-Z][A-Za-z0-9_-]+)/g, type: "person" },
  { pattern: /\b(database|table|collection)\s+([A-Za-z_][A-Za-z0-9_-]*)/g, type: "data" },
  { pattern: /\b(file|module)\s+([A-Za-z0-9_./-]+)/g, type: "file" },
];

// Relationship patterns (directional) — support multi-word entities
const RELATIONSHIP_PATTERNS = [
  /([A-Z][A-Za-z0-9_-]+(?:\s+[A-Z][A-Za-z0-9_-]+)*)\s+(?:uses|calls|imports|requires|depends on|connects to|replaces|integrates with|works with|contains|has|needs|manages|wraps)\s+([A-Z][A-Za-z0-9_-]+(?:\s+[A-Z][A-Za-z0-9_-]+)*)/gi,
  /([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\u2192|->|=>)\s*([A-Za-z_][A-Za-z0-9_-]*)/g,
];

// ─── Fact patterns ──────────────────────────────────────────────

const FACT_PATTERNS = [
  { test: /\b(decided|agreed|confirmed|chose|selected|approved)\b/i, type: "decision", confidence: 0.9 },
  { test: /\b(deadline|due|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d)/i, type: "deadline", confidence: 0.95 },
  { test: /\b(must|shall|require|need to|should|important)\b/i, type: "requirement", confidence: 0.7, minLength: 30 },
  { test: /\b(project|client|team|api|endpoint|database|service)\s+[A-Z]/i, type: "entity", confidence: 0.6 },
];

// ─── extractEntities ────────────────────────────────────────────

/**
 * Extract entities from text using regex patterns.
 * @param {string} text
 * @returns {{ entities: Map<string, {name: string, type: string, mentions: number}>, edges: Array<{from: string, to: string, context: string, type?: string}> }}
 */
export function extractEntities(text) {
  const entities = new Map();
  const edges = [];

  // Standalone capitalized multi-word names
  const standaloneNames = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  for (const name of standaloneNames) {
    if (name.length < 3 || name.length > 60) continue;
    const key = name.toLowerCase();
    if (!entities.has(key)) entities.set(key, { name, type: "entity", mentions: 0 });
    entities.get(key).mentions++;
  }

  const lines = text.split("\n").filter(l => l.trim());

  for (const line of lines) {
    // Named entity patterns
    for (const { pattern, type } of ENTITY_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const name = match[2];
        if (name.length < 2) continue;
        const existing = entities.get(name);
        if (existing) {
          existing.mentions = (existing.mentions || 1) + 1;
        } else {
          entities.set(name, { name, type, mentions: 1 });
        }
      }
    }

    // Relationship edges
    for (const rp of RELATIONSHIP_PATTERNS) {
      rp.lastIndex = 0;
      let match;
      while ((match = rp.exec(line)) !== null) {
        const from = match[1];
        const to = match[2];
        if (from.length >= 2 && to.length >= 2 && from !== to) {
          edges.push({ from, to, context: line.trim().slice(0, 120) });
        }
      }
    }
  }

  // Co-occurrence edges: two entities in the same line → RELATES
  for (const line of lines) {
    const lineEntities = [];
    for (const [key, ent] of entities) {
      if (line.includes(ent.name)) lineEntities.push(ent.name);
    }
    for (let i = 0; i < lineEntities.length; i++) {
      for (let j = i + 1; j < lineEntities.length; j++) {
        const key = `${lineEntities[i]}|||${lineEntities[j]}`;
        const reverseKey = `${lineEntities[j]}|||${lineEntities[i]}`;
        if (!edges.some(e => `${e.from}|||${e.to}` === key || `${e.from}|||${e.to}` === reverseKey)) {
          edges.push({ from: lineEntities[i], to: lineEntities[j], context: line.trim().slice(0, 120), type: "RELATES" });
        }
      }
    }
  }

  return { entities, edges };
}

// ─── extractFacts ───────────────────────────────────────────────

/**
 * Extract structured facts from text using regex patterns.
 * @param {string} text
 * @param {Object} cfg - { types?: string[] }
 * @returns {{ facts: Array<{type: string, content: string, timestamp?: string}> }}
 */
export function extractFacts(text, cfg = {}) {
  const facts = [];
  const lines = text.split("\n").filter(l => l.trim());
  const allowedTypes = cfg.types || null;

  for (const line of lines) {
    // Collect inline entity names for each line
    const lineEntities = [];
    for (const { pattern } of ENTITY_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(line)) !== null) {
        if (m[2] && m[2].length >= 2) lineEntities.push(m[2]);
      }
    }

    for (const fp of FACT_PATTERNS) {
      if (fp.minLength && line.length <= fp.minLength) continue;
      if (allowedTypes && !allowedTypes.includes(fp.type)) continue;
      if (fp.test.test(line)) {
        facts.push({
          type: fp.type,
          content: line.trim(),
          confidence: fp.confidence,
          entities: lineEntities,
        });
        break; // one fact type per line
      }
    }
  }

  // Dedupe by first 60 chars
  const seen = new Set();
  const deduped = facts.filter(f => {
    const key = f.content.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { facts: deduped.sort((a, b) => b.confidence - a.confidence).slice(0, 20) };
}

// ─── extractAll ─────────────────────────────────────────────────

/**
 * Single-pass extraction of both entities and facts.
 * @param {string} text
 * @param {Object} cfg
 * @returns {{ entities: Map<string, {name, type, mentions}>, edges: Array<{from, to, context, type?}>, facts: Array<{type, content, timestamp?}> }}
 */
export function extractAll(text, cfg = {}) {
  const { entities, edges } = extractEntities(text);
  const { facts } = extractFacts(text, cfg);
  return { entities, edges, facts };
}
