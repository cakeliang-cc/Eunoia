# ADR 006 — 面向未来小程序的前后端分离

## 背景

产品将先通过 **web** 客户端演示。用户打算**稍后切换到微信小程序（WeChat
mini-program）**，并要求分离从一开始就内建，而不是事后改造。

这不是假设。适合浏览器的传输与鉴权选择，并不是小程序所能提供的那些，而其中
任何一个渗入 Agent 核心，都会把迁移变成重写。

### 小程序实际支持什么（调研所得，而非假设）

"小程序不支持 SSE"这一常见说法是误导性的。没有原生 `EventSource`，也没有
`fetch` 的 `ReadableStream`，但**分块流式传输是可行的**：
`wx.request({ enableChunked: true })` 加上 `requestTask.onChunkReceived`，
解码 `ArrayBuffer` 分块并手工解析 SSE 帧格式。现成的客户端已经存在
（`cross-sse`、`uni-sse`、`native-sse`）。

约束服务端的需求与陷阱：

- 基础库 **≥ 2.20.0** 才支持 `enableChunked`；**≥ 2.21.0** 才有原生
  `TextDecoder`（低于此版本需要 polyfill）。
- 分块边界是任意的，且**在模拟器与真机之间不同**，因此多字节 UTF-8 字符可能被
  分块切开——解析器必须缓冲不完整的字节，并处理 `\r\n`、`\n` 和 `\r`。
- **服务端不能缓冲响应。** 在代理之后这意味着 `proxy_buffering off`、
  `X-Accel-Buffering: no`、HTTP/1.1、不压缩，以及较长的读超时——否则流会一次性
  到达，打字机效果会无声消失。
- iOS 上的企业微信有报告称 `onChunkReceived` 从不触发，且没有任何错误。因此
  客户端的降级处理是真实需求，而不是防御性的添头。

**结论：SSE 的线上格式可以移植到小程序。** 只有客户端传输方式不同。不需要
WebSocket。

## 决定

沿用 spec §17 的结构，强制一条单向依赖边界：

```
src/agent/  src/memory/  src/tools/  src/safety/  src/evaluation/   ← CORE
        │  transport-agnostic. No HTTP, no framework, no cookies.
        ▼
src/api/    ← TRANSPORT BOUNDARY. Owns HTTP, SSE framing, auth headers.
        │
        ▼
web/        ← WEB CLIENT (and later: miniprogram/)
```

1. **核心发出的是 `AsyncIterable<AgentEvent>`，而不是响应。** 核心从不知道这些
   字节会变成一个 SSE 帧、一条 WebSocket 消息，还是一个测试断言。
2. **`src/api/` 是唯一知道 HTTP 的地方。** 它把事件流适配为 SSE 帧格式。
3. **鉴权是显式的 bearer token**，绝不是仅靠 cookie 的会话，这样小程序的流程
   （`wx.login` → code → 服务端会话）可以复用同一套服务端契约。
4. **边界由测试强制，而不是靠自觉**：一个测试断言 `src/agent/`、`src/memory/`、
   `src/tools/`、`src/safety/`、`src/evaluation/` 之下没有任何东西从 `src/api/`、
   `express`/`fastify`/`hono` 或任何客户端目录导入。与模型 ID 的守卫
   （ADR 005）是同样的机制。
5. **API 契约被记录为带版本号的产物**，这样小程序客户端可以据此构建，而无需
   阅读服务端源码。

## 备选方案

1. **Next.js（或其他全栈框架）加 server actions。** 已否决。它把 Agent 逻辑
   耦合到 web 框架的请求生命周期和 RSC 传输上；小程序将需要一整套独立的后端，
   而这正是本 ADR 意在避免的结果。
2. **从一开始就用 WebSocket。** 因过早而否决。分块 SSE 已被验证在小程序上可行，
   而 WebSocket 会在 Phase 1 引入连接生命周期、重连与握手鉴权的复杂性，目前
   没有任何收益。适配层这道缝隙意味着日后增加 WS 传输是增量式的，而不是重写。
3. **立即上 npm workspaces 的 monorepo。** 推迟。真正重要的分离是*依赖方向*，
   它由测试强制；workspace 工具会引入 spec §0 所警告的构建复杂性。可以在第二个
   客户端真正存在时再引入。

## 理由

用户的诉求靠一条边界就能满足，而不是靠一个框架。让核心发出事件而不是响应，
今天不花任何代价，却让小程序变成一个新适配器加一个新客户端——也就是他们所要的
那次迁移。

## 后果

- `AgentEvent` 成为一等核心类型并带有测试，因为它是每一个未来客户端都依赖的
  契约。
- 服务端必须通过 HTTP/1.1 提供且不缓冲响应，流式才能工作；这是一项**部署**
  要求，记录在此是因为它不会在本地开发中暴露，并且最可能是"流式在我机器上
  没问题"的原因。
- Phase 1 交付 SSE 适配器和一个最小的 web 客户端。小程序适配器在更晚的阶段
  之前不在范围内。
- 未来某个无法流式的客户端（按调研，iOS 的企业微信）必须降级为非流式响应；
  核心已经支持这一点，因为非流式的回复不过是一个带单个终止事件的事件流。
