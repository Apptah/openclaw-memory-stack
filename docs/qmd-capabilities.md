# QMD Capability Matrix

> Verified 2026-03-22. This document is the single source of truth for QMD capability assumptions in the Memory Stack architecture.

## Two-Layer Model

QMD capabilities are split into **product-level** (what the code supports) and **runtime-level** (what is reliably available on a given machine at a given moment).

### Product-Level Capability

| Command | Status | LLM Models Required | Notes |
|---------|--------|---------------------|-------|
| `qmd search -c <col>` | Supported | None | BM25 full-text. Scores 0.09-0.12. |
| `qmd vsearch -c <col>` | Supported | embedding (328MB) + generation (1.28GB) | Vector + HyDE expansion. Scores ~0.61. |
| `qmd query -c <col>` | Supported | embedding + generation + reranking (639MB) | BM25 + vector + Qwen3 reranking. Scores 0.46-0.90. |
| `qmd embed` | Supported | embedding (328MB) | Bulk indexing only. No `--text` CLI flag. |
| `qmd search` (no `-c`) | PROHIBITED | — | 169 collections, cross-contamination confirmed. |

### Runtime-Level Capability

| Command | Availability | Failure Mode |
|---------|-------------|--------------|
| `search -c` | ALWAYS | Pure BM25, no model loading needed. |
| `vsearch -c` | RUNTIME-GATED | Needs Metal GPU context for 2 GGUF models. |
| `query -c` | RUNTIME-GATED | Needs Metal GPU context for 3 GGUF models (~1.9GB total). |

**Why intermittent:** `node-llama-cpp` v3.14.5 creates Metal GPU contexts for each model. With 3 models loaded concurrently, context creation can fail under GPU memory pressure. Same machine, same code — one session succeeds, another crashes.

## Patch History

| Date | Issue | Fix |
|------|-------|-----|
| 2026-03-22 | `llm.ts:177` defaulted to Jina reranker v3 GGUF, which lacks `cls.weight` tensor | Patched to `hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` (matches GitHub main v1.1.5+) |

## Runtime Probe Protocol

### Probe Design

- Use a **fixed query known to hit the collection** (e.g. `"memory store save"`), not a generic string
- Success = exit code 0 AND ≥1 result with score > 0
- Failure = non-zero exit OR 0 results OR timeout

### Startup Probe

Run on engine initialization, in order:

1. `qmd search "<fixed>" -c <col> -n 1 --json` — if fails, disable QMD entirely
2. `qmd vsearch "<fixed>" -c <col> -n 1 --json` — if fails, mark vsearch unavailable
3. `qmd query "<fixed>" -c <col> -n 1 --json` — if fails, mark query unavailable

### State Scoping

- Probe state is **per-collection + per-mode**, not a global flag
- Key: `${collection}:${mode}` → `{ available: bool, cooldownUntil: timestamp }`
- Switching collection resets probe state for that collection

### Graceful Degradation (per request)

- `query` fails → if vsearch is probe-healthy, retry once with vsearch; else retry once with search. Return.
- `vsearch` fails → retry once with search. Return.
- `search` fails → return empty.
- **Never chain two fallbacks** in one request (no query→vsearch→search)
- **Never re-probe** a failed mode inside the request path

### Cooldown and Re-Probe

- On failure: set cooldown (e.g. 60s) for the failed mode
- After cooldown expires: next request triggers a single re-probe attempt
- If re-probe passes: restore mode
- If re-probe fails: extend cooldown (exponential backoff)

## Score Calibration Notes

When calibrating fusion scores (Phase 5), handle **two modes**:

| Mode | QMD Scores Available | Calibration Strategy |
|------|---------------------|---------------------|
| Full QMD (query available) | 0.46-0.90 (reranked) | Reranker output is well-calibrated. Focus calibration on other engines. |
| Search-only fallback | 0.09-0.12 (BM25) | BM25 scores are inherently low for code. Needs aggressive normalization. |

## Models on Disk

```
~/.cache/qmd/models/
  hf_ggml-org_embeddinggemma-300M-Q8_0.gguf        (328MB, embedding)
  hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf    (1.28GB, generation/expansion)
  hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf        (639MB, reranking)
  hf_jinaai_jina-reranker-v3-Q8_0.gguf             (640MB, UNUSED — lacks cls.weight)
```
