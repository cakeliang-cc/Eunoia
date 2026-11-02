# Sandbox API

所有执行都必须经过 `SandboxGateway`。下面的类型是公开契约；实现见
`src/sandbox/gateway.ts`，端口见 `src/tools/types.ts`。

## 1. 创建与绑定

```ts
interface CreateSandboxInput {
  taskId: string;
  workspaceId: string;
  imageDigest: string;     // 必须是 operator 配置的 sha256 digest
  policyVersion: string;   // 必须是当前 SANDBOX_POLICY_VERSION
  resourceProfile: string; // small | default | large
}
```

`Gateway.create(input, context)` 会：

1. 校验 task 存在、workspace 属于该 task、image/policy 与部署配置一致；
2. 检查全局/用户/单 task 并发上限；
3. 写入 `sandboxes`（`CREATING`）和策略文档；
4. 编译 `RuntimeSandboxConfig`（固定环境、资源、网络、唯一 mount）；
5. `Controller.create()` → `Runtime.create()` → `start()` → inspect；
6. 成功写 `READY`，失败销毁残留并写 `FAILED`。

同一个 task 已有活动 sandbox 时返回它，不重复创建。

## 2. 执行

```ts
interface ExecuteInput {
  sandboxId: string;
  executionId: string;       // 可选；不给则生成
  idempotencyKey: string;    // 工具调用 id
  command: readonly string[];
  cwd: string;               // 必须在 /workspace 内
  timeoutMs: number;         // 被 SANDBOX_TIMEOUT_MS 截断
  shell?: boolean;           // true: command[0] 交给 /bin/sh -c
  toolCallId?: string;
}

interface ExecutionResult {
  executionId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'UNKNOWN';
  exitCode?: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt?: string;
}
```

`Gateway.execute(context, input, { signal })` 的行为：

| 情况 | 结果 |
|---|---|
| 相同 `idempotencyKey` + 相同命令 + 已终态 | 返回存储结果，不执行 |
| 相同 key + 不同命令 | `SandboxConflictError` |
| 相同 key 仍在运行 | `SandboxConflictError`，不重复提交 |
| 策略 `DENY` | `SandboxPolicyError`，审计 `denied` |
| 策略 `APPROVAL_REQUIRED` 且无 grant | `SandboxError(code=approval_required)` |
| runtime 不可达（提交前） | 执行 `FAILED`，抛错 |
| runtime 失败（`RUNNING` 后） | 执行 `UNKNOWN`，抛错 |
| 超时 | `TIMEOUT`；容器被 kill；sandbox `INTERRUPTED` |
| 取消 | `CANCELLED`；容器被 kill |

输出在写入存储前按 `SANDBOX_OUTPUT_LIMIT_BYTES` 截断（保留结尾），并做凭据脱敏。

## 3. 生命周期

```ts
gateway.inspect(sandboxId): Promise<SandboxStatusSnapshot>
gateway.interrupt(context, sandboxId, executionId): Promise<void>
gateway.recover(context, sandboxId): Promise<SandboxStatusSnapshot>
gateway.destroy(context, sandboxId): Promise<void>   // workspace 保留
gateway.gc({ idleMs, checkpointRetentionMs })
gateway.approve(context, { action, resourceScope, ttlMs, approvedBy })
gateway.checkpoint(context, sourceExecutionId?)
```

`destroy` 只销毁 runtime；workspace、checkpoint 和审计记录保留。

## 4. 工具端口

工具只认识这两个端口（`src/tools/types.ts`）：

```ts
interface ToolExecutor {
  run(input: {
    command: readonly string[];
    shell?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    toolCallId: string;
  }): Promise<ToolExecutionResult>;
}

interface ToolWorkspacePort {
  relative(hostPath: string): string;
  readLines(input: string, start?: number, end?: number): Promise<ToolFileSlice>;
  listDir(input?: string, depth?: number): Promise<ToolDirectoryListing>;
  glob(pattern: string, maxResults?: number): Promise<{ paths: string[]; truncated: boolean }>;
  grep(options: GrepOptions): Promise<ToolGrepResult>;
  writeText(input: string, content: string): Promise<ToolWriteResult>;
  editText(options: EditOptions): Promise<ToolEditResult>;
}
```

`ToolExecutionResult` 比 `ExecutionResult` 多 `timedOut` / `durationMs`，少
`startedAt` / `finishedAt`；它不暴露 runtime id、容器名或 sandbox 内部状态。

## 5. 工具映射

| 工具 | 端口 | Action | 默认（`WORKSPACE_WRITES/COMMANDS` 关） |
|---|---|---|---|
| `read_file` | `readLines` | `fs.read` | ALLOW |
| `list_dir` | `listDir` | `fs.list` | ALLOW |
| `glob` | `glob` | `fs.read` | ALLOW |
| `grep` | `grep` | `fs.read` | ALLOW |
| `write_file` | `writeText` | `fs.write` | APPROVAL_REQUIRED |
| `edit_file` | `editText` | `fs.write` | APPROVAL_REQUIRED |
| `run_command` | `run` | `process.exec` | APPROVAL_REQUIRED |

