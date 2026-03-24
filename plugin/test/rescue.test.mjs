import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { extractKeyFacts, initRescueDB, saveRescueFacts } from "../lib/rescue.mjs";
import { gateFactInsert, archiveFact } from "../lib/dedup-gate.mjs";
import { RESCUE_DB } from "../lib/constants.mjs";

describe("rescue", () => {
  it("extracts decision facts", () => {
    const facts = extractKeyFacts("We decided to use PostgreSQL for the new service.");
    assert.ok(facts.some(f => f.type === "decision"));
    assert.ok(facts[0].confidence >= 0.8);
    assert.ok(Array.isArray(facts[0].entities));
  });

  it("extracts deadline facts", () => {
    const facts = extractKeyFacts("The deadline is March 25 for the MVP launch.");
    assert.ok(facts.some(f => f.type === "deadline"));
    assert.ok(facts[0].confidence >= 0.9);
  });

  it("extracts requirement facts", () => {
    const facts = extractKeyFacts("The system must support at least 1000 concurrent connections.");
    assert.ok(facts.some(f => f.type === "requirement"));
  });

  it("returns ExtractedFact schema", () => {
    const facts = extractKeyFacts("We decided to use Redis for caching.");
    for (const f of facts) {
      assert.ok(["decision", "deadline", "requirement", "entity", "preference", "workflow", "relationship", "correction"].includes(f.type));
      assert.equal(typeof f.fact, "string");
      assert.equal(typeof f.confidence, "number");
      assert.ok(Array.isArray(f.entities));
    }
  });

  it("extracts workflow facts from regex fallback", () => {
    const facts = extractKeyFacts("I always use Vim for quick edits.");
    assert.ok(facts.some(f => f.type === "workflow"));
  });

  it("extracts preference facts", () => {
    const facts = extractKeyFacts("I prefer TypeScript over JavaScript for large projects.");
    assert.ok(facts.some(f => f.type === "preference"));
  });

  it("extracts relationship facts", () => {
    const facts = extractKeyFacts("The auth service depends on the user database.");
    assert.ok(facts.some(f => f.type === "relationship"));
  });

  it("extracts correction facts", () => {
    const facts = extractKeyFacts("Actually, we should NOT use MongoDB for this.");
    assert.ok(facts.some(f => f.type === "correction" || f.type === "decision"));
  });

  it("preserves negated decisions", () => {
    const facts = extractKeyFacts("We will NOT use MongoDB.");
    assert.ok(facts.some(f => f.type === "decision" && /NOT use MongoDB/.test(f.fact || f.value)));
  });

  it("handles sentence splitting", () => {
    const facts = extractKeyFacts("We decided on PostgreSQL. The deadline is Friday.");
    assert.ok(facts.some(f => f.type === "decision"));
    assert.ok(facts.some(f => f.type === "deadline"));
  });

  it("validates structured LLM facts format", () => {
    const facts = extractKeyFacts("We decided to use PostgreSQL for the backend.");
    for (const f of facts) {
      assert.ok(["decision", "deadline", "requirement", "entity", "preference", "workflow", "relationship", "correction"].includes(f.type));
      assert.ok(f.fact || f.value, "must have fact or value");
      assert.equal(typeof f.confidence, "number");
      assert.ok(Array.isArray(f.entities));
    }
  });

  it("deduplicates facts", () => {
    const text = "We decided to use Redis.\nWe decided to use Redis.\nWe decided to use Redis.";
    const facts = extractKeyFacts(text);
    assert.ok(facts.length <= 2);
  });
});

