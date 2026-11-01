# Sandbox 测试报告

日期：2026-11-01
环境：macOS 14 (Darwin 24.6.0, arm64)，Node v24.7.0，Docker Desktop 28.x
运行时：Docker **runc**（该主机没有 gVisor/runsc）

## 1. 默认测试套件

```bash
npm test
```

结果（本次实现完成后）：

```text
Test Files  65 passed | 3 skipped (68)
Tests       901 passed | 20 skipped (921)
```

其中 sandbox 控制面单独运行：9 个文件、163 个测试通过；
`tests/architecture/sandbox-boundaries.test.ts` 7 个测试通过。
`tests/sandbox/integration.docker.test.ts` 默认跳过（需要真实 runtime）。

覆盖：

| 范围 | 文件 |
|---|---|
| 策略/审批/网络策略/编译 | `tests/sandbox/policy.test.ts` |
| 路径逃逸、symlink、credential、原子写 | `tests/sandbox/paths.test.ts` |
| 容器 argv 基线、exec wrapper、mount | `tests/sandbox/runtime-args.test.ts` |
| Gateway 幂等、状态、文件、审批、UNKNOWN、恢复 | `tests/sandbox/gateway.test.ts` |
| egress IP/DNS rebinding/allowlist | `tests/sandbox/egress.test.ts` |
| 配置 fail-closed | `tests/sandbox/config.test.ts` |
| SQLite schema v3（含 v2→v3 迁移）、CAS、event log | `tests/sandbox/sqlite.test.ts` |
| 架构边界 | `tests/architecture/sandbox-boundaries.test.ts` |

既有测试（`tests/tools/*`、`tests/service/*`、`tests/agent/*`、`tests/api/*`、
`tests/db/*` 等）全部通过；只改了两个测试文件以匹配迁移后的端口
（`tests/tools/workspace.test.ts` 的 `runCommand` 删除，`tests/tools/coding-tools.test.ts`
的命令工具改用 fake executor）。

## 2. 真实 Runtime 集成 / 安全测试

```bash
SANDBOX_INTEGRATION=1 \
SANDBOX_TEST_IMAGE_DIGEST=$(docker image inspect --format '{{.Id}}' alpine/curl:latest) \
npx vitest run tests/sandbox/integration.docker.test.ts
```

结果：**15/15 通过**（约 18 秒）。

| 测试 | 结果 |
|---|---|
| 非 root（uid/gid 1000） | PASS |
| 只读根文件系统（`/proc/mounts`） | PASS |
| 无法读 `/etc/shadow` | PASS |
| 无 docker/containerd socket | PASS |
| `--network none` 无默认路由 | PASS |
| 只能写 `/workspace`，宿主可见 | PASS |
| timeout → TIMEOUT → 恢复 → 继续执行 | PASS |
| 非零退出码 + stdout/stderr | PASS |
| 不泄漏宿主环境变量 | PASS |
| bind 模式下 `.env` / `*.pem` 对命令不可见（mask mount） | PASS |
| seccomp filter 生效（`Seccomp: 2`） | PASS |
| HostConfig：只读 rootfs、cap-drop ALL、no-new-privileges、cgroups、network none | PASS |
| fork bomb 受 PID limit 约束 | PASS |
| 内存耗尽受 memory limit 约束 | PASS |
| copy 模式跨 task 隔离 | PASS |

## 3. 安全自检（本机 Docker runc）

```bash
WORKSPACE_ROOT=/tmp/eunoia-demo \
SANDBOX_IMAGE_DIGEST=$(docker image inspect --format '{{.Id}}' alpine/curl:latest) \
SANDBOX_RUNTIME_CLASS=runc SANDBOX_ALLOW_NON_GVISOR=1 \
npm run sandbox:check
```

本机结果（全部 PASS）：

```text
PASS  non-root user  1000/1000
PASS  read-only root filesystem  read-only
PASS  cannot read /etc/shadow  status=FAILED exit=1
PASS  no docker/containerd socket  ., .., lock
PASS  cannot write outside /workspace  status=FAILED
PASS  writes only inside /workspace  status=SUCCEEDED
PASS  network is isolated (no default route)  network none
PASS  timeout is enforced  status=TIMEOUT
PASS  sandbox recovers after termination  READY
PASS  execution works after recovery  alive
```

另外在本机验证了：

- `npm run build` 通过；
- `npm run dev` 启动，`/health` 返回 `sandbox: null`（未配置时）；
- 配置 `WORKSPACE_ROOT` + digest + `runc` 后，`/health.sandbox` 显示
  `runtime_ok=true`、`gvisor_required=false`、`non_gvisor_acknowledged=true`；
- `npm run sandbox -- status` / `recover` 正常输出；
- 两个 task 在 bind 模式下共享同一 workspace，但 sandbox identity 不同。

## 4. 安全自检脚本

```bash
npm run sandbox:check
```

在配置了真实 runtime 的主机上运行；不满足条件时以非零退出：

- runtime probe 失败 → 1；
- 要求 gVisor 但 probe 没有 `gvisor=present` → 1；
- 任一项检查失败 → 1；
- sandbox 未配置 → 2。

## 5. 未验证项（必须如实记录）

以下需要在目标 Linux 主机上运行，本机无法证明：

| 项 | 原因 | 验证方式 |
|---|---|---|
| gVisor `runsc` 正常 | 本机无 runsc | `SANDBOX_RUNTIME_CLASS=gvisor npm run sandbox:it` |
| containerd/nerdctl 路径 | 本机无 containerd | 同上（`SANDBOX_RUNTIME_CLIENT=nerdctl`） |
| AppArmor profile | macOS 无 AppArmor | `SANDBOX_APPARMOR_PROFILE=eunoia-sandbox npm run sandbox:check` |
| seccomp profile | 同上 | `SANDBOX_SECCOMP_PROFILE=...` |
| 宿主防火墙 egress 规则 | 需要 root 网络配置 | `docs/sandbox/OPERATIONS.md` §8 + `npm run sandbox:check` |
| Controller 进程崩溃后重扫 | 本机只用 fake runtime 验证了持久化逻辑 | Linux 上 kill -9 后 `npm run sandbox -- recover` |
| OOM / Fork bomb 资源限制 | 未构造；cgroups 参数已设置 | `SANDBOX_MEMORY_MB` 下构造后 `sandbox:check` 扩展 |

**本机通过的 runc 测试不等于 gVisor 验证。** `/health` 中的
`gvisor_required=false` 和 `non_gvisor_acknowledged=true` 就是这件事的可见记录。

## 6. 性能

| 指标 | 观测 |
|---|---|
| 容器创建（alpine/curl, runc） | ~200–400 ms |
| 单次 exec（`id -u`） | ~150–300 ms |
| copy 模式首次 workspace 复制 | 取决于项目大小；跳过 node_modules/.git |
| timeout 后重建 | ~1 s（含 kill + create） |

这些是本机数字，不是容量承诺；`/health.sandbox.metrics` 会在部署后给出真实值。

## 7. 结论

- 控制面（策略、幂等、状态机、审计、恢复、文件 guard）有单元/集成测试；
- 执行面在真实 Docker runc 上通过了非 root、只读 rootfs、无 socket、无网络、
  workspace 边界、timeout、跨 task 隔离；
- gVisor、containerd、AppArmor、seccomp、宿主 egress 防火墙仍待 Linux 目标机验证，
  文档和脚本已给出步骤，没有用 mock 代替。
