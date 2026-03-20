/**
 * OpenClaw Memory Stack — v2 Plugin
 *
 * Three competitive advantages over native memory:
 *
 * 1. LOCAL SEMANTIC SEARCH (no API keys, no cost)
 *    QMD hybrid search (BM25 + local vector) alongside native SQLite FTS5.
 *    memory-lancedb needs OpenAI API key → we run 100% offline.
 *
 * 2. MEMORY QUALITY MANAGEMENT
 *    Detect duplicates, stale entries, and noise.
 *    memory_health tool shows memory quality score.
 *    Auto-consolidation merges similar memories.
 *
 * 3. COMPACTION RESCUE
 *    Before each turn, extract key facts from conversation.
 *    Store them persistently so compaction can't erase them.
 *    After compaction, auto-recall injects them back.
 *    "Conversations can be any length — nothing gets lost."
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const MEMORY_DB = resolve(HOME, ".openclaw/memory/main.sqlite");
const WORKSPACE = resolve(HOME, ".openclaw/workspace");
const INSTALL_ROOT = resolve(HOME, ".openclaw/memory-stack");
const RESCUE_DIR = resolve(HOME, ".openclaw/memory-stack/rescue");
const GRAPH_PATH = resolve(HOME, ".openclaw/memory-stack/graph.json");
const QMD_BIN = (() => {
  // Find qmd binary
  const paths = [
    resolve(HOME, ".bun/bin/qmd"),
    resolve(HOME, ".openclaw/memory-stack/node_modules/.bin/qmd"),
  ];
  for (const p of paths) { if (existsSync(p)) return p; }
  // Try PATH
  try { execSync("command -v qmd", { encoding: "utf-8" }); return "qmd"; } catch { return null; }
})();

// ─── Direction 1: Search engines ─────────────────────────────────

function searchNativeFTS5(query, maxResults) {
  if (!existsSync(MEMORY_DB)) return [];
  const safeQuery = query.replace(/'/g, "''").replace(/"/g, '""');
  try {
    const sql = `SELECT c.text, c.path, bm25(chunks_fts) as rank FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid WHERE chunks_fts MATCH '${safeQuery}' ORDER BY rank LIMIT ${maxResults};`;
    const result = execSync(`sqlite3 -json "${MEMORY_DB}" "${sql}"`, { encoding: "utf-8", timeout: 5000 });
    return JSON.parse(result || "[]").map(r => ({
      content: r.text || "", source: r.path || "memory-sqlite",
      relevance: Math.min(1, Math.abs(r.rank || 0) / 10), engine: "fts5",
    }));
  } catch {
    try {
      const likeSql = `SELECT text, path FROM chunks WHERE text LIKE '%${safeQuery}%' LIMIT ${maxResults};`;
      const result = execSync(`sqlite3 -json "${MEMORY_DB}" "${likeSql}"`, { encoding: "utf-8", timeout: 5000 });
      return JSON.parse(result || "[]").map(r => ({
        content: r.text || "", source: r.path || "memory-sqlite", relevance: 0.3, engine: "like",
      }));
    } catch { return []; }
  }
}

function searchQMD(query, maxResults, mode) {
  if (!QMD_BIN) return [];
  const searchMode = mode || "hybrid";
  const cmd = searchMode === "hybrid"
    ? `"${QMD_BIN}" query "${query.replace(/"/g, '\\"')}" --limit ${maxResults} --json 2>/dev/null`
    : `"${QMD_BIN}" search "${query.replace(/"/g, '\\"')}" --limit ${maxResults} --json 2>/dev/null`;
  try {
    const result = execSync(cmd, { encoding: "utf-8", timeout: 8000 });
    const data = JSON.parse(result || "{}");
    const hits = data.results || data.hits || [];
    return hits.map(h => ({
      content: h.text || h.content || h.snippet || "",
      source: h.path || h.file || "qmd",
      relevance: h.score || h.relevance || 0.5,
      engine: "qmd-" + searchMode,
    }));
  } catch { return []; }
}

function searchMemoryMd(query, maxResults) {
  const results = [];
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const memoryMdPath = resolve(WORKSPACE, "MEMORY.md");
  if (!existsSync(memoryMdPath)) return results;
  try {
    const lines = readFileSync(memoryMdPath, "utf-8").split("\n").filter(l => l.trim() && !l.startsWith("#"));
    for (const line of lines) {
      const lower = line.toLowerCase();
      const matchCount = words.filter(w => lower.includes(w)).length;
      if (matchCount > 0) {
        results.push({
          content: line.trim(), source: "MEMORY.md",
          relevance: Math.min(1, matchCount / Math.max(words.length, 1)),
          engine: "memorymd",
        });
      }
      if (results.length >= maxResults) break;
    }
  } catch { /* ignore */ }
  return results;
}

