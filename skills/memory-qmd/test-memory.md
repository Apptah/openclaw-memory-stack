# QMD — Memory Backend Verification Checklist

Run these tests sequentially after `setup.sh` completes successfully.

## 1. Prerequisites

```bash
# Verify Bun runtime
bun --version
# Expected: version number (e.g., 1.x.x)

# Verify qmd CLI
qmd --version
# Expected: version number, no errors
```

- [ ] `bun --version` prints a version number
- [ ] `qmd --version` prints a version number

## 2. Store — Create and Index a Test Collection

```bash
# Create a temporary test directory
mkdir -p /tmp/qmd-test-memory
echo "# Auth Module\nThis module handles JWT authentication and session management." > /tmp/qmd-test-memory/auth.md
echo "# Payment Flow\nRetry logic for failed payment transactions using exponential backoff." > /tmp/qmd-test-memory/payment.md
echo "# User Service\nCRUD operations for user accounts, profile updates, and deletion." > /tmp/qmd-test-memory/user.md

# Add collection
qmd collection add test-mem --pattern "**/*.md" --path /tmp/qmd-test-memory

# Generate embeddings
qmd embed test-mem
```

- [ ] `qmd collection add` succeeds without errors
- [ ] `qmd embed` completes and reports indexed file count (should be 3)

## 3. Retrieve — Get a Specific Document

```bash
qmd get qmd://test-mem/auth.md
```

- [ ] Returns the content of `auth.md`
- [ ] Output includes the file path and content

## 4. Search — BM25 Keyword

```bash
qmd search "JWT authentication" -c test-mem --minScore 0.1
```

- [ ] Returns `auth.md` as a result
- [ ] Raw relevance score is in the 0.1-0.4 range (this is normal for BM25)
- [ ] Results are valid JSON or structured output

## 5. Search — Vector Semantic

```bash
qmd vsearch "how does login work" -c test-mem --minScore 0.3
```

- [ ] Returns `auth.md` as a top result (semantic match: login ~ authentication)
- [ ] Relevance score is in the 0.0-1.0 range
- [ ] Semantic understanding: matches "authentication" even though query says "login"

## 6. Search — Hybrid

```bash
qmd query "retry failed transactions" -c test-mem --minScore 0.3
```

- [ ] Returns `payment.md` as a top result
- [ ] Combines keyword and semantic signals

## 7. Output Format — Verify Contract Compliance

All search results, when wrapped by the router, must match this structure:

```json
{
  "query_echo": "JWT authentication",
  "results": [
    {
      "content": "...",
      "relevance": 0.82,
      "source": "qmd",
      "timestamp": "ISO8601"
    }
  ],
  "result_count": 1,
  "status": "success",
  "error_message": null,
  "error_code": null,
  "backend_duration_ms": 150,
  "normalized_relevance": 0.82,
  "backend": "qmd"
}
```

- [ ] `query_echo` matches the original query string
- [ ] `results` is an array of objects with `content`, `relevance`, `source`, `timestamp`
- [ ] `source` is `"qmd"`
- [ ] `status` is one of: `success`, `partial`, `empty`, `error`
- [ ] `backend` is `"qmd"`

## 8. Relevance Normalization

Verify the normalization formula: `normalized = min(raw * 3, 1.0)`

| Raw BM25 Score | Expected Normalized | Pass? |
|----------------|---------------------|-------|
| 0.10 | 0.30 | [ ] |
| 0.15 | 0.45 | [ ] |
| 0.20 | 0.60 | [ ] |
| 0.25 | 0.75 | [ ] |
| 0.33 | 0.99 | [ ] |
| 0.34+ | 1.00 (capped) | [ ] |

- [ ] Scores below 0.34 are multiplied by 3
- [ ] Scores at or above 0.34 are capped at 1.0
- [ ] Vector search scores (vsearch) are NOT normalized (already 0.0-1.0)

## 9. Edge Cases

### Empty collection
```bash
mkdir -p /tmp/qmd-test-empty
qmd collection add test-empty --pattern "**/*.md" --path /tmp/qmd-test-empty
qmd embed test-empty
qmd search "anything" -c test-empty
```
- [ ] Returns empty results, not an error
- [ ] Status should be `empty` (via router) or zero results

### No matches above threshold
```bash
qmd search "xyzzynonexistent12345" -c test-mem --minScore 0.1
```
- [ ] Returns empty results or very low scores
- [ ] Does not crash or error

### Special characters in query
```bash
qmd search "func handleAuth() -> Bool" -c test-mem --minScore 0.1
```
- [ ] Query with parentheses and arrow does not cause parsing errors
- [ ] Returns results or empty — no crash

### Collection does not exist
```bash
qmd search "test" -c nonexistent-collection-xyz
```
- [ ] Returns a clear error message about missing collection
- [ ] Error code should map to `BACKEND_ERROR`

## 10. Cleanup

```bash
qmd collection remove test-mem
qmd collection remove test-empty
rm -rf /tmp/qmd-test-memory /tmp/qmd-test-empty
```

- [ ] Collections removed cleanly
- [ ] Temp files cleaned up

## Summary

| Test Area | Status |
|-----------|--------|
| Prerequisites | [ ] |
| Store (collection + embed) | [ ] |
| Retrieve (get) | [ ] |
| Search — BM25 | [ ] |
| Search — Vector | [ ] |
| Search — Hybrid | [ ] |
| Output format | [ ] |
| Relevance normalization | [ ] |
| Edge cases | [ ] |
