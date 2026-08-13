---
id: developer-bridge-remediation-v1
type: security-remediation-matrix
schema_version: 1
project: LAOS
date: 2026-08-07
author: 林森 (Linsen Li)
updated_by: claude-haiku-4-5[1m]
status: remediated-pending-redteam
---

# Developer Bridge P0-R Remediation Matrix v1

> Finding | Affected Files | Attack | Fix | Regression Test | Status
> 不得只依赖聊天记录。本表是独立审计依据。

## F-01 — Scope Escalation

| 项 | 值 |
|---|---|
| Affected Files | `src/laos-memory-tool.js`（`normalizeTask`） |
| Attack | caller 提交 `workspace=work`/`project=other`/`confidentiality=restricted`，旧实现透传到 Core，读取其他 partition |
| Fix | 统一 `normalizeScopedTask()`：冲突 `scope_mismatch` reject before Core；删除 caller scope；注入 trusted profile scope（C-INV-13） |
| Regression Test | `test/laos-scope-boundary.test.js`（19 tests）、`test/constitutional-scope.test.js`（4 tests） |
| Status | **PASS** |

## F-02 — Source Identity Binding

| 项 | 值 |
|---|---|
| Affected Files | `src/vault/note-identity.js`、`src/vault/snapshot.js`、`src/laos-memory-tool.js`、`src/review/source_refs.py`、`src/agents/evidence.py` |
| Attack | artifact 只绑定 payload；`same payload + note_id A/B` 产生同一 artifact |
| Fix | artifact schema_version 2 把 source identity（scheme/note_id/source_sha256）+ locator 绑进 body；`artifact_sha256` 随 note_id 变 |
| Regression Test | Core `test_constitutional_provenance.py`、`tests/test_evidence_publish.py`；Bridge `test/laos-canonical-golden.test.js` |
| Status | **PASS** |

## F-03 — Hash Contract Split / Bridge Bypass

| 项 | 值 |
|---|---|
| Affected Files | `src/laos-memory-tool.js`、`src/vault/snapshot.js`、`src/review/source_refs.py` |
| Attack | 三种 SHA 混用（source/payload/artifact 用一个）；canonical_identity 用 artifact_sha256 冒充 source_sha256 |
| Fix | 冻结 `docs/adr/evidence-hash-semantics-v1.md`：`source_sha256`/`payload_sha256`/`artifact_sha256` 独立语义；Bridge 与 Core 各自重算（C-INV-15） |
| Regression Test | Bridge `test/laos-canonical-golden.test.js`（9）、Core `test_constitutional_provenance.py` |
| Status | **PASS** |

## F-04 — Vault Snapshot TOCTOU

| 项 | 值 |
|---|---|
| Affected Files | `src/vault/stable-read.js`（新）、`src/vault/vault-evidence.js`、`src/vault/note-identity.js` |
| Attack | 两次读取：identity 读 B、payload 读 A → `payload A + identity B` |
| Fix | `readStableVaultNote()` 单次稳定读取：open once → fstat before/after → 同 stable file → raw bytes（C-INV-17） |
| Regression Test | `test/vault-stable-read.test.js`（5 tests） |
| Status | **PASS** |

## F-05 — Mutable Partition Map

| 项 | 值 |
|---|---|
| Affected Files | `src/vault/partition-map.js` |
| Attack | `Object.freeze(array)` 未冻结 rule 对象；caller 可注入 `partitionMap` |
| Fix | `Object.freeze(entries.map(rule => Object.freeze({...rule})))`；resolvePartition 返回冻结对象（C-INV-13/16 相关） |
| Regression Test | `test/vault-partition-map.test.js`（10 tests） |
| Status | **PASS** |

## F-06 — YAML Parser Ambiguity

| 项 | 值 |
|---|---|
| Affected Files | `src/vault/yaml-front-matter.js` |
| Attack | 未显式 reject duplicate key / `__proto__` / anchors / aliases / merge keys |
| Fix | fail-closed：duplicate key/`__proto__`/prototype/constructor/merge key/alias/anchor/tag/ambiguous 全 reject；mapping 用 `Object.create(null)` |
| Regression Test | `test/yaml-front-matter.test.js` |
| Status | **PASS** |

## F-07 — Projectmem Trust Semantics

| 项 | 值 |
|---|---|
| Affected Files | `src/projectmem/index.js`、`src/projectmem/core-client.js`、`bin/projectmem` |
| Attack | `binding_state: verified` 冒充 authority；unknown handle → `memory:unknown` |
| Fix | summary v2：`binding_state` 限 `derived|refreshed|stale|invalid`（C-INV-18）；unknown handle fail entire refresh；core client 构造期绑定 scope；manifest 与 profile 对账 |
| Regression Test | `test/projectmem.test.js`（12）、`test/projectmem-core-client.test.js`（7） |
| Status | **PASS** |

## Deployment Parity（R-01）

| 项 | 值 |
|---|---|
| Affected Files | `src/bridge-info.js`（新）、`src/bridge-with-sync-tools.js` |
| Attack | 审查源码允许 evidence.publish，运行中 @laos1 没有 |
| Fix | 只读 `laos_bridge_info`：git_commit/git_tree/dirty/allowlist_sha256/protocol_version/core commit（C-INV-19） |
| Regression Test | `test/bridge-info.test.js`（5 tests） |
| Status | **PASS** |

## Clean Audit Anchor（R-03）

| 项 | 值 |
|---|---|
| Affected Files | `.gitignore` |
| Attack | 下一轮红队基于 dirty tree（node_modules symlink 未忽略） |
| Fix | `.gitignore` 补 `node_modules`（symlink 形式）；git diff --check PASS |
| Regression Test | `git status --short` 无 node_modules |
| Status | **PASS** |

## Fake E2E Coverage（R-04）

| 项 | 值 |
|---|---|
| Affected Files | `test/bridge-true-e2e.test.js`（新）、`test/core-provenance-e2e.test.js`（原 vault-core-provenance-e2e 改名） |
| Attack | 旧 `vault-core-provenance-e2e` 直接调 Core CLI，绕过 Bridge |
| Fix | 新 `bridge-true-e2e.test.js`：真实 Vault→Bridge public entry→unified scope gate→evidence normalizer→Core EvidenceAgent→artifact（E01-E20 矩阵） |
| Regression Test | `test/bridge-true-e2e.test.js`（16 tests） |
| Status | **PASS** |

## 最终验证

- Bridge：`npm test` → **295/295 PASS**
- Core：`python3.11 -m unittest discover -s tests` → **1131/1131 PASS**
- Core compileall：PASS；`git diff --check`：PASS
- 未 commit / 未 push（等待人工授权）