function searchRescueStore(query, maxResults) {
  if (!existsSync(RESCUE_DIR)) return [];
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const results = [];
  try {
    const files = execSync(`ls -t "${RESCUE_DIR}"/*.json 2>/dev/null`, { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean).slice(0, 20);
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(file, "utf-8"));
        const facts = data.facts || [];
        for (const fact of facts) {
          const lower = (fact.text || "").toLowerCase();
          const matchCount = words.filter(w => lower.includes(w)).length;
          if (matchCount > 0) {
            results.push({
              content: fact.text, source: "rescue:" + fact.category,
              relevance: Math.min(1, 0.6 + matchCount * 0.1),
              engine: "rescue",
            });
          }
          if (results.length >= maxResults) break;
        }
      } catch { /* skip bad files */ }
      if (results.length >= maxResults) break;
    }
  } catch { /* no rescue files */ }
  return results;
}

function combinedSearch(query, maxResults, maxTokens, searchMode) {
  // Run all engines in parallel-ish (sync but fast)
  const fts5 = searchNativeFTS5(query, maxResults);
  const qmd = searchQMD(query, maxResults, searchMode);
  const md = searchMemoryMd(query, maxResults);
  const rescue = searchRescueStore(query, maxResults);

  const sessions = searchSessions(query, maxResults);
  const graphResults = queryGraph(query, maxResults);

  // Merge, sort by relevance, dedupe
  const all = [...rescue, ...graphResults, ...sessions, ...qmd, ...fts5, ...md]
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

  const seen = new Set();
  const deduped = [];
  for (const r of all) {
    const key = (r.content || "").slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
    if (deduped.length >= maxResults) break;
  }

  // Post-processing: temporal decay → re-sort → MMR
  applyTemporalDecay(deduped, combinedSearch._halfLifeDays);
  deduped.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
  const reranked = applyMMR(deduped, combinedSearch._mmrLambda, maxResults);

  // Token budget
  const charBudget = maxTokens * 4;
  const selected = [];
  let used = 0;
  for (const r of reranked) {
    if (used + (r.content || "").length > charBudget) break;
    selected.push(r);
    used += (r.content || "").length;
  }
  return selected;
}

// ─── Post-processing: MMR reranking + temporal decay ─────────────

