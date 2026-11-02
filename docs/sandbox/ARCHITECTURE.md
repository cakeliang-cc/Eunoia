# Sandbox 架构

> 实现依据：[ADR 017](../adr/017.sandbox.md)（目标状态）与
> [ADR 018](../adr/018-sandbox-implementation.md)（本次实现的选择与偏差）。
> 本文描述**已经存在的代码**，不是计划。

## 1. 总览

```text
Chat request
    |
    v
service/chat.ts  ── conversationId = taskId
    |
    +--> ToolRegistry (memory tools, skill, coding tools)
    |
    +--> Sandbox gateway tool adapter (src/sandbox/tool-adapter.ts)
            |                         |
            | ToolExecutor            | ToolWorkspacePort
            v                         v
       Sandbox Gateway  ──────────► Workspace Manager
            |                         |
            |  policy + approvals     +--> guarded host filesystem
            v                         |
       Sandbox Controller             +--> checkpoints
            |
            v
       Sandbox Runtime (OCI CLI)
            |
            v
       containerd / runsc  (production)
       docker              (development)
```

一条命令的实际路径：

```text
bash tool
  -> ToolExecutor.run(command, toolCallId)
  -> Gateway.execute()
       1. validate task ownership and sandbox binding
       2. idempotency lookup by (sandboxId, toolCallId)
       3. PermissionManager.evaluate('process.exec')
       4. persist execution: CREATED -> AUTHORIZED -> SUBMITTED
       5. Controller.ensureRunning()  (recover/rebuild if needed)
       6. persist RUNNING
       7. Runtime.execute() -> docker exec / nerdctl exec
       8. persist terminal state + events + audit
  -> ExecutionResult
  -> tool formats output for the model
```

## 2. 模块

| 模块 | 职责 | 不允许做 |
|---|---|---|
| `src/service/chat.ts` | 一轮对话；构建 task/provider；注册工具 | 不构造容器、不读宿主路径 |
| `src/tools/types.ts` | `ToolExecutor` / `ToolWorkspacePort` 端口 | 不知道 sandbox 存在 |
| `src/sandbox/tool-adapter.ts` | 端口 → Gateway；task 懒初始化；`/workspace` 路径映射 | 不直接执行命令 |
| `src/sandbox/gateway.ts` | 唯一入口：create/execute/inspect/interrupt/recover/destroy；文件工具；idempotency；事件 | 不生成 OCI argv |
| `src/sandbox/policy.ts` | 结构策略（system/tenant/task）；runtime 配置编译 | 不做 I/O |
| `src/sandbox/permissions/*` | 模式解析、规则、Grant、Request、Auto-review、Human Approval、权限恢复 | 不执行命令、不建容器 |
| `src/sandbox/controller.ts` | 生命周期状态机；heartbeat；recover/rebuild | 不接收任意 OCI 配置 |
| `src/sandbox/runtime/*` | 唯一的容器客户端；硬化的 argv | 不向调用方暴露 runtime 类型 |
| `src/sandbox/workspace-manager.ts` | bind/copy workspace、checkpoint、清理 | 不销毁 bind 模式的用户目录 |
| `src/sandbox/workspace-files.ts` | 路径 guard 之上的文件操作 | 不含 `runCommand` |
| `src/sandbox/paths.ts` | 词法 + realpath + `O_NOFOLLOW` 检查 | 不信任字符串前缀 |
| `src/sandbox/store*.ts` | task/workspace/sandbox/execution/event/approval/audit 持久化 | 不写会话内容 |
| `src/sandbox/recovery.ts` | 启动扫描；sandbox/workspace/execution 恢复 | 不重放命令 |
| `src/sandbox/network/*` | egress 策略、DNS/IP 检查、HTTP/CONNECT 代理 | 不改容器网络 |
| `src/sandbox/credentials.ts` | 短期凭证、scope、过期、撤销、脱敏 | 不注入宿主长期密钥 |
| `src/sandbox/audit.ts` | append-only 审计、指标 | 不修改已写记录 |
| `src/sandbox/cli.ts` | status/recover/permission modes/requests/approvals/grants/checkpoint/gc/proxy | 不绕过 Gateway |

