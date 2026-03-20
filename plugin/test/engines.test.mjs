import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("engine interface compliance", () => {
  const enginePaths = [
    ["fts5", "../lib/engines/fts5.mjs"],
    ["qmd", "../lib/engines/qmd.mjs"],
    ["memorymd", "../lib/engines/memorymd.mjs"],
    ["rescue", "../lib/engines/rescue.mjs"],
    ["sessions", "../lib/engines/sessions.mjs"],
  ];

  for (const [name, path] of enginePaths) {
    it(`${name} exports name, queryType, search`, async () => {
      const mod = await import(path);
      const engine = mod.default;
      assert.equal(typeof engine.name, "string");
      assert.ok(["raw", "expanded", "both"].includes(engine.queryType), `${name} queryType must be raw|expanded|both`);
      assert.equal(typeof engine.search, "function");
    });

    it(`${name} search returns Promise resolving to array`, async () => {
      const mod = await import(path);
      const engine = mod.default;
      const result = engine.search("test query", { maxResults: 3 });
      assert.ok(result instanceof Promise);
      const results = await result;
      assert.ok(Array.isArray(results));
    });
  }
});

describe("engine registry", () => {
  it("exports engines array with all 6 built-in engines", async () => {
    const { engines } = await import("../lib/engines/index.mjs");
    assert.ok(Array.isArray(engines));
    assert.equal(engines.length, 6);
    const names = engines.map(e => e.name);
    assert.ok(names.includes("fts5"));
    assert.ok(names.includes("qmd"));
    assert.ok(names.includes("memorymd"));
    assert.ok(names.includes("rescue"));
    assert.ok(names.includes("sessions"));
    assert.ok(names.includes("lossless"));
  });
});

describe("lossless engine", () => {
  it("exports valid Engine interface", async () => {
    const { default: lossless } = await import("../lib/engines/lossless.mjs");
    assert.equal(lossless.name, "lossless");
    assert.equal(lossless.queryType, "raw");
    assert.equal(typeof lossless.search, "function");
  });

  it("returns empty array when DB not found", async () => {
    const { default: lossless } = await import("../lib/engines/lossless.mjs");
    const results = await lossless.search("test query", { maxResults: 5 });
    assert.ok(Array.isArray(results));
  });
});
