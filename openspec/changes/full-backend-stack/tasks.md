## 0. Phase 0 — 定義與去 Tier 化 ✅

- [x] 0.1 定義四態模型文件
- [x] 0.2 修改 `router.sh` — ready/degraded 拆分 + 確定性排序
- [x] 0.3 驗證 router 排序
- [x] 0.3b 驗證 co-primary degraded demotion
- [x] 0.4 去 tier 化 `build-release.sh`
- [x] 0.5 去 tier 化 `bin/openclaw-memory`
- [x] 0.6 去 tier 化 `install.sh`
- [x] 0.7 審查 `lib/license.sh`
- [x] 0.8 測試 build-release.sh
- [x] 0.9 測試 CLI help
- [x] 0.10 Commit

## 1. Phase 1 — Health Check 基礎 + Capability Matrix

- [x] 1.1 新增 `contract_health()` 到 `lib/contracts.sh`
- [x] 1.2 建立 `skills/memory-qmd/capability.json`
- [x] 1.3 建立 `skills/memory-totalrecall/capability.json`
- [x] 1.4 新增 `cmd_health` 到 qmd wrapper（讀 capability.json probe）
- [x] 1.5 新增 `cmd_health` 到 totalrecall wrapper
- [x] 1.6 測試三級 probe
- [x] 1.7 Commit
- [ ] 1.8 修改 `router.sh` — dispatch 時讀 `capability.json` `supported_modes`，跳過不支援當前 hint 的 backend
- [ ] 1.9 測試：hint=exact 時 router 跳過 supported_modes 不含 exact 的 backend
- [ ] 1.10 Commit: "feat: router filters dispatch by capability supported_modes"
- [ ] 1.11 新增 CLI `health` 子命令到 `bin/openclaw-memory`（支援 `--deep` 透傳）
- [ ] 1.12 測試 `openclaw-memory health`
- [ ] 1.13 Commit: "feat: add CLI health subcommand with --deep support"

## 2. Phase 2a — OpenViking Wrapper (retrieval_engine, Python)

- [ ] 2.1 驗證 openviking API：`pip install openviking`，確認 `import openviking as ov`、`SyncOpenViking` / `AsyncOpenViking` API
- [ ] 2.2 建立 `skills/memory-openviking/capability.json`（supported_modes: [semantic, exact]，requires_credentials: true — 需 VLM+Embedding，可用 OpenClaw 現有 LLM API）
- [ ] 2.3 建立 `skills/memory-openviking/wrapper.sh`（Layer A: ov.find/ov.add_resource, Layer B: adapter, Layer C: cmd_health 讀 capability.json）
- [ ] 2.4 建立 `tests/fixtures/openviking-mock-response.json`
- [ ] 2.5 測試 health + mock adapter
- [ ] 2.6 Commit: "feat: add OpenViking retrieval_engine wrapper"

## 3. Phase 2b — Vertex Wrapper (memory_store, npm plugin + GCP)

- [ ] 3.1 驗證 vertex plugin：確認 `openclaw-vertexai-memorybank` npm package 和 `memorybank_search` / `memorybank_remember` API
- [ ] 3.2 建立 `skills/memory-vertex/capability.json`（requires_credentials: true, requires_external_service: true — GCP 帳號）
- [ ] 3.3 建立 `skills/memory-vertex/wrapper.sh`（Layer A: memorybank CLI commands, Layer B: adapter, Layer C: cmd_health — L1 check npm package, L2 check GCP creds, L3 probe API）
- [ ] 3.4 建立 `tests/fixtures/vertex-mock-response.json`
- [ ] 3.5 測試 health + mock adapter
- [ ] 3.6 Commit: "feat: add Vertex memory_store wrapper (Vertex AI Memory Bank)"

## 4. Phase 2c — Nowledge Wrapper (knowledge_graph, REST API)

- [ ] 4.1 驗證 Nowledge Mem API：確認 `http://127.0.0.1:14242` endpoints（/api/memories/search, /api/memories, /api/threads）
- [ ] 4.2 建立 `skills/memory-nowledge/capability.json`（supported_modes: [relationship, semantic, timeline], requires_external_service: true — 需本地 server running）
- [ ] 4.3 建立 `skills/memory-nowledge/wrapper.sh`（Layer A: curl REST API, Layer B: adapter, Layer C: cmd_health — L1 check curl, L2 check port 14242, L3 probe endpoint）
- [ ] 4.4 建立 `tests/fixtures/nowledge-mock-response.json`
- [ ] 4.5 測試 health + mock adapter
- [ ] 4.6 Commit: "feat: add Nowledge knowledge_graph wrapper (Nowledge Mem REST API)"

## 5. Phase 2d — Lossless Wrapper (context_engine, OpenClaw plugin)

- [ ] 5.1 驗證 lossless-claw：確認 `openclaw plugins install @martian-engineering/lossless-claw` 和 lcm_grep/lcm_describe/lcm_expand tools
- [ ] 5.2 建立 `skills/memory-lossless/capability.json`（supported_modes: [decision, timeline], requires_credentials: false）
- [ ] 5.3 建立 `skills/memory-lossless/wrapper.sh`（Layer A: lcm_grep/lcm_describe/lcm_expand, Layer B: adapter, Layer C: cmd_health — L1 check plugin installed, L2 check SQLite DAG, L3 probe lcm_describe）
- [ ] 5.4 建立 `tests/fixtures/lossless-mock-response.json`
- [ ] 5.5 測試 health + mock adapter
- [ ] 5.6 Commit: "feat: add Lossless context_engine wrapper (lossless-claw)"

## 6. Phase 3 — Router、Installer、Build 更新

- [ ] 6.1 更新 `router-config.json`：移除 cognee/brainx，確認 4 classes 5 backends
- [ ] 6.2 移除 `router-config.starter.json`（如存在）
- [ ] 6.3 測試 router dispatch
- [ ] 6.4 Commit: "feat: update router config — 5 backends, 4 classes"
- [ ] 6.5 更新 `install.sh`：新增 runtime bootstrap helpers + `--skip-models`
- [ ] 6.6 更新 `install.sh`：動態讀取 `capability.json` `install_hint` 安裝依賴
- [ ] 6.7 測試 install.sh
- [ ] 6.8 Commit: "feat: overhaul installer — auto-install runtimes via capability.json"
- [ ] 6.9 確認 `build-release.sh` 驗證每個 backend 含 `wrapper.sh` + `capability.json`
- [ ] 6.10 Commit（if needed）

## 7. Phase 4 — 整合測試

- [ ] 7.1 建立 `tests/integration/test-all-backends-health.sh`
- [ ] 7.2 建立 `tests/integration/test-capability-consistency.sh`
- [ ] 7.3 執行整合測試
- [ ] 7.4 Commit: "test: add health + capability consistency integration tests"
- [ ] 7.5 執行 `openclaw-memory health`
- [ ] 7.6 執行 `build-release.sh`
- [ ] 7.7 最終驗證：artifact 解壓 → install.sh --skip-models → openclaw-memory health
