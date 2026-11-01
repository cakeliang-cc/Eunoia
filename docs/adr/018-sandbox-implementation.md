# ADR 018 — Sandbox 实现：把 ADR 017 落到这台机器和这份代码上

## 背景

ADR 017 描述的是目标状态：所有不可信执行都在隔离环境里，经 Sandbox Gateway
进入，由 Permission Manager 决策，Runtime 负责内核级隔离。它写在纸面上是完整的；
这份 ADR 记录的是**实现时真正做的选择**，以及和 017 的字面要求不一致的地方。

之所以单独写，是因为 017 里有几处不能靠“看起来实现了”来交差：

- 它要求 containerd + gVisor，本机是 macOS，没有 `runsc`；
- 它要求所有文件操作也走 Sandbox，但本项目的文件工具一直是宿主侧进程；
- 它要求审批服务，但聊天传输是单向 SSE，无法在回合中间提问；
- 它要求网络隔离和出口代理，但没有规定代理由谁运行。

不把这些写成决策，下一个人会在代码里看到“只做了 Docker”而不知道这是有意的。

## 决定

### 1. Runtime 是 provider，不是 Docker 的别名

`SandboxRuntime` 是唯一的运行时接口（`src/sandbox/types.ts`），实现在
`src/sandbox/runtime/oci-runtime.ts`。它接受 `RuntimeSandboxConfig`——一个封闭的
结构体，没有任何字段能表达 capability、mount、namespace、device 或 runtime binary。
argv 由 `oci-args.ts` 生成，并在 spawn 之前用 `assertBaseline()` 再检查一遍。

一个实现同时支持两个客户端：

| 客户端 | 用途 | gVisor handler |
|---|---|---|
| `docker` | 开发机；`runtimeClass=runc` 时必须显式承认 | `runsc` |
| `nerdctl` | Linux 生产；containerd 的 `eunoia` namespace | `io.containerd.runsc.v1` |

选 nerdctl 而不是直接写 containerd gRPC：`ctr`/`nerdctl` 是 containerd 的官方
客户端，参数面小、可审计，而自写一个 gRPC 客户端只会增加一份需要维护的协议
实现。Runtime Manager 仍然是**唯一**调用容器客户端的组件；
`tests/architecture/sandbox-boundaries.test.ts` 会检查 `node:child_process` 只出现在
`src/sandbox/runtime/`。

### 2. gVisor 是要求，不是回退

默认 `SANDBOX_RUNTIME_CLASS=gvisor`，`requireGvisor=true`。启动时 probe 必须
返回 `gvisor=present`，否则 `createSandboxPlatform` 直接抛错；每次 create 也会再
probe。`runc`/`default` 只有在同时设置 `SANDBOX_RUNTIME_CLASS` 和
`SANDBOX_ALLOW_NON_GVISOR=1` 时才允许，而且这个事实会出现在启动日志、
`/health` 和每个 sandbox 的 `runtimeType` 上。

macOS 开发机因此只能跑 `runc`。这是有意的：它让“本机测试”与“生产隔离”在配置
上可见地不同，而不是让一个默认值悄悄决定。

### 3. 文件工具走 Gateway，但文件操作在宿主侧

命令必须在容器内执行；这是边界。文件读写则不一样：workspace 是宿主上的一个
目录，bind mount 进容器，沙箱内的进程看到的正是同一份文件。把读文件也做成
容器内 exec 会引入一个 in-container helper、协议和额外的故障面，而它并不增加
隔离——容器里的 agent 本来就能读写 `/workspace`。

因此：

- `ToolExecutor.run` → Gateway → Controller → Runtime（容器内）；
- `ToolWorkspacePort.*` → Gateway → `WorkspaceFiles`（宿主侧，`WorkspacePathGuard`）。

宿主侧这一层用 `O_NOFOLLOW` 打开、对最近的已存在祖先做 `realpath`、拒绝对 symlink
写入、写临时文件再 rename。残留风险写在 `docs/sandbox/SECURITY.md`：Node 没有
`openat`，父目录在 check 和 rename 之间被换掉的 TOCTOU 不能完全消除；真正的
边界仍是 mount namespace。

### 4. 审批是 CLI 授权，不是回合中弹窗

`PermissionManager` 能返回 `APPROVAL_REQUIRED`。`ApprovalGrant` 不是
`{approved:true}`，而是带 action、resource scope、expiresAt、approvedBy 和
policyVersion 的记录，存在 `sandbox_approvals` 表里。授权入口是
`npm run sandbox -- approve ...`，因为 SSE 回合无法中途等待一个人点击。

这保留了 ADR 017 的核心性质：审批只能在系统允许的范围内放宽，永远不能覆盖
`DENY`；并且 `fs.write` 与 `process.exec` 的 scope 都经过容器路径规范化。

### 5. Egress Proxy 是独立进程，网络边界由宿主防火墙补齐

