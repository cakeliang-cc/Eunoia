# Eunoia 开发工具现状与选型

日期：2026-11-08。执行入口：[开发工具补齐实施清单](../../plans/eunoia-开发工具补齐实施清单.md)。

Eunoia 已有文件发现、文本读取编辑、沙箱命令和 Skills。接下来的目标是打通真实开发任务中的预览、观察、交互和安全修改流程。MCP 提供接入协议，具体服务仍需安装、配置和验证；工具定义可见不等于功能可以使用。

## 当前基础与缺口

工作区正在开发 MCP 和 Team，实施时应以最新集成代码重新核对状态。以下是本次检查到的接口边界。

| 能力 | 现有实现 | 需要补齐 |
| --- | --- | --- |
| 文件发现与文本操作 | `src/tools/coding/` 的 read、list_dir、glob、grep、write、edit | 多文件补丁与版本冲突处理；不重复实现基本读写 |
| 命令与终端 | 一次性 bash；另有 Web 工作台终端 | 面向 Agent 的持久作业 ID、日志游标、查询、输入、取消及预览服务管理 |
| 浏览器 | `scripts/browser-check.ts` 固定操作自有验收页面 | 可配置浏览器 MCP、页面操作、截图、控制台与网络观察 |
| 图片 | 私有图片上传、能力预检、实际变体预算 | 从工作区安全读取图片并转成模型真正收到的图片内容 |
| 网络资料 | MCP 正在提供连接能力 | 搜索与网页正文读取的具体后端、来源信息和前端展示 |
| 用户交互 | 普通聊天、审批；MCP 补充输入正在开发 | 通用的 Agent 需求提问、答案恢复、取消与过期处理 |
| 代码语义 | 文本检索，命令可运行类型检查 | 可调用的定义、引用、符号与诊断接口 |
| 工作区恢复 | 底层 checkpoint；Team 候选集成正在开发 | 用户可操作的按轮次撤销，保护用户后来修改的内容 |
| 远程协作 | 本地 Git 可通过命令执行 | GitHub Issue、PR 和 CI 可按需接入；不强制增加一套本地 Git 工具 |

当前 checkpoint 恢复会保留快照后新增的文件，属于恢复机制；它本身不构成准确的“撤销本轮”。图片上传也不自动使文本 read 能查看本地 PNG。

## DSH 的参考实现

固定版本：`deepseek-ai/deepseek-harness@fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。以下机制作为参考，Eunoia 继续使用自己的执行循环、持久化和沙箱。

| 能力 | DSH 的处理 | Eunoia 的取舍 |
| --- | --- | --- |
| 持续命令 | 独立插件维护每个 Agent 的 shell 状态；交互工作另有终端工具 | 扩展受控进程服务，保留一次性 bash，新增明确的后台作业接口 |
| 浏览器 | Playwright/Chrome DevTools 走 MCP，也有 Stagehand 原生后端 | 本次选 Playwright MCP；内部管理资源、权限和媒体 |
| 图片与补丁 | 文件工具提供 read_image、apply_patch | 复用文件网关与媒体服务实现原生工具 |
| 联网 | 内部 web_search/web_fetch 契约调用可替换后端 | 保留统一模型工具，后端配置与模型厂商解耦 |
| 用户提问 | ask_user_question 对接用户问题服务和客户端 | 建立持久提问服务，复用已有交互设施；需求答案与权限批准分开 |

来源：[持续 Bash](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/shell/tool-bash-persistent/README.md)、[文件工具](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/fs/tool-fs/README.md)、[联网工具](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/web/tool-web/README.md)、[用户提问](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/interaction/tool-ask-user/README.md)。

DSH 的 browser-use 注册服务只登记后端名称，限制同一服务实例的后端注册；具体工具和资源生命周期由提供者负责。不能把它当成已经定义完整浏览器操作接口的统一驱动层。[服务说明](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/browser-use/browser-use/README.md)

## 内置工具与 MCP 的分工

内置工具直接调用本项目领域服务；MCP 工具经过协议调用独立服务。工具运行在本机仍可能是 MCP。插件是一种安装与组织形式，可以在内部启动 MCP 服务。

本次原生实现进程、预览、图片读取、用户提问、补丁和撤销。浏览器执行选用 Playwright MCP。代码语义通过 LSP 适配器访问语言服务，LSP 本身不是 MCP。网页读取原生实现，搜索通过 SearchProvider 接入真实 API，预留通过 MCP 后端替换的边界。

不同时向模型暴露两套同义的浏览器工具；不为 git、npm test 等每条已有命令增加一个工具。工具契约应围绕实际生命周期与安全边界划分。

## 工具从哪里来

Playwright MCP 是上游软件包；DSH 官方浏览器插件依赖它并启动其入口。核对版本固定依赖 `@playwright/mcp@0.0.80`，不代表 Eunoia 必须永远使用这个版本。[依赖声明](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/browser-use-playwright-mcp/package.json)、[启动代码](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/browser-use-playwright-mcp/src/index.ts)

Eunoia 应提供“安装浏览器工具依赖、检测浏览器、启用连接”的明确流程，锁定经过测试的版本。包管理器可复用已有依赖；缺少浏览器二进制时单独提示安装或选择已有浏览器。安装、下载和启用不能混为一个状态。

其他 MCP 可以来自本地已安装程序、按需运行的软件包或远程 HTTP 服务。`npx` 可获取缺少的软件包并使用缓存，但不会替应用完成配置、认证或隔离。[npm 说明](https://docs.npmjs.com/cli/v11/commands/npm-exec/)

## 后端选择

- 浏览器默认采用隔离的 Playwright MCP，复用上游页面操作、截图、控制台和网络工具；版本与能力以锁文件及实际工具发现为准。[上游项目](https://github.com/microsoft/playwright-mcp)
- 搜索交付一个可用的 Tavily HTTP 适配器，使用独立配置的凭据，基础模式只取结果与来源，不额外调用总结模型；SearchProvider 保持可替换。服务需要账号配置，不能以空结果模拟成功。[搜索 API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- 代码语义交付 TypeScript/JavaScript 的 LSP 后端及通用适配端口，定义、引用、符号和诊断需通过真实语言服务验证；其他语言按需配置，不宣称已全语言支持。[LSP 功能映射](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)

这些是工程选型，不是性能或费用优势结论。搜索凭据与主模型凭据分别配置，避免换模型时连带重写联网能力。

## 按需接入的服务

GitHub 官方 MCP 可补 Issue、PR、远程检查等工作流，本地 Git 继续使用受控命令。PDF、设计平台、错误监控和数据库服务按实际需求接入，均通过既有 MCP 权限和资源机制。[GitHub 官方服务](https://github.com/github/github-mcp-server)

本次必需范围是开发工具清单中的八组能力；上面的账号型服务不作为所有安装的默认依赖，也不因 MCP Host 接通便记为已经具备。