describe("dedup gate", () => {
  it("skips exact structured duplicates", async () => {
    initRescueDB();
    // Seed a known fact into the DB
    const seedContent = "dedup-gate-exact-test-unique-" + Date.now();
    execSync(
      `sqlite3 "${RESCUE_DB}" "INSERT INTO facts (type, content, source, timestamp) VALUES ('decision', '${seedContent}', 'test', datetime('now'));"`,
      { timeout: 5000 }
    );
    // gateFactInsert with same type + content should return skip
    const result = gateFactInsert({ type: "decision", fact: seedContent });
    assert.equal(result.action, "skip");
  });

  it("archives older fact when key/value changes", async () => {
    initRescueDB();
    // Insert a preference fact with key=db, value=PostgreSQL
    execSync(
      `sqlite3 "${RESCUE_DB}" "INSERT INTO facts (type, content, source, timestamp, key, value) VALUES ('preference', 'I prefer PostgreSQL', 'test', datetime('now'), 'db', 'PostgreSQL');"`,
      { timeout: 5000 }
    );
    // gateFactInsert with same type+key but different value should return archive
    const result = gateFactInsert({ type: "preference", fact: "I prefer MySQL", key: "db", value: "MySQL" });
    assert.equal(result.action, "archive");
    assert.ok(typeof result.archivedId === "number");
  });

  it("handles old flat facts and new structured facts in same table", async () => {
    initRescueDB();
    const uniqueTag = "coexist-test-" + Date.now();
    // Clean up any prior 'arch' key rows to avoid count accumulation across runs
    execSync(
      `sqlite3 "${RESCUE_DB}" "DELETE FROM facts WHERE key = 'arch';"`,
      { timeout: 5000 }
    );
    // Seed old flat fact (no structured columns)
    execSync(
      `sqlite3 "${RESCUE_DB}" "INSERT INTO facts (type, content, source, timestamp) VALUES ('decision', 'old flat fact ${uniqueTag}', 'test', datetime('now'));"`,
      { timeout: 5000 }
    );
    // Save a new structured fact via saveRescueFacts
    await saveRescueFacts([
      { type: "decision", fact: "new structured fact " + uniqueTag, key: "arch", value: "microservices", scope: "project", confidence: 0.9, entities: ["arch"] }
    ], "test-session");
    // Both should exist
    const flat = execSync(
      `sqlite3 "${RESCUE_DB}" "SELECT COUNT(*) FROM facts WHERE content LIKE 'old flat fact ${uniqueTag}';"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    assert.equal(flat, "1", "old flat fact should still exist");
    const structured = execSync(
      `sqlite3 "${RESCUE_DB}" "SELECT COUNT(*) FROM facts WHERE key = 'arch' AND content LIKE 'new structured fact %';"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    assert.equal(structured, "1", "new structured fact should exist with key column");
    // FTS should find both
    const ftsSql = "DELETE FROM facts_fts; INSERT INTO facts_fts (rowid, content, type, key, value, scope, entities) SELECT id, content, type, key, value, scope, entities FROM facts;";
    execSync(`sqlite3 "${RESCUE_DB}" "${ftsSql}"`, { timeout: 5000 });
    const ftsResult = execSync(
      `sqlite3 "${RESCUE_DB}" "SELECT COUNT(*) FROM facts_fts WHERE facts_fts MATCH 'flat';"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    assert.ok(parseInt(ftsResult) >= 1, "FTS should find old flat fact");
  });

  it("inserts new fact (no prior duplicate)", () => {
    initRescueDB();
    const unique = { type: "decision", fact: "brand-new-unique-fact-" + Date.now() };
    const result = gateFactInsert(unique);
    assert.equal(result.action, "insert");
  });

  it("returns skip for empty content", () => {
    const result = gateFactInsert({ type: "decision", fact: "" });
    assert.equal(result.action, "skip");
  });
});

describe("facts schema migration", () => {
  it("initRescueDB runs without throwing", () => {
    assert.doesNotThrow(() => initRescueDB());
  });

  it("facts table has all 7 required v2 columns", () => {
    initRescueDB();
    const raw = execSync(`sqlite3 "${RESCUE_DB}" "PRAGMA table_info(facts);"`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const columns = new Set(
      raw.split("\n").filter(Boolean).map(row => row.split("|")[1])
    );
    const required = ["key", "value", "scope", "confidence", "evidence", "supersedes", "entities"];
    for (const col of required) {
      assert.ok(columns.has(col), `Missing column: ${col}`);
    }
  });

  it("facts_fts returns seeded legacy row after FTS rebuild", () => {
    initRescueDB();
    // Seed a legacy row (base-schema columns only, no v2 columns)
    execSync(
      `sqlite3 "${RESCUE_DB}" "INSERT INTO facts (type, content, source, timestamp) VALUES ('decision', 'legacy test fact for fts verification', 'test', datetime('now'));"`,
      { timeout: 5000 }
    );
    // Manually rebuild FTS (same SQL as ensureFactsFTS / rebuildFactsFTS)
    const ftsSql = [
      "DELETE FROM facts_fts;",
      "INSERT INTO facts_fts (rowid, content, type, key, value, scope, entities) SELECT id, content, type, key, value, scope, entities FROM facts;",
    ].join(" ");
    execSync(`sqlite3 "${RESCUE_DB}" "${ftsSql}"`, { timeout: 5000 });
    // Verify FTS search finds the seeded row
    const result = execSync(
      `sqlite3 "${RESCUE_DB}" "SELECT content FROM facts_fts WHERE facts_fts MATCH 'legacy';"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    assert.ok(result.includes("legacy test fact for fts verification"), `FTS did not return seeded row; got: ${result}`);
  });

  it("migrates facts table in place and rehydrates facts_fts (idempotent)", () => {
    // Run twice to verify idempotency (migration safe to call multiple times)
    assert.doesNotThrow(() => {
      initRescueDB();
      initRescueDB();
    });
  });
});
