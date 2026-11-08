# Eunoia 开发工具补齐验收报告

- 分支：`feat/developer-toolkit`
- 实现提交：`1373577`；catalog 修正 `8314006`；进程快速退出修复见该分支后续提交
- 日期：2026-11-08
- 实施清单：[eunoia-开发工具补齐实施清单](../plans/eunoia-开发工具补齐实施清单.md)
- 选型研究：[eunoia-开发工具现状与选型](../research/tools/eunoia-开发工具现状与选型.md)
- 架构决定：[ADR 038](../adr/038-developer-toolkit.md)

> **结论先行：本次不是“D01–D64、V01–V08 全部通过”。**
> 八组能力的原生服务、工具、持久化、API/部分 UI 和测试已落地；容器预览、真实 Tavily 搜索、真实图片模型回合、浏览器截图入媒体、LSP 适配器和部分 UI 仍被环境或实现边界阻塞。下面逐项区分「实现完成」「离线测试通过」「真实环境通过」和「BLOCKED/FAIL」。没有用工具注册、mock 或跳过测试冒充通过。

## 1 环境与版本

| 项 | 值 |
| --- | --- |
| Node | v24.7.0 |
| 操作系统 | macOS（Apple Silicon） |
| Docker | 28.3.3，daemon 可达 |
| 沙箱镜像 | `sha256:d46d4112…`（`SANDBOX_IMAGE_DIGEST`） |
| Chrome | `/Applications/Google Chrome.app` |
| Playwright MCP | `@playwright/mcp@0.0.80`（已安装，真实启动并操作 example.com） |
| TypeScript 语言服务 | 项目 `typescript`（LanguageService）；`typescript-language-server@6.0.3` 已安装但未接线 |
| 搜索 | Tavily 适配器已实现；**本机没有 `TAVILY_API_KEY`** |
| 模型 | DeepSeek 密钥存在；本轮未执行真实图片模型回合 |

## 2 八组能力的实现落点

| 能力 | 代码 | 持久化/接口 |
| --- | --- | --- |
| 持续进程与预览 | `src/processes/service.ts`、`src/tools/process-tools.ts`、`src/tools/preview-tools.ts` | `dev_jobs`、`dev_previews`；`GET /api/processes` |
| 浏览器 | 锁定 Playwright MCP；`scripts/toolkit-setup.ts` 生成配置 | 复用 MCP 服务器/工具发现/审批/媒体分类 |
| 本地图片 | `src/tools/coding/read-image-tool.ts`、`src/media/tool-media.ts` | 私有媒体资产；`read_image` |
| 联网搜索/网页 | `src/web/*`、`src/tools/web-tools.ts` | `web_documents`；`web_search`、`web_fetch` |
| 用户提问 | `src/questions/*`、`src/tools/question-tools.ts`、`web/app.js` | `user_questions`；`/api/questions` |
| 代码语义 | `src/tools/coding/semantic-tools.ts`、`src/semantic/toolchain.ts` | `find_definition`、`find_references`、`list_symbols`、`diagnostics` |
| 多文件补丁 | `src/tools/coding/apply-patch.ts` | 复用变更集 journal/undo |
| 按轮撤销 | ADR 036 + 补丁 journal | `workspace_changesets`、`/api/conversations/:id/changes` |

## 3 真实证据

### 3.1 全量离线测试

```text
npm run typecheck    通过
npm run lint         0 errors / 4 warnings（均在既有 browser-check 脚本）
npm test             125 files passed / 4 skipped；1560 tests passed / 27 skipped
npm run build        通过
npm run browser:check 通过（桌面、390px、MCP 抽屉）
```

覆盖新增：`read_image` 9 项、web 10 项、questions 7+3 项、apply_patch 8 项、process 9 项、semantic 12 项，以及补丁→撤销端到端 1 项。

### 3.2 真实 Playwright MCP（不是 mock）

用进程内 MCP 客户端启动真实 `playwright-mcp`（系统 Chrome、`--isolated`、headless），发现 24 个浏览器工具，并实际执行：

