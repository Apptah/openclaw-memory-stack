// plugin/test/posting.test.mjs
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PostingWriter, PostingReader } from "../lib/posting.mjs";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("posting file", () => {
  let testDir;
  before(() => { testDir = mkdtempSync(join(tmpdir(), "posting-test-")); });

  it("writes and reads posting lists", () => {
    const postingsPath = join(testDir, "postings.bin");
    const lookupPath = join(testDir, "lookup.bin");

    const writer = new PostingWriter(postingsPath, lookupPath);
    writer.addPosting("abc", ["chunk1", "chunk2", "chunk3"]);
    writer.addPosting("def", ["chunk2", "chunk4"]);
    writer.addPosting("xyz", ["chunk1"]);
    writer.flush();

    assert.ok(existsSync(postingsPath));
    assert.ok(existsSync(lookupPath));

    const reader = new PostingReader(postingsPath, lookupPath);
    const abcIds = reader.lookup("abc");
    assert.deepEqual(new Set(abcIds), new Set(["chunk1", "chunk2", "chunk3"]));

    const defIds = reader.lookup("def");
    assert.deepEqual(new Set(defIds), new Set(["chunk2", "chunk4"]));

    const missing = reader.lookup("zzz");
    assert.deepEqual(missing, []);
  });

  it("handles hash collisions by verifying trigram string", () => {
    const postingsPath = join(testDir, "collision-postings.bin");
    const lookupPath = join(testDir, "collision-lookup.bin");

    const writer = new PostingWriter(postingsPath, lookupPath);
    writer.addPosting("abc", ["chunk1"]);
    writer.addPosting("abd", ["chunk2"]);
    writer.flush();

    const reader = new PostingReader(postingsPath, lookupPath);
    const abcIds = reader.lookup("abc");
    assert.ok(abcIds.includes("chunk1"));
    // abd should return its own posting, not abc's
    const abdIds = reader.lookup("abd");
    assert.ok(abdIds.includes("chunk2"));
  });

  it("handles missing files gracefully", () => {
    const reader = new PostingReader(
      join(testDir, "nonexistent-postings.bin"),
      join(testDir, "nonexistent-lookup.bin")
    );
    const ids = reader.lookup("abc");
    assert.deepEqual(ids, []);
  });
});