`src/sandbox/network/egress-policy.ts` 实现了域名、端口、IP 范围、metadata
地址、IP literal、IPv6 映射和 DNS rebinding 检查；`egress-proxy.ts` 是一个真正的
HTTP/CONNECT 代理，连接时使用已检查过的 IP。`npm run sandbox -- proxy` 启动它。

但“沙箱只能到代理”不是应用进程能保证的：它需要宿主上的 nftables/iptables
规则，把 egress 网络的出站限制到代理地址。`scripts/sandbox-install.sh` 给出示例
规则，`docs/sandbox/OPERATIONS.md` 把它列为上线检查项。默认 `network=none` 时
不需要代理，这也是本项目的默认配置。

### 6. 一个 task 一个 workspace，identity 与生命周期解耦

`taskId` 就用 conversation id。`workspaceId` 由 workspace 的规范化路径派生，
在 bind 模式下多个 task 会共享同一个 workspace；这是单用户本机产品的
`SANDBOX_WORKSPACE_MODE=bind` 默认。需要真正的多任务隔离时用 `copy`：每个 task
复制一份到 `SANDBOX_WORKSPACE_ROOT/tasks/<task>`，`cp` 时跳过 ignored 目录、
凭据文件和所有 symlink。`python`/`node` 不等价于“隔离”，文档里不这么写。

Sandbox 被销毁时 workspace 不删；`gateway.destroy` 只销毁 runtime，CLI 的 `gc`
也只过期 runtime。copy 模式的目录要删，必须显式调用 `WorkspaceManager.destroy`。

### 7. 基础镜像由 operator 维护

运行时只接受 `sha256:` digest，并且 `--pull=never`。参考镜像和构建脚本在
`scripts/sandbox-image/`，规则见 `docs/sandbox/IMAGES.md`：镜像由 operator
构建、扫描并推进 digest，Agent 不能修改，也不把凭据烤进镜像。

### 8. UNKNOWN 是正式状态

`executionOutcome()` 把未完成的执行映射到 `UNKNOWN`。执行包装器把退出码写到
容器内 tmpfs 的 marker 文件：`/tmp/.eunoia/<executionId>.status`。Gateway 崩溃后，
Recovery 用 marker 作为证据；marker 和 runtime 都没了，结果就停在 UNKNOWN，不会
被改写成 FAILED，也不会被重放。`UNKNOWN` 在
`UNFINISHED_EXECUTION_STATES` 里，所以下次 recovery 会再次尝试核验。

### 9. SQLite schema v3，而不是第二个数据库

sandbox 的九张表放在 `src/sandbox/schema.ts`，由 `sqlite-schema.ts` 追加到基础
schema，`PRAGMA user_version` 从 1 升到 3（v2 建表，v3 增加 `resource_profile`）。它们和会话/记忆共用同一个连接，
因为这是单进程、单文件的本地应用；但 `SandboxStore` 是独立端口，`Store` 没有
多出任何 sandbox 字段。

## 与 ADR 017 的偏差（明确列出）

| 017 的要求 | 本次实现 | 原因 |
|---|---|---|
| containerd 客户端 + gVisor | `docker`（开发）/ `nerdctl`（生产，containerd）+ runsc | 不自己实现 gRPC；两者都是 containerd 的受支持客户端 |
| 所有文件操作也在沙箱内 | 命令在沙箱内；文件操作在宿主侧、经 Gateway 与路径 guard | 不增加隔离，减少协议和故障面；风险已记录 |
| 审批服务 / Auto-review | 带范围的 ApprovalGrant + CLI；无自动审批 | ADR 017 明确说不能把安全交给 LLM auto-review |
| 网络策略由 namespace + 宿主网络层实施 | 默认 `--network none`；proxy_only 需要宿主防火墙规则 | 单进程无法配置宿主 firewall；脚本给出规则 |
| 长期运行的 Sandbox 容器（heartbeat/reconnect） | 有；容器 `sleep`，exec 进入；timeout 会 kill 并重建 | 满足执行状态和恢复要求 |
| 子 Agent / MCP / 后台任务也要迁移 | 本仓库不存在这些执行入口 | Step 1 审计结果：只有 7 个 coding 工具、记忆工具和 `load_skill` |

## 后果

- 没有 `runsc` 的机器不能以“生产模式”启动；必须显式选择 `runc` 并接受
  `non_gvisor_acknowledged=true`。
- 真实隔离测试需要 Linux 或 Docker Desktop；默认 `npm test` 不跑它们，
  `npm run sandbox:it` 和 `npm run sandbox:check` 会跑，而且不会用 mock 假装通过。
- 新增一个 tool 时，不需要碰 sandbox；新增一个 sandbox 能力时，必须先改
  `RuntimeSandboxConfig` 和 baseline 测试，而不是在工具里加参数。