```text
browser_navigate https://example.com
→ Page URL: https://example.com/
→ Page Title: Example Domain
browser_take_screenshot probe.png
→ 截图为 /tmp/eunoia-browser/probe.png（文本结果引用文件）
```

说明：浏览器后端真实可用；截图目前以文件引用返回，**尚未自动进入媒体管线**，因此 V02/V05 只算部分通过。

### 3.3 真实网页读取

对公网 URL 执行 `web_fetch`：

```json
{"url":"https://example.com/","title":"Example Domain","status":200,
 "chars":171,"head":"Example Domain This domain is for use in documentation examples ..."}
```

对本地 HTTP fixture 另行验证 gzip、302、404、429、401、PDF 拒绝、登录页识别、私有地址拒绝和 cursor 分页。证据见 `tests/web/web-tools.test.ts`。

### 3.4 语义工具真实仓库检查

在本仓库 `src/mcp/service.ts` 上运行：

```text
list_symbols → class McpService @70:1、constructor、broker、describeEndpoint…
find_definition McpService → src/mcp/service.ts:70:14 — class McpService
diagnostics → 没有诊断错误（检查了 1 个文件）
```

中文/emoji/CRLF 行列转换有独立测试（`tests/tools/semantic-tools.test.ts`）。

### 3.5 真实部署与 Playwright MCP（本机）

- 服务从 `.worktrees/mcp` 的 `dist` 启动，PID `66297`；`/health` 返回
  `status:ok`、`web:true`、sandbox enabled、`network:none`。
- 生产库迁移到 schema **14**，`web_documents`、`dev_jobs`、`dev_previews`、
  `user_questions` 四张表存在；旧会话/媒体保留。
- 在真实服务里创建并连接 Playwright MCP（host 模式，隔离 profile，deny
  `browser_run_code_unsafe`/`browser_file_upload`）：状态 `ready`，发现 24 个工具，
  协议 `2025-11-25`，serverInfo Playwright `1.63.0-alpha`。
- `GET /api/tools` 返回内置工具目录、MCP 工具、web/processes/browser/languageServer
  后端状态；未配置 Tavily 时搜索明确显示 `configured:false`。

### 3.6 真实模型回合（同一轮内）

在真实服务、真实 DeepSeek 模型上执行了四个非破坏性回合：

- **web_fetch**：模型调用 `web_fetch`，工具结果 `ok`，最终回答
  「标题：Example Domain / 来源 URL：https://example.com/」。
- **后台作业**：模型调用 `process_start`（命令 `echo live-job-output; sleep 20`）→
  状态 `starting`；`process_read` 读到 16 字节 stdout `live-job-output`；
  `process_stop` 返回 `已停止`；数据库作业状态 `stopped`。这证明进程工具在真实
  Docker 沙箱内运行，不是本地 mock。
- **提问**：模型调用 `ask_user_question` 提出「请选择目标分支」，服务端
  `user_questions` 出现 pending；通过 `/api/questions/:id/answer` 回答 `main` 后，
  同一回合继续，最终回复「你选择了：main」。
- **read_image**：模型调用 `read_image`，结果为 `120×80` 且 `images:1`；下一个模型
  请求被明确拒绝：`当前模型不支持图片输入，请换一个能看图的模型`。工具与媒体管线
  正常，**当前部署的模型没有视觉能力**，因此 V03 仍是 BLOCKED，不是编造成功。

### 3.7 进程/预览

进程服务在真实本地 shell 上验证：启动立即返回、stdout/stderr 游标、退出码、FIFO 输入、取消、进程组停止、PID 消失→unknown、同 toolCall 幂等、并发上限、预览容器内 HTTP 探测。**尚未在真实 Docker 沙箱内跑同一套生命周期**（见 §4 阻塞）。

## 4 逐项验收

状态说明：`PASS` 实现 + 测试（+真实环境，如注明）；`PARTIAL` 有实现但有明确缺口；`FAIL` 未实现或关键行为不满足；`BLOCKED` 需要账号/环境，本轮无法真实执行。

