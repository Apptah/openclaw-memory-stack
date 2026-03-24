import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("plugin default export (integration)", () => {
  let plugin;

  it("imports without error", async () => {
    plugin = (await import("../index.mjs")).default;
    assert.ok(plugin);
  });

  it("has correct id, name, kind", () => {
    assert.equal(plugin.id, "openclaw-memory-stack");
    assert.equal(plugin.name, "OpenClaw Memory Stack");
    assert.equal(plugin.kind, "memory");
  });

  it("has a register function", () => {
    assert.equal(typeof plugin.register, "function");
  });

  it("register calls registerTool and on()", () => {
    const calls = { registerTool: 0, on: {}, loggerInfo: [] };

    const fakeApi = {
      pluginConfig: {},
      logger: { info: (msg) => calls.loggerInfo.push(msg) },
      registerTool: (_factory, _opts) => {
        calls.registerTool++;
        // Verify factory returns tools array
        const tools = _factory();
        assert.ok(Array.isArray(tools), "factory must return array");
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, "memory_search");
        assert.equal(typeof tools[0].execute, "function");
        assert.ok(tools[0].parameters);
        // Verify opts
        assert.deepEqual(_opts, { names: ["memory_search"] });
      },
      on: (event, handler) => {
        calls.on[event] = (calls.on[event] || 0) + 1;
        assert.equal(typeof handler, "function");
      },
    };

    plugin.register(fakeApi);

    assert.equal(calls.registerTool, 1, "should call registerTool once");
    assert.equal(calls.on["before_agent_start"], 1, "should register before_agent_start");
    assert.equal(calls.on["agent_end"], 1, "should register agent_end");
    assert.ok(calls.loggerInfo.length >= 2, "should log at least 2 messages");
  });

  it("register with autoRecall=false skips before_agent_start", () => {
    const calls = { on: {} };
    const fakeApi = {
      pluginConfig: { autoRecall: false },
      logger: { info: () => {} },
      registerTool: () => {},
      on: (event) => { calls.on[event] = (calls.on[event] || 0) + 1; },
    };

    plugin.register(fakeApi);

    assert.equal(calls.on["before_agent_start"], undefined, "should NOT register before_agent_start");
    assert.equal(calls.on["agent_end"], 1, "should still register agent_end");
  });
});

describe("lib module imports (smoke)", () => {
  it("constants exports all paths", async () => {
    const mod = await import("../lib/constants.mjs");
    assert.equal(typeof mod.HOME, "string");
    assert.equal(typeof mod.MEMORY_DB, "string");
    assert.equal(typeof mod.WORKSPACE, "string");
    assert.equal(typeof mod.INSTALL_ROOT, "string");
    assert.equal(typeof mod.RESCUE_DIR, "string");
    assert.equal(typeof mod.GRAPH_PATH, "string");
    assert.equal(typeof mod.DEFAULT_CONFIG, "object");
    assert.equal(typeof mod.findQmdBin, "function");
    // New global memory path constants
    assert.ok(mod.MEMORY_ROOT, "MEMORY_ROOT must be exported");
    assert.ok(mod.MEMORY_MD, "MEMORY_MD must be exported");
    assert.ok(mod.EXTERNAL_MEMORY_DIR, "EXTERNAL_MEMORY_DIR must be exported");
    assert.ok(mod.MAINTENANCE_STATE, "MAINTENANCE_STATE must be exported");
  });

  it("engines exports array of 5", async () => {
    const mod = await import("../lib/engines/index.mjs");
    assert.ok(Array.isArray(mod.engines));
    assert.equal(mod.engines.length, 5);
    for (const e of mod.engines) {
      assert.equal(typeof e.name, "string");
      assert.equal(typeof e.search, "function");
    }
  });

  it("pipeline exports combinedSearch, computeRRF, fallbackTemporalFilter", async () => {
    const mod = await import("../lib/pipeline.mjs");
    assert.equal(typeof mod.combinedSearch, "function");
    assert.equal(typeof mod.computeRRF, "function");
    assert.equal(typeof mod.fallbackTemporalFilter, "function");
  });

  it("rescue exports all functions", async () => {
    const mod = await import("../lib/rescue.mjs");
    assert.equal(typeof mod.extractKeyFacts, "function");
    assert.equal(typeof mod.extractFacts, "function");
    assert.equal(typeof mod.saveRescueFacts, "function");
    assert.equal(typeof mod.cleanupOldRescueFiles, "function");
  });

  it("rescue exports saveRescueFacts as async function", async () => {
    const mod = await import("../lib/rescue.mjs");
    // Call with empty array — should return a promise (async function)
    const result = mod.saveRescueFacts([], "test");
    assert.ok(result instanceof Promise || result === undefined, "saveRescueFacts must return Promise or undefined for empty input");
  });

  it("dedup-gate exports gateFactInsert and archiveFact", async () => {
    const mod = await import("../lib/dedup-gate.mjs");
    assert.equal(typeof mod.gateFactInsert, "function");
    assert.equal(typeof mod.archiveFact, "function");
  });

  it("quality exports all functions", async () => {
    const mod = await import("../lib/quality.mjs");
    assert.equal(typeof mod.analyzeMemoryHealth, "function");
    assert.equal(typeof mod.consolidateMemories, "function");
    assert.equal(typeof mod.organizeMemories, "function");
    assert.equal(typeof mod.deduplicateResults, "function");
    assert.equal(typeof mod.applyCosineDedup, "function");
  });

  it("graph/store exports all functions", async () => {
    const mod = await import("../lib/graph/store.mjs");
    assert.equal(typeof mod.loadGraph, "function");
    assert.equal(typeof mod.saveGraph, "function");
    assert.equal(typeof mod.extractEntities, "function");
    assert.equal(typeof mod.mergeIntoGraph, "function");
    assert.equal(typeof mod.queryGraph, "function");
  });

  it("graph/algorithms exports all functions", async () => {
    const mod = await import("../lib/graph/algorithms.mjs");
    assert.equal(typeof mod.multiHopQuery, "function");
    assert.equal(typeof mod.getEvolutionTimeline, "function");
    assert.equal(typeof mod.extractEvolutionEdges, "function");
    assert.equal(typeof mod.detectCommunities, "function");
    assert.equal(typeof mod.rankByPageRank, "function");
    assert.equal(typeof mod.invalidateGraphCache, "function");
    assert.ok(Array.isArray(mod.EVOLUTION_PATTERNS));
  });
});

describe("command dispatch (unit)", () => {
  let execute;

  it("setup: get execute function", async () => {
    const plugin = (await import("../index.mjs")).default;
    let tools;
    const fakeApi = {
      pluginConfig: {},
      logger: { info: () => {} },
      registerTool: (factory) => { tools = factory(); },
      on: () => {},
    };
    plugin.register(fakeApi);
    execute = tools[0].execute;
    assert.ok(execute);
  });

  it("health command returns health report", async () => {
    const result = await execute("id", { query: "health" });
    assert.ok(result.content[0].text.includes("Memory Health Score"));
  });

  it("graph command returns graph summary", async () => {
    const result = await execute("id", { query: "graph" });
    assert.ok(result.content[0].text.includes("Knowledge Graph Summary"));
  });

  it("consolidate command returns consolidation report", async () => {
    const result = await execute("id", { query: "consolidate" });
    assert.ok(result.content[0].text.includes("Memory Consolidation Report"));
  });

  it("default search returns results or no-match message", async () => {
    const result = await execute("id", { query: "test query xyz" });
    assert.ok(result.content[0].text);
  });
});
