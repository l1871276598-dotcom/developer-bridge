---
id: evidence-hash-semantics-v1
type: contract
status: frozen
schema_version: 1
project: LAOS
created: 2026-08-07
updated: 2026-08-07
supersedes: "混用单一 sha256 的旧模型（F-03）"
author: 林森 (Linsen Li)
updated_by: claude-haiku-4-5[1m]
---

# Evidence Hash Semantics v1 + LAOS Canonical JSON v1（冻结）

> 本文冻结 LAOS 证据链的三种 digest 语义与跨语言 canonical 编码。
> 任何实现（Bridge / Core）若偏离本文，即违反 C-INV-15（三种 digest 独立冻结语义）
> 与 C-INV-14（source identity 密码学绑定）。

---

## 1. LAOS Canonical JSON v1

`LAOSCanonicalJSON(value)` 定义为：

```text
sorted keys (recursive, lexicographic by UTF-16 code unit for Node, by code point for Python — 两者在 ASCII 域一致)
compact (no whitespace)
UTF-8 encoding (no BOM)
no trailing newline
NaN reject
Infinity reject
duplicate JSON key reject
```

- Node：`JSON.stringify(sortedValue(value))`（拒绝非有限 number）。
- Python：`json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")`。

**跨语言一致性**：上述两实现在 ASCII 与 UTF-8 文本域产生逐字节相同的 canonical bytes。
Node 对 surrogate pair 与非 ASCII 的处理与 Python `ensure_ascii=False` 在文本域一致。

### 冻结 golden vectors（固定 expected digest，不可推导）

对 payload `{content: string, metadata: {title: string}}`（闭合 schema，v1）：

| # | payload | canonical bytes | payload_sha256 |
|---|---|---|---|
| V0 | `{"content":"hello","metadata":{"title":"World"}}` | 同上 | `740f2bd6ac530daabc4ab36e7dc17ae51886c8e81f473c1cb6ca366f5992d8f0` |
| V1 | `{"content":"你好世界","metadata":{"title":"设计注意事项"}}` | 同上 | `27206f916c8e44d94587ef0b36bf585a5e8db460a1ac0ef605565deafa4eed62` |
| V2 | `{"content":"quote \" and \n newline","metadata":{"title":"esc"}}` | 同上 | `82d48f49055144586ec61ebbd240be42d90bdba80b8d0abd8b6eecca3946d793` |
| V3 | `{"content":"nested","metadata":{"a":{"b":[1,2,3],"c":"x"},"title":"t"}}` | 同上 | `ae4a9663d705d259cdeddb429fc17406cba2a3cfadcda18b0701c61e623b1fd6` |
| V4 | `{"content":"k","metadata":{}}` | 同上 | `da9af6ea9b3ccdae0b3ee710e839111d035ca5f9126a987183ec6baf27208533` |
| V5 | `{"content":"key order","metadata":{"z":1,"a":{"y":[3,2],"x":"n"},"m":null}}` | 同上 | `35770bc99abfab12f2e410fc17608f6ac2a7cff7e4aada8f9cd5bde67c9d00c3` |

> V0–V5 已在 2026-08-07 用 Node `crypto` 与 Python `hashlib` 独立计算，两者逐字节一致
> （见 `test/laos-canonical-golden.test.js` 与 `tests/test_evidence_publish.py`）。

---

## 2. 三种 digest 的独立冻结语义

| 字段 | 定义 | 绑定 | 谁计算 |
|---|---|---|---|
| `source_sha256` | `SHA256(canonical source bytes)`；Vault 中 = `SHA256(canonical note bytes)` | source 内容本身 | Bridge（首次）+ Core（重算） |
| `payload_sha256` | `SHA256(LAOSCanonicalJSON(payload))` | evidence payload | Bridge（校验）+ Core（重算） |
| `artifact_sha256` | `SHA256(LAOSCanonicalJSON(entire artifact body))` | identity + locator + scope + payload | Core（发布）+ Bridge（预期） |

**不得混用**。旧模型把一个 SHA 同时当 source/payload/artifact digest（F-03 根因）。

---

## 3. canonical source identity

```text
canonical_identity = vault-note:<note_id>@<source_sha256>
```

- `note_id` 是 source 的稳定标识（Vault 中来自 Front Matter `id` 或派生）。
- `source_sha256` 是 canonical note bytes 的摘要。
- **Path 不进 canonical identity**。path 只是 `locator`。
  因此 `A/design.md → B/design.md`：若 `note_id` 不变 + content 不变，
  **canonical source identity unchanged**（artifact 可因 locator 变化变成新 artifact，
  两个概念分开）。

---

## 4. Evidence Publish v2 请求（外部 caller）

```json
{
  "task": {
    "type": "evidence.publish",
    "input": {
      "schema_version": 2,
      "kind": "vault_note_snapshot",
      "source": {
        "scheme": "vault-note",
        "note_id": "abc123",
        "source_sha256": "0123456789abcdef..."
      },
      "locator": { "relative_path": "Projects/LAOS/design.md" },
      "payload": {
        "content": "...",
        "metadata": { "title": "..." }
      },
      "payload_sha256": "0123456789abcdef..."
    }
  }
}
```

外部 caller **不提交**可信 `workspace`/`project`/`confidentiality`/`canonical_identity`/`artifact_sha256`——
这些是派生或 trusted-boundary 数据，由 Bridge/Core 派生并注入。

---

## 5. Canonical identity 必须派生，不可信任 caller

Bridge 计算：`vault-note:` + `note_id` + `@` + `source_sha256`。
Core 再次计算并返回。返回结果必须与 Bridge 预期逐字节一致。

---

## 6. 成功返回（v2）

```json
{
  "result": {
    "source_ref": "artifact:<artifact_sha256>",
    "canonical_identity": "vault-note:abc123@<source_sha256>",
    "source_sha256": "...",
    "payload_sha256": "...",
    "artifact_sha256": "...",
    "workspace": "personal",
    "project": "laos",
    "confidentiality": "internal"
  }
}
```

---

## 7. Artifact body v2（Core 发布格式）

```json
{
  "schema_version": 2,
  "kind": "vault_note_snapshot",
  "source": { "scheme": "vault-note", "note_id": "abc123", "source_sha256": "..." },
  "locator": { "relative_path": "Projects/LAOS/design.md" },
  "workspace": "personal",
  "project": "laos",
  "confidentiality": "internal",
  "payload": { "content": "...", "metadata": { "title": "..." } },
  "payload_sha256": "..."
}
```

`artifact_sha256 = SHA256(LAOSCanonicalJSON(entire artifact body))`。

**关键性质（F-02 修复）**：`note_id A + payload X` 与 `note_id B + payload X`
必然产生不同 artifact，因为 source identity 绑定进 body。

---

## 8. 版本兼容

- `schema_version 1` artifact：read-only 兼容（现有 v1 仍可验证/读取）。
- `schema_version 2` artifact：新 publication 格式。
- 新 `vault_note_snapshot` 只能发布为 v2。

---

## 相关

- Bridge：`src/laos-memory-tool.js`、`test/laos-canonical-golden.test.js`
- Core：`src/review/source_refs.py`、`src/agents/evidence.py`、`tests/test_evidence_publish.py`
- 方向：[[LAOS Red Team P0-R Remediation Direction 2026-08-07]]
- 计划：[[LAOS P0-R Developer Bridge Remediation Plan v1.0]]