### 4.1 D01–D08 共用执行与资源

| 项 | 状态 | 证据/缺口 |
| --- | --- | --- |
| D01 每次调用带 owner/conversation/turn/tool/Team 身份 | PARTIAL | 原生工具从 `ToolContext` 绑定 user/conversation/toolCallId；Team 的 run/member/activation/taskAttempt/generation 尚未传入所有新工具 |
| D02 稳定 ID、状态、版本、清理策略；内存/SQLite 契约测试 | PARTIAL | `dev_jobs`/`web_documents`/`user_questions` 有 ID/状态/时间；清理策略与内存/SQLite 双实现契约测试未补齐 |
| D03 生命周期幂等；重启对账不自动重发 | PARTIAL | 提问、进程启动、补丁、撤销有幂等/冲突；预览、搜索没有独立幂等键；重启对账代码存在但未做真实重启测试 |
| D04 统一内容块；大结果入受控资源 | PASS | `read_image` 返回 image block + 私有资产；web 正文 50k 截断 + snapshot；进程日志 16k 游标 |
| D05 权限交集；MCP 工具同样审批 | PARTIAL | 进程走沙箱执行器的路径/命令权限；浏览器/MCP 复用现有审批；原生 web/image 未接审批（只读/网络读） |
| D06 预算与独立费用 | PARTIAL | web 结果有界、Tavily `billed:true`；搜索/浏览的独立费用未写入 usage ledger，未显示在 UI |
| D07 超时/取消语义 | PARTIAL | 工具超时、进程 stop、提问 abort 有测试；浏览器动作取消未验证“已点击不可回滚”的文案/行为 |
| D08 日志脱敏、owner 校验 | PASS | Tavily key 注册脱敏；web 文档、问题、作业按 user 查询；UI 不读取他人资源 |

### 4.2 D09–D17 进程

| 项 | 状态 | 证据/缺口 |
| --- | --- | --- |
| D09 start 尽快返回 | PASS | `tests/processes/service.test.ts` 首项；不等待开发服务器退出 |
| D10 状态机/退出码/归属 | PASS | starting/running/exited/stopping/stopped/unknown；本地测试覆盖 running/exited/stopped/unknown |
| D11 stdout/stderr 分流、游标、截断/缺口 | PASS | 游标按字节；超过上限返回截断；gap 标记存在；数据库日志容量上限未实现 |
| D12 input 仅 PTY/可输入；不回显敏感输入 | PARTIAL | FIFO 输入 + 长度/状态校验 + 测试；无 PTY；“不回显到审计”未实现（输入未写审计，但也没有脱敏审计记录） |
| D13 wait 可取消、超时不等于失败 | PASS | `process_wait` 超时返回仍在运行；abort 可退出轮询 |
| D14 stop 定向终止进程组并核对 | PASS | 真实 Docker 沙箱回合：start→read 16 字节→stop「已停止」，数据库 `stopped`；本地另有 TERM→KILL 测试 |
| D15 OCI 运行时受控长期进程端口 | PARTIAL | 复用现有沙箱 `ToolExecutor`（容器内 `setsid`/nohup），没有新增可绕过权限的宿主执行；没有专用 runtime 端口 |
| D16 重启核对 marker/pid/generation | PARTIAL | marker + `/proc/<pid>/cmdline` 校验，缺失则 unknown；未做真实服务重启/容器重启演练 |
| D17 服务/Team/成员退出清理、预览 TTL | FAIL | 无 Team/成员清理钩子、无 TTL 回收任务；用户只能显式 stop |

### 4.3 D18–D23 预览

