import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { ingestExternalMarkdown } from "../lib/external-ingest.mjs";
import { EXTERNAL_MEMORY_DIR, RESCUE_DB } from "../lib/constants.mjs";

const HOME = homedir();
const TEST_FILE = resolve(EXTERNAL_MEMORY_DIR, "_test-ingest-file.md");

function cleanTestFile() {
  try { rmSync(TEST_FILE); } catch { /* ignore */ }
}

function cleanIngestedRecord() {
  if (existsSync(RESCUE_DB)) {
    try {
      execSync(
        `sqlite3 "${RESCUE_DB}" "DELETE FROM ingested_files WHERE path = '${TEST_FILE.replace(/'/g, "''")}'"`,
        { timeout: 5000 }
      );
    } catch { /* ignore */ }
  }
}

before(() => {
  mkdirSync(EXTERNAL_MEMORY_DIR, { recursive: true });
  cleanTestFile();
  cleanIngestedRecord();
});

after(() => {
  cleanTestFile();
  cleanIngestedRecord();
});

describe("external-ingest", () => {
  it("ingests markdown files from external dir", async () => {
    writeFileSync(
      TEST_FILE,
      [
        "# Test Memory File",
        "",
        "- We decided to use PostgreSQL for the external ingest test.",
        "- The system must support concurrent writes.",
        "",
        "We prefer TypeScript over plain JavaScript for this project.",
      ].join("\n"),
      "utf-8"
    );

    const result = await ingestExternalMarkdown({});
    assert.ok(typeof result.ingested === "number", "result.ingested should be a number");
    assert.ok(typeof result.skipped === "number", "result.skipped should be a number");
    assert.ok(result.ingested >= 1, `Expected ingested >= 1, got ${result.ingested}`);
  });

  it("skips unchanged files using hash guard", async () => {
    // File already written and ingested in previous test — run again without changes
    const result = await ingestExternalMarkdown({});
    assert.ok(result.skipped >= 1, `Expected skipped >= 1, got ${result.skipped}`);
    assert.equal(result.ingested, 0, `Expected ingested === 0, got ${result.ingested}`);
  });

  it("re-ingests when file content changes", async () => {
    // Modify the file
    writeFileSync(
      TEST_FILE,
      [
        "# Updated Test Memory File",
        "",
        "- We agreed to migrate to a microservices architecture.",
        "- Deadline is April 1 for the first milestone.",
      ].join("\n"),
      "utf-8"
    );

    const result = await ingestExternalMarkdown({});
    assert.ok(result.ingested >= 1, `Expected ingested >= 1 after file change, got ${result.ingested}`);
  });
});
