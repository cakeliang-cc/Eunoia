# ADR 021 — 实现记录：Task-scoped CWD

## 背景

ADR 021 描述的是目标状态：`run_command` 无状态，Task CWD 有状态，Runtime 在每次
Execution 创建时读取并冻结 CWD，Sandbox Gateway 二次校验，OCI Runtime 用
`--workdir` 启动，Agent 只能通过 `change_directory` 改变任务目录。

这份文档记录**实现时真正做的选择**，以及和 021 字面要求不一致的地方。和前几份
实现记录一样，不能靠“看起来实现了”来交差的地方都写在这里。

## 决定

### 1. CWD 状态在 Task 行上，通过专用 CAS 接口写

`TaskExecutionContext`（`src/sandbox/cwd/cwd-types.ts`）是领域类型，权威存储是
`sandbox_tasks` 的五个新列：

| 列 | 含义 |
|---|---|
| `workspace_root` | 容器内的 workspace 根，来自 Workspace Manager，任务生命周期内不变 |
| `current_cwd` | Task CWD，绝对容器路径 |
| `cwd_version` | CAS token，每次成功变更 +1 |
| `cwd_invalidated_at` | 校验失败的时间戳（ADR §11.3），不覆盖 `current_cwd` |
| `cwd_invalid_reason` | 失败原因，稳定错误码 |

`updateTask` 的可写字段仍然只有 `status / sandbox_id / workspace_id`
（`store-sqlite.ts` 的 `TASK_MUTABLE`、`store-memory.ts` 的显式 patch），
所以普通的 Task 更新路径**不可能**改 CWD。只有
`SandboxStore.compareAndSetTaskCwd()` 会写这三个值。

### 2. CAS 与审计行在同一个事务里

`compareAndSetTaskCwd()` 接收完整的 `AuditEvent` 并在同一个
`BEGIN IMMEDIATE … COMMIT` 中写入 `sandbox_audit_events`。内存实现用同步段
模拟同样的语义（单线程下 check 与 write 之间没有 await）。

这样就不存在 ADR §3.2 明令禁止的状态：CWD 变了但没有审计，或审计写了但 CWD
回滚。ADR 建议的 Transactional Outbox 在这里没有必要——审计行本身就是那张
outbox 表，而 SQLite 的写事务已经把它和状态绑在一起。

### 3. 两层路径检查，宿主侧做物理校验

- **词法**（`cwd-path.ts`）：`resolveTaskPath` 用 `posix.resolve` 解析相对路径，
  `isWithinRoot` 用 `path.relative` 判断包含关系。字符串前缀检查在这里是错的，
  `/workspace-evil` 的用例有测试。
- **物理**（`cwd-validator.ts`）：把容器路径映射回 bind mount 的宿主目录，
  `realpath` + `stat`，再确认物理路径仍在物理 workspace 内。符号链接逃逸因此变成
  `SYMLINK_ESCAPE`，而不是“目录不存在”。

物理校验放在宿主侧，是因为 workspace 就是宿主上的一个目录，bind mount 进容器；
容器内的进程看到的正是这棵树。ADR §4.4 说“实际路径检查必须在 Sandbox 内完成”，
这条在本实现里由第 4 点的容器内启动器满足；宿主侧的这次检查是为了在命令变成
进程**之前**就能拒绝，代价是两次检查而不是一次。

### 4. TOCTOU 由容器内的启动器兜底，没有 `openat2`/`fchdir`

`docker exec` 没有传递“已验证目录文件描述符”的接口，所以 ADR 推荐的
`openat2(RESOLVE_BENEATH)` + `fchdir` 在这条链路上不可用。采用 ADR 明确允许的
替代方案：受控的执行启动器。

`runtime/oci-args.ts` 的 `WRAPPER` 现在接收 `id / workspaceRoot / cwd` 三个位置
参数（**不拼接进脚本源码**），在同一个 shell 进程里：

```sh
cd -P "$dir" || { eunoia:cwd_rejected:missing; exit 126; }
real=$(pwd -P)
case "$real" in "$root"|"$root"/*) ;; *) eunoia:cwd_rejected:escape; exit 126;; esac
"$@"
```

校验与 `cd` 和命令启动发生在同一个进程，所以“校验后、进入前”的窗口不存在。
符号链接在两次检查之间被替换时，启动器会拒绝，Runtime 把
`detail: 'cwd-rejected'` 交给 Gateway，Gateway 调用
`CwdManager.markInvalidFromRuntime()` 把上下文标记为失效——不会静默落到 `/`。

