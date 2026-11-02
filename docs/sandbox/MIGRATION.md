# 旧执行路径迁移说明

## 1. 审计结果（ADR 017 Step 1）

在改动之前完整扫描了 `src/`、`tests/`、`scripts/` 的调用关系。结论：

| 类别 | 旧路径 | 处理 |
|---|---|---|
| Shell / 子进程 | `src/tools/workspace.ts` 的 `runCommand()`，`spawn(value, { shell: true, env: process.env })` | 删除；命令改走 `ToolExecutor` → Gateway → 容器 |
| 文件读写 | `Workspace.readLines/listDir/glob/grep/writeText/editText`，直接 `node:fs` | 保留实现但移到 `src/sandbox/workspace-files.ts`，经 Gateway 与 path guard |
| Docker / containerd API | 无（项目里没有 Docker 客户端） | 新增，且只在 `src/sandbox/runtime/` |
| 网络工具 | 无浏览器/网络工具；只有 `node:http` 的 SSE 服务端 | 不变；新增 egress 策略/代理用于沙箱 |
| 环境变量/凭证注入 | `runCommand` 把整个 `process.env` 传给子进程 | 删除；容器使用固定最小环境 + brokered 值 |
| Session/Task 持久化 | `conversations` / `messages`（SQLite） | 保留；新增 `sandbox_tasks`，taskId = conversationId |
| 后台任务/取消 | Agent loop 的 `AbortSignal`；无独立后台任务 | 保留；执行层新增 timeout + container kill |
| 绕过 Tool Dispatcher | `bash` 直接调 `Workspace.runCommand` | 删除；工具只能拿 `ToolExecutor` 端口 |
| 人员工作台的 git | `src/workspace-ui/git.ts` 的 `spawn('git', ...)` | **不在 agent 执行路径内**：由人打开 Changes 标签触发，无 shell、净化环境、只读、有超时/上限；架构测试禁止 `src/tools|agent|service` 引入它 |
| MCP / Agent Delegation / Scheduled Task | 本仓库不存在 | 无需迁移；`docs/sandbox/SECURITY.md` 已注明 |

也可以看 `tests/architecture/sandbox-boundaries.test.ts`：它检查 `src/tools/` 不再
import `node:fs`/`node:child_process`，`src/service/`/`src/agent/` 不 import
Controller/runtime/store，`node:child_process` 只出现在 `src/sandbox/runtime/`。

## 2. 新旧接口映射

| 旧调用 | 新调用 |
|---|---|
| `Workspace.runCommand(cmd, { timeoutMs, signal })` | `ToolExecutor.run({ command: [cmd], shell: true, timeoutMs, signal, toolCallId })` |
| `Workspace.readLines(...)` | `ToolWorkspacePort.readLines(...)` → `Gateway.readFile` |
| `Workspace.writeText(...)` | `ToolWorkspacePort.writeText(...)` → `Gateway.writeFile` |
| `Workspace.editText(...)` | `ToolWorkspacePort.editText(...)` → `Gateway.editFile` |
| `ToolContext.workspace` | `ToolContext.workspace`（类型改为 `ToolWorkspacePort`） |
| — | `ToolContext.executor`（新增，命令端口） |
| `TurnDependencies.workspace` | `TurnDependencies.sandbox: SandboxToolProvider` |
| `createApp({ workspace })` | `createApp({ sandbox: SandboxPlatform })` |
| `workspace.root` 展示 | `sandboxSession.displayPath`（`/workspace`） |

工具的 **schema**、模型可见描述、`ToolResult` 形状、SSE `tool_call`/`tool_result`
事件、`read` 的 ledger 行为都没有变。模型不需要知道 sandbox 的存在。

## 3. 数据库迁移

`PRAGMA user_version` 从 1 变为 3：v2 追加九张表，v3 给 `sandboxes` 增加
`resource_profile`（默认 `default`），让恢复时使用同一个资源档位。

```text
sandbox_tasks
sandbox_workspaces
sandbox_workspace_checkpoints
sandboxes
executions
execution_events
sandbox_approvals
sandbox_policies
sandbox_audit_events
```

迁移方式：`openSqliteStore()` 在 `version < 2` 时执行完整 schema（全部 `CREATE
TABLE IF NOT EXISTS`），在 `version === 2` 时执行 `ALTER TABLE sandboxes ADD
COLUMN resource_profile`，最后把 `user_version` 写成 3。不改写、不删除任何已有行。
测试见 `tests/sandbox/sqlite.test.ts` 的 “upgrades an existing version-1 file”
用例：保留 `users` 行，重建 sandbox 表。

历史数据：

- 旧会话没有 task 行 → 第一次使用文件/命令工具时 `Gateway.ensureTask()` 懒创建，
  `taskId = conversationId`；
- 旧 workspace 就是 `WORKSPACE_ROOT` → 默认 bind 模式，`workspaceId` 由规范化路径
  派生；不复制、不移动；
- 旧执行记录不存在（此前没有持久化）→ 不伪造新执行；`executions` 为空；
- 历史工具调用不被重新执行，也不会被映射成 SUCCEEDED/FAILED。

## 4. 配置迁移

以前：

```bash
WORKSPACE_ROOT=/path/to/repo
WORKSPACE_WRITES=1
WORKSPACE_COMMANDS=1
npm run dev
```

现在必须再给 sandbox：

```bash
WORKSPACE_ROOT=/path/to/repo
WORKSPACE_WRITES=1
WORKSPACE_COMMANDS=1
SANDBOX_IMAGE_DIGEST=sha256:...
SANDBOX_RUNTIME_CLASS=runc          # macOS 开发；生产用 gvisor
SANDBOX_ALLOW_NON_GVISOR=1          # 仅 runc 需要
npm run dev
```

如果只改 `WORKSPACE_ROOT` 而没有 sandbox 配置，服务会在启动时抛
`SANDBOX_IMAGE_DIGEST must be an immutable digest…`。这是 fail-closed：不会退回
宿主机执行。想临时关闭全部文件/命令工具，设 `SANDBOX_ENABLED=0`。

## 5. 回滚

- **运行时关闭**：`SANDBOX_ENABLED=0`。agent 只剩记忆工具，没有宿主执行路径。
- **代码回滚**：回到 sandbox 之前的版本。schema v3 的表对旧版本是无害的多余表；
  旧版本读 `user_version=3` 时如果它的 `SQLITE_SCHEMA_VERSION` 更小，会拒绝打开
  （“newer than this build”）。所以回滚代码前先备份数据库，或把 `user_version`
  改回 1（不推荐，会丢 sandbox 元数据）。
- **workspace**：bind 模式不会被本服务删除；copy 模式目录在
  `SANDBOX_WORKSPACE_ROOT/tasks/`，可手工删除。checkpoint 在
  `SANDBOX_WORKSPACE_ROOT/checkpoints/`。

## 6. 上线顺序

1. 安装 runtime（`scripts/sandbox-install.sh` 或 Docker Desktop）；
2. 配置 `SANDBOX_IMAGE_DIGEST` / runtime class；
3. `npm run migrate`（应用 schema v3）；
4. `npm run sandbox:check`；不通过不进入下一步；
5. 在目标 Linux 上 `npm run sandbox:it`（gVisor）；
6. 启动服务，观察 `/health.sandbox`；
7. 用 `npm run sandbox -- status` 看 sandbox 列表；
8. 旧会话第一次调用工具时会懒创建 task，不需要批量迁移脚本。
