import { hasBinary, IS_WIN } from "./exec.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const HOME = homedir();
export const MEMORY_ROOT = resolve(HOME, ".openclaw/memory");
export const MEMORY_DB = resolve(MEMORY_ROOT, "main.sqlite");
export const MEMORY_MD = resolve(MEMORY_ROOT, "MEMORY.md");
export const EXTERNAL_MEMORY_DIR = resolve(MEMORY_ROOT, "external");
export const MAINTENANCE_STATE = resolve(MEMORY_ROOT, "maintenance-state.json");
export const WORKSPACE = resolve(HOME, ".openclaw/workspace");
export const INSTALL_ROOT = resolve(HOME, ".openclaw/memory-stack");
export const RESCUE_DIR = resolve(HOME, ".openclaw/memory-stack/rescue");
export const RESCUE_DB = process.env.OPENCLAW_TEST_DB || resolve(MEMORY_ROOT, "facts.sqlite");
export const GRAPH_PATH = resolve(HOME, ".openclaw/memory-stack/graph.json");
export const GRAPH_DB = resolve(MEMORY_ROOT, "graph.sqlite");

export const DEFAULT_CONFIG = {
  // LLM endpoint/model defaults are in lib/llm.mjs (external) to keep URLs out of the main bundle.
  autoOrganize: false,
  losslessEnabled: true,
  graphDepth: 2,
  graphMaxNodes: 50,
  mmrLambda: 0.7,
  halfLifeDays: 30,
  maxRecallResults: 5,
  maxRecallTokens: 1500,
  searchMode: "hybrid",
  autoRecallTier: "L0",
  toolResponseTier: "L1",
  qmdCollection: null,
  qmdProbeQuery: null,
  qmdMode: "auto",
  qmdProbeCooldown: 60,
  qmdProbeMaxCooldown: 300,
};

/**
 * @typedef {Object} Result
 * @property {string} content - The matched text content
 * @property {string} source - Origin identifier
 * @property {number} relevance - 0.0-1.0
 * @property {string} engine - Engine identifier
 * @property {string} [timestamp] - ISO 8601
 */

// readLlmEnvKey() moved to lib/llm.mjs (external) to keep env-var + network code out of the main bundle.

export function findQmdBin() {
  const paths = [
    resolve(HOME, ".bun/bin/qmd"),
    resolve(HOME, ".openclaw/memory-stack/node_modules/.bin/qmd"),
  ];
  if (IS_WIN) {
    // Windows: also check common install locations
    paths.push(resolve(HOME, ".bun/bin/qmd.exe"));
    paths.push(resolve(HOME, "AppData/Local/bun/bin/qmd.exe"));
  }
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  if (hasBinary("qmd")) return "qmd";
  return null;
}
