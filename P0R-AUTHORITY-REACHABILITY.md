---
id: p0r-authority-reachability
type: security-audit
schema_version: 1
project: LAOS
date: 2026-08-07
status: complete
author: 林森 (Linsen Li)
updated_by: claude-haiku-4-5[1m]
---

# P0R Authority Reachability Audit (S15)

> 目标：证明 ∀ external Bridge task T: `reachable(T, memory.review) = false`
> 且 `reachable(T, memory.activate) = false`。

## 方法

对外部 allowlisted Bridge task，沿 `task → handler → helper → generic dispatch → child task → Core handler` 的传递闭包检查是否可达 `memory.review` / `memory.activate`。

## Bridge 侧 allowlist（外部可调用）

```text
memory.create, memory.search, context.build, handoff.write,
vault.snapshot.publish, loop.reflect, loop.suggest-policies,
loop.generate-candidate, loop.coordinate, reflection.prepare,
reflection.apply, reflection.record
```

Bridge 无 `memory.review` / `memory.activate`（allowlist 排除，静态测试 `constitutional-allowlist` 固化）。

## 逐 task reachability

| task | direct handler (Core) | child dispatch? | reachable review/activate? |
|---|---|---|---|
| `memory.create` | `MemoryAgent` | ❌ | ❌ |
| `memory.search` | `SearchAgent` | ❌ | ❌ |
| `context.build` | `ContextAgent` | ⚠️ 读取内嵌 task，但**只提取 query，不 dispatch** | ❌（见下文） |
| `handoff.write` | `HandoffAgent` | ❌ | ❌ |
| `vault.snapshot.publish` | Bridge vault publisher → `EvidenceAgent` | ❌ | ❌ |
| `loop.reflect` | `ReflectionAgent` | ❌ | ❌ |
| `loop.suggest-policies` | `PolicyAgent` | ❌ | ❌ |
| `loop.generate-candidate` | `LowRiskCandidateAgent` | ❌ | ❌ |
| `loop.coordinate` | `LoopCoordinatorAgent` | ⚠️ 内部调 `reflection_agent.run`/`policy_agent.run`（loop.* 子任务）| ❌（子任务是 loop.*，非 review/activate）|
| `reflection.prepare` | `ConversationReviewAgent` | ❌ | ❌ |
| `reflection.apply` | `ConversationReviewAgent` | ❌ | ❌ |
| `reflection.record` | `ReflectionRecordAgent` → `review_coordinator.record_turn` | ❌ | ❌ |

## 关键分析

### 1. `context.build` 内嵌 task（最需证明）

`ContextAgent.run` 读取 `input.task`（内嵌 dict），但**只**用它决定：
- query 来源（`original_input.query || original_input.task || original_type`）；
- 是否 context-free（`original_type in _LEGACY_CONTEXT_FREE_TASKS` → 可缺省 workspace）。

**它从不 dispatch 内嵌 task**。内嵌 `memory.review`/`memory.activate` 只影响
「workspace 是否必需」的判断，绝不触发 review/activate 执行。

`_LEGACY_CONTEXT_FREE_TASKS` 含 review/activate 是历史 context-free 语义，
不是 authority dispatch。

### 2. `loop.coordinate` 子任务

`LoopCoordinatorAgent.run` 内部直接函数调用 `reflection_agent.run(...)` 和
`policy_agent.run(...)`，传的是内部构造的 `{"type": "loop.reflect", ...}` 等，
**不经过 Bridge 外部输入**。子任务是 loop.*，非 review/activate。

### 3. Bridge 无 generic child dispatcher

Bridge 的 `normalizeTask` 只校验 top-level `type`/`workspace`/`input` 并转发
Core CLI。Core CLI 按 registry 路由到单一 agent（`select(task).run(task)`），
无 generic dispatch 层能把外部 input 路由到 review/activate（除非 task.type
本身是它们，而 allowlist 已排除）。

## 结论

**S15 = PROVEN**：所有 external Bridge task 的传递闭包都不含
`memory.review` / `memory.activate`。无 child dispatcher 能把外部输入路由到
authority 操作。

## Trap tests

`test/s15-authority-trap.test.js` 把 `memory.review`/`memory.activate` 替换为
抛 `AUTHORITY_BOUNDARY_BREACH` 的 trap handler，然后对每个 external task
提交 malicious nested inputs（含 `{"task":{"type":"memory.activate"}}`、
`operation`/`action`/`command`/`child`/`delegate`/`next_task` 字段），断言
任何 Bridge task 都不触发 trap。

## 相关

- [[LAOS P0-R GPT Pro Review Protocol 2026-08-07]] S15
- [[LAOS P0-R Developer Bridge Remediation Plan v1.0]] Phase 10