`tests/architecture/sandbox-boundaries.test.ts` 机械化检查：

- `node:child_process` 只允许出现在 `src/sandbox/runtime/`；
- `src/tools/` 不允许 import `node:fs` / `node:child_process`；
- `src/service/`、`src/agent/` 不允许 import Controller、runtime 或 sandbox store；
- tools 不允许 import Gateway；
- `node:http` / `node:net` 只允许出现在 `src/sandbox/network/`。

## 3. 数据模型

```text
sandbox_tasks 1 ── 1 sandbox_workspaces 1 ── N sandbox_workspace_checkpoints
      │                  │
      │                  └──────────────┐
      └── N sandboxes ─── N executions ── N execution_events
                    │
                    └── N sandbox_audit_events

sandbox_approvals   (grants: task/session-scoped, expiring, policy-versioned)
sandbox_policies    (versioned policy documents)
permission_policies (session/task/sandbox mode + rules + restricted allow-list)
permission_requests (one open request per principal/action/resource/policy)
permission_approval_requests (human approval queue)
permission_decisions (append-only decision ids)
```

关键约束：

- `executions (sandbox_id, idempotency_key)` 唯一。同一个 key 不会产生第二次副作用。
- `execution_events` 只追加；没有 update 端口。
- `sandbox_audit_events` 只追加。
- `sandboxes` 通过 `workspace_id` 引用 workspace，worker 不拥有 workspace 的生命周期。
- 所有状态更新都是 compare-and-set：`UPDATE ... WHERE status IN (...)`。
- `permission_requests` 和 `permission_approval_requests` 同样用 CAS 迁移状态；
  `permission_decisions` 只追加。
- `sandboxes.config_digest` 记录编译后的 runtime 配置哈希；模式切换后 Controller
  不重连旧容器。

## 4. 状态机

### Sandbox

```text
CREATING -> READY -> RUNNING -> READY
                |        |
                |        +-> INTERRUPTED -> RECOVERING -> READY
                |        |                       |
                |        |                       +-> FAILED -> RECOVERING
                +--------+-> TERMINATING -> DESTROYED
                         +-> EXPIRED -> TERMINATING -> DESTROYED
```

`heartbeat` 只把“runtime 确实不在了”的 sandbox 标成 `INTERRUPTED`，不会因为一次
心跳超时就把任务判失败。`RECOVERING` 会重新 inspect；活着就重连，不在就重建，
workspace 始终不删。

### Execution

```text
CREATED -> AUTHORIZED -> SUBMITTED -> RUNNING
                                        |
                    +---------+---------+---------+
                    v         v         v         v
                SUCCEEDED   FAILED   TIMEOUT  INTERRUPTED/UNKNOWN
                                                      |
                                                      v
                                                  RECONCILING
                                                   /       \
                                                  v         v
                                             SUCCEEDED    RETRYABLE / UNKNOWN
```

- `CREATED/AUTHORIZED/SUBMITTED` 失败 → `FAILED`（命令可证明没有运行）；
- `RUNNING` 之后失败 → `UNKNOWN`（可能已经产生副作用）；
- `UNKNOWN` 只能通过 `RECONCILING` 离开；
- `RETRYABLE` 不会自动重试，它只是给 operator/模型的一个判断结果。

## 5. 执行事件

每次执行至少写：

```text
execution/created
execution/authorized
execution/submitted
execution/started
execution/stdout       (只记录字节数，不重复正文)
execution/stderr
execution/finished | execution/failed
execution/interrupted  (取消时)
execution/reconciled   (核验时)
```