function applyMMR(results, lambda = 0.7, maxResults = results.length) {
  if (results.length <= 1) return results.slice(0, maxResults);

  // Build word sets for Jaccard similarity
  const wordSets = results.map(r =>
    new Set((r.content || "").toLowerCase().split(/\W+/).filter(w => w.length > 2))
  );

  function jaccard(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    for (const w of setA) { if (setB.has(w)) intersection++; }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  // Greedy selection: start with highest-relevance result
  const selected = [0];
  const remaining = new Set(results.map((_, i) => i));
  remaining.delete(0);

  while (selected.length < maxResults && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const i of remaining) {
      const relevance = results[i].relevance || 0;
      // Max similarity to any already-selected result
      let maxSim = 0;
      for (const j of selected) {
        const sim = jaccard(wordSets[i], wordSets[j]);
        if (sim > maxSim) maxSim = sim;
      }
      const score = lambda * relevance - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }

  return selected.map(i => results[i]);
}

function applyTemporalDecay(results, halfLifeDays = 30) {
  const now = Date.now();
  const datePattern = /(\d{4})-(\d{2})-(\d{2})/;

  for (const r of results) {
    // Evergreen sources are exempt
    if (r.source === "MEMORY.md" || (r.source || "").startsWith("rescue:")) continue;

    const match = (r.source || "").match(datePattern);
    if (!match) continue;

    const docDate = new Date(match[0]).getTime();
    if (isNaN(docDate)) continue;

    const ageDays = (now - docDate) / 86400000;
    if (ageDays <= 0) continue;

    // Exponential decay: score * 2^(-age/halfLife), floored at 20%
    const decayFactor = Math.max(0.2, Math.pow(2, -ageDays / halfLifeDays));
    r.relevance = (r.relevance || 0) * decayFactor;
  }

  return results;
}

// ─── Direction 2: Memory quality ─────────────────────────────────

function analyzeMemoryHealth() {
  const issues = { duplicates: [], stale: [], noise: [], total: 0, score: 100 };

  if (!existsSync(resolve(WORKSPACE, "MEMORY.md"))) return issues;

  try {
    const content = readFileSync(resolve(WORKSPACE, "MEMORY.md"), "utf-8");
    const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    issues.total = lines.length;

    // Detect duplicates (similar content)
    const normalized = lines.map(l => l.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, " ").trim());
    for (let i = 0; i < normalized.length; i++) {
      for (let j = i + 1; j < normalized.length; j++) {
        if (normalized[i] === normalized[j] || (normalized[i].length > 20 && normalized[j].includes(normalized[i].slice(0, 20)))) {
          issues.duplicates.push({ line1: i + 1, line2: j + 1, text: lines[j].trim() });
        }
      }
    }

    // Detect stale entries (past dates, "today", "tomorrow", "this week")
    const now = new Date();
    const datePattern = /(\d{1,2})[\/\-](\d{1,2})|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b.*\d{1,2}/i;
    const relativePattern = /\b(today|tomorrow|this week|this friday|this monday|yesterday|last week)\b/i;
    for (let i = 0; i < lines.length; i++) {
      if (relativePattern.test(lines[i])) {
        issues.stale.push({ line: i + 1, text: lines[i].trim(), reason: "relative date reference" });
      }
    }

    // Detect noise (very short entries, just punctuation, etc.)
    for (let i = 0; i < lines.length; i++) {
      const clean = lines[i].replace(/^[-*•]\s*/, "").trim();
      if (clean.length < 10 && clean.length > 0) {
        issues.noise.push({ line: i + 1, text: lines[i].trim(), reason: "too short to be useful" });
      }
    }

    // Calculate score (100 = perfect, deduct for issues)
    issues.score = Math.max(0, 100
      - issues.duplicates.length * 10
      - issues.stale.length * 5
      - issues.noise.length * 3);
  } catch { /* ignore */ }

  return issues;
}

// ─── Direction 3: Compaction rescue ──────────────────────────────

function extractKeyFacts(text) {
  // Extract structured facts from conversation text without LLM
  // Uses pattern matching for decisions, deadlines, names, numbers
  const facts = [];
  const lines = text.split("\n").filter(l => l.trim());

  for (const line of lines) {
    const lower = line.toLowerCase();

    // Decisions
    if (/\b(decided|agreed|confirmed|chose|selected|approved)\b/i.test(line)) {
      facts.push({ text: line.trim(), category: "decision", weight: 0.9 });
    }
    // Deadlines
    else if (/\b(deadline|due|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d)/i.test(line)) {
      facts.push({ text: line.trim(), category: "deadline", weight: 0.95 });
    }
    // Requirements / specs
    else if (/\b(must|shall|require|need to|should|important)\b/i.test(line) && line.length > 30) {
      facts.push({ text: line.trim(), category: "requirement", weight: 0.7 });
    }
    // Names / entities
    else if (/\b(project|client|team|api|endpoint|database|service)\s+[A-Z]/i.test(line)) {
      facts.push({ text: line.trim(), category: "entity", weight: 0.6 });
    }
  }

  // Dedupe and keep top facts
  const seen = new Set();
  return facts.filter(f => {
    const key = f.text.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.weight - a.weight).slice(0, 20);
}

function saveRescueFacts(facts, sessionKey) {
  if (facts.length === 0) return;
  mkdirSync(RESCUE_DIR, { recursive: true });
  const filename = `${Date.now()}-${(sessionKey || "default").replace(/[^a-z0-9]/gi, "_").slice(0, 30)}.json`;
  const filepath = resolve(RESCUE_DIR, filename);
  writeFileSync(filepath, JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionKey: sessionKey || "unknown",
    factCount: facts.length,
    facts,
  }, null, 2));
}

