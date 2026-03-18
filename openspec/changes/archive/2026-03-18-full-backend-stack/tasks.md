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
- [x] 1.8 修改 `router.sh` — dispatch 時讀 `capability.json` `supported_modes`，跳過不支援當前 hint 的 backend
- [x] 1.9 測試：capability filtering 正確（Python block 驗證通過，e2e 有 detect_rule stdin 衝突的既有 bug）
- [x] 1.10 Commit
- [x] 1.11 新增 CLI `health` 子命令到 `bin/openclaw-memory`（支援 `--deep` 透傳）
- [x] 1.12 測試 `openclaw-memory health` — 6 backends 全部回報正確狀態
- [x] 1.13 Commit

## 2. Phase 2a — OpenViking Wrapper (retrieval_engine, Python)

- [x] 2.1 驗證 openviking API
- [x] 2.2 建立 `skills/memory-openviking/capability.json`
- [x] 2.3 建立 `skills/memory-openviking/wrapper.sh`
- [x] 2.4 建立 `tests/fixtures/openviking-mock-response.json`
- [x] 2.5 測試 health → unavailable（未安裝，預期）
- [x] 2.6 Commit

## 3. Phase 2b — Vertex Wrapper (memory_store, 可選 — 用戶自行安裝)

- [x] 3.1 驗證 vertex plugin
- [x] 3.2 建立 `skills/memory-vertex/capability.json`（optional: true）
- [x] 3.3 建立 `skills/memory-vertex/wrapper.sh`
- [x] 3.4 tests/fixtures/vertex-mock-response.json（已存在）
- [x] 3.5 測試 health → unavailable（plugin 未裝，預期）
- [x] 3.6 Commit

## 4. Phase 2c — Nowledge Wrapper (knowledge_graph, REST API) ✅

- [x] 4.1 驗證 Nowledge Mem API
- [x] 4.2 建立 `skills/memory-nowledge/capability.json`
- [x] 4.3 建立 `skills/memory-nowledge/wrapper.sh`
- [x] 4.4 建立 `tests/fixtures/nowledge-mock-response.json`
- [x] 4.5 測試 health → installed（server 未跑，預期）
- [x] 4.6 Commit

## 5. Phase 2d — Lossless Wrapper (context_engine, OpenClaw plugin) ✅

- [x] 5.1 驗證 lossless-claw
- [x] 5.2 建立 `skills/memory-lossless/capability.json`
- [x] 5.3 建立 `skills/memory-lossless/wrapper.sh`
- [x] 5.4 建立 `tests/fixtures/lossless-mock-response.json`
- [x] 5.5 測試 health → unavailable（plugin 未裝，預期）
- [x] 5.6 Commit

## 6. Phase 3 — Router、Installer、Build 更新 ✅

- [x] 6.1 確認 router-config.json：4 classes, 6 backends (vertex optional)
- [x] 6.2 移除 router-config.starter.json
- [x] 6.3 測試 router dispatch
- [x] 6.4 No commit needed (already correct)
- [x] 6.5 更新 install.sh：runtime bootstrap + --skip-models
- [x] 6.6 更新 install.sh：capability.json install_hint，跳過 optional
- [x] 6.7 測試 install.sh syntax
- [x] 6.8 Commit
- [x] 6.9 build-release.sh 驗證 capability.json
- [x] 6.10 Commit

## 7. Phase 4 — 整合測試 ✅

- [x] 7.1 建立 test-all-backends-health.sh
- [x] 7.2 建立 test-capability-consistency.sh
- [x] 7.3 執行整合測試：0 failures（2 pass, 4 warnings）
- [x] 7.4 Commit
- [x] 7.5 執行 openclaw-memory health ✅
- [x] 7.6 執行 build-release.sh — 6 backends, 52K artifact
- [x] 7.7 最終驗證：artifact 含 6 backends, version.json 無 tier, 結構正確