`ExecutionEvent` 带 `taskId / sandboxId / executionId / idempotencyKey /
policyVersion / timestamp / payload`；审计事件额外带 `sessionId / toolCallId /
approvalId`。

## 6. 幂等与 UNKNOWN

1. 工具调用 id（模型给的 `callId`）就是 `idempotencyKey`；
0. 同一个 sandbox 同时只允许一个命令执行（`inFlight` + `maxConcurrentPerTask`），
   超过时新执行被置 `CANCELLED`，不会排队也不会重复跑；
2. Gateway 先按 key 查；命中且终态 → 直接返回存储结果，不执行；
3. 命中但未终态 → 冲突错误，不重复提交；
4. 同一个 `executionId` 也不能第二次执行；
5. 命令本身不保证幂等（`docker push`、写数据库），所以恢复只做核验，不做重放；
6. 容器内 marker `/tmp/.eunoia/<executionId>.status` 是恢复时唯一可信的“命令跑完
   了没有”的证据；没有它就保持 UNKNOWN。

## 7. 文件工具

bind 模式下，宿主项目里的 `.env` / `*.pem` / `id_rsa` 等凭据文件会在容器里被
一个**空的只读文件覆盖挂载**（`maskedCredentials`）：文件工具拒绝它们，`bash`
读到的也是空文件，宿主原件不变。copy 模式不复制这些文件，所以不需要 mask。

文件操作不经过容器，但**经过 Gateway**：

```text
read -> ToolWorkspacePort.readLines
          -> Gateway.readFile
          -> policy: fs.read on /workspace/<path>
          -> WorkspaceFiles.readLines
          -> guard: lexical -> realpath ancestor -> O_NOFOLLOW open -> fstat
          -> audit
```

写路径的额外规则：拒绝对 symlink 写入、临时文件 + rename、写完刷新
`workspace.currentVersion`（内容 digest）。

## 8. 凭据

```text
CredentialBroker.register()   (operator, startup)
CredentialBroker.issue(task)  (scoped, TTL, audit)
Gateway.executionEnv(task)    -> EUNOIA_CRED_<NAME>
Runtime.execute(env)          -> --env-file (mode 0600), never --env in argv
Audit/Redactor                -> 值被登记，日志/事件里替换成 [redacted]
```

宿主的 `process.env` 不会被复制进容器。`compileRuntimeConfig` 还会拒绝
`LD_PRELOAD`、`NODE_OPTIONS`、`PYTHONSTARTUP` 这类能注入代码的键。

## 9. 网络

- 默认：`--network none`；容器里没有默认路由。
- `proxy_only`：容器挂到 operator 创建的 egress 网络，环境里有 `HTTP(S)_PROXY`；
  唯一允许的出站目的地应由宿主防火墙限制为代理地址。
- 代理在连接前检查：域名 allowlist、端口 allowlist、IP literal、loopback、
  RFC1918、link-local、CGNAT、metadata、IPv6 映射、NAT64、DNS rebinding
  （解析出的每个地址都必须是公网地址），然后连接已检查的 IP。

## 10. 恢复

启动时 `platform.start()`：

```text
probe runtime
  -> recoverAll()
       for each active sandbox:
           workspace record?  -> 没有: 标 FAILED / task PAUSED
           workspace 可读?    -> 不可读: 同上
           inspect runtime    -> 活着: 重连 READY
                              -> 不在: 用同一个 sandboxId 重建（workspace 不变）
       for each unfinished execution:
           CREATED/AUTHORIZED -> FAILED（从未提交）
           marker 存在 -> SUCCEEDED/FAILED
           runtime 活但无 marker -> UNKNOWN
           runtime 和 marker 都没了 -> UNKNOWN
  -> heartbeat timer
```

Controller 重启后只依赖数据库和 runtime，不依赖进程内 map；集成测试用一个新的
`FakeRuntime` + 同一个 store 验证了这一点。