### 5. `fs.chdir` 是独立的权限动作

`change_directory` 用新的 `PermissionAction = 'fs.chdir'`，不是 `fs.read`，也不是
`fs.write`。理由：

- 它改变的是任务状态，影响之后每一条命令，值得单独审计；
- 它不是文件权限。站在 `/workspace/secrets` 不会让那里的写操作通过——文件工具
  仍然逐路径判权；
- 四种模式的行为按 ADR §9.2：`read-only` 在只读范围内允许切换，
  `auto` 在工作区内允许，`on-request` 走同一套策略并在需要时进入审批，
  `restricted` 只在白名单目录内允许（`narrowPolicyForMode` 已经把
  `filesystem.read` 与白名单求交，`cwd-policy.ts` 读的是求交后的策略）。

### 6. `run_command` 的输入没有 `workdir`

`runCommandTool.parameters` 仍然只有 `command` 和 `timeout_ms`。CWD 由
`GatewayToolSession.run()` 在创建 Execution 时从 `TaskContextStore` 读取，并作为
`cwdVersion` 一起传给 Gateway。模型无法命名 task、workspace 或绝对工作目录。

Gateway 不信任 adapter 传来的值：它重新读取 Task Context，核对
`sandbox.workspaceId === task.workspaceId`、`input.cwdVersion` 与记录版本、
`input.cwd` 与记录路径，再跑一次物理校验，才创建 Execution。不一致分别返回
`CWD_VERSION_MISMATCH` / `EXECUTION_CONTEXT_INVALID`，而不是“猜一个目录”。

### 7. Execution 快照是冻结的

`executions.cwd_version` 与 `cwd` 在创建时写入，之后不随 Task CWD 变化；
`execution.cwd.snapshot.created` 事件记录 `cwd / cwd_version / workspace_id /
workspace_root / sandbox_id / policy_version`。已经在跑的 Execution 使用自己的
快照，这正是 ADR §6.3 要求的一致性语义。

### 8. 幂等按 operation id 持久化

`task_cwd_operations` 保存整个 `ChangeDirectoryResult`。`change_directory` 工具把
`toolCallId` 作为 operation id 传下去，因此一次网络层重试返回原始结果而不是再
递增一次版本；同一个 operation id 配不同路径返回 `IDEMPOTENCY_CONFLICT`。

### 9. 失效不修复

`cwd_invalidated_at` 一旦写入，`execute` 在**进入校验之前**就拒绝
（`CWD_INVALID`），恢复流程也不会自动换一个目录。唯一清除方式是：

- `change_directory` 成功（CAS 同时清空标记），或
- `CwdManager.recover()` 重新校验通过（任务重启 / sandbox 重建后由
  `gateway.recover()` 调用）。

删除 `current_cwd` 或回退 `/workspace` 都是 ADR §11.3 明令禁止的。

## 模块地图

```text
src/sandbox/cwd/
  cwd-types.ts          领域类型、错误码、审计动作
  cwd-path.ts           词法解析与边界判断（纯函数）
  cwd-validator.ts      物理校验（realpath + stat + 宿主侧包含判断）
  cwd-policy.ts         模式与目录范围（读的是收窄后的策略）
  task-context-store.ts 唯一读写入口、CAS、失效标记
  cwd-manager.ts        变更业务入口、权限决策、幂等、恢复

src/tools/coding/
  change-directory-tool.ts   change_directory 工具（只接收 path）

src/sandbox/
  gateway.ts            二次校验、Execution 快照、currentDirectory/changeDirectory
  tool-adapter.ts       run() 注入 CWD，实现 ToolCwdPort
  runtime/oci-args.ts   --workdir + 容器内启动器
  runtime/oci-runtime.ts cwd-rejected 映射
  schema.ts             v5：task_cwd_operations 与新列
```

## 数据库迁移（v4 → v5）

```sql
ALTER TABLE sandbox_tasks ADD COLUMN workspace_root TEXT;
ALTER TABLE sandbox_tasks ADD COLUMN current_cwd TEXT;
ALTER TABLE sandbox_tasks ADD COLUMN cwd_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sandbox_tasks ADD COLUMN cwd_invalidated_at TEXT;
ALTER TABLE sandbox_tasks ADD COLUMN cwd_invalid_reason TEXT;
ALTER TABLE executions    ADD COLUMN cwd_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE task_cwd_operations (...);
```

