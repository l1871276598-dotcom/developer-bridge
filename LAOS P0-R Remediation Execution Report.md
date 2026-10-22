---
id: laos-p0r-remediation-execution-report
type: execution-report
schema_version: 1
project: LAOS
date: 2026-08-07
status: implementation-complete-ready-for-redteam
author: 林森 (Linsen Li)
updated_by: claude-haiku-4-5[1m]
final_verdict: "READY FOR INDEPENDENT RED-TEAM RE-REVIEW (NOT CLAIMED CONVERGED)"
---

# LAOS P0-R Remediation Execution Report

> 基于 GPT Pro 审查结果（GP-01..04、S7、S8、S10、S12、S13、S15）的第二轮执行。
> 每 phase 单独 commit。**最终状态 = READY FOR INDEPENDENT RED-TEAM RE-REVIEW**，
> 不自行宣布 CONVERGED（S8 有 PARTIAL RESIDUAL）。

---

## A. Baseline

| 仓 | commit | tree |
|---|---|---|
| Developer Bridge | `f8cc1f2d49eea57dcef9c042ad14b279754e33b0` | `9e191e955779faf10268a0d7696564c80fe37b09` |
| ws-gpt Core | `225296fdb86088754b8de432ce1a7f4f6452498f` | `521b59f8d4fb8f53c6f363b3dee636e48033f02c` |

## B. Final

| 仓 | commit | tree | porcelain |
|---|---|---|---|
| Developer Bridge | `43f4f954d3971359f50c4d525b98916f8e87d3b6` | `de5fa0b943f03f83063877f179bcaf4d68fd5f6c` | **0**（clean）|
| ws-gpt Core | `225296fdb86088754b8de432ce1a7f4f6452498f` | `521b59f8d4fb8f53c6f363b3dee636e48033f02c` | 非本轮残留（`.gitignore`/`docs/laos-core-next.md`，未触碰）|

> Bridge 分支：`p0r/developer-bridge-remediation`。Core 本轮未改动（evidence v2
> 已在上一轮 commit `225296f` 完成）。

## C. Commit list（Bridge，`f8cc1f2..HEAD`，11 个）

| hash | 标题 | 安全属性 | tests |
|---|---|---|---|
| `4d4b38b` | make vault evidence publication adapter-owned | GP-01 | 311 |
| `6f4efba` | unify canonical source byte contract | GP-02 | 321 |
| `de70901` | harden locator provenance | GP-03 | 334 |
| `6670e86` | detect same-inode mutation during read | S7 | 336 |
| `9e45425` | bind validated path to opened inode; record S8 residual | S8 | 337 |
| `1b82413` | fail closed on all unsupported yaml constructs | S10 | 353 |
| `9aec77f` | eliminate prototype-sensitive canonicalization | GP-04 | 358 |
| `5a8d2ea` | fail closed on malformed core handles | S12 | 363 |
| `66bd6d4` | make deployment metadata independently auditable | S13 | 365 |
| `62f483e` | prove review/activate unreachable from bridge tasks | S15 | 485 |
| `43f4f95` | red-team regression pack coverage manifest | RT-01..19 | 504 |

## D. Security invariant table

| finding | 状态 |
|---|---|
| GP-01 Synthetic Vault Evidence Forgery | **CLOSED** |
| GP-02 Source Byte Contract 分裂 | **CLOSED** |
| S7 stable-read TOCTOU | **CLOSED** |
| S8 Secure Open | **PARTIAL RESIDUAL**（见 E）|
| S10 YAML fail-closed 漏洞 | **CLOSED** |
| GP-03 Locator Provenance / Traversal | **CLOSED** |
| GP-04 canonicalJson prototype safety | **CLOSED** |
| S12 unknown handle fail-closed | **PROVEN** |
| S13 bridge_info 可审计性 | **PROVEN** |
| S15 indirect review/activate reachable | **PROVEN** |

## E. Remaining residuals（不隐藏）

1. **S8 = PARTIAL RESIDUAL**：Node v22 无 dirfd-relative openat（`process.binding`
   已移除），无法实现计划的 atomic dirfd-chain 模型。当前实现为
   「validate + inode binding + fd before/after 全字段校验」的组合防御——
   resolve→open 的 inode swap 被检测（测试 `S8: path swapped between
   validation and open`），同 inode 同 size mutation 被 ctime 检测。
   inode 不可伪造性闭合实际窗口，但非 atomic。详见
   `P0R-S8-SECURE-OPEN-STATUS.md`。**红队需裁决该 residual 是否可接受**。
2. **Core direct ingress**：Core CLI 仅被 Bridge spawn，非网络暴露；无
   production direct-Core evidence bypass（ingress map Gate 0 已证）。
   红队可独立复核。
3. **S15**：Bridge→review/activate 传递闭包为 PROVEN（trap tests 120/120），
   但 Core 侧 `context.build` 的 `_LEGACY_CONTEXT_FREE_TASKS` 仍含
   review/activate（历史 context-free 语义，非 dispatch）。红队应复核该
   语义不会成为未来 dispatch 入口。

## F. 测试结果

| 套件 | command | passed | failed | skipped | duration |
|---|---|---|---|---|---|
| Bridge | `npm test` | **504** | 0 | 0 | ~36s |
| Core | `python3.11 -m unittest discover -s tests` | **1131** | 0 | 0 | ~53s |
| Core compileall | `python3.11 -m compileall -q src tests` | PASS | - | - | - |
| Core git diff --check | `git diff --check` | PASS | - | - | - |

## G. 成功标准对照

| # | 成功标准 | 状态 |
|---|---|---|
| 1 | caller 不能伪造 Vault-backed evidence | ✅ GP-01 |
| 2 | trusted scope 只能来自 profile/partition | ✅ scope gate + vault partition |
| 3 | source bytes 只有一个定义 | ✅ GP-02 |
| 4 | locator 不能伪造跨路径 provenance | ✅ GP-03 |
| 5 | Vault read 检测 concurrent mutation | ✅ S7 |
| 6 | path validation 与实际 open 对象绑定 | ⚠️ S8 PARTIAL（inode 绑定，非 atomic）|
| 7 | unsupported YAML fail closed | ✅ S10 |
| 8 | canonical JSON 不受 JS prototype 影响 | ✅ GP-04 |
| 9 | malformed Core handle fail closed | ✅ S12 |
| 10 | bridge_info 可独立审计且无副作用 | ✅ S13 |
| 11 | Bridge→review/activate 无传递可达 | ✅ S15 |
| 12 | memory.review/activate frozen semantics 未变 | ✅ 未触碰 |
| 13 | projectmem 永不是 verified authority | ✅ C-INV-18 |
| 14 | 所有历史攻击进 regression suite | ✅ RT-01..19 manifest |

## 最终状态

```text
IMPLEMENTATION COMPLETE
READY FOR INDEPENDENT RED-TEAM RE-REVIEW
NOT CLAIMED CONVERGED (S8 PARTIAL RESIDUAL)
```

最终 `P0-R CLOSED` 必须由独立红队重新裁决。

## 双向链接

- [[LAOS P0-R GPT Pro Review Protocol 2026-08-07]]（触发本轮审查）
- [[LAOS P0-R Developer Bridge Remediation Plan v1.0]]
- `P0R-INGRESS-MAP.md` · `P0R-AUTHORITY-REACHABILITY.md` · `P0R-S8-SECURE-OPEN-STATUS.md`
