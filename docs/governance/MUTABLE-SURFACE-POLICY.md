---
id: mutable-surface-policy
type: governance
status: ratified-v1
schema_version: 1
project: LAOS
date: 2026-08-07
author: 林森 (Linsen Li)
updated_by: claude-haiku-4-5[1m]
---

# LAOS Mutable Surface Policy v1.0

> 定义 LAOS 的「可修改面」与「不可修改面」。任何改动必须先分类再执行：
> 不可修改面上的变更 = 需重新红队；可修改面上的变更 = 需人工审核 + 测试回归。

## 1. 不可修改面（frozen / authority）

以下在任何常规开发中**不得修改**。修改即触发完整 Red Team 重新审计：

| 面 | 理由 |
|---|---|
| `memory.review` | 权威链核心 |
| `memory.activate` | 权威链核心 |
| Review Gate | 权威链核心 |
| AuthorityStore | 权威链核心 |
| generation CAS | 权威链核心 |
| activation receipt | 权威链核心 |
| active-memory visibility | 权威链核心 |
| Bridge allowlist 的 authority 排除（memory.review/activate） | C-INV-20 |

## 2. 可修改面（mutable — 需人工审核 + 回归测试）

| 面 | 约束 |
|---|---|
| Bridge 统一 scope gate（`normalizeScopedTask`） | 变更需 F-01 回归全 PASS |
| Evidence Hash Semantics（三种 SHA） | 变更需 golden vectors 全 PASS + 跨语言一致 |
| Vault snapshot / stable read | 变更需 TOCTOU 测试全 PASS |
| Partition map | 变更需 deep-freeze 测试全 PASS |
| YAML parser | 变更需 fail-closed 测试全 PASS |
| projectmem trust semantics | 变更需 binding-state 测试全 PASS |
| build identity（`laos_bridge_info`） | 变更需 C-INV-19 测试全 PASS |
| Core EvidenceArtifactStore v2 | 变更需 Core 全量 1123+ PASS |

## 3. 判断流程

1. 定位变更面。
2. 若属不可修改面 → 停止，进入 Red Team 重新审计流程。
3. 若属可修改面 → 先写 RED 测试 → 最小修复 → 目标测试 PASS → 全量 PASS →
   人工审核 → 人工授权 commit。

## 4. 新增能力（本版本禁止）

Console / 联网 / Model Gateway / Multimodal / Background Scheduler /
Self Evolution / Agent Swarm / 自动 Vault watcher。属 P1+。

## 相关

- `LAOS-CONSTITUTION.md`（不变量全文）
- `docs/adr/evidence-hash-semantics-v1.md`（三种 SHA 冻结）
- `docs/adr/ADR-vault-evidence-chain.md`（证据链架构）
