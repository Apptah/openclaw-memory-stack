## Why

OpenClaw Memory Stack 宣稱多引擎記憶架構，但只有 2 個可用 backend（QMD、TotalRecall）。整個產品從 installer、build、CLI、router state 到 license 系統都深度綁定 starter/2-backend 模型。需要補齊剩餘 3 個 backend 並系統性去除 tier 假設。

## What Changes

### Phase 0 — 去 tier 化 ✅ 已完成
### Phase 1 — Health Check 基礎 ✅ 部分完成（tasks 1.1-1.7）

### Phase 2 — 新增 3 個 Wrappers
- **OpenViking** (retrieval_engine) — openviking PyPI package，虛擬文件系統管理，Python
- **Vertex** (memory_store) — openclaw-vertexai-memorybank npm plugin，Google Vertex AI Memory Bank，需 GCP
- **Nowledge** (knowledge_graph) — Nowledge Mem (mem.nowledge.co)，本地 REST API :14242 + MCP

### Phase 3 — Lossless context_engine wrapper
- **Lossless** (context_engine) — @martian-engineering/lossless-claw OpenClaw npm plugin，DAG-based context management

### 移除的 Backends
- ~~Cognee~~ — 移除
- ~~BrainX~~ — 移除

## Capabilities

### New Capabilities
- `backend-state-model`: 四態定義 + 三級 probe + 路由語義 ✅
- `backend-capability-matrix`: capability.json 機器可讀配置 ✅
- `backend-health-check`: 統一 Layer C cmd_health 機制 ✅
- `cli-health`: openclaw-memory health 子命令
- `openviking-backend`: OpenViking retrieval engine wrapper (Python, 本地)
- `vertex-backend`: Vertex AI Memory Bank wrapper (npm plugin, GCP)
- `nowledge-backend`: Nowledge Mem wrapper (REST API + MCP)
- `lossless-backend`: Lossless-claw context engine wrapper (OpenClaw plugin)
- `runtime-bootstrap`: install.sh 自動安裝所有 runtime 依賴

### Modified Capabilities
- `router-dispatch`: 四態排序、移除 experimental class
- `build-release`: 動態打包，移除 tier 分層 ✅
- `installer`: 去 tier 化、動態 backend 發現 ✅
- `cli-help`: 動態列舉 backend ✅

## Impact

- **5 個 backend**（QMD、TotalRecall、OpenViking、Vertex、Nowledge）+ 1 個 context engine（Lossless）
- **wrapper 類型多樣化**: Bash CLI (qmd/git)、Python (openviking)、npm plugin (vertex/lossless)、REST API (nowledge)
- **外部依賴**: GCP 帳號 (vertex)、API key (nowledge)、LLM API (openviking 用 OpenClaw 現有 API 連接)
