---
id: p0r-ingress-map
type: security-map
schema_version: 1
project: LAOS
date: 2026-08-07
status: complete
author: 林森 (Linsen Li)
updated_by: claude-haiku-4-5[1m]
---

# P0R Ingress Map — 生产 evidence 入口

> Phase 0 产物。修改代码前先确定所有 evidence 入口。

## Baseline（本轮开始）

| 仓 | HEAD | tree |
|---|---|---|
| Developer Bridge | `f8cc1f2d49eea57dcef9c042ad14b279754e33b0` | `9e191e955779faf10268a0d7696564c80fe37b09` |
| ws-gpt Core | `225296fdb86088754b8de432ce1a7f4f6452498f` | `521b59f8d4fb8f53c6f363b3dee636e48033f02c` |

## Evidence 入口表

| 入口 | 调用者 | 外部可调用? | dispatcher | target | 可构造 source identity? | 可构造 payload? | 可触发 child task? |
|---|---|---|---|---|---|---|---|
| `laos_memory_task` → `evidence.publish` | external caller | ✅ | Bridge `normalizeScopedTask` → `normalizeEvidenceTask` | Core `EvidenceAgent` → `publish_source_artifact_v2` | ✅（caller 提交 source）| ✅（caller 提交 payload）| ❌ |
| `bin/vault-evidence` CLI | 本地运维 | ⚠️ 本地 CLI | `buildLaosEvidencePublisher` → `normalizeEvidenceIngress` → Core CLI | Core `EvidenceAgent` | ❌（从 Vault read）| ❌（从 Vault read）| ❌ |
| `laos_memory_task` → 其他 task | external caller | ✅ | Bridge scope gate | Core 各 agent | ❌（非 evidence）| ❌ | ❌（Bridge 无 child dispatch）|
| Core CLI `--task-json` 直调 | 仅 Bridge spawn | ❌ 非网络暴露 | Core Orchestrator registry | 按 task type | ✅（若被外部触发）| ✅ | ❌（Core 无外部 child）|

## 关键判断

1. **Bridge allowlist 含 `evidence.publish`**（`src/laos-memory-tool.js:15`）——external caller 可直接调用，
   提交任意 `source`/`payload`，这是 **GP-01** 目标。计划 Phase 1 从 external allowlist 移除。
2. **`bin/vault-evidence`** 走 `normalizeEvidenceIngress` + Vault read，是 Bridge-owned 路径，
   但它是本地 CLI（运维），非 external network surface。其 input 构造受 Vault read 约束。
3. **Core CLI 不对 external caller 暴露**：`laos.py` 无网络端口，仅被 Bridge spawn。
   `build_review_transport` 是 review RPC transport，非 evidence ingress。→ **无 production direct-Core evidence bypass**。
4. **Core registry 注册了 `memory.review`/`memory.activate`**——这是 Core authority 正常注册。
   Bridge allowlist 不含它们（S15 目标：证明无传递可达路径）。
5. **Bridge 无 generic child dispatcher**：`dispatch`/`child`/`next_task` 命中均为
   `github_actions_dispatch`（无关）或注释。LAOS task 是直接透传 Core CLI。

## 结论

- 存在一条 external caller → Bridge → `evidence.publish` → Core 的路径，且 caller 可自由构造
  source identity + payload（GP-01 需封闭）。
- 无 direct-Core evidence bypass（Core 非网络暴露）。
- 无 child dispatch 层（S15 的传递闭包相对简单：Bridge task → Core 单层）。

**Gate 0 PASS** — ingress map 完成，进入 Phase 1。
