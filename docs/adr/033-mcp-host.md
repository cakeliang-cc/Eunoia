# ADR 033：MCP 主机接入

日期：2026 年 11 月 8 日。状态：已实现（有一处明确的验收缺口，见“后果”）。

## 1 背景

Eunoia 原来的工具只有一种来源：项目代码里的 `ToolDefinition`，参数用 Zod 声明，
注册表从 Zod 导出模型可见的 JSON Schema，循环直接 `safeParse`。这带来三个隐含假设：

1. 所有工具都在本进程内，权限可以由进程级开关回答；
2. 工具结果是字符串，循环不需要理解有序内容块；
3. 工具目录随进程启动固定，不需要“租约”“代次”或“目录失效”。

MCP 逐一打破这三个假设。外部工具由别的进程或远端服务执行，参数是服务器发布的
JSON Schema，结果是 ordered content，目录可能在回合进行中变化，认证有自己的账户与
scope。如果只是把 MCP 工具塞进现有注册表，就会得到一条绕过权限、预算和恢复的
“第二执行路径”——那正是本项目一直避免的结构。

本 ADR 记录把 MCP 接入生产链路所做的重构，以及不做什么。

## 2 决定一：统一工具契约

`src/tools/contract.ts` 引入 `ToolContract`：模型看到的 schema 与运行前的
validator 成对保存，并带来源（builtin / mcp）、契约摘要和可信分类。

- 内置工具通过 `zodContract()` 生成，模型声明仍来自同一份 Zod；
- MCP 工具通过 `mcpContract()` 生成，保留服务器原始 JSON Schema；
- `normalizeJsonSchema()` 只做无损归一化（如 2020-12 的 `prefixItems` → draft-07
  的 tuple 形式），并拒绝无法强制执行的关键字（`unevaluatedProperties` 等）和
  远程 `$ref`。不支持就诊断，不用 `z.any()` 或删约束冒充等价适配；
- 契约摘要是 `sha256(规范化 JSON)`，审批、目录租约和调用都绑定它。

`ToolDefinition.parameters` 保留为兼容字段；循环与注册表一律优先 `contract`，所以
MCP 工具不会被 passthrough 的 Zod 占位符放行。

## 3 决定二：统一结果契约与媒体

`ToolResult` 扩展为 `output`（稳定文本投影）+ 有序 `content` 块 +
`structuredContent`。MCP 的 text / image / resource_link / embedded resource /
audio 映射为 `ToolContentBlock`，顺序不变：

- 图片从实际返回字节导入私有媒体库（`MediaService.putToolImage`），立即绑定为
  `bound`，并记录 owner / conversation / action；
- 非图片二进制进入 `mcp_artifacts`（复用 blob 存储，不当图片，也不当代码执行）；
- 音频/视频/不支持格式写出可见说明，绝不宣称模型“看/听过”；
- `structuredContent` 按 `outputSchema` 在主机侧校验。校验失败是一次**已发生的失败**，
  不是未知传输错误，因此主机不把 definition 交给 SDK 做二次校验（否则 SDK 抛错，
  管理器只能记为 unknown）。

## 4 决定三：统一执行管线

模型 tool call → 循环授权 → 执行 → 结果 → 预算/轨迹，只有一条：

```
loop.planFor → contract.validate → permission.decide
             → （wait：InteractionBroker）→ execute
             → toolResult(content) → transcript → next step
```

- 内置工具仍由 `policyDenial` 按进程策略决定；
- MCP 工具**必须**有 `ToolPermissionPort`，没有就拒绝，不存在“没有授权端口所以放行”；
- 并发只发生在连续的内置只读调用之间；外部调用始终单独执行，便于归因和取消；
- 超时/取消/断开都经同一路径进入 `unknown`，不把“停止等待”当成“副作用没发生”。

## 5 决定四：传输与连接代次

- stdio 两种运行位置：
  - `host`：SDK 直接 spawn，只能由部署开关 `MCP_ALLOW_HOST_PROCESS=1` 打开，UI
    明确显示“宿主进程”，绝不标成沙箱；
  - `sandbox`：每个连接一个 `docker run -i` 容器，镜像必须 digest 固定，无网络、
    只读根、drop capabilities、内存/CPU/PID 限制；环境变量按名传递（`-e NAME`），
    不写进 argv。
- HTTP：官方 SDK 的 Streamable HTTP；应用提供受控 fetch，手动处理重定向，跨域
  丢弃 Authorization/Cookie，私网与明文 HTTP 需要部署显式允许。
- 每次连接递增 generation；旧代次的迟到目录不得发布。重连只重跑发现，不重放
  `tools/call`。

## 6 决定五：原子目录与租约

`buildCatalog()` 先完整构建再发布：分页上限、重复游标拒绝、重复工具名拒绝、
schema/目录字节上限、模型名命名空间与截短摘要。失败保留上一份有效快照并标记失效。

每个回合的 `ToolRegistry` 来自一份快照，调用时携带 `catalogRevision + contractHash`。
目录在回合中变化时，旧租约被拒绝（`MCP_CATALOG_STALE`），而不是悄悄转发到新契约。

模型名格式为 `mcp__<serverSlug>__<original>`，serverSlug 含 serverId 摘要；超长时
保留 8 位摘要后缀，防止两个服务器截短后碰撞。

## 7 决定六：人工审批与交互

审批不是 UI 弹窗，而是持久状态机（`InteractionBroker` + `mcp_interactions`）：

