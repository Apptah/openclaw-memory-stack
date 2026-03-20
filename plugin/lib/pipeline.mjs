import { engines } from "./engines/index.mjs";
import { deduplicateResults, applyCosineDedup } from "./quality.mjs";
import { DEFAULT_CONFIG } from "./constants.mjs";

// ─── HyDE (Gap 1) ───────────────────────────────────────────────

let ollamaReachable = null;
let ollamaCheckTime = 0;

async function isOllamaReachable(endpoint) {
  const now = Date.now();
  if (ollamaReachable !== null && now - ollamaCheckTime < 60000) return ollamaReachable;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${endpoint}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    ollamaReachable = res.ok;
  } catch {
    ollamaReachable = false;
  }
  ollamaCheckTime = now;
  return ollamaReachable;
}

async function hydeExpand(query, endpoint, model) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: `Write a short paragraph that would be a good search result for: "${query}"`,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data.response || null;
  } catch {
    return null;
  }
}

// ─── RRF (Reciprocal Rank Fusion) ───────────────────────────────

export function computeRRF(engineResults, K = 60) {
  const scoreMap = new Map(); // key -> { result, totalScore }

  for (const { results, weight } of engineResults) {
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank];
      const key = (r.content || "").slice(0, 80).toLowerCase();
      const rrfScore = (weight || 1) / (K + rank + 1);

      if (scoreMap.has(key)) {
        const existing = scoreMap.get(key);
        existing.totalScore += rrfScore;
        // Keep longer content + more metadata
        if ((r.content || "").length > (existing.result.content || "").length) {
          existing.result = { ...r, relevance: existing.totalScore };
        } else {
          existing.result.relevance = existing.totalScore;
        }
      } else {
        scoreMap.set(key, { result: { ...r, relevance: rrfScore }, totalScore: rrfScore });
      }
    }
  }

  return [...scoreMap.values()]
    .map(({ result, totalScore }) => ({ ...result, relevance: totalScore }))
    .sort((a, b) => b.relevance - a.relevance);
}

// ─── Bi-temporal filter (Gap 3) ──────────────────────────────────

export function fallbackTemporalFilter(results, temporal) {
  if (!temporal || (!temporal.after && !temporal.before)) return results;

  return results.filter(r => {
    if (!r.timestamp) return true; // No timestamp = not filtered
    const ts = new Date(r.timestamp).getTime();
    if (isNaN(ts)) return true;
    if (temporal.after && ts < temporal.after.getTime()) return false;
    if (temporal.before && ts > temporal.before.getTime()) return false;
    return true;
  });
}

// ─── Temporal Decay ──────────────────────────────────────────────

function applyTemporalDecay(results, halfLifeDays = 30) {
  const now = Date.now();
  const datePattern = /(\d{4})-(\d{2})-(\d{2})/;

  for (const r of results) {
    if (r.source === "MEMORY.md" || (r.source || "").startsWith("rescue:")) continue;

    const match = (r.source || "").match(datePattern) || (r.timestamp || "").match(datePattern);
    if (!match) continue;

    const docDate = new Date(match[0]).getTime();
    if (isNaN(docDate)) continue;

    const ageDays = (now - docDate) / 86400000;
    if (ageDays <= 0) continue;

    const decayFactor = Math.max(0.2, Math.pow(2, -ageDays / halfLifeDays));
    r.relevance = (r.relevance || 0) * decayFactor;
  }

  return results;
}

// ─── MMR Reranking ───────────────────────────────────────────────

