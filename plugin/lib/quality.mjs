import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { WORKSPACE } from "./constants.mjs";

// ─── Memory Health Analysis ──────────────────────────────────────

export function analyzeMemoryHealth() {
  const issues = { duplicates: [], stale: [], noise: [], total: 0, score: 100 };

  if (!existsSync(resolve(WORKSPACE, "MEMORY.md"))) return issues;

  try {
    const content = readFileSync(resolve(WORKSPACE, "MEMORY.md"), "utf-8");
    const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    issues.total = lines.length;

    // Detect duplicates
    const normalized = lines.map(l => l.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, " ").trim());
    for (let i = 0; i < normalized.length; i++) {
      for (let j = i + 1; j < normalized.length; j++) {
        if (normalized[i] === normalized[j] || (normalized[i].length > 20 && normalized[j].includes(normalized[i].slice(0, 20)))) {
          issues.duplicates.push({ line1: i + 1, line2: j + 1, text: lines[j].trim() });
        }
      }
    }

    // Detect stale entries
    const relativePattern = /\b(today|tomorrow|this week|this friday|this monday|yesterday|last week)\b/i;
    for (let i = 0; i < lines.length; i++) {
      if (relativePattern.test(lines[i])) {
        issues.stale.push({ line: i + 1, text: lines[i].trim(), reason: "relative date reference" });
      }
    }

    // Detect noise
    for (let i = 0; i < lines.length; i++) {
      const clean = lines[i].replace(/^[-*•]\s*/, "").trim();
      if (clean.length < 10 && clean.length > 0) {
        issues.noise.push({ line: i + 1, text: lines[i].trim(), reason: "too short to be useful" });
      }
    }

    issues.score = Math.max(0, 100
      - issues.duplicates.length * 10
      - issues.stale.length * 5
      - issues.noise.length * 3);
  } catch { /* ignore */ }

  return issues;
}

// ─── Embedding Cache (Phase 3, Step 3.5) ─────────────────────────

const CACHE_MAX = 100;
const embeddingCache = new Map();

function cacheKey(text) {
  return createHash("sha256").update(text.trim().toLowerCase()).digest("hex");
}

/**
 * Get an embedding vector with LRU caching.
 * Uses the LLM provider chain (llm.mjs) instead of qmd shell-outs.
 * Returns null if no LLM provider is available.
 */
export async function getEmbedding(text) {
  const key = cacheKey(text);
  if (embeddingCache.has(key)) {
    // Move to end (LRU refresh)
    const val = embeddingCache.get(key);
    embeddingCache.delete(key);
    embeddingCache.set(key, val);
    return val;
  }

  // Try llmEmbed from provider chain
  const { llmEmbed, llmAvailable } = await import("./llm.mjs");
  if (!(await llmAvailable())) return null;

  const embedding = await llmEmbed(text);
  if (!embedding) return null;

  // Evict oldest if full
  if (embeddingCache.size >= CACHE_MAX) {
    const oldest = embeddingCache.keys().next().value;
    embeddingCache.delete(oldest);
  }
  embeddingCache.set(key, embedding);
  return embedding;
}

/** Exposed for testing — returns current cache size. */
export function embeddingCacheSize() {
  return embeddingCache.size;
}

// ─── Cosine Similarity ──────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 4-level tiered deduplication.
 * Level 1: Exact content key (first 80 chars lowercase)
 * Level 2: Normalized text (lowercase, strip punctuation, collapse whitespace)
 * Level 3: Substring overlap > 80% of shorter string
 * Level 4: Cosine similarity > 0.9 via LLM embedding (if available)
 */
export function deduplicateResults(results) {
  if (results.length <= 1) return results;

  const kept = [];
  const maxCandidates = Math.min(results.length, 50);
  const candidates = results.slice(0, maxCandidates);
  const overflow = results.slice(maxCandidates);

  for (const result of candidates) {
    let isDuplicate = false;

    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i];

      // Level 1: Exact key (first 80 chars lowercase)
      const key1 = (result.content || "").slice(0, 80).toLowerCase();
      const key2 = (existing.content || "").slice(0, 80).toLowerCase();
      if (key1 === key2) {
        // Keep higher relevance + longer content
        if ((result.relevance || 0) > (existing.relevance || 0) ||
            (result.content || "").length > (existing.content || "").length) {
          kept[i] = result;
        }
        isDuplicate = true;
        break;
      }

      // Level 2: Normalized text
      const norm1 = (result.content || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
      const norm2 = (existing.content || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
      if (norm1 === norm2) {
        if ((result.relevance || 0) > (existing.relevance || 0)) kept[i] = result;
        isDuplicate = true;
        break;
      }

      // Level 3: Substring overlap > 80%
      const shorter = norm1.length <= norm2.length ? norm1 : norm2;
      const longer = norm1.length > norm2.length ? norm1 : norm2;
      if (shorter.length > 20 && longer.includes(shorter)) {
        const overlap = shorter.length / longer.length;
        if (overlap > 0.8) {
          if ((result.content || "").length > (existing.content || "").length) kept[i] = result;
          isDuplicate = true;
          break;
        }
      }
    }

    if (!isDuplicate) {
      kept.push(result);
    }
  }

  // Level 4: Cosine dedup (only if QMD embed available)
  // Skipped in this pass — applied separately if available
  // We set cosineDedupUsed flag for trajectory

  return [...kept, ...overflow];
}

