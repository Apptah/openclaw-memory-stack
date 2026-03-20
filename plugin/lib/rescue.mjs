import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { RESCUE_DIR, DEFAULT_CONFIG } from "./constants.mjs";

/**
 * Extract entities from a line of text using simple patterns.
 */
function extractEntitiesFromLine(line) {
  const entities = [];
  const patterns = [
    /\b(?:project|app|service)\s+([A-Z][A-Za-z0-9_-]+)/g,
    /\b(?:database|table)\s+([A-Za-z_][A-Za-z0-9_-]*)/g,
    /\b(?:team|client)\s+([A-Z][A-Za-z0-9_-]+)/g,
  ];
  for (const p of patterns) {
    p.lastIndex = 0;
    let m;
    while ((m = p.exec(line)) !== null) {
      if (m[1].length >= 2) entities.push(m[1]);
    }
  }
  return entities;
}

/**
 * Check if Ollama is reachable. Cache result for 60s.
 */
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

/**
 * Extract facts using LLM via Ollama.
 */
async function extractFactsWithLLM(text, endpoint, model) {
  const prompt = `Extract key facts from the following conversation text. Return a JSON array of objects with this schema:
{ "type": "decision"|"deadline"|"requirement"|"entity"|"insight", "fact": "the fact text", "confidence": 0.0-1.0, "entities": ["referenced entity names"] }

Only include facts that are explicitly stated. Be concise.

Text:
${text.slice(0, 3000)}

Return ONLY a JSON array, no other text:`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json();
    const response = data.response || "";

    // Extract JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;

    const facts = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(facts)) return null;

    // Validate each fact against schema
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

/**
 * Main extraction function: tries LLM first, falls back to regex.
 */
export async function extractFacts(text, cfg = {}) {
  const endpoint = cfg.hydeEndpoint || DEFAULT_CONFIG.hydeEndpoint;
  const model = cfg.hydeModel || DEFAULT_CONFIG.hydeModel;

  if (await isOllamaReachable(endpoint)) {
    const llmFacts = await extractFactsWithLLM(text, endpoint, model);
    if (llmFacts) return llmFacts;
  }

  return extractKeyFacts(text);
}

/**
 * Save extracted facts to rescue store.
 */
export function saveRescueFacts(facts, sessionKey) {
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

/**
 * Clean up rescue files older than maxAgeDays.
 */
export function cleanupOldRescueFiles(maxAgeDays) {
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