function applyMMR(results, lambda = 0.7, maxResults = results.length) {
  if (results.length <= 1) return results.slice(0, maxResults);

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

  const selected = [0];
  const remaining = new Set(results.map((_, i) => i));
  remaining.delete(0);

  while (selected.length < maxResults && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const i of remaining) {
      const relevance = results[i].relevance || 0;
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

// ─── Combined Search Pipeline ────────────────────────────────────

export async function combinedSearch(query, options = {}) {
  const cfg = options;
  const maxResults = cfg.maxResults || DEFAULT_CONFIG.maxRecallResults;
  const maxTokens = cfg.maxTokens || DEFAULT_CONFIG.maxRecallTokens;
  const searchMode = cfg.searchMode || DEFAULT_CONFIG.searchMode;
  const mmrLambda = cfg.mmrLambda ?? DEFAULT_CONFIG.mmrLambda;
  const halfLifeDays = cfg.halfLifeDays ?? DEFAULT_CONFIG.halfLifeDays;
  const hydeEnabled = cfg.hyde !== false;
  const hydeEndpoint = cfg.hydeEndpoint || DEFAULT_CONFIG.hydeEndpoint;
  const hydeModel = cfg.hydeModel || DEFAULT_CONFIG.hydeModel;

  const trajectory = {
    engines: [],
    timing: {},
    candidates: 0,
    afterRRF: 0,
    afterDedup: 0,
    afterMMR: 0,
    hydeUsed: false,
    cosineDedupUsed: false,
    tier: "L0",
  };

  // Temporal options
  const temporal = {};
  if (cfg.after) temporal.after = cfg.after instanceof Date ? cfg.after : new Date(cfg.after);
  if (cfg.before) temporal.before = cfg.before instanceof Date ? cfg.before : new Date(cfg.before);

  // Step 1: HyDE query expansion
  let rawQuery = query;
  let expandedQuery = query;

  if (hydeEnabled && await isOllamaReachable(hydeEndpoint)) {
    const expanded = await hydeExpand(query, hydeEndpoint, hydeModel);
    if (expanded) {
      expandedQuery = expanded;
      trajectory.hydeUsed = true;
    }
  }

  // Step 2: Fan-out to all engines
  const enginePromises = engines.map(engine => {
    const engineQuery = engine.queryType === "expanded" ? expandedQuery
      : engine.queryType === "raw" ? rawQuery
      : rawQuery; // "both" — could pass both, but raw is fine as default

    const start = performance.now();
    return engine.search(engineQuery, {
      maxResults,
      after: temporal.after,
      before: temporal.before,
      searchMode, // for qmd engine
    }).then(results => {
      const elapsed = Math.round(performance.now() - start);
      trajectory.engines.push(engine.name);
      trajectory.timing[engine.name] = elapsed;
      return { engineName: engine.name, weight: 1.0, results };
    }).catch(() => {
      trajectory.engines.push(engine.name);
      trajectory.timing[engine.name] = -1;
      return { engineName: engine.name, weight: 1.0, results: [] };
    });
  });

  const engineResults = await Promise.allSettled(enginePromises);
  const settledResults = engineResults
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);

  trajectory.candidates = settledResults.reduce((sum, er) => sum + er.results.length, 0);

  // Determine tier based on result count
  if (trajectory.candidates === 0) trajectory.tier = "L0";
  else if (trajectory.candidates <= 10) trajectory.tier = "L1";
  else trajectory.tier = "L2";

  // Step 3: RRF merge
  let merged = computeRRF(settledResults);
  trajectory.afterRRF = merged.length;

  // Step 4: Fallback temporal filter (for engines that don't push down)
  if (temporal.after || temporal.before) {
    merged = fallbackTemporalFilter(merged, temporal);
  }

  // Step 5: Tiered dedup (Levels 1-3)
  merged = deduplicateResults(merged);

  // Step 6: Cosine dedup (Level 4)
  const cosineResult = applyCosineDedup(merged);
  merged = cosineResult.results;
  trajectory.cosineDedupUsed = cosineResult.cosineDedupUsed;
  trajectory.afterDedup = merged.length;

  // Step 7: Temporal decay
  applyTemporalDecay(merged, halfLifeDays);
  merged.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

  // Step 8: MMR reranking
  const reranked = applyMMR(merged, mmrLambda, maxResults);
  trajectory.afterMMR = reranked.length;

  // Step 9: Token budget
  const charBudget = maxTokens * 4;
  const selected = [];
  let used = 0;
  for (const r of reranked) {
    if (used + (r.content || "").length > charBudget) break;
    selected.push(r);
    used += (r.content || "").length;
  }

  return {
    results: selected,
    meta: { trajectory },
  };
}
