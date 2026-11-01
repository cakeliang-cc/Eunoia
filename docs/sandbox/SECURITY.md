# Sandbox 安全模型

> 目标与威胁列表来自 [ADR 017 §13](../adr/017.sandbox.md)；本文描述本实现
> 实际提供的控制、测试证据和残留风险。

## 1. 安全边界

| 层 | 负责 | 不负责 |
|---|---|---|
| Permission Manager (`policy.ts`) | 授权决策：system deny > tenant > task > approval | 内核隔离 |
| Sandbox Runtime (`runtime/`) | 容器隔离、资源限制、无宿主 mount | 业务授权 |
| Network Layer (`network/`) | 默认拒绝、egress 策略、DNS/IP 检查 | 宿主防火墙本身 |
| Credential Broker | 短期凭证、scope、撤销、脱敏 | 外部系统的权限模型 |
| Audit | 决策/执行/恢复的 append-only 记录 | 阻止行为 |

**没有任何一层把安全交给模型或 auto-review。** 策略是值，审批是带范围/过期/
policy version 的记录，`DENY` 不能被审批覆盖。

## 2. 运行时基线

`buildCreateArgs()` 生成并由 `assertBaseline()` 再检查：

| 控制 | 实现 |
|---|---|
| 非 root | `--user 1000:1000` |
| 只读根文件系统 | `--read-only` |
| 唯一可写 mount | `--mount type=bind,src=<workspace>,dst=/workspace`（policy 无写权限时加 `readonly`） |
| 无 privileged | 禁止 `--privileged` / `--cap-add` / `--device` |
| 无宿主 namespace | 默认新建 PID/IPC；禁止 `--pid=host` / `--ipc=host` / `--network=host` |
| capabilities | `--cap-drop ALL` |
| 提权 | `--security-opt no-new-privileges:true` |
| 网络 | `--network none` 或 operator 的 egress 网络 |
| cgroups | `--pids-limit` / `--memory` / `--memory-swap` / `--cpus` |
| 临时目录 | `--tmpfs /tmp`（rootfs 只读） |
| seccomp / AppArmor | 运行时默认 + 可选 operator 配置的 profile |
| 镜像 | 只接受 `sha256:` digest；`--pull=never` |
| 环境 | 固定最小环境；拒绝 `LD_*` / `NODE_OPTIONS` 等注入键；`--env-file`（0600），不出现在 argv |
| 容器管理 socket | 不挂载；命令策略另外拒绝 `docker`/`ctr`/`nerdctl`/`mount`/`nsenter` 等 |

`tests/sandbox/runtime-args.test.ts` 逐项断言这些 flag 存在、禁止项不存在。

## 3. 路径与文件

`WorkspacePathGuard` 的顺序：

1. 词法：绝对路径、`..`、NUL、换行 → 拒绝；
2. 规范化：`/workspace/../etc/passwd` → `/etc/passwd`，再交给 system deny；
3. 祖先 realpath：不存在的路径也要检查最近的已存在祖先；
4. `O_NOFOLLOW` + `fstat`：final component 是 symlink 就拒绝；
5. 写入：拒绝 symlink、临时文件 + rename、写前再检查；
6. credential 文件名（`.env`、`*.pem`、`id_rsa` 等）默认拒绝；
7. ignored 目录（`.git`、`node_modules` 等）默认拒绝。

测试：`tests/sandbox/paths.test.ts`（真实文件系统，含 symlink、symlinked parent、
写穿 symlink、`..`、NUL、credential、binary、atomic write）。

## 4. 权限

```text
system deny  ── 不可覆盖（/etc/shadow、/proc/sys、docker.sock、metadata…）
   tenant    ── 只能收窄
   task      ── workspace 形状
   approval  ── 带 scope/过期/policy version
   runtime   ── 内核执行
```

- `fs.write` / `process.exec` 在 `WORKSPACE_WRITES` / `WORKSPACE_COMMANDS` 关闭时
  返回 `APPROVAL_REQUIRED`，不是 ALLOW；
- `ApprovalGrant` 必须匹配 action、scope、policyVersion、task、未过期、未撤销；
- `tests/sandbox/policy.test.ts` 验证“审批不能提升 system deny”。

## 5. 网络

`EgressPolicy.evaluate()` 在 DNS 解析后检查**每一个**地址：

- 拒绝 IP literal（含 IPv6、IPv4-mapped）；
- 拒绝 loopback / RFC1918 / link-local / CGNAT / multicast / reserved /
  documentation / 唯一本地 IPv6 / NAT64 / 6to4；
- 拒绝 cloud metadata 主机名和 `169.254.169.254`、`100.100.100.200`；
- 域名 allowlist 支持精确和 `*.` 后缀；
- 端口 allowlist；
- 解析失败 → fail closed；
- 混合公网/私网答案 → 拒绝（DNS rebinding）；
- 代理连接到已检查的 IP，不再二次解析。

