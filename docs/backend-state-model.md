# Backend State Model

## Four States

| State | Probe Level | Meaning | Router Dispatch |
|-------|-------------|---------|-----------------|
| `ready` | L1+L2+L3 pass | Fully operational, accepts queries | Normal priority in dispatch chain |
| `degraded` | L1+L2 pass, L3 fail | Runtime present but functional probe failed (no index, no connection, missing credentials) | Included after ALL ready backends exhausted |
| `installed` | L1 pass, L2 fail | CLI/package exists but runtime dependencies missing (no models, no DB, no venv) | Excluded from dispatch chain |
| `unavailable` | L1 fail | CLI/package not found | Excluded from dispatch chain |

## Three-Level Probe

Each backend's `capability.json` defines probe commands. `cmd_health` executes them in sequence:

| Level | Check | Example |
|-------|-------|---------|
| L1: install | CLI or package importable | `command -v qmd` / `python3 -c "import cognee"` |
| L2: runtime | Models, DB, venv, config present | `[ -d ~/.cache/qmd/models ]` |
| L3: functional | Real probe — read-only, 5s timeout | `qmd status --json \| ...` |
| L3_deep (optional) | Write+read round-trip, `--deep` only | temp namespace, auto-cleanup |

**State determination:** report = lowest passing level.
- L1 fail → `unavailable`
- L1 pass, L2 fail → `installed`
- L1+L2 pass, L3 fail → `degraded`
- L1+L2+L3 pass → `ready`

## Router Dispatch Chain Ordering

Deterministic. No ambiguity.

```
1. Primary class   — ready backends    (config order)
2. Fallback class  — ready backends    (config order)
3. Primary class   — degraded backends (config order)
4. Fallback class  — degraded backends (config order)
```

All `ready` backends (across both classes) are exhausted before any `degraded` backend is tried.

For rules with `dispatch_order` (co-primary): degraded backends from the explicit order are moved to the end of the chain, preserving their relative order.

## L3 Probe Constraints

- Default `l3_functional` MUST be read-only (no writes, no index creation, no paid API calls)
- 5-second timeout enforced (`OPENCLAW_PROBE_TIMEOUT` overrides)
- Timeout → report `degraded` with reason "probe timed out"
- `l3_deep` (optional) MAY write to `__openclaw_probe_*` temp namespace, must clean up
- Keyword scan in tests is a safety net, not a guarantee — implementors bear responsibility for L3 read-only compliance

## Health JSON Format

```json
{"backend": "<name>", "status": "<ready|degraded|installed|unavailable>", "reason": "<human-readable, includes remediation>"}
```

Produced by `contract_health()` in `lib/contracts.sh`.
