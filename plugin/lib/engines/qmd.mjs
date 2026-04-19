import { execSync, silenceStderr } from "../exec.mjs";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findQmdBin, DEFAULT_CONFIG, HOME } from "../constants.mjs";

const QMD_BIN = findQmdBin();

// ─── Probe state ────────────────────────────────────────────────
// Key: `${collection}:${mode}` → { available: bool, cooldownUntil: number, backoff: number }
const probeState = new Map();

function getProbeKey(collection, mode) {
  return `${collection}:${mode}`;
}

function getProbeStatus(collection, mode) {
  const key = getProbeKey(collection, mode);
  const state = probeState.get(key);
  if (!state) return { available: false, initialized: false };
  // If in cooldown, check if cooldown expired
  if (!state.available && state.cooldownUntil > 0 && Date.now() >= state.cooldownUntil) {
    return { available: false, initialized: true, cooldownExpired: true, backoff: state.backoff };
  }
  return { available: state.available, initialized: true, cooldownExpired: false, backoff: state.backoff || 0 };
}

function setProbeAvailable(collection, mode, available, config = {}) {
  const key = getProbeKey(collection, mode);
  const existing = probeState.get(key) || {};
  const baseCooldown = config.qmdProbeCooldown || DEFAULT_CONFIG.qmdProbeCooldown;
  const maxCooldown = config.qmdProbeMaxCooldown || DEFAULT_CONFIG.qmdProbeMaxCooldown;

  if (available) {
    probeState.set(key, { available: true, cooldownUntil: 0, backoff: baseCooldown });
  } else {
    const prevBackoff = existing.backoff || baseCooldown;
    const nextBackoff = Math.min(prevBackoff * 2, maxCooldown);
    probeState.set(key, {
      available: false,
      cooldownUntil: Date.now() + prevBackoff,
      backoff: nextBackoff,
    });
  }
}

// ─── QMD CLI execution ─────────────────────────────────────────

function execQmd(mode, query, collection, maxResults) {
  if (!QMD_BIN) return null;
  const safeQuery = query.replace(/"/g, '\\"');
  const collectionFlag = collection ? ` -c ${collection}` : "";
  const cmd = `"${QMD_BIN}" ${mode} "${safeQuery}"${collectionFlag} --limit ${maxResults} --json ${silenceStderr()}`;
  try {
    const result = execSync(cmd, { encoding: "utf-8", timeout: 8000 });
    const data = JSON.parse(result || "{}");
    const hits = Array.isArray(data) ? data : (data.results || data.hits || []);
    return hits;
  } catch {
    return null;
  }
}

// ─── Probe execution ───────────────────────────────────────────

function runProbe(mode, collection, probeQuery) {
  const hits = execQmd(mode, probeQuery, collection, 3);
  if (hits === null) return false; // exec failed
  if (hits.length === 0) return false; // no results
  // At least 1 result with score > 0
  return hits.some(h => (h.score || h.relevance || 0) > 0);
}

// ─── Collection detection ───────────────────────────────────────

function detectCollection(config) {
  // Explicit config takes priority
  if (config.qmdCollection) return config.qmdCollection;

  // Try .openclaw-memory.json in common locations
  const candidates = [
    resolve(process.cwd(), ".openclaw-memory.json"),
    resolve(HOME, ".openclaw-memory.json"),
    resolve(HOME, ".openclaw/memory-stack/.openclaw-memory.json"),
  ];

  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const data = JSON.parse(readFileSync(p, "utf-8"));
        if (data.collection) return data.collection;
        const nested = data.backends?.qmd?.collection;
        if (nested) return nested;
      }
    } catch { /* skip */ }
  }

  return null; // No collection found → engine disabled
}

// ─── Initialization ─────────────────────────────────────────────

let initialized = false;
let activeCollection = null;
let modeAvailability = { search: false, vsearch: false, query: false };

function initializeProbe(collection, probeQuery, config) {
  if (!probeQuery) {
    // No probe query → search-only baseline, no probe needed
    modeAvailability = { search: true, vsearch: false, query: false };
    setProbeAvailable(collection, "search", true, config);
    return modeAvailability;
  }

  const modes = {};

  // Step 1: search probe — if this fails, QMD is entirely disabled
  modes.search = runProbe("search", collection, probeQuery);
  setProbeAvailable(collection, "search", modes.search, config);
  if (!modes.search) {
    modes.vsearch = false;
    modes.query = false;
    modeAvailability = modes;
    return modes;
  }

  // Step 2: vsearch probe
  modes.vsearch = runProbe("vsearch", collection, probeQuery);
  setProbeAvailable(collection, "vsearch", modes.vsearch, config);

  // Step 3: query probe
  modes.query = runProbe("query", collection, probeQuery);
  setProbeAvailable(collection, "query", modes.query, config);

  modeAvailability = modes;
  return modes;
}

