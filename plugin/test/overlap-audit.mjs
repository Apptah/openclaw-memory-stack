#!/usr/bin/env node
/**
 * Overlap Audit — diagnostic tool (not a pass/fail test)
 *
 * Runs 20 fixed queries against each engine independently,
 * then outputs an overlap matrix showing how often engines
 * return overlapping content for the same query.
 *
 * Usage: node plugin/test/overlap-audit.mjs
 */

import { engines } from "../lib/engines/index.mjs";

// ─── 20 fixed diagnostic queries ────────────────────────────────
const QUERIES = [
  // Factual
  "production deployment URL",
  "Stripe webhook secret configuration",
  "Cloudflare Pages project name",
  "sqlite database schema",
  "FTS5 tokenizer settings",

  // Temporal
  "changes made yesterday",
  "recent bug fixes",
  "latest release version",
  "upgrade plan timeline",
  "session history from last week",

  // Entity
  "openclaw plugin architecture",
  "QMD search engine",
  "Resend email integration",
  "R2 bucket configuration",
  "KV namespace bindings",

  // Concept
  "how memory recall works",
  "deduplication strategy",
  "token budget management",
  "graceful degradation pattern",
  "bi-temporal filtering approach",
];

// ─── Overlap detection ──────────────────────────────────────────

function contentFingerprint(content) {
  // Normalize: lowercase, collapse whitespace, take first 100 chars
  return (content || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
}

function computeOverlap(resultsA, resultsB) {
  const fpA = new Set(resultsA.map(r => contentFingerprint(r.content)).filter(Boolean));
  const fpB = new Set(resultsB.map(r => contentFingerprint(r.content)).filter(Boolean));
  if (fpA.size === 0 || fpB.size === 0) return 0;
  let intersection = 0;
  for (const fp of fpA) {
    if (fpB.has(fp)) intersection++;
  }
  const union = fpA.size + fpB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const engineNames = engines.map(e => e.name);
  console.log(`Overlap Audit: ${QUERIES.length} queries x ${engineNames.length} engines`);
  console.log(`Engines: ${engineNames.join(", ")}\n`);

  // Collect per-query, per-engine results
  const allResults = []; // [queryIdx][engineIdx] = results[]

  for (let q = 0; q < QUERIES.length; q++) {
    const query = QUERIES[q];
    const queryResults = [];
    for (let e = 0; e < engines.length; e++) {
      try {
        const results = await engines[e].search(query, { maxResults: 10 });
        queryResults.push(results);
      } catch {
        queryResults.push([]);
      }
    }
    allResults.push(queryResults);

    // Per-query summary
    const counts = queryResults.map(r => r.length);
    const nonEmpty = counts.filter(c => c > 0).length;
    console.log(`[${String(q + 1).padStart(2)}] "${query}"`);
    console.log(`     hits: ${engineNames.map((n, i) => `${n}=${counts[i]}`).join(", ")}  (${nonEmpty}/${engineNames.length} engines responded)`);
  }

  // ─── Overlap matrix ────────────────────────────────────────────
  console.log("\n=== OVERLAP MATRIX (Jaccard similarity, averaged over all queries) ===\n");

  // Header
  const colW = 10;
  const labelW = 12;
  process.stdout.write("".padEnd(labelW));
  for (const name of engineNames) {
    process.stdout.write(name.padStart(colW));
  }
  console.log();
  console.log("-".repeat(labelW + colW * engineNames.length));

  // Matrix body
  for (let i = 0; i < engineNames.length; i++) {
    process.stdout.write(engineNames[i].padEnd(labelW));
    for (let j = 0; j < engineNames.length; j++) {
      if (i === j) {
        process.stdout.write("   ---   ".padStart(colW));
        continue;
      }
      // Average Jaccard over all queries
      let totalOverlap = 0;
      let validQueries = 0;
      for (let q = 0; q < QUERIES.length; q++) {
        const rA = allResults[q][i];
        const rB = allResults[q][j];
        if (rA.length > 0 || rB.length > 0) {
          totalOverlap += computeOverlap(rA, rB);
          validQueries++;
        }
      }
      const avg = validQueries > 0 ? totalOverlap / validQueries : 0;
      process.stdout.write(avg.toFixed(3).padStart(colW));
    }
    console.log();
  }

  // ─── Per-engine hit rate ────────────────────────────────────────
  console.log("\n=== ENGINE HIT RATES ===\n");
  for (let e = 0; e < engineNames.length; e++) {
    let totalHits = 0;
    let queriesWithHits = 0;
    for (let q = 0; q < QUERIES.length; q++) {
      const count = allResults[q][e].length;
      totalHits += count;
      if (count > 0) queriesWithHits++;
    }
    console.log(`${engineNames[e].padEnd(labelW)} ${queriesWithHits}/${QUERIES.length} queries hit, ${totalHits} total results`);
  }

  console.log("\nDone.");
}

main().catch(err => {
  console.error("Overlap audit failed:", err.message);
  process.exit(1);
});
