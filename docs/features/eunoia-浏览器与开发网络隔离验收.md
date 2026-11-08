# 浏览器与开发网络隔离验收

本次接手并完成 R04/R05 的生产运行时缺口：浏览器容器化、会话/成员隔离、开发任务独立出口，以及真实预览和截图链路。Tavily 真实搜索仍缺 `TAVILY_API_KEY`；统一验收中的其他 PARTIAL 项也保留原编号，不把本次修复写成整个项目全部通过。

实现提交：`b08bd45519f80d1184cd08eb6611a5f65db0276e`，分支 `fix/browser-network-isolation`，基线 `7c5e0bd`。当前服务运行该分支的 `.worktrees/browser-network-isolation` 构建，入口仍为 `http://127.0.0.1:8788`。后续证据提交只修改文档和验收记录。

## 本次结果

| 项目 | 结果 | 本次证据 |
| --- | --- | --- |
| 类型检查、构建 | PASS | [typecheck](./evidence/integration-acceptance/network/typecheck.txt)、[build](./evidence/integration-acceptance/network/build.txt) |
| Lint | PASS，0 error；保留旧脚本的 9 个 any warning | [lint](./evidence/integration-acceptance/network/lint.txt) |
| 全量回归 | 1,909 PASS，46 SKIP；SKIP 不计通过 | [regression](./evidence/integration-acceptance/network/regression.txt) |
| 真实 Docker / Chromium / npm | 15/15 PASS | [docker-live](./evidence/integration-acceptance/network/docker-live.txt) |
| 真实模型视觉闭环 V08 | 1/1 PASS | [vision-loop](./evidence/integration-acceptance/network/vision-loop.txt) |
| 正式应用的实际浏览器调用 | 导航、截图均 succeeded，截图事件包含 1 个 image block；临时会话删除后实例释放 | [deployed-browser-call](./evidence/integration-acceptance/network/deployed-browser-call.json) |
| 配置迁移 | 正式 Playwright 从 host 迁为 browser，版本 +1；副本上重复迁移无变更 | [migration-applied](./evidence/integration-acceptance/network/migration-applied.json)、[migration-idempotent](./evidence/integration-acceptance/network/migration-idempotent.json) |
| 部署 | 新 PID、构建哈希、原数据库/媒体、真实 OCI 配置均核对 | [deployment](./evidence/integration-acceptance/network/deployment.json) |
| R08 / D32 / V04 Tavily | BLOCKED，未执行真实搜索 | [doctor](./evidence/integration-acceptance/network/doctor.json) |

## 为什么原先完成不了

原来的依赖出口用测试专用代理和手工 internal network 验证，生产 runtime 没有建立、恢复、销毁这些资源。浏览器仍走宿主 stdio；`--isolated` 只隔离浏览器上下文，操作系统网络仍然是宿主网络。MCP 连接又按用户/服务复用，成员自己的工具上下文没有对应到自己的浏览器实例。

这不是把 sandbox 权限整体放开就能解决的问题。现在开发任务和浏览器都保持 `network:none`，通过控制管道获得各自的策略代理：正常业务可以访问允许的目标，绕过代理则没有直接路由。

## 已验证的边界

- 正常路径：真实 npm 查询依赖；真实项目容器启动 dev server，经预览租约和网关进入另一只浏览器容器，取得 DOM 和 PNG 像素并进入媒体适配器。
- 公网出口：显式允许的 HTTPS 目标可达；未允许目标、IP 字面量、元数据、宿主地址、IPv6 回环和重定向到元数据被阻断。已有 DNS 多答案、私网和重绑定单测一并回归。
- 绕过代理：容器内直连公网 TCP、自己发 DNS/UDP、IPv6 直连均失败。没有 Docker bridge、发布端口或宿主目录挂载可绕过控制管道。
- 成员隔离：两名成员有不同页面/标签页和独立容器；即使都访问 `https://example.com`，Cookie 和 localStorage 也不共享，不能打开另一成员的预览。
- WebSocket：自己的预览连接能收到真实帧，另一成员的连接被拒绝。针对 Chromium 的 CONNECT 行为，内层 HTTP 会再次检查 origin，错误 Host、换目标 URL、嵌套 CONNECT 的用例均拒绝且上游计数为 0。
- 生命周期：代理断链后不能联网，新 runtime 能恢复当前白名单通道；权限收紧后的下一次调用替换旧浏览器；控制进程 SIGKILL 后实际浏览器容器退出并删除；成员结束、删除会话、禁用服务和应用关闭会主动释放。
- 图片：PNG 签名与真实解码通过后才建立媒体块。V08 使用真实模型读取设计与截图，修改 CSS，再从媒体里的第二张截图断言中心像素；端口随机分配，预览进程和会话均清理。

## 实际部署

数据库继续使用 `/Users/Zhuanz/Projects/designFree/data/eunoia.sqlite`，媒体继续使用同目录下的 `media`，schema 为 15。升级前完成 SQLite 在线快照与媒体校验，1 个既有媒体资产验证通过；私有备份位于运行工作区的 `backups/eunoia-2026-11-08T15-41-29-443Z`，没有提交到 Git。

服务监听 PID 为 `24874`，构建报告 `b08bd455…`、`dirty:false`。正式 Playwright 服务已经是 `runLocation:browser`、配置版本 2、ready、28 个工具；实际浏览器容器检查为非 root、只读根文件系统、capabilities 全部移除、`network:none`、无宿主挂载和发布端口。删除部署验收会话后只保留用于目录发现的基线实例。

开发任务已启用 `dev_preview`，默认只允许通过 HTTPS 下载 npm/PyPI 依赖；浏览器公网白名单默认空，仅允许自身有效预览。模型请求、网页搜索运行在宿主的服务适配层，和这些容器出口是不同的通道；缺 Tavily 密钥与 `network:none` 无关。

## 复验

```bash
npm run typecheck
npm run lint
npm run build
npm test

BROWSER_INTEGRATION=1 SANDBOX_INTEGRATION=1 \
EUNOIA_BROWSER_IMAGE_DIGEST=<已安装的浏览器镜像sha256> \
SANDBOX_TEST_IMAGE_DIGEST=<已安装的沙箱镜像sha256> \
npm test -- tests/browser/isolation.docker.test.ts \
  tests/sandbox/egress.docker.test.ts tests/sandbox/preview-tunnel.docker.test.ts

# 需要现有真实模型凭据；加载私有部署配置后执行。
RUN_SMOKE=1 V08_SMOKE=1 EUNOIA_BROWSER_IMAGE_DIGEST=<镜像sha256> \
  npx vitest run tests/smoke/live-v08.test.ts

# 对运行中的服务做实际调用；仅批准脚本新建会话的浏览器操作，随后删除会话。
python3 docs/features/evidence/integration-acceptance/network/deploy-smoke.py
npm run acceptance:check
```

配置、原理和限制见 [运维说明](../sandbox/browser-network-isolation.md)。本机明确使用 runc，不声称具备 gVisor 的内核隔离强度；公网 CONNECT 不解密 TLS，策略约束域名、端口与连接，不能检查加密请求的路径和内容。R14 的本次部署与隔离链路已经复验，项目整体无条件 PASS 仍受 Tavily 凭据和统一清单中其余 PARTIAL 项约束。