// ─── Mode selection ─────────────────────────────────────────────

function getBestAvailableMode(collection, preferredMode) {
  // If a specific mode is requested (not "auto"), use it if available
  if (preferredMode && preferredMode !== "auto") {
    const status = getProbeStatus(collection, preferredMode);
    if (status.available || !status.initialized) return preferredMode;
    // Requested mode unavailable → fall through to best available
  }

  // Auto: prefer query > vsearch > search
  if (modeAvailability.query) {
    const status = getProbeStatus(collection, "query");
    if (status.available) return "query";
  }
  if (modeAvailability.vsearch) {
    const status = getProbeStatus(collection, "vsearch");
    if (status.available) return "vsearch";
  }
  if (modeAvailability.search) {
    const status = getProbeStatus(collection, "search");
    if (status.available) return "search";
  }

  return "search"; // Default fallback
}

// ─── Fallback logic ─────────────────────────────────────────────

function getFallbackMode(failedMode, collection) {
  // Exactly one fallback per request — NEVER chain two
  if (failedMode === "query") {
    const vs = getProbeStatus(collection, "vsearch");
    if (vs.available) return "vsearch";
    return "search";
  }
  if (failedMode === "vsearch") {
    return "search";
  }
  // search fails → no fallback
  return null;
}

// ─── Runtime re-probe ───────────────────────────────────────────

function checkAndReprobe(collection, mode, probeQuery, config) {
  if (!probeQuery) return; // No probe query → can't re-probe
  const status = getProbeStatus(collection, mode);
  if (status.initialized && !status.available && status.cooldownExpired) {
    const success = runProbe(mode, collection, probeQuery);
    setProbeAvailable(collection, mode, success, config);
    if (success) modeAvailability[mode] = true;
  }
}

// ─── Format results ─────────────────────────────────────────────

function formatResults(hits, mode) {
  return hits.map(h => ({
    content: h.text || h.content || h.snippet || "",
    source: h.path || h.file || "qmd",
    relevance: h.score || h.relevance || 0.5,
    engine: `qmd-${mode}`,
    timestamp: h.created_at || h.timestamp || undefined,
  }));
}

// ─── Engine export ──────────────────────────────────────────────

export default {
  name: "qmd",
  queryType: "expanded",

  /**
   * Note: when query mode is active, pipeline-level HyDE is redundant
   * since QMD query mode already performs semantic expansion internally.
   */
  get hydeRedundant() {
    return modeAvailability.query && getProbeStatus(activeCollection, "query").available;
  },

  async search(query, options = {}) {
    if (!QMD_BIN) return [];

    const config = { ...DEFAULT_CONFIG, ...options };
    const maxResults = options.maxResults || 10;

    // Detect collection — NEVER fallback to unscoped search
    if (!initialized) {
      activeCollection = detectCollection(config);
      if (!activeCollection) return []; // No collection → disabled
      initializeProbe(activeCollection, config.qmdProbeQuery, config);
      initialized = true;
    }

    if (!activeCollection) return [];

    const collection = activeCollection;
    const probeQuery = config.qmdProbeQuery;
    const preferredMode = config.qmdMode || DEFAULT_CONFIG.qmdMode;

    // Check for cooldown-expired modes that need re-probing
    for (const mode of ["search", "vsearch", "query"]) {
      checkAndReprobe(collection, mode, probeQuery, config);
    }

    // Select best mode
    const mode = getBestAvailableMode(collection, preferredMode);

    // Execute primary search
    const hits = execQmd(mode, query, collection, maxResults);

    if (hits !== null && hits.length > 0) {
      return formatResults(hits, mode);
    }

    // Primary failed — attempt exactly one fallback
    if (hits === null) {
      // Runtime failure: mark mode as unavailable
      setProbeAvailable(collection, mode, false, config);
      modeAvailability[mode] = false;
    }

    const fallbackMode = getFallbackMode(mode, collection);
    if (!fallbackMode) return []; // search failed → no further fallback

    const fallbackHits = execQmd(fallbackMode, query, collection, maxResults);
    if (fallbackHits !== null && fallbackHits.length > 0) {
      return formatResults(fallbackHits, fallbackMode);
    }

    // Fallback also failed — mark and return empty
    if (fallbackHits === null) {
      setProbeAvailable(collection, fallbackMode, false, config);
      modeAvailability[fallbackMode] = false;
    }

    return [];
  },

  // Exposed for testing
  _probeState: probeState,
  _resetForTest() {
    initialized = false;
    activeCollection = null;
    modeAvailability = { search: false, vsearch: false, query: false };
    probeState.clear();
  },
};