`tests/sandbox/egress.test.ts` 覆盖上述每一条。

**限制：** CONNECT 隧道内只校验目的域名/端口/解析地址，不能检查 TLS 内的具体
请求；正向代理无法阻止已允许域名上的任意路径。allowlist 应尽量窄。

## 6. 跨 task

- 每个 task 有独立 workspace record；`execute`/`file`/`destroy` 都校验
  `sandbox.taskId === context.taskId` 和 `task.userId === context.userId`；
- bind 模式（默认，单用户本机）多个 task 共享同一项目目录，这是产品选择；
  多任务隔离用 `SANDBOX_WORKSPACE_MODE=copy`，每个 task 独立复制，跨 task 读不到；
- `tests/sandbox/integration.docker.test.ts` 用 copy 模式验证 task A 的文件在
  task B 的容器里不可读。

## 7. 凭据

- **bind 模式下，`.env` / `*.pem` / `id_rsa` 等文件被空的只读文件覆盖挂载**：
  `run_command` 看到的也是空文件，宿主的原件不变；文件工具仍然拒绝这些名字。
  copy 模式根本不复制它们。mask 在 sandbox 创建/重建时计算；运行期间 host 上
  新出现的凭据文件要等一次重建才会被遮蔽。
- 宿主 `process.env` 不进入容器；
- 只注入 `CredentialBroker` 签发的短期值，环境名 `EUNOIA_CRED_*`；
- grant 有 task、scope、过期、撤销；
- 值登记到 `Redactor`，写入日志/审计/执行输出前替换；
- 长生命周期 SSH key、云 root、生产数据库密码不在默认注入路径上。

## 8. 恢复与未知结果

- 心跳超时 ≠ 任务失败；先 inspect runtime；
- `RUNNING` 后失败 → `UNKNOWN`，不会写成 `FAILED`；
- 恢复只核验 marker，不重放命令；
- 非幂等外部副作用（push、写库、创建云资源）必须由人或模型在核验后决定。

## 9. 测试矩阵

| 测试 | 位置 | 运行条件 |
|---|---|---|
| policy / approval / path / argv / egress / store / gateway / recovery | `tests/sandbox/*.test.ts` | 默认 `npm test` |
| 非 root、只读 rootfs、/etc/shadow、socket、workspace、credential mask、seccomp、fork bomb、内存、timeout、env、跨 task | `tests/sandbox/integration.docker.test.ts` | `npm run sandbox:it` + 真实镜像 |
| 安全自检（含恢复） | `scripts/sandbox-security-check.ts` | `npm run sandbox:check` |
| Controller 重启恢复 | `tests/sandbox/gateway.test.ts` | 默认（fake runtime，验证持久化逻辑） |

**未在本机验证的：** gVisor/runsc、AppArmor、seccomp profile、KVM/ptrace 平台、
containerd/nerdctl 路径、宿主防火墙规则。它们需要目标 Linux 主机；本机 Docker
Desktop 只提供 `runc`，所以本机跑的是 `runc` 配置，且在 `/health` 中明确标记
`gvisor_required=false`、`non_gvisor_acknowledged=true`。这不是“通过”，是未验证。

## 10. 残留风险（明确列出）

1. Node 没有 `openat`：父目录在 realpath 检查和 rename 之间被替换的 TOCTOU
   窗口不能完全消除。真正的边界是 mount namespace；宿主侧文件工具只操作
   服务端选定的 workspace。
2. 文件工具是宿主侧进程，不是容器内进程。它能读写的范围由 guard 限制在
   workspace 内，但它的崩溃/漏洞属于服务进程，不属于容器。
3. bind 模式多 task 共享 workspace；需要强隔离必须用 copy 模式。
4. `mount`、`docker` 等命令的字符串拒绝是纵深防御，不是边界；真正的边界是
   capability drop、seccomp、只读 rootfs 和没有 socket。
5. Egress 的宿主防火墙规则不由本服务配置；没有规则时 `proxy_only` 的隔离不完整。
6. gVisor 的 syscall 覆盖面与内核版本相关；升级 runsc 需要重跑安全测试。
7. 审计表是 append-only 但没有签名/远程复制；能改数据库的人也能改审计。
8. `.git/config` 没有被 mask（git 需要它才能工作）；不要把长期 token 放在
   workspace 的 remote URL 里，使用 credential broker / 单独的 git 代理。
9. `SANDBOX_DISK_MB` 没有在 Docker overlay2 上强制执行；磁盘配额需要 volume +
   文件系统 quota。CPU/memory/pids 由 cgroups 强制执行。
10. `src/workspace-ui/` 是**人**使用的工作台（读 git、人自己输入的命令），不是
   agent 工具。它有独立的超时/字节上限/净化环境，并且架构测试禁止 agent、tools、
   service 引入它。把它当成 agent 的 Git Tool 是不正确的；本仓库目前没有 agent
   可调用的 Git 工具。