function cleanupOldRescueFiles(maxAgeDays) {
  if (!existsSync(RESCUE_DIR)) return;
  const cutoff = Date.now() - maxAgeDays * 86400000;
  try {
    const files = execSync(`ls "${RESCUE_DIR}"/*.json 2>/dev/null`, { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean);
    for (const file of files) {
      const ts = parseInt(file.split("/").pop().split("-")[0], 10);
      if (ts && ts < cutoff) {
        try { execSync(`rm "${file}"`); } catch { /* ignore */ }
      }
    }
  } catch { /* no files */ }
}

// ─── Direction 2b: Self-evolving memory (consolidation) ──────────

function consolidateMemories() {
  const memoryMdPath = resolve(WORKSPACE, "MEMORY.md");
  if (!existsSync(memoryMdPath)) return { totalMemories: 0, clusters: [], consolidatable: { count: 0, entries: [], suggestion: "No MEMORY.md found." } };

  const content = readFileSync(memoryMdPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
  const totalMemories = lines.length;

  // Build word bags (words > 3 chars)
  const wordBags = lines.map(l =>
    new Set(l.toLowerCase().split(/\W+/).filter(w => w.length > 3))
  );

  // Find clusters via Jaccard similarity > 0.4
  const parent = lines.map((_, i) => i);
  function find(i) { return parent[i] === i ? i : (parent[i] = find(parent[i])); }
  function union(a, b) { parent[find(a)] = find(b); }

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (wordBags[i].size === 0 && wordBags[j].size === 0) continue;
      let intersection = 0;
      for (const w of wordBags[i]) { if (wordBags[j].has(w)) intersection++; }
      const unionSize = wordBags[i].size + wordBags[j].size - intersection;
      const jaccard = unionSize === 0 ? 0 : intersection / unionSize;
      if (jaccard > 0.4) union(i, j);
    }
  }

  // Group clusters
  const groups = new Map();
  for (let i = 0; i < lines.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(lines[i].trim());
  }

  const clusters = [];
  for (const [, members] of groups) {
    if (members.length >= 2) {
      clusters.push(members);
    }
  }

  const consolidatable = {
    count: clusters.length,
    entries: clusters.slice(0, 3).map(c => c.slice(0, 3)),
    suggestion: clusters.length > 0
      ? `Found ${clusters.length} cluster(s) of similar memories that could be merged. Review and consolidate to reduce noise.`
      : "No similar memory clusters found — memory is well-organized.",
  };

  return { totalMemories, clusters, consolidatable };
}

// ─── Direction 5: Session indexing ───────────────────────────────

function searchSessions(query, maxResults) {
  if (!existsSync(MEMORY_DB)) return [];
  const safeQuery = query.replace(/'/g, "''").replace(/"/g, '""');
  try {
    const sql = `SELECT c.text, c.path, bm25(chunks_fts) as rank FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid WHERE chunks_fts MATCH '${safeQuery}' AND c.source = 'sessions' ORDER BY rank LIMIT ${maxResults};`;
    const result = execSync(`sqlite3 -json "${MEMORY_DB}" "${sql}"`, { encoding: "utf-8", timeout: 5000 });
    return JSON.parse(result || "[]").map(r => ({
      content: r.text || "", source: "session:" + (r.path || ""),
      relevance: Math.min(1, Math.abs(r.rank || 0) / 10), engine: "session",
    }));
  } catch { return []; }
}

// ─── Direction 4: Knowledge graph ────────────────────────────────

function loadGraph() {
  try {
    if (existsSync(GRAPH_PATH)) {
      return JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
    }
  } catch { /* corrupted file, start fresh */ }
  return { entities: {}, edges: [] };
}

function saveGraph(graph) {
  const dir = resolve(GRAPH_PATH, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2));
}

