## Context

OpenClaw Memory Stack 深度綁定 starter/2-backend 模型。波及面：

| 檔案 | tier 假設 |
|------|----------|
| `router.sh:136` | 只認 `status == "ready"`，degraded 被剪掉 |
| `build-release.sh:11,34-38,54-60,69-73,44-50` | Starter 標題、swap `.starter.json`、拒絕 tier 2/3 目錄、驗證 2 classes、`version.json` 寫 tier |
| `bin/openclaw-memory:42` | 寫死 `Backends: qmd, totalrecall` |
| `bin/openclaw-memory:128` | `.openclaw-memory.json` 寫 tier 欄位 |
| `install.sh` | 只枚舉 2 backend 的 runtime check |
| `lib/license.sh` | `license_field "tier"` 被 init 流程引用 |

現有 wrapper 中 `cmd_status` 是 native 工具狀態透傳（qmd → `qmd status`，totalrecall → `git branch`），與系統層 health check 是不同職責。

## Goals / Non-Goals

**Goals:**
- 定義四態模型 + router 對每態的處理策略
- 系統性去除所有 tier/starter 假設
- 建立 capability matrix 讓 router 做正確分流
- 8 個 backend wrapper 達到 `installed` 狀態，通過 probe 的達到 `ready`
- CLI `health` 子命令聚合所有 backend 即時 probe

**Non-Goals:**
- Subscription/付費系統 → 獨立 plan
- 讓所有 8 個 backend 在全新機器上都達 `ready`（第三方依賴不可控）
- Windows 原生支援
- Backend 效能調優

## Decisions

### D1: 四態模型定義 + 三級 probe

**四態：**
```
installed   → L1 pass, L2 fail — wrapper 存在、CLI/package 可 import，但 runtime 依賴不齊（缺模型、缺 DB、缺 venv）
ready       → L1+L2+L3 pass — functional probe 通過，可接受查詢，結果可靠
degraded    → L1+L2 pass, L3 fail — runtime 齊全但 functional probe 失敗（無 index、連不上服務、缺憑證）
unavailable → L1 fail — CLI/package 不存在
```

**三級 probe（由 `capability.json` 的 `probe` 欄位定義，`cmd_health` 執行）：**

| Level | 檢查內容 | 範例 |
|-------|---------|------|
| L1: install | CLI/package 可執行或可 import | `command -v qmd` / `python3 -c "import cognee"` |
| L2: runtime | 模型、DB、venv、config 等 runtime 依賴 | `[ -d ~/.cache/qmd/models ]` / `[ -f ~/.openclaw/venv/bin/activate ]` |
| L3: functional | 真實操作 probe（trivial query、write+read、connection test） | `qmd status --json \| python3 -c "..."` / `cognee.search("ping")` |

**路由語義（確定性排序）：**

dispatch chain 順序固定為：
1. Primary class `ready` backends（按 config 順序）
2. Fallback class `ready` backends（按 config 順序）
3. Primary class `degraded` backends（按 config 順序）
4. Fallback class `degraded` backends（按 config 順序）

即：**先窮盡所有 ready（primary + fallback），再試 degraded。** 不是「同 class 內 ready 先於 degraded」。

Router 修改位置：`router.sh` `build_dispatch_chain` — 將 available set 拆為 `ready_set` 和 `degraded_set`，先 chain ready，再 append degraded。

**替代方案A:** degraded 完全不路由 → QMD 沒下載 models 時連 BM25 都不能用。
**替代方案B:** 同 class 內 ready→degraded 再跳 fallback class → 會優先用 primary 的殘缺結果而不是 fallback 的完整結果，品質更差。

### D2: `health` vs `status` 語義分離

| 概念 | 命令 | 職責 | 回傳格式 |
|------|------|------|---------|
| Health probe | `wrapper.sh health` → `cmd_health()` | 系統層：回報四態 + 原因 | `contract_health` JSON |
| Native status | `wrapper.sh status` → `cmd_status()` | 工具層：透傳原生工具輸出 | 各工具原生格式 |
| CLI 聚合 | `openclaw-memory health` | 迭代所有 wrapper `cmd_health`，聚合顯示 | 表格 |

CLI 不新增 `status` 子命令，避免與 native `status` 語義撞車。

### D3: Capability Matrix 作為機器可讀 single source of truth

