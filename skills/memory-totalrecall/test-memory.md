# Total Recall — Verification Checklist

Run these tests after `setup.sh` completes successfully. Each test includes exact commands and expected outcomes. All commands assume you are at the project repository root.

---

## Prerequisites

```bash
# Confirm setup completed — branch exists
git show-ref --verify refs/heads/openclaw-memory
# Expected: a commit hash followed by refs/heads/openclaw-memory

# Confirm _memory/ directory exists on the branch
git ls-tree --name-only openclaw-memory _memory/
# Expected: .gitkeep
```

---

## Test 1: Store a Memory

**Goal**: Create a memory entry and verify it exists on the memory branch.

```bash
# Save current branch
CURRENT=$(git rev-parse --abbrev-ref HEAD)

# Switch to memory branch
git checkout openclaw-memory

# Create memory file
TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%S")
FILENAME="_memory/${TIMESTAMP}_test-store-entry.md"

cat > "$FILENAME" << 'EOF'
---
key: test-store-entry
timestamp: 2026-03-17T14:30:00Z
tags: [test, verification]
---

# Test Store Entry

This is a test memory stored by the verification checklist.
The auth service uses JWT tokens with RS256 signing.
EOF

git add "$FILENAME"
git commit -m "memory: test-store-entry — verification test memory"

# Switch back
git checkout "$CURRENT"
```

**Verify** (without switching branches):
```bash
# File exists on memory branch
git ls-tree openclaw-memory _memory/ | grep "test-store-entry"
# Expected: shows the file entry with its blob hash

# Commit message is searchable
git log openclaw-memory --grep="test-store-entry" --oneline
# Expected: "memory: test-store-entry — verification test memory"
```

**Pass criteria**: File appears in `git ls-tree` AND commit appears in `git log --grep`.

---

## Test 2: Retrieve by Key

**Goal**: Retrieve a memory by its key and read its content without switching branches.

```bash
# Find the commit by key
COMMIT=$(git log openclaw-memory --grep="memory: test-store-entry" --format="%H" --max-count=1)
echo "Commit: $COMMIT"
# Expected: a 40-character SHA hash

# Get the file path from that commit
FILEPATH=$(git diff-tree --no-commit-id --name-only -r "$COMMIT" | grep "_memory/")
echo "File: $FILEPATH"
# Expected: _memory/YYYY-MM-DDTHH-MM-SS_test-store-entry.md

# Read the file content from the memory branch
git show "openclaw-memory:$FILEPATH"
# Expected: full markdown content including frontmatter and body
```

**Verify**: Output contains the string "JWT tokens with RS256 signing".

**Pass criteria**: File content is retrieved correctly without switching branches.

---

## Test 3: Search by Pattern

**Goal**: Search memory file contents for keyword patterns.

```bash
# Search commit messages on the memory branch
git log openclaw-memory --grep="test" --format="%ai %s"
# Expected: at least one line showing the test-store-entry commit

# Search file contents (keyword in file body)
git grep "JWT" openclaw-memory -- "_memory/"
# Expected: line(s) containing "JWT" from the test file

# Search with context lines
git grep -n -C 1 "RS256" openclaw-memory -- "_memory/"
# Expected: the RS256 line plus one line of surrounding context

# Case-insensitive search
git grep -i "jwt" openclaw-memory -- "_memory/"
# Expected: same results as the case-sensitive "JWT" search
```

**Pass criteria**: All four search commands return results containing content from the test memory.

---

## Test 4: Output Format (Contract Compliance)

**Goal**: Verify the agent can construct valid contract JSON from git command output.

After retrieving a memory, the agent must produce JSON in this exact structure:

```json
{
  "query_echo": "test-store-entry",
  "results": [
    {
      "content": "This is a test memory stored by the verification checklist. The auth service uses JWT tokens with RS256 signing.",
      "relevance": 1.0,
      "source": "totalrecall",
      "timestamp": "2026-03-17T14:30:00Z"
    }
  ],
  "result_count": 1,
  "status": "success",
  "error_message": null,
  "error_code": null,
  "backend_duration_ms": 50,
  "normalized_relevance": 1.0,
  "backend": "totalrecall"
}
```

**Verify each field**:
- [ ] `query_echo` matches the original query string
- [ ] `results` is an array (even for a single result)
- [ ] Each result has `content`, `relevance`, `source`, `timestamp`
- [ ] `relevance` is a float between 0.0 and 1.0
- [ ] `source` is `"totalrecall"`
- [ ] `timestamp` is ISO 8601 format
- [ ] `status` is one of: `success`, `partial`, `empty`, `error`
- [ ] `backend` is `"totalrecall"`
- [ ] `normalized_relevance` equals the highest relevance among all results
- [ ] `result_count` equals the length of `results` array

**Pass criteria**: All checkboxes satisfied.

---

## Test 5: Relevance (Time-Decay Scoring)

**Goal**: Verify the time-decay relevance formula produces correct values.

**Formula**: `relevance = max(0.2, 1.0 - (days_ago * 0.043))`