迁移是幂等的：每列先查 `PRAGMA table_info` 再加，所以半途崩溃的文件下次打开会
收敛。存量任务被回填为 `workspace_root = '/workspace'`、
`current_cwd = workspace_root`、`cwd_version = 1`。

**不从历史命令推断目录。** ADR §16.1 的理由成立：`cd` 可能发生在子 shell、
脚本、函数或条件分支里，父 shell 的最终 CWD 无法可靠恢复；猜一个目录比回到
workspace 根更糟。

## 错误码与用户可见行为

| 错误码 | 触发点 | 模型的下一步 |
|---|---|---|
| `PATH_OUTSIDE_WORKSPACE` | 词法边界 / 策略 | 换工作区内的路径 |
| `SYMLINK_ESCAPE` | 物理校验 | 换真实目录，不要用链接 |
| `DIRECTORY_NOT_FOUND` | 物理校验 / 恢复 | 确认目录存在 |
| `NOT_A_DIRECTORY` | 物理校验 | 目标必须是目录 |
| `PERMISSION_DENIED` | 权限层 / 模式 | 需要不同的权限或目录 |
| `CWD_VERSION_CONFLICT` | CAS | 重新读取当前目录再决定 |
| `CWD_VERSION_MISMATCH` | Gateway 二次校验 | 重新读取上下文，不要重放旧请求 |
| `CWD_INVALID` | 失效标记 | 先 `change_directory` 到一个存在的目录 |
| `EXECUTION_CONTEXT_INVALID` | Gateway 二次校验 | 请求与任务上下文不符 |
| `IDEMPOTENCY_CONFLICT` | 幂等记录 | 不要复用同一个 operation id |
| `TASK_NOT_ACTIVE` | 状态检查 | 任务已结束 |

工具结果不包含宿主机路径、内部堆栈或敏感文件信息；`cwd-manager` 对未识别的
异常统一返回 `CWD_INVALID`，细节只进审计。

## 审计事件

```text
task.cwd.initialized               task.cwd.change.requested
task.cwd.change.succeeded          task.cwd.change.denied
task.cwd.change.failed             task.cwd.recovered
task.cwd.invalidated               execution.cwd.snapshot.created
execution.cwd.validation.failed
```

`listAudit()` 支持按 `taskId / sandboxId / executionId / action` 过滤
（`SandboxStore.listAudit`）。运维侧对应命令：

```bash
npm run sandbox -- cwd --task <id>
npm run sandbox -- cd  --task <id> --path src
npm run sandbox -- audit --task <id> --action task.cwd.change.succeeded
```

## 测试覆盖

| ADR 验收项 | 测试 |
|---|---|
| 词法解析、`..`、绝对路径、前缀相似路径 | `tests/sandbox/cwd-path.test.ts` |
| 符号链接逃逸、文件、缺失目录、workspace 丢失 | `tests/sandbox/cwd-validator.test.ts` |
| 规则、版本冲突、`expectedCwdVersion`、幂等、失效 | `tests/sandbox/cwd-manager.test.ts` |
| 端到端：默认目录、切换、run_command 注入、Gateway 二次校验、恢复、权限模式 | `tests/sandbox/cwd.test.ts` |
| CAS 事务、审计同写、跨重启持久化 | `tests/sandbox/cwd-sqlite.test.ts` |
| 工具 schema、结构化错误、ordering | `tests/tools/change-directory-tool.test.ts` |
| 真实容器：`--workdir`、one-shot shell、启动器拒绝 | `tests/sandbox/integration.docker.test.ts`（`SANDBOX_INTEGRATION=1`） |

真实容器用例默认跳过，因为它们是 `runc`/`gVisor` 的证明，不是控制面逻辑的证明
（与 ADR 018 同样的取舍）。

## 与 ADR 021 字面要求的差异

1. **`openat2` / `fchdir` 未使用**：API 不存在于 `docker exec` 链路。替代方案见
   决定 4；这是 ADR 自己允许的路径。
2. **`WorkspaceFilter` 的 `/bin/bash` 问题保持原状**：ADR §7.3 明确说本重构不顺带
   改 shell 兼容性。当前仍是 `/bin/sh -c`，工具的文档承诺 POSIX shell 语义，
   CWD 机制不依赖 shell 进程持久化。
3. **`TaskExecutionContext.status` 多了 `paused`**：ADR 的三值无法表达 `PAUSED`，
   而 PAUSED 任务必须拒绝改目录。保留四值并映射 `FAILED → cancelled`、
   `COMPLETED/ARCHIVED → completed`。