每個 backend 在 wrapper 同目錄放 `capability.json`，是該 backend 能力的唯一事實來源。Router、installer、`cmd_health`、tests 全部從這個檔案讀取，不允許在其他地方硬編碼 backend 能力判斷。

```json
{
  "capability_version": 1,
  "backend": "qmd",
  "supported_modes": ["exact", "semantic", "grep"],
  "requires_credentials": false,
  "requires_external_service": false,
  "cold_start_ms": 200,
  "probe": {
    "l1_install": "command -v qmd",
    "l2_runtime": "[ -d \"$HOME/.cache/qmd/models\" ] && [ -n \"$(ls -A \"$HOME/.cache/qmd/models\" 2>/dev/null)\" ]",
    "l3_functional": "qmd status --json 2>/dev/null | python3 -c \"import json,sys; d=json.load(sys.stdin); exit(0 if d.get('documents',{}).get('total',0)>0 else 1)\"",
    "l3_deep": null
  },
  "install_hint": "bun install -g @tobilu/qmd"
}
```

**Schema 演進：** `capability_version: 1` 鎖定初始 schema。消費者檢查此欄位，遇到不認識的版本將 backend 標為 `unavailable` 而非 crash。未來加欄位時 bump version。

**L3 probe 成本控制：**
- 預設 `l3_functional` 必須唯讀、5 秒 timeout（`OPENCLAW_PROBE_TIMEOUT` 可調）
- `l3_deep`（可選）允許 write+read round-trip，只在 `--deep` flag 下執行
- deep probe 寫入必須用 `__openclaw_probe_*` temp namespace 並清理

**消費者：**
- `cmd_health()`: 讀 `probe` 欄位，依序執行 L1→L2→L3（或 L3_deep），判定四態
- `router.sh`: 讀 `supported_modes`，比對 rule hint，跳過不支援的 backend
- `install.sh`: 讀 `install_hint`，動態安裝
- `build-release.sh`: 驗證 `capability.json` 存在
- `tests/`: 讀 `probe` 欄位驗證 health check 行為；驗證 `capability_version` 欄位存在

**替代方案A:** 放在 router-config.json → 耦合 router 和 backend 細節，wrapper 更新時改兩處。
**替代方案B:** 只做文件不做 config → router/installer/health/tests 各自複製能力判斷，很快漂移。

### D4: 去 tier 化策略

**一次性清除，不做向後相容：**
- `build-release.sh`: 移除 `.starter.json` swap、tier 2/3 拒絕邏輯、2 class 驗證；改為動態發現 `skills/memory-*/wrapper.sh` 並驗證完整性
- `version.json`: 移除 `tier` 欄位
- `bin/openclaw-memory --help`: 動態列舉已安裝 backend（從 `$INSTALL_ROOT/skills/memory-*/` 掃描）
- `bin/openclaw-memory init`: `.openclaw-memory.json` 移除 `tier` 欄位，backends 區段動態生成
- `install.sh`: 動態迭代 `skills/memory-*/` 而非硬編碼列表
- `lib/license.sh`: `license_field "tier"` 的呼叫點改為不影響 backend 可用性判斷

**理由:** 產品已決定移除 tier 分層，保留相容 shim 只增加複雜度。

### D5: 共用 Python venv + 非致命安裝

與前版相同。`$HOME/.openclaw/venv`，`uv venv --python 3.12`，每個 Python package install failure 用 warn 處理。

### D6: Result 解析改用 temp file

新 wrappers 用 temp file 分離 JSON array 和 metadata，避免 `read -r` 空格問題。既有 wrappers 不動。

### D7: `--skip-models` flag

QMD 模型下載 (~2.1GB) 預設執行但可用 `--skip-models` 跳過。

## Risks / Trade-offs

| Risk | Impact | Mitigation |
|------|--------|------------|
| 去 tier 化波及 license.sh 邏輯 | 可能影響付費驗證流程 | 只移除 tier 對 backend availability 的影響，不動 license 驗證本身 |
| capability matrix 維護負擔 | 每次新增 backend 要更新 | 放在 wrapper 同目錄，由 wrapper 作者維護 |
| degraded 路由降權但結果品質差 | 用戶拿到不完整結果 | router envelope 已有 `status: "partial"` 語義，前端可據此提示 |
| 第三方 Python API 與預期不符 | 單一 backend 停在 `installed` | 四態模型允許 graceful degradation |
| 去 tier 後 build 變大 | artifact 包含所有 backend | 未安裝依賴的 backend 只是 shell script，幾 KB |