| 项 | 状态 | 证据/缺口 |
| --- | --- | --- |
| D18 端口分配/发布 | FAIL | 沙箱 `network: none` 且未发布端口；preview 只返回容器内地址 |
| D19 就绪超时 + 证据 | PARTIAL | 容器内 HTTP 探测 + 超时；用户地址为 null，进程日志仍可读 |
| D20 用户/浏览器地址分离 | FAIL | 没有宿主/浏览器可访问的 user URL |
| D21 预览路由 HTTP/WebSocket | FAIL | 未实现代理 |
| D22 HTML/脚本/Cookie/iframe 隔离 | FAIL | 未实现预览隔离策略 |
| D23 UI 就绪/日志/打开/停止 | FAIL | 只有 `GET /api/processes` 列表；没有作业/预览面板 |

### 4.4 D24–D28 浏览器

| 项 | 状态 | 证据/缺口 |
| --- | --- | --- |
| D24 安装/检测/启用流程 | PARTIAL | `@playwright/mcp@0.0.80` + Chrome + `toolkit:doctor`；`toolkit:setup` 打印配置；真实服务里已创建并连接（24 工具）；没有 UI 一键启用 |
| D25 真实浏览器/截图/控制台/网络 | PASS（后端） | 真实服务 MCP ready + 直接进程内导航 example.com；控制台/网络工具已发现；未在 Eunoia 会话内走完整审批链 |
| D26 页面行为验证、截图入媒体 | PARTIAL | 截图文件存在；未导入媒体、未形成 vision 内容块 |
| D27 权限/审批/代理/隔离 | PARTIAL | 走 MCP 审批与工具策略；宿主进程 + `--isolated` profile，不是容器/网络隔离 |
| D28 不重复注册同义浏览器工具 | PASS | 浏览器只经 MCP 发现；无原生 browser_* 工具 |

### 4.5 D29–D34 图片

| 项 | 状态 | 证据/缺口 |
| --- | --- | --- |
| D29 识别真实格式、伪扩展拒绝、路径守卫、大小上限 | PASS | 9 项测试：PNG/WebP、`.jpg` 内 PNG 拒绝、SVG 拒绝、缺失、越界、符号链接、超大、无媒体上下文 |
| D30 复用媒体管线、不可变资产 | PASS | 解码 + 私有 blob；源文件修改后资产字节不变 |
| D31 绑定用户/会话/动作，引用不可跨会话 | PASS | `putToolImage` + `assetId` 绑定；读取按 owner |
| D32 尺寸/字节/模型能力预算 | PARTIAL | 入库/字节/20MB 上限；模型能力由下一步媒体计划拒绝；未在工具边界先查能力 |
| D33 UI 展示来源/描述/资产/预览 | PARTIAL | 复用既有图片消息渲染；`read_image` 工具卡片的文件名/来源展示未单独验证 |
| D34 图片来源/时序/不可变 provenance | PASS | `source:'tool'`、路径/尺寸/字节；资产签名/不可变 |

### 4.6 D35–D40 联网

| 项 | 状态 | 证据/缺口 |
| --- | --- | --- |
| D35 Tavily 基础搜索与真实凭据 | BLOCKED | 适配器、错误映射、请求体约束有测试；本机无 `TAVILY_API_KEY`，未做真实搜索 |
| D36 多查询、域名、时间、限流/超额 | PASS（离线） | 最多 3 query、5 结果、basic、无 answer/raw/images；401/429/超时映射有测试；真实额度未验 |
| D37 web_fetch SSRF/重定向/登录/大小/类型 | PASS | 字符串 + DNS 结果双层检查；逐跳校验；401/403/429/PDF/登录页/私有地址测试 |
| D38 正文提取/编码/分页/快照 | PASS | HTML→文本，去 script/style，实体解码；gzip；cursor 快照分页 |
| D39 登录墙/反爬/无效内容 | PARTIAL | 401/403 + 密码框短页面识别；验证码/JS 渲染页面无法通用识别，会作为正文返回 |
| D40 来源 metadata/前端展示 | PARTIAL | `structuredContent.sources` 含 title/url/snippet/date/query/provider；前端来源卡片未实现 |

### 4.7 D41–D46 提问