工具输入/输出格式保持不变：`ToolResult { ok, output, error?, meta? }`。
`run_command` 的 `meta` 增加 `status`、`executionId`；`read_file` 的 ledger 行为不变。

## 6. 权限 API（ADR 020）

Gateway 是权限模块唯一的应用入口；没有绕过它的 HTTP 面。

```ts
gateway.setPermissionPolicy({
  scopeType: 'session' | 'task' | 'sandbox',
  scopeId: string,
  mode?: 'read-only' | 'auto' | 'on-request' | 'restricted',
  ttlMs?: number,
  actor: string,
  overrides?: { rules?, autoReview?, approval?, restricted?, expiresAt? },
}): Promise<PermissionPolicyRecord>

gateway.permissionStatus(context): Promise<{
  mode: PermissionMode,
  permission_policy_version: string,
  scopes: EffectivePolicyScope[],
  auto_review: AutoReviewSettings,
  approval: ApprovalSettings,
  restricted: RestrictedAllowlist,
  requests: PermissionRequestRecord[],
  approvals: HumanApprovalRecord[],
  grants: ApprovalGrant[],
}>

gateway.listPermissionRequests(context): Promise<PermissionRequestRecord[]>
gateway.listPermissionApprovals(context): Promise<HumanApprovalRecord[]>
gateway.listPermissionGrants(context): Promise<ApprovalGrant[]>

gateway.approvePermissionRequest(context, {
  approvalRequestId: string,
  decidedBy: string,              // 不能是 agent:*，不能是请求者本人
  scope?: 'once' | 'task' | 'session',
  ttlSeconds?: number,
  reason?: string,
}): Promise<{ approval: HumanApprovalRecord, grantId: string | null }>

gateway.denyPermissionRequest(context, {
  approvalRequestId: string,
  decidedBy: string,
  reason?: string,
}): Promise<HumanApprovalRecord>

gateway.sweepPermissions(): Promise<{
  requests: number, approvals: number, expiredGrants: number, staleGrants: number,
}>
```

`ExecuteInput` / 文件工具没有 `permissionMode` 字段。模式只由部署配置和持久化
作用域策略决定；Agent 不能给自己改模式。

`approval_required` 错误额外携带 `requestId` 和 `approvalRequestId`，便于操作员
在 CLI 里定位：

```ts
catch (error) {
  if (error instanceof SandboxApprovalRequiredError) {
    error.approvalRequestId; // npm run sandbox -- approve-request --approval <id> --by <person>
  }
}
```

详细语义、风险等级和与 ADR 的偏差见 [PERMISSIONS.md](PERMISSIONS.md)。

## 7. 权限 CLI

```text
npm run sandbox -- permissions --task <id>
npm run sandbox -- mode --task <id> --mode read-only [--minutes 30] [--by alice]
npm run sandbox -- requests --task <id>
npm run sandbox -- approvals --task <id>
npm run sandbox -- approve-request --approval <id> --by alice [--scope once|task|session]
npm run sandbox -- deny-request --approval <id> --by alice --reason "not needed"
npm run sandbox -- grants --task <id>
npm run sandbox -- revoke --task <id> --approval <id>
npm run sandbox -- sweep
```

`mode` / `approve-request` / `deny-request` 是可信控制面操作，不经过 HTTP。

## 8. HTTP 面

沙箱目前**没有**对外 HTTP API；它从聊天工具路径进入，运维用 CLI。这是有意的：
一个可以创建容器、执行命令的 HTTP 端点会需要一个认证层，而这个服务现在只有
单用户身份句柄（ADR 009）。`/health` 暴露只读摘要：

```json
{
  "sandbox": {
    "enabled": true,
    "runtime": "docker",
    "runtime_class": "runc",
    "gvisor_required": false,
    "runtime_ok": true,
    "image": "sha256:…",
    "workspace_mode": "bind",
    "network_mode": "none",
    "writes": true,
    "commands": true,
    "metrics": { "execution_total": 3, "execution_success_rate": 1 }
  }
}
```

## 9. 错误

| code | 含义 | 模型应该怎么处理 |
|---|---|---|
| `invalid_input` | 参数/配置不合法 | 修正参数或告诉用户配置 |
| `not_found` | task/sandbox/workspace 不存在 | 不要重试，报告 |
| `forbidden` | 策略 DENY（含 system deny） | 换一个在授权范围内的操作 |
| `approval_required` | 需要审批；错误带 `requestId` / `approvalRequestId` | 停下来告诉用户，由人用 CLI 批准 |
| `conflict` | 幂等键/状态冲突 | 不要重试同一个执行 |
| `runtime_unavailable` | runtime 或 gVisor 不可用 | 不要退回宿主机，报告 |
| `quota_exceeded` | 并发上限 | 等待或让用户清理 |
| `timeout` | 执行超时 | 不要盲目重跑；先看输出/状态 |
| `unknown_execution` | 结果未知 | 不要重试，先核验外部状态 |
