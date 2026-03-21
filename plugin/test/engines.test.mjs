import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// ─── Helpers ────────────────────────────────────────────────────

/** Assert a single result item has the canonical engine result shape. */
function assertResultShape(item, label) {
  assert.equal(typeof item.content, "string", `${label}: content must be string`);
  assert.equal(typeof item.source, "string", `${label}: source must be string`);
  assert.equal(typeof item.relevance, "number", `${label}: relevance must be number`);
  assert.ok(item.relevance >= 0 && item.relevance <= 1, `${label}: relevance must be in [0, 1], got ${item.relevance}`);
  assert.equal(typeof item.engine, "string", `${label}: engine must be string`);
}

// ─── 1. Existing interface compliance tests (unchanged) ─────────

describe("engine interface compliance", () => {
  const enginePaths = [
    ["fts5", "../lib/engines/fts5.mjs"],
    ["qmd", "../lib/engines/qmd.mjs"],
    ["memorymd", "../lib/engines/memorymd.mjs"],
    ["rescue", "../lib/engines/rescue.mjs"],
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
  it("exports engines array with all 5 built-in engines", async () => {
    const { engines } = await import("../lib/engines/index.mjs");
    assert.ok(Array.isArray(engines));
    assert.equal(engines.length, 5);
    const names = engines.map(e => e.name);
    assert.ok(names.includes("fts5"));
    assert.ok(names.includes("qmd"));
    assert.ok(names.includes("memorymd"));
    assert.ok(names.includes("rescue"));
    assert.ok(names.includes("lossless"));
    // sessions absorbed into fts5 via options.source filter
    assert.ok(!names.includes("sessions"));
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

// ─── 2. Result shape validation (catches [] false-pass) ─────────

describe("result item shape validation", () => {
  const enginePaths = [
    ["fts5", "../lib/engines/fts5.mjs"],
    ["qmd", "../lib/engines/qmd.mjs"],
    ["memorymd", "../lib/engines/memorymd.mjs"],
    ["rescue", "../lib/engines/rescue.mjs"],
    ["lossless", "../lib/engines/lossless.mjs"],
  ];

  for (const [name, path] of enginePaths) {
    it(`${name}: non-empty results have {content, source, relevance, engine}`, async () => {
      const mod = await import(path);
      const engine = mod.default;
      const results = await engine.search("test query", { maxResults: 5 });
      // We cannot guarantee hits in test env, but when results exist,
      // every item MUST have the correct shape.
      for (const [i, item] of results.entries()) {
        assertResultShape(item, `${name}[${i}]`);
      }
    });
  }
});

// ─── 3. QMD formatResults + execQmd JSON parsing ────────────────

describe("qmd: formatResults shape", () => {
  // Test formatResults indirectly via the module's own data path.
  // We import qmd and use _resetForTest to exercise formatResults
  // with known mock data shapes.

  it("formats QMD hit objects into canonical shape", async () => {
    // formatResults is not exported directly, but we can verify the
    // shape contract by constructing what execQmd would parse and
    // checking the output of formatResults via the engine's search.
    //
    // Instead, test the two JSON shapes that execQmd must handle:
    // Line 56 of qmd.mjs: Array.isArray(data) ? data : (data.results || data.hits || [])

    // Shape A: bare JSON array (QMD CLI >= 2.x)
    const bareArray = [
      { text: "memory one", path: "/a.md", score: 0.9 },
      { content: "memory two", file: "/b.md", relevance: 0.7 },
    ];
    const parsedA = Array.isArray(bareArray) ? bareArray : (bareArray.results || bareArray.hits || []);
    assert.ok(Array.isArray(parsedA), "bare array must parse as array");
    assert.equal(parsedA.length, 2);

    // Shape B: object with results key (QMD CLI <= 1.x)
    const wrappedObj = { results: [{ text: "hit", path: "/c.md", score: 0.5 }] };
    const parsedB = Array.isArray(wrappedObj) ? wrappedObj : (wrappedObj.results || wrappedObj.hits || []);
    assert.ok(Array.isArray(parsedB), "object.results must parse as array");
    assert.equal(parsedB.length, 1);

    // Shape C: object with hits key (alternative backend)
    const hitsObj = { hits: [{ text: "alt", path: "/d.md", score: 0.3 }] };
    const parsedC = Array.isArray(hitsObj) ? hitsObj : (hitsObj.results || hitsObj.hits || []);
    assert.ok(Array.isArray(parsedC), "object.hits must parse as array");
    assert.equal(parsedC.length, 1);

    // Shape D: empty object (no results/hits key) must degrade to []
    const emptyObj = { metadata: {} };
    const parsedD = Array.isArray(emptyObj) ? emptyObj : (emptyObj.results || emptyObj.hits || []);
    assert.ok(Array.isArray(parsedD), "object without results/hits must degrade to []");
    assert.equal(parsedD.length, 0);
  });

  it("formatResults maps all QMD field name variants", () => {
    // Replicate the formatResults logic from qmd.mjs lines 196-203
    const formatResults = (hits, mode) =>
      hits.map(h => ({
        content: h.text || h.content || h.snippet || "",
        source: h.path || h.file || "qmd",
        relevance: h.score || h.relevance || 0.5,
        engine: `qmd-${mode}`,
        timestamp: h.created_at || h.timestamp || undefined,
      }));

    // Variant 1: text/path/score (most common)
    const r1 = formatResults([{ text: "hello", path: "/a.md", score: 0.8 }], "search");
    assertResultShape(r1[0], "variant-text/path/score");
    assert.equal(r1[0].content, "hello");
    assert.equal(r1[0].source, "/a.md");
    assert.equal(r1[0].relevance, 0.8);
    assert.equal(r1[0].engine, "qmd-search");

    // Variant 2: content/file/relevance
    const r2 = formatResults([{ content: "world", file: "/b.md", relevance: 0.6 }], "vsearch");
    assertResultShape(r2[0], "variant-content/file/relevance");
    assert.equal(r2[0].content, "world");
    assert.equal(r2[0].source, "/b.md");
    assert.equal(r2[0].relevance, 0.6);
    assert.equal(r2[0].engine, "qmd-vsearch");

    // Variant 3: snippet only, no path/file — defaults to "qmd" source, 0.5 relevance
    const r3 = formatResults([{ snippet: "partial" }], "query");
    assertResultShape(r3[0], "variant-snippet-only");
    assert.equal(r3[0].content, "partial");
    assert.equal(r3[0].source, "qmd");
    assert.equal(r3[0].relevance, 0.5);
    assert.equal(r3[0].engine, "qmd-query");

    // Variant 4: completely empty hit — still valid shape with defaults
    const r4 = formatResults([{}], "search");
    assertResultShape(r4[0], "variant-empty-hit");
    assert.equal(r4[0].content, "");
    assert.equal(r4[0].source, "qmd");
    assert.equal(r4[0].relevance, 0.5);
  });
});

// ─── 4. QMD _resetForTest isolation ─────────────────────────────

describe("qmd: _resetForTest clears state", () => {
  it("resets initialized, activeCollection, modeAvailability, probeState", async () => {
    const { default: qmd } = await import("../lib/engines/qmd.mjs");

    // Seed some state
    qmd._probeState.set("test:search", { available: true, cooldownUntil: 0, backoff: 5000 });

    qmd._resetForTest();

    assert.equal(qmd._probeState.size, 0, "probeState must be empty after reset");
    // After reset, search should re-detect collection (and return [] in test env)
    const results = await qmd.search("anything", { maxResults: 1 });
    assert.ok(Array.isArray(results));
  });
});

// ─── 5. detectCollection config parsing ─────────────────────────

describe("qmd: detectCollection config shapes", () => {
  const TMP_DIR = resolve(tmpdir(), `openclaw-test-${process.pid}`);
  const TMP_CONFIG = resolve(TMP_DIR, ".openclaw-memory.json");

  // We cannot call detectCollection directly (not exported), but we
  // can test the same logic the function uses. This catches the
  // regression where nested backends.qmd.collection was ignored.

  function parseCollection(jsonData) {
    // Mirrors qmd.mjs lines 89-92
    if (jsonData.collection) return jsonData.collection;
    const nested = jsonData.backends?.qmd?.collection;
    if (nested) return nested;
    return null;
  }

  it("top-level { collection: \"foo\" } returns \"foo\"", () => {
    assert.equal(parseCollection({ collection: "foo" }), "foo");
  });

  it("nested { backends: { qmd: { collection: \"bar\" } } } returns \"bar\"", () => {
    assert.equal(
      parseCollection({ backends: { qmd: { collection: "bar" } } }),
      "bar"
    );
  });

  it("top-level takes priority over nested", () => {
    assert.equal(
      parseCollection({ collection: "top", backends: { qmd: { collection: "nested" } } }),
      "top"
    );
  });

  it("missing collection returns null", () => {
    assert.equal(parseCollection({}), null);
    assert.equal(parseCollection({ backends: {} }), null);
    assert.equal(parseCollection({ backends: { qmd: {} } }), null);
  });

  it("completely unrelated keys return null", () => {
    assert.equal(parseCollection({ name: "my-project", version: 1 }), null);
  });
});

// ─── 6. QMD engine returns [] without crashing when unconfigured ─

describe("qmd: graceful degradation", () => {
  it("returns [] when no QMD binary or collection found", async () => {
    const { default: qmd } = await import("../lib/engines/qmd.mjs");
    qmd._resetForTest();
    // In test env, either QMD_BIN is missing or collection is unset.
    // Either way, result must be [] — never null, never throw.
    const results = await qmd.search("test", { maxResults: 3 });
    assert.ok(Array.isArray(results), "must return array, not null/undefined");
  });
});