```bash
# Get the commit date of the test memory
git log openclaw-memory --grep="memory: test-store-entry" --format="%ai" --max-count=1
# Expected: today's date
```

**Verify with known inputs**:

| days_ago | Calculation | Expected relevance |
|----------|-------------|--------------------|
| 0 | max(0.2, 1.0 - 0.000) | **1.000** |
| 3 | max(0.2, 1.0 - 0.129) | **0.871** |
| 7 | max(0.2, 1.0 - 0.301) | **0.699** |
| 14 | max(0.2, 1.0 - 0.602) | **0.398** |
| 19 | max(0.2, 1.0 - 0.817) | **0.200** (floor) |
| 30 | max(0.2, 1.0 - 1.290) | **0.200** (floor) |
| 365 | max(0.2, 1.0 - 15.695) | **0.200** (floor) |

**Key observations**:
- The floor is always 0.2 — memories never score below this.
- Memories older than ~19 days all score 0.2.
- The formula produces a smooth decay, not discrete jumps.

**Pass criteria**: Agent computes correct relevance for each row in the table.

---

## Test 6: Edge Cases

### 6a: Empty query

```bash
git log openclaw-memory --grep="" --format="%H %s" --max-count=5
# Note: empty grep matches everything in git
```

**Expected agent behavior**: Return status `"empty"` with error_code `"EMPTY_RESULT"` rather than returning all memories. The agent must validate input before running the git command.

### 6b: Non-existent key

```bash
git log openclaw-memory --grep="memory: nonexistent-key-xyz-999" --format="%H" --max-count=1
# Expected: no output (empty result)
```

**Expected response**:
```json
{
  "query_echo": "nonexistent-key-xyz-999",
  "results": [],
  "result_count": 0,
  "status": "empty",
  "error_message": null,
  "error_code": "EMPTY_RESULT",
  "backend_duration_ms": 15,
  "normalized_relevance": 0.0,
  "backend": "totalrecall"
}
```

### 6c: Special characters in content

```bash
CURRENT=$(git rev-parse --abbrev-ref HEAD)
git checkout openclaw-memory

TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%S")
cat > "_memory/${TIMESTAMP}_special-chars-test.md" << 'EOF'
---
key: special-chars-test
timestamp: 2026-03-17T15:00:00Z
tags: [test, edge-case]
---

# Special Characters Test

Content with "double quotes", 'single quotes', `backticks`, $variables,
angle <brackets>, ampersands & more, pipes | here,
and unicode: kanji, accented letters, em-dashes.
EOF

git add "_memory/${TIMESTAMP}_special-chars-test.md"
git commit -m "memory: special-chars-test — edge case verification"
git checkout "$CURRENT"

# Verify retrieval preserves special characters
COMMIT=$(git log openclaw-memory --grep="memory: special-chars-test" --format="%H" --max-count=1)
FILEPATH=$(git diff-tree --no-commit-id --name-only -r "$COMMIT" | grep "_memory/")
git show "openclaw-memory:$FILEPATH" | grep "double quotes"
# Expected: the line with all special characters intact
```

**Pass criteria**: All special characters are stored and retrieved without corruption.

### 6d: Memory branch missing (error handling)

```bash
# If the memory branch does not exist, git commands fail:
git log nonexistent-branch --grep="test" --format="%H" 2>&1
# Expected: fatal: bad default revision 'nonexistent-branch'
```

**Expected agent response**:
```json
{
  "query_echo": "test",
  "results": [],
  "result_count": 0,
  "status": "error",
  "error_message": "Memory branch 'openclaw-memory' not found. Run setup.sh to initialize.",
  "error_code": "BACKEND_UNAVAILABLE",
  "backend_duration_ms": 5,
  "normalized_relevance": 0.0,
  "backend": "totalrecall"
}
```

---

## Cleanup

Remove test entries after all tests pass:

```bash
CURRENT=$(git rev-parse --abbrev-ref HEAD)
git checkout openclaw-memory
git rm _memory/*test-store-entry* _memory/*special-chars-test* 2>/dev/null || true
git commit -m "memory: cleanup — remove verification test entries" --allow-empty
git checkout "$CURRENT"
```

---

## Summary

| # | Test | Description | Pass? |
|---|------|-------------|-------|
| 1 | Store | Create memory file and commit on memory branch | [ ] |
| 2 | Retrieve | Query by key, read file without switching branches | [ ] |
| 3 | Search | Keyword search across memory file contents | [ ] |
| 4 | Output | Contract JSON has all required fields and correct types | [ ] |
| 5 | Relevance | Time-decay formula produces correct scores | [ ] |
| 6a | Edge: empty query | Agent rejects empty query with EMPTY_RESULT | [ ] |
| 6b | Edge: missing key | Agent returns empty status for non-existent key | [ ] |
| 6c | Edge: special chars | Special characters survive store/retrieve round-trip | [ ] |
| 6d | Edge: no branch | Agent returns BACKEND_UNAVAILABLE error | [ ] |

All 9 checks must pass for Total Recall to be considered operational.
