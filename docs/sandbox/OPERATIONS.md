# Sandbox 运维手册

## 1. 启动前检查

| 项 | 检查 |
|---|---|
| 运行时 | `docker info` 或 `nerdctl --namespace eunoia info` |
| gVisor（生产） | `docker info --format '{{json .Runtimes}}'` 含 `runsc`，或 containerd 注册 `io.containerd.runsc.v1` |
| 镜像 | `SANDBOX_IMAGE_DIGEST` 是 `sha256:<64 hex>`；镜像已在本机/本 namespace |
| workspace | `WORKSPACE_ROOT` 存在、是目录、属主可读写 |
| 端口/磁盘 | 容器运行时可用；`SANDBOX_WORKSPACE_ROOT` 有空间 |

镜像：参考 [IMAGES.md](IMAGES.md)；`scripts/sandbox-image/build.sh` 会构建并打印
不可变 digest。

安装 Linux 运行时：

```bash
sudo ./scripts/sandbox-install.sh
```

脚本会安装 containerd + runsc + nerdctl、注册 `io.containerd.runsc.v1`、创建
`eunoia-egress` 网络和 `eunoia-sandbox` AppArmor profile。它不会 pull 镜像，也
不会替你配置防火墙；两者都在脚本末尾打印为待办。

## 2. 配置

完整变量见 `.env.example` 的 `sandbox` 段。最小生产配置：

```bash
WORKSPACE_ROOT=/srv/eunoia/workspaces/project
SANDBOX_IMAGE_DIGEST=sha256:...
SANDBOX_RUNTIME_CLIENT=nerdctl
SANDBOX_RUNTIME_CLASS=gvisor
SANDBOX_APPARMOR_PROFILE=eunoia-sandbox
```

macOS 开发（没有 runsc，必须显式承认）：

```bash
WORKSPACE_ROOT=/Users/you/Projects/your-repo
SANDBOX_IMAGE_DIGEST=$(docker image inspect --format '{{.Id}}' alpine/curl:latest)
SANDBOX_RUNTIME_CLASS=runc
SANDBOX_ALLOW_NON_GVISOR=1
```

启动时会打印 `sandbox.platform` 摘要（不含密钥），`/health` 里也有同一份信息。
`runtime_class=runc` 时 `gvisor_required=false`，这是可见的，不是隐藏的降级。

## 3. 日常命令

```bash
npm run sandbox -- status          # 配置、probe、sandboxes
npm run sandbox -- recover         # 扫描 runtime，重连/重建，核验未完成执行与权限状态
npm run sandbox -- permissions --task <taskId>       # 模式、策略版本、请求、审批、grant
npm run sandbox -- mode --task <taskId> --mode read-only --minutes 30 --by alice
npm run sandbox -- requests --task <taskId>          # 待处理 / 历史权限请求
npm run sandbox -- approvals --task <taskId>         # 等待人工决策的队列
npm run sandbox -- approve-request --approval <id> --by alice --scope once
npm run sandbox -- deny-request --approval <id> --by alice --reason "out of scope"
npm run sandbox -- grants --task <taskId>
npm run sandbox -- revoke --task <taskId> --approval <id>
npm run sandbox -- sweep           # 过期 request/approval/grant 清扫
npm run sandbox -- approve --task <taskId> --action fs.write --scope /workspace --minutes 10
npm run sandbox -- checkpoint --task <taskId>
npm run sandbox -- gc --idle-minutes 60 --checkpoint-days 7
npm run sandbox -- proxy --listen 0.0.0.0:8788
npm run sandbox:check              # 真实 runtime 安全自检（不通过则非零退出）
npm run sandbox:smoke              # 真实 SQLite + Docker 的端到端冒烟
```

`approve` / `approve-request` 写一条带 scope、过期时间、policy version 和批准人的
grant；它不能覆盖 `DENY`。`mode` 切换会 bump policy version、把旧 grant 标记过期，
并让受影响的 sandbox 在下次执行时重建（read-only 的只读 mount 由此生效）。
`gc` 只销毁 runtime 和过期 checkpoint，不删除 bind 模式的项目目录。

审批只能由人执行：`--by` 不能是 `agent:*`，也不能是请求者本人。重复 approve 是
幂等的，不会创建第二个 grant。

## 4. 健康与指标

`/health` 的 `sandbox.metrics` 提供：

| 指标 | 用途 |
|---|---|
| `sandbox_creation_success_rate` | 创建失败（镜像缺失、runtime 冲突） |
| `sandbox_start_latency_ms` | 启动耗时 |
| `execution_success_rate` | 执行成功率 |
| `execution_unknown` | 需要人工核验的数量 |
| `duplicate_execution_rate` | 幂等命中/重复提交 |
| `unauthorized_access_block_rate` | 策略拒绝 |
| `resource_limit_triggered` | Timeout / OOM 类限制 |
| `sandbox_recovery_success_rate` | 重建/重连成功率 |

