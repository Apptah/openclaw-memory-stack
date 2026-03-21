/**
 * Tiered output formatters for memory search results.
 *
 * L0 — ~100 tokens. One-line summary per result.  (auto-recall default)
 * L1 — ~800 tokens. First sentence + entity names. (tool response default)
 * L2 — ~2000 tokens. Full content, budget-truncated. (--full)
 *
 * Each result: { content, source, relevance, engine, timestamp? }
 */

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Extract the first sentence from text.
 * Splits on sentence-ending punctuation followed by whitespace or end-of-string.
 */
function firstSentence(text) {
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  return match ? match[1] : text.slice(0, 120);
}

/**
 * Extract capitalised entity-like names from text (2+ chars, starts uppercase).
 * Returns at most 5 unique names.
 */
function extractEntityNames(text) {
  const seen = new Set();
  const entities = [];
  // Match PascalCase or multi-word proper nouns
  const re = /\b([A-Z][a-zA-Z0-9]{1,}(?:\s[A-Z][a-zA-Z0-9]{1,})*)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    // Skip common English words that happen to start sentences
    if (/^(The|This|That|These|Those|When|Where|What|Which|How|There|Here|Some|Any|All|Each|Every|After|Before|About|Into|From|With|They|Their|Have|Has|Had|Was|Were|Been|Being|Will|Would|Could|Should|Also|Just|Only|Then|Than|Because|Since|While|Until|Unless|Although|Though|However|Therefore|Moreover|Furthermore|Meanwhile|Instead|Otherwise|Nevertheless|Nonetheless|Regardless|Already|Always|Never|Often|Sometimes|Usually|Probably|Certainly|Definitely|Absolutely|Apparently|Obviously|Clearly|Simply|Really|Actually|Basically|Essentially|Particularly|Specifically|Especially|Generally|Typically|Currently|Previously|Recently|Finally|Initially|Eventually|Immediately|Gradually|Suddenly|Quickly|Slowly|Carefully|Completely|Entirely|Mostly|Partly|Nearly|Almost|Hardly|Barely|Exactly|Merely|Roughly|Slightly|Somewhat|Quite|Rather|Fairly|Pretty|Very|Most|More|Much|Many|Few|Several|Both|Either|Neither|Other|Another|Next|Last|First|Second|Third|Only|Still|Already|Yet|Soon|Now|Then|Once|Again|Too|Also|Even|Ever|Never)$/.test(name)) continue;
    if (!seen.has(name)) {
      seen.add(name);
      entities.push(name);
      if (entities.length >= 5) break;
    }
  }
  return entities;
}

// ─── Formatters ───────────────────────────────────────────────────

/**
 * L0: Ultra-compact. ~100 tokens total.
 * Format: `[source] first-60-chars...`
 */
export function formatL0(results) {
  if (!results || results.length === 0) return "";
  return results
    .map(r => {
      const preview = (r.content || "").replace(/\n/g, " ").slice(0, 60);
      const ellipsis = (r.content || "").length > 60 ? "..." : "";
      return `[${r.source}] ${preview}${ellipsis}`;
    })
    .join("\n");
}

/**
 * L1: Mid-detail. ~800 tokens total.
 * Format: `[source] (score) first-sentence | entities: A, B`
 */
export function formatL1(results) {
  if (!results || results.length === 0) return "";
  return results
    .map((r, i) => {
      const sentence = firstSentence((r.content || "").replace(/\n/g, " "));
      const entities = extractEntityNames(r.content || "");
      const entityStr = entities.length > 0 ? ` | entities: ${entities.join(", ")}` : "";
      const score = (r.relevance || 0).toFixed(2);
      return `[${i + 1}] (${r.source}, score: ${score}) ${sentence}${entityStr}`;
    })
    .join("\n");
}

/**
 * L2: Full content, budget-truncated at ~2000 tokens.
 * Format matches the original tool output style.
 */
export function formatL2(results) {
  if (!results || results.length === 0) return "";

  const TOKEN_BUDGET = 2000;
  const lines = [];
  let estimatedTokens = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const entry = `[${i + 1}] (${r.source}, score: ${(r.relevance || 0).toFixed(2)})\n${r.content}`;
    const entryTokens = entry.split(/\s+/).length;

    if (estimatedTokens + entryTokens > TOKEN_BUDGET && lines.length > 0) {
      // Truncate: include partial if possible
      const remaining = TOKEN_BUDGET - estimatedTokens;
      if (remaining > 20) {
        const words = entry.split(/\s+/);
        lines.push(words.slice(0, remaining).join(" ") + " [truncated]");
      }
      break;
    }

    lines.push(entry);
    estimatedTokens += entryTokens;
  }

  return lines.join("\n---\n");
}

/**
 * Parse --full suffix from a query string.
 * Returns { query, tier } where tier is "L2" if --full was present, otherwise the default.
 */
export function parseFullSuffix(query, defaultTier) {
  if (query.endsWith("--full")) {
    return { query: query.slice(0, -6).trim(), tier: "L2" };
  }
  return { query, tier: defaultTier };
}
