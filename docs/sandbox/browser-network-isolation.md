# 浏览器与开发任务的受控网络

项目容器和托管浏览器都保持 `network:none`。需要联网时，容器里的 `127.0.0.1:3128` 通过 `docker exec -i` 控制管道连接该容器专属的宿主策略代理。容器没有公网路由，没有发布端口，不挂载 Docker socket、用户目录或模型凭据。

```text
开发任务（network:none）──控制管道──任务代理──允许的依赖源
浏览器（network:none）───控制管道──浏览器代理──部署白名单 ∩ 成员网络权限
                                         └──本成员的活跃预览租约
宿主预览网关───────────另一条控制管道──项目容器的指定回环端口
```

代理环境变量供 npm/curl 等客户端选择通道；真正的边界是容器没有直接网络。清除环境变量、直连 IP、自己发 DNS/UDP/IPv6，都不会获得公网路由。管道关闭后断网；恢复时重新建立当前策略的管道。

## 配置开发任务

```dotenv
SANDBOX_NETWORK_PROFILE=dev_preview
```

这个配置展开为 `proxy_only`、HTTPS 443，以及 `registry.npmjs.org,pypi.org,files.pythonhosted.org`。可用 `SANDBOX_ALLOWED_DOMAINS`、`SANDBOX_ALLOWED_PORTS` 明确覆盖。`offline` 完全关闭出口；`custom` 配合原有 `SANDBOX_NETWORK_MODE` 和白名单使用。显式 mode 与 profile 冲突会拒绝启动。

删除旧的 `SANDBOX_EGRESS_NETWORK`、`SANDBOX_PROXY_URL`，新实现会拒绝这些桥接网络覆盖。项目的预览入口不依赖公网出口：关闭依赖下载权限后，本地预览仍可以通过有效租约访问。

## 安装托管浏览器

先按 [沙箱运行文档](./OPERATIONS.md) 准备包含 Node/npm 的 Alpine 沙箱镜像，再构建：

```bash
docker build --build-arg BASE_IMAGE=eunoia-sandbox:general \
  -t eunoia-browser:isolated -f scripts/browser-image/Dockerfile .
docker image inspect --format '{{.Id}}' eunoia-browser:isolated
```

将实际输出的 `sha256:…` 写入私有部署配置：

```dotenv
EUNOIA_BROWSER_IMAGE_DIGEST=sha256:<实际镜像ID>
# 留空时只允许当前身份拥有的本地预览，不开放公网浏览。
EUNOIA_BROWSER_ALLOWED_DOMAINS=
EUNOIA_BROWSER_ALLOWED_PORTS=80,443
```

镜像固定安装 `@playwright/mcp@0.0.80` 和 Chromium，运行时 `--pull never`。浏览器继承沙箱运行级别：默认要求 gVisor；本机明确选择 `SANDBOX_RUNTIME_CLASS=runc` 时，还必须设置 `SANDBOX_ALLOW_NON_GVISOR=1`。runc 不会被描述成 gVisor。

在“外部服务”选择“隔离浏览器”，或者使用 `npm run toolkit:setup` 输出的配置：

```json
{
  "name": "Playwright",
  "transport": "stdio",
  "enabled": true,
  "stdio": { "command": "eunoia-browser", "args": [], "runLocation": "browser" }
}
```

镜像、启动参数、挂载和代理由部署控制；这个服务不接受自定义 command、args、cwd、image 或 envRefs。镜像缺失、Docker 不可用或配置错误会明确失败，不能自动改用宿主 Chrome。

已有宿主 Playwright 配置可离线迁移，保留服务 ID、绑定、启用状态和工具策略，增加配置版本并使旧目录失效：

```bash
npm run backup
# 停止应用后执行；默认只查看拟迁移项目。
node --env-file=.env --experimental-sqlite --experimental-strip-types scripts/migrate-browser-isolation.ts
node --env-file=.env --experimental-sqlite --experimental-strip-types scripts/migrate-browser-isolation.ts --apply
npm run build
npm start
```

## 隔离和生命周期

- 目录发现使用不联网的探测实例；实际工具连接按用户、服务、会话、成员和权限摘要区分。并发创建复用同一待连接 Promise；配置或权限变更会替换旧实例。
- 每个实例使用独立容器和 tmpfs，没有宿主输出目录挂载；Cookie、localStorage、标签页和文件不跨实例共享。单实例限制 1 GiB 内存、2 CPU、256 进程，根文件系统只读、非 root、capabilities 全部移除。
- 活跃会话实例最多全局 8 个、单用户 4 个，15 分钟空闲后回收；成员激活结束、会话删除、服务禁用/更新、应用关闭时主动释放。
- MCP 是容器主工作负载，由 init 回收子进程；连接 stdin 关闭后退出并自动删除容器。真实 SIGKILL 故障用例验证控制进程死亡后的回收。
- 固定版本 Playwright 使用 MCP 2025 握手。通用 MCP 继续自动协商；托管浏览器不使用会额外启动同 argv 子进程的 SDK 自动探测，防止探测进程消耗一次性的容器连接。

## 预览、HTTP 和 WebSocket

浏览器代理只接受当前用户、会话、成员持有且未过期的 ready 租约，并严格匹配其完整 origin。预览网关继续校验进程存活、HTTP/WS Origin、Cookie/Auth 边界；不能用路径或自定义 Header 选择另一条路由。

Chromium 对 `ws://` 也可能发送 CONNECT，因此预览 CONNECT 不能直接暴露网关 TCP socket：管道内部再次解析 HTTP，固定目标 origin，拒绝不同 Host、绝对 URL 换目标和嵌套 CONNECT；每次 HTTP/升级重新检查租约。公网 HTTPS CONNECT 则走域名、端口、全部 DNS 答案的公网地址检查，并连接已经检查的地址，阻止 DNS 重绑定与元数据访问。

这是 HTTP/CONNECT 代理，不解密公网 TLS。它约束域名、端口、连接和传输量，不承诺对加密后的 URL 路径或业务内容作过滤。托管出口每容器限 600 请求/分钟，管道最多 64 连接，帧、缓冲和单请求字节数都有上限。

## 图片与页面结果

截图文件只在对应容器内读取，仍需通过输出目录、真实路径、普通文件、大小、签名和媒体解码校验，再进入当前会话的媒体库。宿主不会根据容器返回的路径读本机文件。模型看到的是媒体 image block，沿用现有模型能力检查与图片 token 预算，不以文件存在作为“模型已看到图片”的证据。

新版 Playwright 可能只返回页面快照链接；模型应调用 `browser_snapshot` 获取结构。工具说明已加入这个提示。截图则调用 `browser_take_screenshot`，由媒体适配器导入。

实际验收命令和结果见 [浏览器与开发网络隔离验收](../features/eunoia-浏览器与开发网络隔离验收.md)。Tavily 真实搜索仍须另外配置 `TAVILY_API_KEY`，容器网络的修复不会生成搜索凭据。