| 项 | 状态 | 证据/缺口 |
| --- | --- | --- |
| D41 原生提问服务 + 工具 + API/UI | PASS | `user_questions`、`ask_user_question`、`/api/questions`、轮询卡片 |
| D42 schema/单选/多选/自由文本/取消/过期 | PASS | 字段 key/必填/选项/多选/布尔/数字校验；7 项服务测试 + UI 收集 |
| D43 持久化、恢复、幂等、多端 | PARTIAL | SQLite 持久化与 pending 列表；服务重启后回答不会自动续跑原回合；多端同时回答原子更新 |
| D44 超时/取消/断线/模型中止 | PASS | 10 分钟 TTL、abort、取消、过期测试；断线后问题仍可回答 |
| D45 答案不是权限批准 | PASS | 独立表/API/UI；未调用任何 approve/grant |
| D46 子成员提问经主 Agent 汇总 | FAIL | 未接 Team 成员身份/汇总；Team 代码未改动 |

### 4.8 D47–D51 语义

| 项 | 状态 | 证据/缺口 |
| --- | --- | --- |
| D47 定义、引用、符号、诊断 | PASS（编译器 LanguageService） | 4 个工具；真实仓库定义/引用/诊断；符号树测试 |
| D48 位置/排序/Unicode/CRLF | PASS | 1-based；码点列；中文/emoji/CRLF 测试 |
| D49 文档符号/工作区符号 | PASS（文档符号） | `list_symbols` 单文件声明；工作区级符号未实现 |
| D50 诊断与错误 | PASS（近似） | 语法/类型诊断；第三方包类型未完整加载，README/ADR 说明 |
| D51 LSP 失败/重连/取消 | FAIL | 未接 LSP 适配器（`typescript-language-server` 仅安装 + doctor） |

### 4.9 D52–D57 补丁/撤销

| 项 | 状态 | 证据/缺口 |
| --- | --- | --- |
| D52 预检/上下文/冲突/失败回滚 | PASS | 8 项补丁测试；歧义 hunk 拒绝；写失败回滚已写/已删文件 |
| D53 增删改/移动/多文件/行尾 | PASS | Add/Update/Move/Delete；CRLF 保留；20 文件/200 hunk 上限 |
| D54 并发/工具外改动冲突 | PARTIAL | 基于内容匹配，无写锁/摘要二次校验；读后到写前的并发修改可能被覆盖 |
| D55 修改集/撤销/依赖/状态 | PARTIAL | 补丁 journal 进入变更集，撤销测试覆盖增删改移动；无依赖关系图，独立文件逐文件恢复 |
| D56 diff/行号/冲突/部分撤销 UI | FAIL | 后端变更集有文件明细；前端没有补丁 diff 面板/部分撤销 |
| D57 预算/大补丁/二进制/审计 | PARTIAL | 1MB/20 文件/200 hunk/2MB 单文件；二进制拒绝；审计记录有；大补丁拒绝提示 |

### 4.10 D58–D64 前端/持久化/恢复

| 项 | 状态 | 证据/缺口 |
| --- | --- | --- |
| D58 时间线/工具卡片/来源/资产 | PARTIAL | 工具结果统一渲染；问题卡片；图片复用既有渲染；来源卡片/作业卡片缺失 |
| D59 审批/权限/提问/补丁/撤销状态 | PARTIAL | 审批与撤销已有；补丁/作业状态未在 UI 显示 |
| D60 刷新/断线/多端一致 | PARTIAL | 会话恢复、问题轮询；作业列表只在 API |
| D61 幂等/取消/重试/冲突提示 | PARTIAL | 提问/进程/补丁/撤销有后端语义；UI 冲突提示只覆盖撤销 |
| D62 schema 迁移/索引/保留/清理 | PARTIAL | schema 14 增量迁移；索引齐全；保留/清理任务未实现 |
| D63 内存/SQLite 契约、故障后不重放 | PARTIAL | 双实现；重启对账代码未真实演练；无自动重放 |
| D64 语义/进程/浏览器/网络 UI 预算 | PARTIAL | 现有上下文预算生效；新增工具结果进入统一预算；独立费用未显示 |

