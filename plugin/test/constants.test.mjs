import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HOME, MEMORY_DB, WORKSPACE, INSTALL_ROOT, RESCUE_DIR, GRAPH_PATH, DEFAULT_CONFIG, findQmdBin } from "../lib/constants.mjs";

describe("constants", () => {
  it("exports all required paths as strings", () => {
    assert.equal(typeof HOME, "string");
    assert.equal(typeof MEMORY_DB, "string");
    assert.equal(typeof WORKSPACE, "string");
    assert.equal(typeof INSTALL_ROOT, "string");
    assert.equal(typeof RESCUE_DIR, "string");
    assert.equal(typeof GRAPH_PATH, "string");
  });

  it("paths resolve from HOME", () => {
    assert.ok(MEMORY_DB.includes(".openclaw/memory/main.sqlite"));
    assert.ok(RESCUE_DIR.includes(".openclaw/memory-stack/rescue"));
    assert.ok(GRAPH_PATH.includes(".openclaw/memory-stack/graph.json"));
  });

  it("DEFAULT_CONFIG has expected keys and values", () => {
    assert.equal(DEFAULT_CONFIG.hyde, true);
    assert.equal(DEFAULT_CONFIG.autoOrganize, false);
    assert.equal(DEFAULT_CONFIG.losslessEnabled, true);
    assert.equal(DEFAULT_CONFIG.graphDepth, 2);
    assert.equal(DEFAULT_CONFIG.graphMaxNodes, 50);
    assert.equal(DEFAULT_CONFIG.mmrLambda, 0.7);
    assert.equal(DEFAULT_CONFIG.halfLifeDays, 30);
    assert.equal(DEFAULT_CONFIG.maxRecallResults, 5);
    assert.equal(DEFAULT_CONFIG.maxRecallTokens, 1500);
    assert.equal(DEFAULT_CONFIG.searchMode, "hybrid");
  });

  it("findQmdBin returns string or null", () => {
    const bin = findQmdBin();
    assert.ok(bin === null || typeof bin === "string");
  });
});
