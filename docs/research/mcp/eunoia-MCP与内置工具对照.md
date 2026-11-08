# Eunoia MCP 与内置工具对照

日期：2026 年 11 月 8 日。结论：DSH 和 Codex 均有 MCP 客户端接入。Eunoia 保留自己的文件、命令和技能工具，新增完整 MCP Host 能力，用统一执行管线连接外部服务。当前完成研究与实施清单，MCP 尚未接入生产链路。

执行入口：[MCP完整接入清单与验收](../../plans/eunoia-MCP接入实施清单.md)。本次一次完整交付，不采用仅只读或仅 HTTP 的分版方案。

## 1 内置工具与 MCP 的关系

Tool Calling 是模型提出调用动作的方式；MCP 是应用连接工具/资源服务的协议。模型可通过同一套 Tool Calling 使用两类工具，供应商模型本身不负责建立 MCP 连接。

```text
模型产生 tool call
        ↓
Eunoia：校验参数、权限、调度、记录结果
        ├─ 内置工具实现：文件检索/编辑、沙箱命令、技能加载
        └─ MCP客户端：按协议发现和调用其它服务的工具
```

| 维度 | Eunoia 内置工具 | MCP 工具 |
| --- | --- | --- |
| 实现入口 | 项目代码中的 ToolDefinition 与 execute | 服务器公布定义，由客户端桥接到工具契约 |
| 运行位置 | 文件引擎、沙箱、应用服务等 | stdio 子进程、容器或远端 HTTP 服务 |
| 参数 | 当前由 Zod 定义并生成模型声明 | MCP 服务公布 JSON Schema，需适配和校验 |
| 更换实现 | 修改或注册项目工具实现 | 更换已授权服务配置，通过相同协议接入 |
| 权限 | 应用策略、路径约束与本地沙箱 | 应用调用授权加服务器账户/scope，效果由外部服务执行 |
| 生命周期 | 随应用和回合组织 | 还涉及进程/网络、认证、目录更新和远端任务 |
| 共同部分 | 模型声明、校验、调度、超时、取消、结果、预算和审计 | 接入后应复用同一管线 |

MCP 也可以提供本地文件操作，内置工具也可以调用远端 API。区别主要在于实现与应用之间是否通过 MCP 协议交换能力和调用。MCP 还提供 resources、prompts，分别供应用组织上下文、供用户选择任务模板。[官方架构](https://modelcontextprotocol.io/docs/learn/architecture)。

## 2 一般用来做什么

| 类型与实例 | 常见用途 | 与内置能力如何配合 |
| --- | --- | --- |
| [OpenAI Docs MCP](https://developers.openai.com/learn/docs-mcp) | 检索并读取开发文档 | 获取接口事实后，内置工具编辑和测试代码 |
| [GitHub官方MCP](https://github.com/github/github-mcp-server) | 读取Issue/PR、检查仓库、创建PR | 外部协作走服务API，工作区修改走内置工具 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 操作浏览器、页面快照和截图 | 验证修改后的页面，截图进入媒体管线 |
| 设计和排障服务 | Figma设计、Sentry错误上下文 | 将设计或故障事实交给模型分析，再修改代码 |
| 企业或自建服务 | 文档库、数据库、订单或工单操作 | 标准协议接业务能力，账户和权限独立授权 |

Codex 官方文档也列出了文档、Figma、浏览器、Sentry 和 GitHub 等场景。[Codex MCP说明](https://developers.openai.com/codex/mcp/)。上表解释用途，不代表这些服务已在 Eunoia 安装或认证。

## 3 DSH 实现参考

源码固定为 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。它提供 stdio/HTTP transport，将发现的工具适配到统一工具系统，按服务隔离命名；目录更新先构建完整结果再发布，连接 supervisor 处理代次、重连和清理。资源、说明与支持的图片结果进入自身上下文/媒体机制。

主要来源：[transport](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client/src/transport.ts)、[工具桥接](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client/src/tools.ts)、[连接管理](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client/src/connection.ts)。

该版本并未覆盖所有可选能力，例如 README 列出了 prompt templates 的限制。Eunoia 参考其桥接机制，不机械继承功能缺口，也不引入 Cordis。

## 4 Codex 实现参考

Codex 支持配置 stdio/HTTP、认证、OAuth、工具允许/禁止列表、服务启停和超时。源码将 schema 适配与实际调用/审批分开处理。Eunoia 重点借鉴配置、认证、执行身份及审批绑定。[官方配置](https://developers.openai.com/codex/mcp/)。

源码固定为 `748ab55ca7de0b647d9a7a9d9a8e70e00f28666d`：[schema适配](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/tools/src/mcp_tool.rs)、[工具调用与审批](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/mcp_tool_call.rs)。

## 5 Eunoia 当前需要重构什么

目前只有项目原生工具注册，没有应用层 MCP 配置、发现/调用、认证、进程和前端管理链路。lockfile 中的 MCP client 是 Agents SDK 的间接可选依赖，不能当作产品已支持 MCP。

1. 将 Zod 单一路径改为统一 schema/validator 契约，保留外部 JSON Schema 约束。
2. 字符串工具结果扩展为结构化内容和媒体；循环中出现新图片时按每次模型请求重新规划预算。
3. 工具授权与沙箱执行解耦，外部读写按准确身份和策略授权。
4. 为 stdio 增加受控的持续 stdin/stdout 端口，管理进程、环境、超时和关闭。
5. 审批、补充输入和长任务持久化；连接恢复与历史回放不重复原始副作用。
6. 目录/说明更新纳入现有模型轨迹边界，不在历史中偷偷改 schema 或提示词。

## 6 一个完整使用例子

这是验收后的目标场景：用户让 Agent 读取测试仓库的登录报错、修复并创建PR。

```text
GitHub MCP → 读取Issue与相关上下文
内置工具   → 搜索、读代码、修改文件
内置命令   → 在受控环境运行测试
浏览器 MCP → 检查页面，必要时返回截图
GitHub MCP → 在明确授权的测试目标创建PR
```

同一任务混用两类工具。MCP 帮助复用外部服务，本地文件、命令与读取账本继续由现有工具负责；协议接通不等于已经获得账户和写入授权。

## 7 交付后的亮点

统一工具契约与调度、可管理的双传输接入、作用域明确的认证和审批、结构化/媒体结果、可恢复的用户交互和远端任务，以及与模型预算/轨迹的一致性。

必须展示“发现→调用→结果入模→暂停/继续→重启恢复”。工具列表可见不足以构成交付。具体编号见 [完整实施清单](../../plans/eunoia-MCP接入实施清单.md)，验收通过前不将这些目标写成简历成果。
