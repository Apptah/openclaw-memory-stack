import { execSync } from "node:child_process";
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
export const RESCUE_DB = resolve(MEMORY_ROOT, "facts.sqlite");
export const GRAPH_PATH = resolve(HOME, ".openclaw/memory-stack/graph.json");
export const GRAPH_DB = resolve(HOME, ".openclaw/memory-stack/graph.sqlite");

export const DEFAULT_CONFIG = {
  llmEndpoint: "https://api.openai.com/v1",
  llmModel: "gpt-4o-mini",
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

export function findQmdBin() {
  const paths = [
    resolve(HOME, ".bun/bin/qmd"),
    resolve(HOME, ".openclaw/memory-stack/node_modules/.bin/qmd"),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  try {
    execSync("command -v qmd", { encoding: "utf-8" });
    return "qmd";
  } catch {
    return null;
  }
}
