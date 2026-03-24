/**
 * posting.mjs — Binary posting file reader/writer for Phase 3 grep
 *
 * File format:
 * - lookup.bin: [entry count (uint32)] + sorted array of { hash: uint32, trigramLen: uint8, trigram: string, offset: uint32, dataLen: uint32, count: uint32 }
 * - postings.bin: concatenated chunk ID strings, null-separated, grouped by trigram
 *
 * Collision safety: lookup stores the original trigram string, verified on read.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

export class PostingWriter {
  constructor(postingsPath, lookupPath) {
    this.postingsPath = postingsPath;
    this.lookupPath = lookupPath;
    this.entries = new Map(); // trigram → string[]
  }

  addPosting(trigram, chunkIds) {
    this.entries.set(trigram, chunkIds);
  }

  flush() {
    const postingChunks = [];
    const lookupEntries = [];
    let offset = 0;

    // Sort by hash for binary search
    const sorted = [...this.entries.entries()]
      .map(([trigram, ids]) => ({ trigram, ids, hash: fnv1a32(trigram) }))
      .sort((a, b) => a.hash - b.hash);

    for (const { trigram, ids, hash } of sorted) {
      const data = ids.join("\0");
      const dataBytes = Buffer.from(data, "utf-8");
      postingChunks.push(dataBytes);
      lookupEntries.push({ hash, trigram, offset, count: ids.length, dataLen: dataBytes.length });
      offset += dataBytes.length;
    }

    writeFileSync(this.postingsPath, Buffer.concat(postingChunks));

    // lookup.bin: [entry count (uint32)] + [entries...]
    // Entry: hash(4) + trigramLen(1) + trigram(N) + offset(4) + dataLen(4) + count(4)
    const entryBuffers = lookupEntries.map(e => {
      const trigramBuf = Buffer.from(e.trigram, "utf-8");
      const buf = Buffer.alloc(4 + 1 + trigramBuf.length + 4 + 4 + 4);
      let pos = 0;
      buf.writeUInt32LE(e.hash, pos); pos += 4;
      buf.writeUInt8(trigramBuf.length, pos); pos += 1;
      trigramBuf.copy(buf, pos); pos += trigramBuf.length;
      buf.writeUInt32LE(e.offset, pos); pos += 4;
      buf.writeUInt32LE(e.dataLen, pos); pos += 4;
      buf.writeUInt32LE(e.count, pos);
      return buf;
    });

    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(lookupEntries.length, 0);

    writeFileSync(this.lookupPath, Buffer.concat([countBuf, ...entryBuffers]));
  }
}

export class PostingReader {
  constructor(postingsPath, lookupPath) {
    this.postingsPath = postingsPath;
    this.lookupPath = lookupPath;
    this._postings = null;
    this._entries = null;
  }

  _load() {
    if (this._postings) return;
    if (!existsSync(this.postingsPath) || !existsSync(this.lookupPath)) {
      this._postings = Buffer.alloc(0);
      this._entries = [];
      return;
    }

    this._postings = readFileSync(this.postingsPath);
    const lookupBuf = readFileSync(this.lookupPath);

    const count = lookupBuf.readUInt32LE(0);
    this._entries = [];

    let pos = 4;
    for (let i = 0; i < count; i++) {
      const hash = lookupBuf.readUInt32LE(pos); pos += 4;
      const trigramLen = lookupBuf.readUInt8(pos); pos += 1;
      const trigram = lookupBuf.subarray(pos, pos + trigramLen).toString("utf-8"); pos += trigramLen;
      const offset = lookupBuf.readUInt32LE(pos); pos += 4;
      const dataLen = lookupBuf.readUInt32LE(pos); pos += 4;
      const entryCount = lookupBuf.readUInt32LE(pos); pos += 4;
      this._entries.push({ hash, trigram, offset, dataLen, count: entryCount });
    }
  }

  lookup(trigram) {
    this._load();
    const hash = fnv1a32(trigram);

    // Binary search in sorted entries
    let lo = 0, hi = this._entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const entry = this._entries[mid];
      if (entry.hash < hash) lo = mid + 1;
      else if (entry.hash > hash) hi = mid - 1;
      else {
        // Hash match — verify trigram string (collision safety)
        if (entry.trigram === trigram) {
          const data = this._postings.subarray(entry.offset, entry.offset + entry.dataLen).toString("utf-8");
          return data.split("\0").filter(Boolean);
        }
        // Hash collision — linear scan neighbors
        let found = null;
        for (let j = mid - 1; j >= 0 && this._entries[j].hash === hash; j--) {
          if (this._entries[j].trigram === trigram) { found = this._entries[j]; break; }
        }
        if (!found) {
          for (let j = mid + 1; j < this._entries.length && this._entries[j].hash === hash; j++) {
            if (this._entries[j].trigram === trigram) { found = this._entries[j]; break; }
          }
        }
        if (found) {
          const data = this._postings.subarray(found.offset, found.offset + found.dataLen).toString("utf-8");
          return data.split("\0").filter(Boolean);
        }
        return [];
      }
    }
    return [];
  }
}