日志是 JSON 行，事件名以 `sandbox.` 开头；审计表 `sandbox_audit_events` 是
append-only。敏感字段在写入前被 `Redactor` 替换。

## 5. 故障处理

| 现象 | 处理 |
|---|---|
| 启动报 `SANDBOX_IMAGE_DIGEST must be…` | 用 `docker image inspect --format '{{.Id}}'` 取 digest，不要用 tag |
| 启动报 gVisor 不可用 | 安装 runsc 并注册 handler；或在开发机显式 `runc` + `SANDBOX_ALLOW_NON_GVISOR=1` |
| `sandbox container did not start` | `docker logs <name>`；检查 image 是否有 shell/sleep、`--init` 是否被 ulimit 破坏 |
| 执行返回 `UNKNOWN` | 不要重跑。先 `sandbox -- status`，再 `sandbox -- recover`；marker 缺失时结果无法确认 |
| timeout 后下一次执行失败 | 下一次执行会自动 `recover`；重建使用同一个 workspace |
| Controller 崩溃 | 重启后自动 `recoverAll`；数据库里的 sandbox 身份不会丢 |
| workspace 不可读 | 恢复会把 task 标 `PAUSED`，不会重建覆盖 |
| 代理不可用 | `proxy_only` 下网络操作失败关闭，不会直连 |
| 沙箱创建后被并发上限挡住 | `SANDBOX_MAX_CONCURRENT_*`；先 `gc` 或用 `status` 看占用 |

**安全能力不可用时不要退回宿主机执行。** 代码里没有这条回退路径，
`WORKSPACE_COMMANDS` 打开的只是沙箱内的命令。

## 6. 备份与恢复

- `data/eunoia.sqlite`（含 sandbox 元数据）用现有 `npm run backup`；
- bind 模式的 workspace 就是用户项目，按项目自己的备份策略；
- copy 模式的 workspace 在 `SANDBOX_WORKSPACE_ROOT/tasks/`，checkpoint 在
  `SANDBOX_WORKSPACE_ROOT/checkpoints/`；
- 恢复顺序：先恢复数据库和 workspace，再启动服务（`platform.start()` 会
  inspect runtime 并重建缺失的容器）。

## 7. 清理

```bash
npm run sandbox -- gc --idle-minutes 60 --checkpoint-days 7
```

- 只处理 `READY` / `INTERRUPTED` / `FAILED` 且 heartbeat 超时的 sandbox；
- `SANDBOX_DISK_MB` 是配置项，但 Docker 的 overlay2 不提供 per-container
  disk quota；需要硬配额时用独立 volume + 文件系统 quota，或在 copy 模式定期
  检查 `du`。CPU / memory / pids 由 cgroups 强制执行。
- 状态先置 `EXPIRED`，再 `TERMINATING -> DESTROYED`；
- checkpoint 目录按 mtime 清理，数据库记录保留用于审计（如果删除了对应的
  workspace 才会 cascade）。

## 8. 生产网络（proxy_only）

1. 运行 `npm run sandbox -- proxy --listen 0.0.0.0:8788`（或交给 systemd）；
2. 在宿主上把 `eunoia-egress` 子网的出站限制到代理地址，示例在
   `scripts/sandbox-install.sh` 末尾；
3. 配置 `SANDBOX_PROXY_URL` 为容器可达的地址（Docker Desktop 用
   `host.docker.internal`，Linux 用桥接网关地址）；
4. 用 `SANDBOX_ALLOWED_DOMAINS` / `SANDBOX_ALLOWED_PORTS` 收窄 allowlist；
5. `npm run sandbox:check` 会报告网络检查项。

代理只处理 HTTP/HTTPS：CONNECT 隧道内只校验目的域名/端口/解析地址，无法检查
TLS 内的具体请求。这是正向代理的固有限制，已在安全文档中列出。

## 9. 上线检查清单

- [ ] `SANDBOX_IMAGE_DIGEST` 是固定 digest，镜像来源可追溯
- [ ] `SANDBOX_RUNTIME_CLASS=gvisor`，probe 返回 `gvisor=present`
- [ ] `SANDBOX_APPARMOR_PROFILE` / seccomp 已加载（Linux）
- [ ] workspace 不是用户 home，也不是 `/`
- [ ] `network=none`，或 proxy_only + 宿主防火墙 + allowlist
- [ ] `npm run sandbox:check` 全 PASS
- [ ] `npm run sandbox:it` 在目标 runtime 上跑过
- [ ] 备份覆盖 SQLite 和 workspace
- [ ] 有 `gc` 定时任务（cron/systemd timer）
- [ ] `/health` 中 `gvisor_required` 与 `runtime_class` 符合预期