- 决策前先写 `mcp_actions`（owner、server、account、tool、参数摘要、contract hash）；
- `pending → accepted/rejected/cancelled/expired` 只能转换一次，两个标签页、重复点击、
  重试请求都只有一次有效恢复；
- 循环在 yield `approval_required` **之前**注册 waiter；若回答先到，`awaitDecision`
  读回已记录的决定，不会挂到超时；
- 进程重启后，点击“批准”只把记录标为 accepted，不会自动执行；显式 resume 执行的是
  原始 action，而不是让模型重新生成 tool call；
- elicitation 复用同一状态机，但语义不同：表单按服务器 schema 校验，表单中索要
  密码/token 的定义直接拒绝；URL 模式只显示目标域名，绝不后台导航。

## 8 决定七：逐步骤媒体计划

“整回合固定一份 media plan”无法给第 3 步才出现的工具图片定价。循环新增
`prepareMedia`：只要请求中的图片 id 集合变化，就重新生成不可变计划；预算、编码和
轨迹使用同一份计划。服务层用 `planToolImages()` 解析资产、加载请求变体并加租约。

## 9 决定八：OAuth 与密钥

- `McpCredentialVault` 用 AES-256-GCM，AAD 绑定 owner/server/kind/version；
- 主密钥只能来自 `EUNOIA_MCP_KEY`（base64/hex 32 字节）或 `EUNOIA_MCP_KEY_FILE`，
  不在 SQLite、不在备份；无密钥时拒绝保存，不回退明文；
- 配置只存 `env:NAME` 引用，且只允许 `MCP_` / `EUNOIA_MCP_` 命名空间；
- OAuth 由 SDK 完成发现/注册/PKCE/刷新，主机补充 owner/服务绑定、一次性 state、
  加密持久化与 UI 状态。回调固定 loopback，state 与服务绑定，跨服务兑换会被拒绝；
- 每个解析出的 token 都登记到进程级脱敏器，错误、说明、结果和 stderr 在入模/落库前
  统一处理。

## 10 决定九：存储与恢复

schema v11 新增：

| 表 | 作用 |
| --- | --- |
| `mcp_servers` | 配置、状态、configRevision（乐观锁） |
| `mcp_catalogs` | 按身份分区的不可变目录快照 |
| `mcp_actions` | 每次调用的准备/发送/结论（含 unknown） |
| `mcp_interactions` | 审批与 elicitation 状态机，resume_key 唯一 |
| `mcp_tasks` | 远端任务句柄与 TTL |
| `mcp_credentials` | 密文、密钥版本、AAD |
| `mcp_conversation_servers` | 会话可用服务 allow list |
| `mcp_resource_snapshots` | 用户选入上下文时的资源快照 |
| `mcp_artifacts` | 非图片二进制的私有引用 |

迁移是增量且幂等的；旧库连续打开两次不会重复建表。删除会话级联清理待处理项、动作、
凭据与媒体引用；远端服务删除后历史仍可审计到墓碑。

## 11 兼容矩阵

| 领域 | 本次实现 |
| --- | --- |
| 协议 | SDK 2.1.0；协商 `2025-06-18`（fixture 实测），支持 `2025-11-25`/`2025-03-26`/`2024-11-05` 等由 SDK 处理；`2026-07-28` 走 SDK 的 modern era |
| 传输 | stdio（host/sandbox-docker）、Streamable HTTP（JSON/SSE、重定向策略） |
| 认证 | 匿名、`env:` Bearer、自定义头、OAuth（预注册/DCR/CIMD 由 SDK 选择） |
| 工具 | 分页、命名空间、schema 校验、原子目录、allow/deny、动态失效 |
| 结果 | 有序 text、structuredContent、image、resource link、embedded text、artifact |
| 资源 | 列表、模板、读取、选入上下文快照、订阅/退订 |
| 提示词 | 列表、参数校验、获取与预览；不自动覆写系统指令 |
| 交互 | 表单/URL elicitation、审批、超时、取消、刷新恢复 |
| 长任务 | 句柄持久化、查询/取消；输入补充与通知轮询依赖 SDK 能力 |
| 产品 | 管理抽屉、会话绑定、来源标签、内联审批、390px 布局 |

## 12 后果

**收益**：MCP 工具与内置工具共享校验、权限、事件、预算、轨迹和媒体；服务器目录
变化不会污染进行中的回合；审批与凭据是可审计、可恢复的持久对象。

**代价与缺口**（在验收报告中逐项标注，不用“基础版”掩盖）：

- OCI 沙箱的真实容器验收需要 Docker 环境，本仓库测试环境没有，标记 BLOCKED；
- 三方 OAuth 授权服务器、真实公共 MCP、真实模型往返需要账号/网络，标记 BLOCKED；
- 进程重启后的 resume 已实现“执行原 action + 返回结果”，但没有把结果自动接回
  正在等待的模型回合；重启后继续对话仍需用户显式继续。M27/M47 因此不是全 PASS；
- Tasks 扩展的查询/取消通过 SDK 原始 `request` 实现，但没有受控 fixture 验证；
- 计量只覆盖模型 usage 与动作记录，没有独立的 MCP 延迟/字节面板（M59 FAIL）。

**不做什么**：不启用已弃用的 sampling；不把远端 `readOnlyHint` 当作授权；不允许
模型修改服务地址、启动命令、凭据或工具策略；不引入 Cordis 或第二套 MCP 执行循环。