function extractEntities(text) {
  const entities = new Map();
  const edges = [];

  // Also extract standalone capitalized multi-word names (e.g. "Team Alpha", "XYZ Corp", "Project Beta")
  const standaloneNames = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  for (const name of standaloneNames) {
    if (name.length < 3 || name.length > 60) continue;
    const key = name.toLowerCase();
    if (!entities.has(key)) entities.set(key, { name, type: "entity", mentions: 0 });
    entities.get(key).mentions++;
  }

  const lines = text.split("\n").filter(l => l.trim());

  // Entity patterns: category keyword followed by a name
  const entityPatterns = [
    { pattern: /\b(project|app|service|system)\s+([A-Z][A-Za-z0-9_-]+)/g, type: "project" },
    { pattern: /\b(api|endpoint)\s+([/A-Za-z0-9._-]+)/g, type: "api" },
    { pattern: /\b(function|method|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g, type: "code" },
    { pattern: /\b(client|customer|team)\s+([A-Z][A-Za-z0-9_-]+)/g, type: "person" },
    { pattern: /\b(database|table|collection)\s+([A-Za-z_][A-Za-z0-9_-]*)/g, type: "data" },
    { pattern: /\b(file|module)\s+([A-Za-z0-9_./-]+)/g, type: "file" },
  ];

  for (const line of lines) {
    for (const { pattern, type } of entityPatterns) {
      // Reset regex lastIndex for each line
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

    // Relationship patterns
    const relPatterns = [
      /([A-Za-z_][A-Za-z0-9_-]*)\s+(?:uses|calls|imports|requires|depends on|connects to)\s+([A-Za-z_][A-Za-z0-9_-]*)/gi,
      /([A-Za-z_][A-Za-z0-9_-]*)\s*(?:→|->|=>)\s*([A-Za-z_][A-Za-z0-9_-]*)/g,
    ];

    for (const rp of relPatterns) {
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

  return { entities, edges };
}

function mergeIntoGraph(graph, extracted) {
  // Merge entities
  for (const [name, entity] of extracted.entities) {
    if (graph.entities[name]) {
      graph.entities[name].mentions = (graph.entities[name].mentions || 1) + (entity.mentions || 1);
      // Keep the more specific type if available
      if (!graph.entities[name].type && entity.type) {
        graph.entities[name].type = entity.type;
      }
    } else {
      graph.entities[name] = { ...entity };
    }
  }

  // Merge edges, deduplicating by from+to
  const existingEdgeKeys = new Set(
    graph.edges.map(e => `${e.from}|||${e.to}`)
  );

  for (const edge of extracted.edges) {
    const key = `${edge.from}|||${edge.to}`;
    if (!existingEdgeKeys.has(key)) {
      graph.edges.push(edge);
      existingEdgeKeys.add(key);
    }
  }

  // Cap edges at 500 (keep most recent)
  if (graph.edges.length > 500) {
    graph.edges = graph.edges.slice(-500);
  }
}

function queryGraph(query, maxResults) {
  const graph = loadGraph();
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

    // Gather related edges
    const relatedEdges = graph.edges.filter(
      e => e.from === name || e.to === name
    );

    let content = `[Entity] ${name} (${entity.type || "unknown"}, mentions: ${entity.mentions || 1})`;
    if (relatedEdges.length > 0) {
      const edgeDescriptions = relatedEdges.slice(0, 5).map(e =>
        e.from === name ? `${name} → ${e.to}` : `${e.from} → ${name}`
      );
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

/**
 * Background update check — fire-and-forget, never blocks startup.
 * Checks at most once every 24 hours. Silent on any error.
 */
function checkForUpdates(api) {
  (async () => {
    try {
      const stateDir = resolve(HOME, ".openclaw/memory-stack");
      const statePath = resolve(stateDir, "update-state.json");

      // Throttle: 24hr
      let state = {};
      try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
      if (Date.now() - (state.last_check || 0) < 86_400_000) return;

      // Read local version + license
      const versionFile = resolve(stateDir, "version.json");
      const licenseFile = resolve(HOME, ".openclaw/state/license.json");
      if (!existsSync(versionFile) || !existsSync(licenseFile)) return;

      const version = JSON.parse(readFileSync(versionFile, "utf8"));
      const license = JSON.parse(readFileSync(licenseFile, "utf8"));

      // Check update (5s timeout)
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `https://api.openclaw.apptah.com/api/check-update?key=${encodeURIComponent(license.key)}&current=${encodeURIComponent(version.version)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);

      if (!res.ok) {
        // Update last_check even on error to avoid hammering
        const tmp = statePath + ".tmp";
        writeFileSync(tmp, JSON.stringify({ last_check: Date.now(), latest: null }));
        renameSync(tmp, statePath);
        return;
      }

      const data = await res.json();

      // Atomic write update-state.json
      const newState = { last_check: Date.now(), latest: data.latest || null };
      const tmp = statePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(newState));
      renameSync(tmp, statePath);

      // Notify if update available
      if (data.update_available) {
        api.logger.info(
          `\u{1F504} Memory Stack v${data.latest} available (you have v${version.version})\n` +
          `   Run: ~/.openclaw/memory-stack/install.sh --upgrade`
        );
      }
    } catch {
      // Silent — never block normal startup
    }
  })();
}

// ─── Plugin registration ─────────────────────────────────────────

export default {
  id: "openclaw-memory-stack",
  name: "OpenClaw Memory Stack",
  description: "Local semantic search + memory quality management + compaction rescue. No API keys needed.",
  kind: "memory",

  register(api) {
    const cfg = api.pluginConfig || {};
    const autoRecall = cfg.autoRecall !== false;
    const maxResults = cfg.maxRecallResults || 5;
    const maxTokens = cfg.maxRecallTokens || 1500;
    const searchMode = cfg.searchMode || "hybrid";
    const mmrLambda = cfg.mmrLambda ?? 0.7;
    const halfLifeDays = cfg.halfLifeDays ?? 30;

    // Expose config to combinedSearch via function properties
    combinedSearch._mmrLambda = mmrLambda;
    combinedSearch._halfLifeDays = halfLifeDays;

    const hasQMD = !!QMD_BIN;
    const hasDB = existsSync(MEMORY_DB);

    api.logger.info(`Memory Stack v2 initializing (qmd=${hasQMD}, db=${hasDB}, recall=${autoRecall})`);

    // Cleanup old rescue files (> 30 days)
    cleanupOldRescueFiles(30);

    // Background update check (fire-and-forget, no await)
    checkForUpdates(api);

    // ─── Tools: memory_search + memory_health (factory pattern) ──
    // Uses memory-core's pattern: single registerTool with factory returning array

    api.registerTool(
      () => {
        const memorySearchTool = {
          name: "memory_search",
          label: "Memory Search",
          description: "Search memories using local BM25 + semantic search. Searches conversation history, saved memories, and rescued facts. Use query 'health' to check memory quality (duplicates, stale entries, noise). No API keys needed.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "What to search for" },
            },
            required: ["query"],
          },
          async execute(_toolCallId, params) {
            // Special command: "health" or "health check" runs memory quality analysis
            if (/^health\b/i.test(params.query)) {
              const health = analyzeMemoryHealth();
              let report = `Memory Health Score: ${health.score}/100\nTotal entries: ${health.total}\n\n`;
              if (health.duplicates.length > 0) {
                report += `Duplicates (${health.duplicates.length}):\n`;
                health.duplicates.forEach(d => { report += `  - Line ${d.line2}: "${d.text.slice(0, 60)}"\n`; });
                report += "\n";
              }
              if (health.stale.length > 0) {
                report += `Stale entries (${health.stale.length}):\n`;
                health.stale.forEach(s => { report += `  - Line ${s.line}: "${s.text.slice(0, 60)}" (${s.reason})\n`; });
                report += "\n";
              }
              if (health.noise.length > 0) {
                report += `Noise (${health.noise.length}):\n`;
                health.noise.forEach(n => { report += `  - Line ${n.line}: "${n.text}" (${n.reason})\n`; });
                report += "\n";
              }
              if (health.score === 100) report += "All clear — memory is clean.";
              else report += "Consider cleaning up the issues above.";
              return { content: [{ type: "text", text: report }] };
            }

            // Special command: "graph" shows knowledge graph summary
            if (/^graph\b/i.test(params.query)) {
              const graph = loadGraph();
              const entityNames = Object.keys(graph.entities);
              const edgeCount = graph.edges.length;
              let report = `Knowledge Graph Summary\nEntities: ${entityNames.length}\nEdges: ${edgeCount}\n`;
              if (entityNames.length > 0) {
                const sorted = entityNames
                  .map(n => ({ name: n, ...graph.entities[n] }))
                  .sort((a, b) => (b.mentions || 1) - (a.mentions || 1))
                  .slice(0, 15);
                report += `\nTop entities:\n`;
                sorted.forEach((e, i) => {
                  report += `  ${i + 1}. ${e.name} (${e.type || "unknown"}, ${e.mentions || 1} mentions)\n`;
                });
              } else {
                report += "\nNo entities tracked yet. Entities are extracted automatically from conversations.";
              }
              return { content: [{ type: "text", text: report }] };
            }

            // Special command: "consolidate" runs self-evolving memory analysis
            if (/^consolidate\b/i.test(params.query)) {
              const result = consolidateMemories();
              let report = `Memory Consolidation Report\nTotal memories: ${result.totalMemories}\nClusters found: ${result.consolidatable.count}\n\n`;
              if (result.consolidatable.count > 0) {
                report += `Similar memory clusters (showing first 3):\n`;
                result.consolidatable.entries.forEach((cluster, i) => {
                  report += `\nCluster ${i + 1}:\n`;
                  cluster.forEach(entry => { report += `  - "${entry.slice(0, 80)}"\n`; });
                });
                report += "\n";
              }
              report += result.consolidatable.suggestion;
              return { content: [{ type: "text", text: report }] };
            }

            const results = combinedSearch(params.query, maxResults, maxTokens, searchMode);
            if (results.length === 0) {
              return { content: [{ type: "text", text: "No relevant memories found." }] };
            }
            const engines = [...new Set(results.map(r => r.engine))];
            const text = results
              .map((r, i) => `[${i + 1}] (${r.source}, score: ${(r.relevance || 0).toFixed(2)})\n${r.content}`)
              .join("\n---\n");
            return { content: [{ type: "text", text: text + `\n\n(engines: ${engines.join(", ")})` }] };
          },
        };

        return [memorySearchTool];
      },
      { names: ["memory_search"] },
    );

    // ─── Auto-recall + compaction rescue (Directions 1 & 3) ────

    if (autoRecall) {
      api.on("before_agent_start", async (event) => {
        // Extract last user message from event
        let query = event.lastUserMessage || event.summary || "";
        if (!query && Array.isArray(event.messages)) {
          // Find last user message
          for (let i = event.messages.length - 1; i >= 0; i--) {
            const msg = event.messages[i];
            if (msg.role === "user") {
              query = typeof msg.content === "string" ? msg.content : (msg.content?.[0]?.text || "");
              break;
            }
          }
        }
        if (!query || query.length < 5) return {};

        const results = combinedSearch(query, maxResults, maxTokens, searchMode);
        if (results.length === 0) return {};

        const memoryText = results.map(r => `[${r.source}] ${r.content}`).join("\n");
        return {
          prependContext: `<memory-stack>\n${memoryText}\n</memory-stack>`,
        };
      });
    }

    // ─── Compaction rescue: save key facts after each turn ─────

    api.on("agent_end", async (event) => {
      // Extract text from event.messages (array of message objects)
      let content = "";
      if (Array.isArray(event.messages)) {
        for (const msg of event.messages) {
          if (msg.role === "assistant" && typeof msg.content === "string") {
            content += msg.content + "\n";
          } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text" && part.text) content += part.text + "\n";
            }
          }
        }
      }
      if (!content) content = event.turnSummary || event.agentResponse || "";
      if (content.length < 20) return;

      // Extract key facts from this turn
      const facts = extractKeyFacts(content);
      if (facts.length > 0) {
        saveRescueFacts(facts, event.sessionKey);
      }

      // Extract entities and merge into knowledge graph
      const extracted = extractEntities(content);
      if (extracted.entities.size > 0 || extracted.edges.length > 0) {
        const graph = loadGraph();
        mergeIntoGraph(graph, extracted);
        saveGraph(graph);
      }
    });

    api.logger.info(`Memory Stack v2 registered (engines: fts5${hasQMD ? "+qmd" : ""}+memorymd+rescue+graph, health=on, rescue=on, graph=on)`);
  },
};
