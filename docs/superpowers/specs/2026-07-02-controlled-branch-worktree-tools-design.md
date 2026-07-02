# Developer Bridge 受控分支与 Worktree 工具设计

## 目标

在现有 Developer Bridge 的单仓库安全边界内增加创建、切换和查看 Git 分支及 worktree 的能力，并生成一份新的 macOS 双击启动文件。现有桌面启动文件保持不变。

新版启动文件为：

`/Users/user/Desktop/启动Developer Bridge-分支与Worktree权限.command`

## 工具范围

新增六个 MCP 工具：

1. `git_branch_list`：列出本地分支、当前分支，以及分支是否已被其他 worktree 占用。
2. `git_branch_create`：从当前 `HEAD` 创建一个新的本地分支，可选择创建后立即切换。
3. `git_branch_switch`：切换到一个已有的本地分支。
4. `git_worktree_list`：列出当前仓库通过 Git 登记的 worktree、分支和状态。
5. `git_worktree_create`：在受控目录中创建 worktree，可使用已有分支，也可从当前 `HEAD` 创建新分支。
6. `git_worktree_switch`：将 Bridge 的当前授权上下文切换到一个已登记且符合路径约束的 worktree。

本次不增加删除分支、删除 worktree、prune、repair、move、detach、reset、强制 checkout、覆盖未提交修改或任意 Git 参数入口。

## 受控路径布局

初始授权工作区的仓库名记为 `<repo>`，其父目录记为 `<parent>`。Bridge 只允许创建新 worktree 到：

`<parent>/<repo>-worktrees/<encoded-branch>`

`encoded-branch` 将分支名中的 `/` 转换为 `--`，并只接受经过严格校验的 Git 分支名。工具不接受任意目标路径。

可切换目标必须同时满足：

- 出现在 `git worktree list --porcelain` 的实时结果中；
- 是初始工作区，或其规范化真实路径位于受控 worktree 根目录内；
- 属于与初始工作区相同的 Git common directory；
- 当前不是 detached HEAD；
- 分支不是 `main` 或 `master`。

符号链接、路径穿越、Git 未登记目录和受控根目录之外的 worktree 均被拒绝。

## 可变授权上下文

Bridge 启动时从环境变量建立一个进程内授权上下文，包含：

- 初始工作区真实路径；
- 当前工作区真实路径；
- Git common directory 的规范化真实路径；
- 受控 worktree 根目录；
- 当前授权分支。

所有文件读写、Git 状态与差异、暂存、提交、推送、测试和验证工具在每次调用时读取当前上下文，不能缓存旧路径。`git_branch_switch` 或 `git_worktree_switch` 成功后，以原子方式更新当前工作区和当前授权分支；任何验证失败都保持旧上下文不变。

环境变量只用于建立初始上下文，不再作为运行期授权状态的唯一来源。

## 分支操作约束

分支名必须：

- 是非空 UTF-8 字符串，并受长度限制；
- 通过 `git check-ref-format --branch`；
- 不以 `-` 开头；
- 不是 `main` 或 `master`；
- 不包含控制字符或 NUL。

创建分支只允许以当前 `HEAD` 为起点，不接受提交、标签、远端引用或任意 start-point。分支已存在时失败。

切换前必须确认当前 worktree：

- 没有已暂存、未暂存或未跟踪修改；
- 不处于 merge、rebase、cherry-pick、revert 或 bisect 流程；
- 目标是已有本地分支；
- 目标没有被其他 worktree 占用；
- 目标不是受保护分支。

切换使用固定参数，不启用 `--force`、`--discard-changes`、detach 或路径 checkout。

## Worktree 操作约束

创建 worktree 时调用者只能提供 `branch` 和 `create_branch`：

- `create_branch=false` 时，分支必须已存在且未被其他 worktree 占用；
- `create_branch=true` 时，分支必须不存在，并从当前 `HEAD` 创建；
- 目标目录由 Bridge 根据固定布局计算；
- 目标目录必须不存在；
- 不接受提交、远端、目标路径或附加 Git 参数。

创建成功后不自动改变当前上下文。调用者可显式调用 `git_worktree_switch`。

`git_worktree_switch` 接受目标分支名而不是路径。Bridge 根据实时 worktree 清单解析唯一目标，完成所有路径、仓库身份、分支与状态验证后再更新上下文。切换上下文不执行 shell `cd`，也不修改用户终端的当前目录。

## 与现有写入工具的关系

现有写入工具继续禁止在 `main` 和 `master` 上运行。切换成功后，`git_stage`、`git_commit`、`git_push_current_branch` 和 `run_validation` 必须使用新上下文的工作区与分支。

普通读写和测试工具也随上下文切换，确保一次调用不会从旧工作区读取、向新工作区写入。单个工具调用开始时取得不可变的上下文快照；上下文切换与其他工具调用串行化，避免并发调用跨越两个根目录。

## 新启动文件

新文件基于 `/Users/user/Desktop/启动Developer Bridge-增强权限.command` 生成，并保留现有工作区选择、端口检查、ngrok、私密 MCP 路径和依赖检查逻辑。

差异包括：

- 启动界面明确列出受控分支/worktree 权限；
- 导出由 Bridge 初始化上下文所需的 worktree 策略变量；
- 初始分支仍不得为 `main`、`master` 或 detached HEAD；
- 文件具有可执行权限；
- 不覆盖或修改原桌面文件。

启动器只负责声明和展示权限；真正的安全校验始终由 Bridge 服务端执行。

## 错误处理与审计

所有命令使用参数数组且 `shell=false`。Git 命令配置固定超时和有界输出。失败信息不得泄漏环境变量、凭据或私密 MCP 路径。

审计日志记录时间、工具名、成功或失败、耗时，以及经过清理的分支名或 worktree 标识。日志不记录文件内容、完整用户目录、远端 URL、令牌或 MCP 私密路径。

任何歧义、目录身份不一致、Git 输出格式异常、并发状态变化或无法证明安全的情况都失败关闭，不扩大权限或回退到宽松操作。

## 测试与验收

自动测试覆盖：

- 六个新工具的 MCP schema、发现顺序与 HTTP/stdio 调用；
- 分支名验证、受保护分支、重复分支和脏工作区拒绝；
- 合并/rebase 等进行中状态拒绝；
- 创建与切换普通分支；
- 固定 worktree 路径计算；
- 创建已有分支或新分支的 worktree；
- 拒绝任意路径、符号链接逃逸、外部 worktree、未登记目录和不同仓库；
- 切换后文件、Git、测试和写入工具使用新上下文；
- 切换失败时旧上下文保持不变；
- 不暴露删除、强制、detach 或任意 Git 参数；
- 新启动文件通过 `bash -n`，与原文件不同，且具有可执行权限。

测试使用临时本地仓库和本地 worktree，不访问真实远端、不推送、不删除用户分支或目录。最终进行一次人工只读验证：启动新版 Bridge，确认新工具可发现，并在临时仓库中完成创建、列出和切换流程。