4. **`task.cwd.changed` 事件名**：实现用的是 ADR §14 的
   `task.cwd.change.succeeded`，同时带有 `previous_cwd` / `new_cwd` /
   `cwd_version` 字段；没有额外再发一个 `task.cwd.changed`。
5. **物理校验在宿主侧做一次**（决定 3），而不是每次纯在容器内：
   容器内的等价检查在启动器里，两者都在。

## 验收矩阵（ADR §15.5）

| # | 验收门槛 | 实现位置 | 证据 |
|---|---|---|---|
| 1 | 所有 one-shot Bash 默认使用 Task CWD | `tool-adapter.ts` 的 `run()` 读 `currentDirectory()` 再 `execute`；`gateway.execute` 只接受任务 CWD | `cwd.test.ts`「passes the task cwd…」；docker 用例「starts a task in the workspace root…」 |
| 2 | `cd` 不会自动改变 Task CWD | 命令在独立 shell 中执行；没有任何从命令文本解析 `cd` 的代码 | `cwd.test.ts`「keeps a cd inside one command…」；docker 用例同名 |
| 3 | `change_directory` 成功后后续 Bash 使用新目录 | `CwdManager.changeDirectory` → CAS；adapter 每次重新读取 | `cwd.test.ts`「resolves a relative path…」「increments the version…」 |
| 4 | Agent 不需要自行维护绝对工作目录 | `change_directory` schema 只有 `path`；`run_command` 没有 `workdir` | `change-directory-tool.test.ts`「accepts only a path…」；`cwd.test.ts`「does not accept a workdir…」 |
| 5 | Task CWD 可跨 Agent 重启恢复 | `sandbox_tasks` 列 + `cwd-sqlite.test.ts` 的 reopen 用例 | `cwd-sqlite.test.ts`「survives a reopen」 |
| 6 | CWD 变更有原子版本控制 | `compareAndSetTaskCwd` 单事务；`cwd_version` CAS | `cwd-sqlite.test.ts`「changes the cwd and writes the audit row in one step」 |
| 7 | 并发冲突可检测 | CAS 失败返回 `CWD_VERSION_CONFLICT`，不静默重放 | `cwd.test.ts`「serialises two concurrent changes」；`cwd-manager.test.ts`「refuses an expected version that is stale」 |
| 8 | Gateway 不信任 Agent 提供的路径 | 二次读取上下文、核对 sandbox/workspace、version、路径 | `cwd.test.ts`「refuses a stale cwd version」「refuses a cwd that is not the task directory」 |
| 9 | Symlink 与 TOCTOU 有执行层防护 | 宿主侧 `realpath` 校验 + 容器内启动器 `cd -P` 与 `pwd -P` 复查 | `cwd-validator.test.ts` 全部；`runtime-args.test.ts`「starts the container in the task cwd…」；docker 用例「refuses to start… once the directory is gone」 |
| 10 | Sandbox 丢失后不会静默使用无效 CWD | `recover()` → `recoverDirectory()`；失效标记阻断执行 | `cwd.test.ts`「re-validates on recovery…」「refuses every execution until…」 |
| 11 | 没有工具绕过 Permission Manager | 变更走 `fs.chdir` 判权；adapter 只调用 Gateway | `cwd-manager.test.ts`「asks the permission layer…」「maps a denied decision…」；`cwd.test.ts` 权限模式两例 |
| 12 | 原有 Execution Marker 与 Recovery 不受破坏 | `WRAPPER` 仍是唯一的 marker 写入者，顺序不变；`transitionExecution` 未改 | 原 `gateway.test.ts` / `runtime-args.test.ts` 全部通过；`execution.cwd.snapshot.created` 是新增事件而非替换 |

已知未覆盖：真实容器用例需要 `SANDBOX_INTEGRATION=1` 与镜像 digest；默认 CI 中跳过，
与 ADR 018 的取舍一致。

## 已知边界

- bind 模式下多个任务共享同一个项目目录：Task CWD 是任务私有的，但目录内容不是。
  这与 ADR 的“不同 Task 不共享目录状态”不冲突，也与既有 workspace 模型一致。
- `current_cwd` 被删后又以同名重建：恢复流程会接受它（物理校验通过），因为
  “同一个路径现在是一个目录”是事实；是否恢复由任务状态决定，不由历史 hash 决定。
- 目录变更不会触发 checkpoint。workspace checkpoint 仍由显式命令或既有策略触发。
