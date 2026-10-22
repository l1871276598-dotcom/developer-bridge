---
id: adr-vault-evidence-chain
type: adr
status: accepted
created: 2026-08-06
updated: 2026-08-06T13:40:00Z
tags: [adr, vault, provenance, evidence, developer-bridge]
---

# ADR: Vault Evidence Chain — External Source Provenance into Core Memory Authority

## Status

accepted（作者确认 2026-08-06；与本仓库既有 ADR `2026-08-06-retire-dual-bridge.md`
一致，不改变 Core Review/Activate 权威链）

## Context

LAOS 需要把外部知识源（Obsidian Vault note）接入可验证的记忆权威链。此前
Vault 与 Core 之间没有可验证的来源绑定：Vault note 既不在 Core data root 内，
Bridge 也没有把外部来源发布为不可变证据 artifact 的接口。

已冻结的前置组件：

- `evidence.publish`（Developer Bridge 允许清单内新增任务，已实现并生产验证）；
- `EvidenceArtifactStore`（Core `publish_source_artifact`，幂等、canonical、
  fail-closed，已存在）；
- Vault Snapshot Adapter（Bridge `src/vault/`，Node 模块 + `bin/vault-evidence`
  CLI，已实现）；
- projectmem v1（Bridge `src/projectmem/` + `bin/projectmem`，repo-local 缓存，
  已实现）。

## Decision

采用以下证据链，外部来源经 immutable artifact 进入 Core，再由既有
Review/Activate 双阶段权威链决定是否成为 active memory：

```text
Vault note
  |
  |  (Snapshot Adapter: note identity + canonical bytes)
  v
vault-note:<id>@<sha256>
  |
  |  (Developer Bridge)
  v
evidence.publish
  |
  v
EvidenceArtifactStore → artifact:<sha256>
  |
  |  (memory.create)
  v
candidate
  |
  |  (Review Gate)
  v
decision
  |
  |  (memory.activate + generation CAS + activation receipt)
  v
active memory
  |
  |  (context.build / memory.search)
  v
projectmem summary / handles
```

### 数据权威分层

| 对象 | 权威源 | 职责 |
|---|---|---|
| Vault note | Vault 原始 bytes + note identity | 事实来源，不决定 Core memory 是否 active |
| Evidence artifact | Core `publish_source_artifact` | 不可变、可验证来源绑定 |
| Core memory | Review decision + activation receipt + generation | active 状态唯一权威 |
| projectmem | repo-local manifest + 派生 summary | 只读缓存，无 authority |
| Developer Bridge | 传输 + allowlist + profile scope | 边界，不持有数据权威 |

## 不采用（明确记录）

1. **Vault 直接写 Core** — 拒绝。绕过 provenance 与 Review Gate，违反
   Untrusted Evidence → 人工授权的闭合链。
2. **projectmem 作为 memory authority** — 拒绝。projectmem 只缓存派生视图，
   无 review/activate 权限，不存 active memory 副本。
3. **自动同步全部 Vault** — 拒绝。v1 仅支持 explicit publish（
   `vault-evidence publish --note <path>`），禁止 filesystem watch / auto-publish。
4. **Bridge 暴露 `memory.review` / `memory.activate`** — 拒绝。Bridge 允许清单
   明确排除这两项；Review/Activate 仅存在于 Core 管理员路径。

## 安全边界

- **Scope 由 Bridge profile 固定**：workspace/project/confidentiality 来自
  `LAOS_CHECKPOINT_*`，caller 注入的冲突 scope 一律 `scope_mismatch` 拒绝。
- **Confidentiality ceiling 校验**：note 分区 confidentiality 超过 profile
  ceiling 时 `scope_exceeded` 拒绝。
- **Canonical bytes**：note identity 的 sha256 基于 canonical note bytes
  （UTF-8/LF/去 BOM/Front Matter canonical JSON），非原始磁盘 bytes。
- **Partition mapping 是唯一 scope 来源**：禁止从路径或 Front Matter 推断
  workspace/project/confidentiality。
- **Payload 上限 256 KiB**：超过拒绝，防止 artifact 膨胀。
- **Vault root 安全**：绝对路径、启动时 canonicalize、拒 symlink 逃逸、
  拒 note 路径越界。
- **无自动同步**：仅显式发布，无 watch / auto-publish。

## 影响

- 正面：Vault → Core 的 provenance 链闭合，外部知识源可成为可验证证据。
- 正面：projectmem 提供 Agent 工作层的 repo-local 上下文缓存。
- 负面/待办：真实 Vault 的 `01-Projects/LAOS` 分区若使用 `internal`
  confidentiality，需要在 Bridge profile 设 `LAOS_CHECKPOINT_CONFIDENTIALITY`
  匹配（当前环境未设，默认推导为 personal，`internal` 分区会 scope_exceeded
  ——这是安全正确的 fail-closed，但需配置）。
- 遗留：projectmem 的 `handoff.write`/`memory_create` 写策略为 `true`，但当前
  CLI 只做读（context.build + memory.search），写路径留待后续。
- 未修改：Core `src/review/authority.py`、`src/review/gate.py`、
  `memory.activate`、`memory.review`、generation CAS 均未触碰。

## 相关文件

- 本仓库：`src/vault/`、`src/projectmem/`、`bin/vault-evidence`、
  `bin/projectmem`、`docs/adr/ADR-vault-evidence-chain.md`
- Core：`src/review/source_refs.py`（`publish_source_artifact`）、
  `src/agents/evidence.py`（EvidenceAgent）
- 既有 ADR：`docs/…/2026-08-06-retire-dual-bridge.md`（单桥收敛）
