---
id: laos-constitution
type: governance
status: ratified-v1
schema_version: 1
project: LAOS
date: 2026-08-07
author: 林森 (Linsen Li)
updated_by: claude-haiku-4-5[1m]
---

# LAOS Constitution v1.0

> 本 Constitution 是 LAOS 安全模型的最高层不变量集合。它不代替测试；
> 每条 invariant 都在对应模块附近有测试固化（plan §64）。红队审计以此为
> 判定基准。

## 1. 权威链（不变）

1. **Single Memory Authority**：active memory 的唯一权威是 Core Review/Activate
   链（`memory.review` → `memory.activate` → generation CAS → activation
   receipt）。无第二 authority。
2. **Review/Activate 不可从 Bridge 到达**：Developer Bridge allowlist 不含
   `memory.review` / `memory.activate`。
3. **Active-state bypass 禁止**：任何外部来源不得直接写 active memory。

## 2. Ingress 不变量（C-INV-13..20）

### C-INV-13 — Bridge effective scope MUST equal trusted profile scope

```text
Bridge Effective Scope = Trusted Bridge Profile Scope
```

- caller 省略 scope → 系统注入 profile。
- caller 写相同 scope → 接受。
- caller 写不同 scope → `scope_mismatch` 拒绝，**before Core invocation**。
- 覆盖全部 scope-bearing task（memory.*/context.build/handoff.write/loop.*/
  reflection.*/evidence.publish）。

### C-INV-14 — External source identity MUST be cryptographically bound into its artifact

```text
artifact_sha256 = SHA256(LAOSCanonicalJSON(entire artifact body))
```

artifact body 绑定：schema_version + kind + source identity + locator +
workspace/project/confidentiality + payload + payload_sha256。
因此 `note_id A + payload X` 与 `note_id B + payload X` 必然产生不同 artifact。

### C-INV-15 — Source digest, payload digest and artifact digest MUST have distinct frozen semantics

```text
source_sha256  = SHA256(canonical source bytes)
payload_sha256 = SHA256(LAOSCanonicalJSON(payload))
artifact_sha256 = SHA256(LAOSCanonicalJSON(entire artifact body))
```

三种 digest 不得混用（见 `docs/adr/evidence-hash-semantics-v1.md`）。

### C-INV-16 — A production external evidence path MUST NOT bypass Developer Bridge policy enforcement

```text
Vault → Vault Publisher → Developer Bridge public dispatcher
      → normalizeScopedTask → normalizeEvidenceTask → Core
```

禁止：spawn Core CLI / import Core EvidenceAgent / 直接调
`publish_source_artifact` / 直接访问 Core state。静态 boundary test 固化。

### C-INV-17 — Snapshot payload and source identity MUST derive from one stable source read

```text
resolve path → security checks → open once → fstat before → read one fd
→ fstat after → same stable file? → raw bytes → identity + payload
```

Identity 与 payload 必须来自同一组 bytes。任何变更 → fail closed（`note_changed`）。

### C-INV-18 — Derived views MUST NOT claim verified status without machine-verifiable authority proof

projectmem 的 `binding_state` 只允许：`derived | refreshed | stale | invalid`。
无机器可验证 proof 时**永远不得**自称 `verified`。

### C-INV-19 — Reviewed source tree and deployed runtime MUST expose verifiable build identity

Bridge 暴露只读 `laos_bridge_info`：

```json
{
  "bridge": { "git_commit": "...", "git_tree": "...", "dirty": false,
              "allowlist_sha256": "...", "protocol_version": "laos-task-v2" },
  "core": { "git_commit": "...", "protocol_version": "evidence-v2" },
  "governance": { "constitution_version": "1.0" }
}
```

### C-INV-20 — Developer Bridge MUST NOT connect to generic Core authority dispatch surface

Bridge 只连接 `restricted laos_memory_task interface`（allowlist 冻结），
禁止接入 generic Core `laos_task`（generic registry 含 memory.review/
memory.activate）。

## 3. Mutable surface policy

可修改面（需人工审核 + 测试回归）与不可修改面见
`MUTABLE-SURFACE-POLICY.md`。

## 4. 约束

- Constitution 本身可写，但**不代替测试**。
- 任何违反本 Constitution 的变更 = Release Blocker。