/**
 * Apply cosine dedup as a separate pass (Level 4).
 * Uses the LLM provider chain embedding cache instead of qmd shell-outs.
 * When no LLM is available, skips cosine dedup entirely
 * (the 3 other dedup levels still catch most duplicates).
 *
 * Returns { results, cosineDedupUsed }.
 */
export async function applyCosineDedup(results) {
  if (results.length <= 1) {
    return { results, cosineDedupUsed: false };
  }

  // Check if LLM embedding is available
  const { llmAvailable } = await import("./llm.mjs");
  if (!(await llmAvailable())) {
    return { results, cosineDedupUsed: false };
  }

  const embeddings = new Map();
  const kept = [];

  for (const result of results.slice(0, 50)) {
    const embedding = await getEmbedding(result.content);
    if (!embedding) { kept.push(result); continue; }

    let isDuplicate = false;
    for (const [idx, existing] of embeddings) {
      const sim = cosineSimilarity(embedding, existing);
      if (sim > 0.9) {
        // Keep higher relevance
        if ((result.relevance || 0) > (kept[idx].relevance || 0)) {
          kept[idx] = result;
          embeddings.set(idx, embedding);
        }
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      embeddings.set(kept.length, embedding);
      kept.push(result);
    }
  }

  return { results: [...kept, ...results.slice(50)], cosineDedupUsed: true };
}

// ─── Consolidation ───────────────────────────────────────────────

export function consolidateMemories() {
  const memoryMdPath = resolve(WORKSPACE, "MEMORY.md");
  if (!existsSync(memoryMdPath)) return { totalMemories: 0, clusters: [], consolidatable: { count: 0, entries: [], suggestion: "No MEMORY.md found." } };

  const content = readFileSync(memoryMdPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
  const totalMemories = lines.length;

  const wordBags = lines.map(l =>
    new Set(l.toLowerCase().split(/\W+/).filter(w => w.length > 3))
  );

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

// ─── A-MEM Self-Organizing Memory (Gap 10) ───────────────────────

export function organizeMemories(options = {}) {
  const apply = options.apply === true;
  const memoryMdPath = resolve(WORKSPACE, "MEMORY.md");

  if (!existsSync(memoryMdPath)) {
    return { applied: false, dryRun: true, clusters: [], candidates: [], suggestions: [] };
  }

  // Phase 1: Jaccard clustering (reuse consolidation logic)
  const { clusters, totalMemories } = consolidateMemories();

  // Phase 2: Generate consolidation candidates
  const candidates = clusters.map(cluster => ({
    candidate: cluster.join(" | "),
    original: cluster,
    summary: `Merge ${cluster.length} similar entries`,
  }));

  // Phase 3: Cross-link suggestions
  const suggestions = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const wordsI = new Set(clusters[i].join(" ").toLowerCase().split(/\W+/).filter(w => w.length > 3));
      const wordsJ = new Set(clusters[j].join(" ").toLowerCase().split(/\W+/).filter(w => w.length > 3));
      let overlap = 0;
      for (const w of wordsI) { if (wordsJ.has(w)) overlap++; }
      if (overlap >= 2) {
        suggestions.push(`Clusters ${i + 1} and ${j + 1} share ${overlap} keywords — consider linking`);
      }
    }
  }

  if (apply) {
    // Mandatory backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${memoryMdPath}.backup.${timestamp}`;
    try {
      copyFileSync(memoryMdPath, backupPath);
    } catch (err) {
      return { applied: false, error: `Backup failed: ${err.message}`, backupPath: null };
    }

    try {
      // For now, A-MEM just writes a report comment at the top
      // Full LLM consolidation would rewrite content — keeping simple for safety
      const content = readFileSync(memoryMdPath, "utf-8");
      const report = `<!-- A-MEM organized: ${new Date().toISOString()}, ${candidates.length} candidates, ${suggestions.length} suggestions -->\n`;
      writeFileSync(memoryMdPath, report + content);
      return { applied: true, backupPath, changes: { candidates: candidates.length, suggestions: suggestions.length } };
    } catch (err) {
      // Restore from backup on failure
      try { copyFileSync(backupPath, memoryMdPath); } catch { /* backup restore failed too */ }
      return { applied: false, error: `Write failed, restored backup: ${err.message}`, backupPath };
    }
  }

  return { applied: false, dryRun: true, clusters, candidates, suggestions };
}