### 4.11 V01–V08 真实视觉闭环

| 项 | 状态 | 证据/阻塞 |
| --- | --- | --- |
| V01 预览真实启动/就绪/页面可达 | BLOCKED | 容器端口未发布；`preview_start` 明确返回 `userUrl:null` |
| V02 浏览器打开预览并观察 | BLOCKED | 依赖 V01 的用户可达地址 |
| V03 工作区图片真实模型查看 | BLOCKED | 已真实执行：`read_image` 成功返回 120×80 + images:1；下一请求明确拒绝「当前模型不支持图片输入」。需要配置视觉模型 |
| V04 真实 Tavily 搜索 | BLOCKED | 无 `TAVILY_API_KEY` |
| V05 Playwright 真实操作/截图/控制台 | PARTIAL | 真实导航 + 截图文件；未入媒体、未在 Eunoia 会话内完成 |
| V06 真实用户提问→回答→同轮恢复 | PASS | 真实模型回合：提问 pending → API 回答 main → 同轮继续并回复「你选择了：main」；浏览器点击未单独做 E2E |
| V07 语义定位真实仓库 | PASS | 真实仓库定义/引用/诊断 + Unicode 测试 |
| V08 视觉闭环 + 真实模型预算 | BLOCKED | 依赖 V01/V02/V03；未发起真实模型请求 |

## 5 阻塞项与需要补充的信息

1. **Tavily**：需要 `TAVILY_API_KEY`（独立于模型密钥）。没有它，D35/V04 只能 BLOCKED。
2. **预览端口**：需要决定是否为沙箱发布宿主端口并实现受控 HTTP/WebSocket 代理；当前容器 `network:none`。需要产品确认允许的端口范围、origin 和隔离策略。
3. **浏览器隔离**：当前以宿主进程 + `--isolated` 运行 Playwright MCP；要满足 D22/D27 的容器隔离，需要构建带 Chromium 的沙箱镜像或独立浏览器容器。
4. **截图入媒体**：Playwright MCP 截图返回文本文件路径；需要在其输出目录上做受控文件导入（或改用能返回 base64 的工具），才能成为 vision 内容块。
5. **LSP**：需要决定是否把语义工具从编译器 LanguageService 切到 `typescript-language-server`（已安装），并实现启动、初始化、变更同步、崩溃重连和取消。
6. **真实图片模型回合**：需要确认可用视觉模型与预算；本轮未消耗真实模型额度。
7. **Team 提问汇总**：需要 Team 成员/activation 身份接入 `QuestionService`，并在主 Agent 汇总答案。
8. **真实容器进程/重启演练**：需要启动真实沙箱，执行长进程、重启容器、验证 unknown/清理；本地 shell 测试不能替代。当前服务的 schema 14 与沙箱均正常，但未通过真实会话发起 `process_start`。

## 6 复现命令

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run browser:check
npm run toolkit:doctor
npm run toolkit:setup
```

单项：

```bash
npx vitest run tests/tools/read-image-tool.test.ts
npx vitest run tests/web/web-tools.test.ts
npx vitest run tests/questions/service.test.ts tests/api/questions.test.ts
npx vitest run tests/tools/apply-patch.test.ts tests/service/workspace-undo.test.ts
npx vitest run tests/processes/service.test.ts
npx vitest run tests/tools/semantic-tools.test.ts
```

## 7 交付判断

- 实现完成：八组能力都有领域服务/工具/持久化；其中进程、图片、联网（除真实搜索）、提问、语义、补丁/撤销有完整离线测试。
- 真实环境通过：Playwright MCP 导航/截图、真实公网 web_fetch、真实仓库语义定位、真实本地进程生命周期。
- 未通过：V01、V04、V08；D18–D23、D46、D51、D56 等明确 FAIL；若干 PARTIAL 如 §4 所示。
- 因此**不宣称 D01–D64/V01–V08 全部通过**，也不把本次提交描述为完整验收。分支保留全部已完成工作与上述缺口，供后续补齐。
