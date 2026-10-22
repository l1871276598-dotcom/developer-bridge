---
id: p0r-s8-secure-open-status
type: security-residual
schema_version: 1
project: LAOS
date: 2026-08-07
status: partial-residual
author: 林森 (Linsen Li)
updated_by: claude-haiku-4-5[1m]
---

# P0R S8 — Secure Open 状态（诚实记录）

## 裁决

**S8 = PARTIAL RESIDUAL（非 atomic open，未宣称完全闭合）**

## 为什么是 PARTIAL 而非 PASS

计划 §5.1-5.3 要求的理想模型是 **dirfd 链式 openat**：

```text
open trusted Vault root directory fd
for each path component:
    openat(previous_dirfd, component, O_NOFOLLOW)
    fstat
    require directory
final component:
    openat(parent_dirfd, name, O_NOFOLLOW)
    require regular file
read from final fd
```

这保证 `validated directory chain == opened directory chain` 是 **atomic 绑定**。

**当前 Node v22.23.1 无法实现此模型**：
- `process.binding('fs')` 已移除（v20+），无法直接调 libuv `uv_fs_open` 的 dirfd 变体；
- `fs.promises.open` 不支持 dirfd-relative openat；
- 无第三方 native helper 在本仓可用（计划 §5.2 允许最小 native primitive，但属于 TCB 变更，需单独记录）。

因此当前实现是「validate then open」+ 强化的 inode 绑定，属于计划 §5.3 明示「单独使用不能宣称 PASS」的方案。

## 当前实现的防御（defense-in-depth，已测试）

| 层 | 机制 | 测试 |
|---|---|---|
| 1 | `normalizeVaultRelativePath` 拒绝 traversal/NUL/反斜杠/绝对路径 | `gp03-locator-provenance` |
| 2 | `resolveNotePath` 逐组件 lstat 拒 symlink + 最终 regular file 校验 | 既有 vault-root 测试 |
| 3 | **resolve→open inode 绑定**：open 后 fstat 的 `dev/ino/mode/size` 必须 == resolve 时验证的 stat，否则 `note_changed` | `S8: path swapped between validation and open` |
| 4 | **fd 内 before/after 全字段校验**（含 ctimeNs）：read 中 mutation 被检测 | `S7` adversarial tests |

这 4 层组合能检测并拒绝：
- traversal / 歧义路径（层 1-2）
- resolve→open 之间的 inode swap（层 3）
- read 期间同 inode 同 size 的 mutation（层 4，ctime）
- read 期间 inode swap（层 4，ino）

## 残留（为什么不能宣称 CONVERGED）

1. **非 atomic**：resolve（lstat 校验）与 open 之间仍有瞬时窗口。层 3 的 inode 绑定能把「swap 已发生」检测出来并 fail-closed，但不能**阻止** swap 发生（无锁）；理论上一个能同时操纵 FS 与时间的攻击者若在 open 前 swap、且被 swap 的文件恰好满足层 3/4 的字段（同 dev/ino 不可能伪造，所以实际是安全的）——inode 不可伪造，因此 swap 必然改变 ino，层 3 必拒。**残留是理论窗口，实际被 inode 不可伪造性闭合**。
2. **若部署环境有同机恶意并发写**（计划 §33 提到的威胁模型），理想方案是 openat + root dirfd 保持打开。当前每次 read 重新 resolve root，root 目录本身若被替换为 symlink 会怎样？—— `resolveVaultRoot` 在 tool 创建时 canonicalize 并拒 symlink，且 `resolveNotePath` 从 root 逐组件 lstat。但 root 若在 read 期间被 swap 为 symlink，层 2 的遍历会拒（组件是 symlink）。已覆盖。

## Gate 5 结论

按计划 §5.3：**「如果当前技术栈不能实现安全 traversal/open：记录 S8 = OPEN RESIDUAL，并停止宣称 P0-R CONVERGED」**。

因此本轮最终状态为 **READY FOR INDEPENDENT RED-TEAM RE-REVIEW**（非 CONVERGED），S8 明确标记为 PARTIAL RESIDUAL，交由红队裁决该 residual 是否可接受。

## 建议的彻底修复路径（P1+，需人工授权）

- 评估引入最小 native addon（如 `@napi-rs/fs` 的 openat 绑定）或 Node `fs.Dir`/`opendir` + 保留 root fd；
- 或迁移 Vault read 到 Core Python 侧（Python `os.open` 支持 dirfd 相对 open：`os.open(path, flags, dir_fd=...)`），由 Bridge 只做 policy，Core 做 open——但这改变 TCB，需单独设计。

## 相关

- [[LAOS P0-R Developer Bridge Remediation Plan v1.0]] Phase 5
- [[LAOS P0-R GPT Pro Review Protocol 2026-08-07]] S8
