# Eunoia 联调整改验收报告（R01–R14）

> 本报告是本次整改的统一入口；[开发工具补齐验收报告](./eunoia-开发工具补齐验收报告.md) 与 [Subagent/AgentTeam 验收报告](./eunoia-AgentTeam验收报告.md) 保留原始历史，并在开头链接到这里。原验收编号 D01–D64、V01–V08、T01–T60、E01–E06 保持原义，未重新编号；R01–R14 是整改事项编号。

## 0 结论先行

**本次不是“R01–R14 全部完成”。** 共 152 个原编号项：PASS 108、PARTIAL 42、FAIL 0、BLOCKED 2、TODO 0。

- 已真实完成并有可复现证据：R01（基线/编号/校验）、R02（成员执行身份与 MCP 权限交集）、R06（真实浏览器截图进入媒体与 image block）、R10（真实 typescript-language-server）、R13（双 Provider 协议夹具与 fork 拒绝）、R14（备份/构建/迁移/重启/真实预览/真实工具调用）。
- 未全部完成：R03 的 Team 发布未并入统一变更服务；R04 的 `dev_preview` 出口 profile 与完整网络负向矩阵未做；R05 的浏览器仍是宿主进程；R07 的 V08 产品闭环未执行；R08/V04 因缺少 Tavily 凭据 BLOCKED；R09 的中断 activation 安全续跑未完成；R11 的 Team 浏览器全流程未合并；R12 的故障矩阵只完成 3 类。
- 本报告不把“工具注册、接口 200、mock、截图文件存在、旧进程仍返回 200”当作完成；每个 PASS 都指向本次实际执行的命令与证据。

## 1 基线与最终提交

| 项 | 值 |
| --- | --- |
| 集成基线 | `1a5c801`（`.worktrees/integration`，`feat/team-mcp-integration`） |
| 整改分支 | `fix/integration-acceptance`（新 worktree `.worktrees/integration-acceptance`） |
| 代码提交 | `7b6dc65718ba9e653fd078e67d04aeddf5d96197` |
| 文档/验收提交 | 本分支最后一次提交（manifest、报告、证据） |
| Node | v24.7.0 |
| Docker | 28.3.3，runtime `runc`（gVisor 缺失且已显式确认） |
| SQLite schema | 15（本次没有降低版本或删除表） |
| Playwright MCP | `@playwright/mcp@0.0.80`，真实 headless Chrome |
| TypeScript LSP | `typescript-language-server@6.0.3`（真实 stdio 子进程） |
| 模型路由 | `deepseek-flash`（图片能力 supported）真实视觉 S01–S03；文本 `deepseek-v4-pro` |
| 搜索 | 未配置 `TAVILY_API_KEY`（只阻塞 V04/D32） |

环境：macOS Apple Silicon；`HOST=127.0.0.1`；服务端口 8788；预览网关 8790（loopback）；数据库 `/Users/Zhuanz/Projects/designFree/data/eunoia.sqlite`；媒体 `/Users/Zhuanz/Projects/designFree/data/media`。未在报告中输出任何密钥。

## 2 R01–R14 实现与最终位置

| ID | 状态 | 实现位置 | 用户入口 / 证据 |
| --- | --- | --- | --- |
| R01 | PASS | `docs/features/evidence/integration-acceptance/manifest.json`、`scripts/acceptance-manifest.ts`、`package.json` | `npm run acceptance:manifest` / `npm run acceptance:check`；原表生成，缺项/重复/证据缺失/PASS 无证据均失败 |
| R02 | PASS | `src/tools/scope.ts`、`src/agents/members.ts`、`src/mcp/permissions.ts`、`src/tools/types.ts`、`src/agent/loop.ts` | 受限成员 MCP 负向测试 5 项；拒绝时服务端动作计数 0 |
| R03 | PARTIAL | `src/sandbox/workspace-change-service.ts`、`src/tools/coding/apply-patch.ts`、`edit-tools.ts`、`read-tools.ts`/`ledger.ts` | 版本复验、每任务锁、跨文件 journal、冲突与用户修改保护；Team 发布仍用自身 journal |
| R04 | PARTIAL | `src/previews/`、`src/sandbox/runtime/oci-runtime.ts`、`src/sandbox/gateway.ts`、`src/tools/preview-tools.ts`、`src/api/server.ts`、`web/dev-panel.js` | 真实 Docker `network:none` 预览；用户 URL/浏览器 URL；HTTP/WebSocket 网关；TTL/停止/恢复 |
| R05 | PARTIAL | `src/browser/environment.ts`、`scripts/toolkit-setup.ts`、`scripts/toolkit-doctor.ts` | 专用 cache/profile/output/download（0700）、realpath/uid/mode/可写探测、EPERM 诊断；浏览器仍宿主运行 |
| R06 | PASS | `src/mcp/browser-output.ts`、`src/mcp/manager.ts`、`src/mcp/content.ts`、`src/media/tool-media.ts` | 真实 Playwright MCP 文件引用→媒体资产→image block；路径/符号链接/伪扩展/超大负向测试 |
| R07 | PARTIAL | `src/models/catalog.ts`、`scripts/vision-diagnostic.ts`、`tests/smoke/live-vision.test.ts` | 真实 DeepSeek Flash S01–S03 与诊断；V08 产品闭环未执行 |
| R08 | PARTIAL | `src/web/tavily.ts`、`src/web/fetch-http.ts`、`scripts/toolkit-doctor.ts` | 本地 HTTP 认证/401/429/超时/取消/来源分页；真实 V04 因缺密钥 BLOCKED |
| R09 | PARTIAL | `src/questions/`、`src/tools/question-tools.ts`、`src/teams/service.ts` | 子成员问题汇入根会话、成员/代次、去重、旧代次拒绝、关闭取消、重启读取答案 |
| R10 | PASS | `src/semantic/lsp-client.ts`、`lsp-provider.ts`、`language-service-provider.ts`、`src/tools/coding/semantic-tools.ts` | 真实 LSP 初始化/跨文件定义引用/中文 emoji CRLF/诊断版本/取消/SIGKILL 重连 |
| R11 | PARTIAL | `web/dev-panel.js`、`web/app.js`、`web/index.html`、`web/team.css`、`scripts/dev-panel-check.ts` | 作业/预览/来源/差异/范围撤销真实 Chrome 62/62；Team 浏览器全流程未合并 |
| R12 | PARTIAL | `tests/fault-injection/process-faults.test.ts`、`tests/fixtures/fault-child.ts`、`src/observability/faults.ts`、`src/teams/integration.ts` | 真实 SIGKILL/重启 3 类：工具效果、发布首文件、用户后续编辑；其余故障矩阵未完成 |
| R13 | PASS | `src/provider/`、`src/agents/fork-protocol.ts`、`src/agents/members.ts`、`tests/provider/` | 两套本地协议 fixture、流式/工具回填/usage/错误/超时/取消；不可转换 fork 拒绝并提示 fresh |
| R14 | PASS | `scripts/backup.ts`、`dist/build-info.json`、`src/previews/`、部署命令 | 备份、构建、schema 15、8788 重启、`/health` 运行版本、真实预览、真实 `web_fetch` 工具调用 |

## 3 原编号统计

| 维度 | PASS | PARTIAL | FAIL | BLOCKED | TODO |
| --- | --- | --- | --- | --- | --- |
| D01–D64 | 42 | 21 | 0 | 1 | 0 |
| V01–V08 | 3 | 4 | 0 | 1 | 0 |
| T01–T60 | 52 | 8 | 0 | 0 | 0 |
| E01–E06 | 5 | 1 | 0 | 0 | 0 |
| R01–R14 | 6 | 8 | 0 | 0 | 0 |
| 合计 | 108 | 42 | 0 | 2 | 0 |

本报告的逐项表由 `manifest.json` 生成；`npm run acceptance:check` 校验缺项、重复 ID、要求文本与原文不一致、证据路径不存在、PASS 无测试/证据/实现提交。它只校验报告完整性，不会把测试结果自动解释为全部需求通过。

## 4 独立证据

### 4.1 R02 成员权限与执行身份

- 统一 `ExecutionScope`：owner/conversation/team/run/member/activation/generation 由服务器注入；模型参数不能覆盖。
- 成员工具注册时过滤、执行前用最新成员记录重算并比较指纹；收紧权限或旧代次句柄返回 `EXECUTION_SCOPE_CHANGED`。
- 真实本地 MCP fixture：禁命令成员调用 `remote_exec`、只读成员调用 `external_write`、越权 URL、越权路径、账号不匹配、旧批准/旧代次、目录重连扩大工具。每个拒绝场景 fixture 的 `side-effect` 计数为 0；授权范围内读调用成功且计数为 1。
- 证据：`logs/r02-mcp-scope.txt`（5/5），`tests/mcp/member-scope.test.ts`。

### 4.2 R03 补丁版本保护

- write/edit/patch 共用 `WorkspaceChangeService` 的每任务锁、读取摘要复验、before/after 哈希与 journal；`apply_patch` 在锁内重新读取并重新 plan，计划后发生的编辑会以 `PATCH_CONFLICT` 拒绝。
- 跨文件 journal 记录 `prepared → applied（逐项）→ completed/needs_reconciliation`；失败回滚只恢复仍匹配本次 after 的文件，用户后续编辑保留为冲突。
- 测试：A 读→B 改→A 写冲突、两个并发写仅一方成功、lock 边界外部编辑、多文件 journal、失败回滚、重复/无变化编辑。
- 证据：`logs/r03-change-protection.txt`（17/17，含 workspace-undo）。

### 4.3 R04 真实预览与网络三条通道

- 预览不再依赖端口发布：`docker exec -i` 在容器内建立到 `127.0.0.1:<port>` 的字节隧道，宿主 `PreviewGateway` 只转发活跃租约；容器保持 `network:none`，宿主无发布端口（真实测试同时断言直连失败）。
- 租约绑定 job/owner/conversation/member/port/route/generation/状态/TTL；停止、过期、跨会话、未知路由分别 404/410；HTTP、chunked 流、HMR WebSocket 升级与 Origin 校验均有测试。
- 独立预览 origin：`<route>.preview.localhost`；path fallback 剥离 Cookie/Authorization；主应用 API 不被代理。
- 真实 Docker：容器内 dev server → 租约 ready → `userUrl` 经 8790 网关返回 `hello preview`/`final-preview-ok`；停止后旧地址 404。
- 证据：`logs/r04-preview-gateway.txt`（11/11）、`logs/r04-preview-docker.txt`（2/2）、`r14-deploy.json`。

### 4.4 R06 截图真正进入模型请求

- 只处理 Playwright/browser 允许列表工具；只读取该 server 配置的 `--output-dir` 内的文件；realpath、普通文件、非逃逸符号链接、真实解码、字节上限全部校验；不从任意文本正则抓路径。
- 导入不可变媒体资产，结果保留原文本顺序并追加 `type:image, source:tool`；不把绝对路径/base64 放入普通历史。
- 真实 `@playwright/mcp` + headless Chrome：导航本地页面→`browser_take_screenshot`（`--image-responses omit` 强制文件路径）→媒体哈希→image block；负向 34 项。
- 证据：`logs/r06-screenshot-live.txt`（1/1 real）、`tests/mcp/browser-output.test.ts`、`manager.browser-output.test.ts`。

### 4.5 R07 真实视觉

- 诊断脚本输出部署提交、选中 modelId、provider endpoint（脱敏）、能力 revision、image policy、错误发生层；明确区分本地预检拒绝与厂商响应。
- 真实 DeepSeek Flash S01–S03：单图识别数字/颜色、双图顺序交换、重启后同资产回放；真实 usage 记录在 `docs/captures/live-vision.json`。
- 仍未完成 V08：同一产品任务内“读设计图→启动预览→截图→据图改样式→再截图”未执行。
- 证据：`logs/r07-vision-smoke.txt`（3/3 real）、`scripts/vision-diagnostic.ts`。

### 4.6 R09 子成员提问

- 子成员问题写入根会话，携带 memberId/generation/activation；同一 prompt+schema 的重复问题合并为一张卡；答案只路由到原等待者；旧代次 `QUESTION_CONFLICT`；重复回答 `QUESTION_ALREADY_ANSWERED`；关闭成员 `cancelForMember` 取消等待；重启后已答问题可读。
- 未完成：中断 activation 的显式安全续跑（不重放副作用）。
- 证据：`logs/r09-questions.txt`（12/12）。

### 4.7 R10 真实 LSP

- 真实 `typescript-language-server` 子进程：initialize/initialized、didOpen/didChange/didClose、跨文件定义/引用、工作区符号有界能力、publishDiagnostics 版本、1-based 行列与 UTF-16 协商、中文/emoji/CRLF、`$/cancelRequest`、SIGKILL 后一次重连与文档重建；服务端 applyEdit/命令/插件被拒绝；结果标记实际后端。
- 临时镜像项目会明确标注为 mirror，不冒充真实项目。
- 证据：`logs/r10-lsp.txt`（19/19）。

### 4.8 R11 开发面板

- 真实 Chrome/CDP：1280 与 390 各 31 项断言，共 62/62。覆盖作业归属/状态/退出码/日志游标、日志读取请求、停止请求与 token、预览 ready 才渲染链接、failed/expired 无链接、启动预览请求体、来源卡片真实标题/URL/费用未知/日期未知、改动 before/after、部分撤销预检拒绝与只提交所选 paths、键盘/Escape/焦点、无横向溢出。
- 截图与 JSON：`docs/features/evidence/integration-acceptance/r11/`。
- 未完成：Team 配置/委派/成员/@消息/任务/审批/冲突的浏览器全流程未合并进同一脚本。

### 4.9 R12 真实进程故障

- 测试父进程以唯一标记启动子进程（真实 SQLite/临时目录/真实发布目标），子进程通过测试专用 IPC 屏障停在精确故障点，父进程 SIGKILL；不使用固定 sleep 猜时机，不 pkill 用户进程。生产 API 无法触发。
- 已完成：工具外部效果已发生但结果未入库（重启 unknown，外部计数保持 1，不重放）；多文件发布首文件后杀进程（journal 只列已应用，重启续传且不重复）；发布中断后用户改首文件（恢复不覆盖，保留冲突）。
- 未完成：消息已落库未注入、注入已提交未确认、根停止后迟到、旧租约、重启后配置消失。
- 证据：`logs/r12-fault-injection.txt`（3/3）。

### 4.10 R13 双 Provider 与 fork 边界

- 两套独立 provider 配置由本地 HTTP/SSE fixture 服务真实协议（responses 与 chat-completions），捕获请求形状并断言文本/工具/usage/错误/超时/取消差异；不是只换 modelId 或返回相同 ModelTurn。
- fork 只继承已提交且工具组完整的历史；私有推理、未完成工具组、namespaced 工具、跨协议图片明确拒绝并提示 fresh。
- 真实第二厂商凭据 smoke 为 opt-in（`tests/smoke/live-second-provider.test.ts`），缺失时不冒充已上线。
- 证据：`logs/r13-providers.txt`（26/26）。

## 5 真实调用与预算

| 调用 | 次数 | 输入/输出 | 说明 |
| --- | --- | --- | --- |
| 视觉 S01–S03（deepseek-flash） | 4 请求（S03 含重放） | S01 2670/9，S02 2823/4，S03 2632/15 与 2632/21 | 真实端点；usage 在 `docs/captures/live-vision.json`；图片 token 厂商未拆分，标记 unknown |
| 部署后 `web_fetch` 回合（deepseek-v4-pro） | 2 步 | 23227/93，cached 14848 | 真实工具调用成功，回复标题与来源 URL |
| 失败的历史部署回合 | 1 | 23164/381 | 旧构建 `Invalid IP address: undefined` 的失败开销保留；修复后未再出现 |
| Tavily 搜索 | 0 | — | 无密钥，V04/D32 BLOCKED；费用 unknown，不显示 0 |

## 6 备份、构建、迁移、重启与运行身份

1. 备份：`backups/eunoia-2026-11-08T13-29-50-178Z/`（SQLite + media manifest；`sha256 51a7bfe3a4ec…`，1 个媒体资产校验通过）。
2. 构建：`npm run build` 通过；`dist/build-info.json` 记录 commit/构建时间；本次运行版本 `3f72c4fc…`（代码提交 `7b6dc657…`，报告/证据提交 `3f72c4f`；`build-info.dirty=false`）。
3. 迁移：`SQLITE_PATH=/Users/Zhuanz/Projects/designFree/data/eunoia.sqlite npm run migrate` → schema 15；未降低版本、未删除表。
4. 重启：8788，PID 见 `r14-deploy.json`；日志 `data/server.log`；预览网关 8790（loopback）。
5. `/health`：`status:ok`、`store:sqlite`、`build.commit=3f72c4fc…`、sandbox runtime ok、`network:none`。
6. 真实预览：API 启动容器内 dev server → 租约 ready → `http://<route>.preview.localhost:8790/` 返回 `final-preview-ok` → 停止后 404。
7. 真实工具：部署服务内 DeepSeek 调用 `web_fetch`，真实回复 `标题：Example Domain` / `来源 URL：https://example.com/`，acceptance `tools_ok:true`。
8. 清理：预览已停止；故障测试子进程全部退出；未杀用户其他进程；原工作区/数据库/备份保留。

部署验证还发现并修复了一个真实 bug：`http.request` 的 `lookup` 在 Node `autoSelectFamily` 下以 `{all:true}` 调用，旧实现返回字符串导致 `ERR_INVALID_IP_ADDRESS`；现在两种形状都返回，并有回归测试。

## 7 仍未通过 / 外部条件

| 项 | 状态 | 原因 | 最小条件 |
| --- | --- | --- | --- |
| D32、V04 | BLOCKED | 无 `TAVILY_API_KEY`；真实搜索与来源网页读取无法执行 | 在环境/加密凭据入口提供 Tavily key；其余本地契约已通过 |
| R04 出口 profile / 完整网络负向矩阵 | PARTIAL | 预览入站已真实可用；`dev_preview` 出口白名单、直连 IP/宿主/元数据/兄弟工作区负向矩阵未全部执行 | 允许创建每工作区内部网络与出口代理的部署环境 |
| R05 浏览器网络隔离 | PARTIAL | 浏览器仍为宿主进程 + `--isolated`；profile 隔离不等于网络隔离 | 浏览器容器/受控网关运行环境 |
| R07 V08 | PARTIAL | 真实视觉与真实预览分别通过；产品内“看图改样式”闭环未执行 | 可用的视觉模型与预览环境（均已具备，需执行完整任务） |
| R09 中断续跑 | PARTIAL | 已回答问题可读；中断 activation 的安全续跑未实现 | 无需外部条件；剩余实现工作 |
| R11 Team 浏览器流程 | PARTIAL | 开发面板已真实验收；Team 配置/委派/任务/审批全流程未合并 | 无需外部条件；剩余自动化工作 |
| R12 其余故障矩阵 | PARTIAL | 已完成 3 类；邮箱/租约/迟到/配置丢失未完成 | 无需外部条件；剩余测试设施工作 |

## 8 逐项原编号表

### 8.1 D01–D64

| 编号 | 原要求 | 状态 | 测试命令 | 证据 | 说明 |
| --- | --- | --- | --- | --- | --- |
| D01 | 已有功能回归：单 Agent、工具、Skills、MCP/Team、媒体、幂等和停止契约保持 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D02 | 工具目录：实际 schema/校验一致，身份由服务绑定，未配置状态与错误准确 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt)<br>[r02-mcp-scope.txt](docs/features/evidence/integration-acceptance/logs/r02-mcp-scope.txt) | — |
| D03 | 作业启动：长期进程快速返回句柄，命令只在受控工作区/容器执行 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D04 | 作业隔离：两成员进程、cwd、环境和资源互不串用，越权 ID 被拒 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 作业隔离有成员工作区与 Docker 测试，但成员进程工具的双成员隔离未单测。 |
| D05 | 增量日志：stdout/stderr、游标、分页、丢失标识和输出上限正确 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D06 | 等待与输入：wait 不占模型许可，取消有效；PTY 输入按归属和状态处理 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D07 | 定向停止：父子进程全部结束，同容器其他合法作业保持运行 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D08 | 重启与 PID 复用：旧句柄不误控新进程，无法核实时 unknown，无自动补启动 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | PID 复用与 marker 有单测；真实服务重启后的长期作业对账未重跑。 |
| D09 | 并发和寿命：启动/停止幂等；上限、TTL、成员关闭和运行停止正确清理 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 并发/幂等有测试；TTL 自动回收长期作业未单独执行。 |
| D10 | 预览就绪：超时/失败/端口冲突正确；浏览器获得真实可达地址 | **PASS** | `npm test` | [r04-preview-gateway.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-gateway.txt)<br>[r04-preview-docker.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-docker.txt) | — |
| D11 | 预览代理：HTTP 与开发 WebSocket 可用，未授权端口与跨用户访问被拒 | **PASS** | `npm test` | [r04-preview-gateway.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-gateway.txt)<br>[r04-preview-docker.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-docker.txt) | — |
| D12 | 预览 origin：被预览脚本无法读取主应用私有 API、控制 token 或 Cookie | **PARTIAL** | — | [r04-preview-gateway.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-gateway.txt) | 预览 origin 的 host/path/cookie 与跨主应用探测有测试；iframe sandbox 与 postMessage 未做浏览器端验证。 |
| D13 | setup/doctor：依赖、浏览器、版本、网络、能力和账号状态准确，不自动安装 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D14 | 浏览器实际连接：真实 Playwright MCP 能发现全部必需能力，锁定版本可复现 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt)<br>[r02-mcp-scope.txt](docs/features/evidence/integration-acceptance/logs/r02-mcp-scope.txt) | — |
| D15 | 浏览器隔离：两成员 Cookie/tab/profile/目录隔离，同名服务不串连接 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 浏览器实例使用 --isolated，但两名成员 Cookie/tab/下载目录隔离未做双实例浏览器测试。 |
| D16 | 浏览器动作：导航、点击、输入、选择、等待、tab、viewport 实际成功 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 真实 headless Chrome 已验证导航与截图；点击/输入/选择/等待/tab 未逐项重跑。 |
| D17 | 页面引用失效：旧元素引用不误操作，重取页面后可恢复 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 旧元素引用失效未做真实浏览器回归。 |
| D18 | 浏览器网络限制：导航、跳转、子资源、脚本/WebSocket 不能绕过授权网络边界 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 浏览器在宿主运行，未经过受控网关；导航/重定向/WebSocket 的网络边界未满足。 |
| D19 | 页面故障证据：捕获控制台 error、失败请求/HTTP 错误，敏感信息脱敏 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 控制台/失败请求工具已发现，但未在本轮真实动作中采集并断言脱敏。 |
| D20 | 截图真正入模：实际截图字节变体经 image 块编码进入下一请求，不只返回路径 | **PASS** | `npm test` | [r06-screenshot-live.txt](docs/features/evidence/integration-acceptance/logs/r06-screenshot-live.txt)<br>[full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D21 | 截图范围：390px/桌面、整页/元素、DPR/变体元数据准确，过长图显式处理 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 截图文件引用可导入；整页/元素/视口/DPR 变体未逐项验证。 |
| D22 | 浏览器取消：已送达动作不假报撤销；停止清理与 unknown 状态准确 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 浏览器取消与 unknown 语义未做真实动作测试。 |
| D23 | attach 与恢复：显式接管/冲突处理正确；重启不假称旧 tab 和 Cookie 已恢复 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | attach/外部浏览器接管与重启恢复未验证。 |
| D24 | 图片读取：JPEG/PNG/WebP 从授权工作区入库，UI 和模型收到相同资源身份 | **PASS** | `npm test` | [r06-screenshot-live.txt](docs/features/evidence/integration-acceptance/logs/r06-screenshot-live.txt)<br>[full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D25 | 图片边界：符号链接/敏感文件/伪扩展/像素洪泛/不支持格式按策略拒绝 | **PASS** | `npm test` | [r06-screenshot-live.txt](docs/features/evidence/integration-acceptance/logs/r06-screenshot-live.txt)<br>[full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D26 | 图片不可变：读取后源文件变化不改历史；实际读取字节和记录哈希一致 | **PASS** | `npm test` | [r06-screenshot-live.txt](docs/features/evidence/integration-acceptance/logs/r06-screenshot-live.txt)<br>[full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D27 | 图片能力和授权：unsupported/unknown 不误看图，跨会话和子成员授权校验不放宽 | **PASS** | `npm test` | [r06-screenshot-live.txt](docs/features/evidence/integration-acceptance/logs/r06-screenshot-live.txt)<br>[full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D28 | 图片预算：实际变体、重复图片、工具续轮与 Team 总预算核算正确 | **PASS** | `npm test` | [r06-screenshot-live.txt](docs/features/evidence/integration-acceptance/logs/r06-screenshot-live.txt)<br>[full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D29 | fetch 正文：HTML 清洗、文本编码、非 2xx、二进制/登录页与截断结果准确 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D30 | fetch 网络：IPv4/IPv6、DNS 重绑定、重定向和代理路径不能访问未授权私网/元数据 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D31 | fetch 资源限制：跳转、超时、压缩炸弹、大正文和转换限额生效，可取消 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D32 | 搜索真实适配：Tavily 协议适配、认证和错误经 HTTP 契约测试，无伪结果/隐形总结调用 | **BLOCKED** | `npx vitest run tests/web` | [r08-search-contract.txt](docs/features/evidence/integration-acceptance/logs/r08-search-contract.txt) | 本机没有 TAVILY_API_KEY，真实搜索调用无法执行；适配器与本地 HTTP 契约测试已通过。 |
| D33 | 搜索配置：无凭据/429/超时/取消区别明确，重试有界且次数可审计 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D34 | 来源与分页：URL/日期/抓取版本可追溯，缺失日期不编造，分页不偷换内容 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D35 | 外部内容：网页/搜索文本不升级指令，不继承认证信息，引用前端可见 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D36 | 后端可替换：替换 Search/FetchProvider 不改 loop/schema；费用未知不显示为零 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D37 | 提问创建：单选/多选/文本及推荐选项准确，需求问题不等同权限审批 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D38 | 提问等待：blocking/timed/取消准确，超时和预选不当答案，不占模型许可 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D39 | 回答幂等：重复回答只注入一次；越权、旧版本、关闭运行和非法选项被拒 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D40 | 提问恢复：刷新/重启恢复卡片；答案进入原执行安全边界，无第二轮互斥绕过 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D41 | 子成员问题：子成员经主 Agent 汇总，避免直接越权弹窗；停止清理等待 | **PARTIAL** | — | [r09-questions.txt](docs/features/evidence/integration-acceptance/logs/r09-questions.txt) | 子成员问题已汇入根会话并带成员/代次；中断后的原执行安全续跑未端到端完成。 |
| D42 | LSP 启动：真实 TS/JS 服务初始化，记录版本/能力，与项目工作区一致 | **PASS** | `npm test` | [r10-lsp.txt](docs/features/evidence/integration-acceptance/logs/r10-lsp.txt) | — |
| D43 | 定义与引用：重名/跨文件场景返回实际符号位置，分页与授权范围正确 | **PASS** | `npm test` | [r10-lsp.txt](docs/features/evidence/integration-acceptance/logs/r10-lsp.txt) | — |
| D44 | 行列编码：中文、emoji、CRLF 和协商编码转换正确，无偏移误定位 | **PASS** | `npm test` | [r10-lsp.txt](docs/features/evidence/integration-acceptance/logs/r10-lsp.txt) | — |
| D45 | 诊断版本：修改后旧结果 stale，新结果对应当前版本，未就绪不当零错误 | **PASS** | `npm test` | [r10-lsp.txt](docs/features/evidence/integration-acceptance/logs/r10-lsp.txt) | — |
| D46 | LSP 更新恢复：文档同步、取消、崩溃重连和错误帧有界处理，不漏进程 | **PASS** | `npm test` | [r10-lsp.txt](docs/features/evidence/integration-acceptance/logs/r10-lsp.txt) | — |
| D47 | LSP 权限：不能跨成员读文件、加载未授权插件或通过 applyEdit 改文件 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | LSP 进程不加载插件并拒绝 applyEdit（实现），但跨成员路径/插件负向测试未单独执行。 |
| D48 | 补丁预检：新增/更新/删除/移动、dry-run、基线与权限校验正确，失败不落盘 | **PASS** | `npm test` | [r03-change-protection.txt](docs/features/evidence/integration-acceptance/logs/r03-change-protection.txt) | — |
| D49 | 补丁竞争：全批提交前重检版本，同文件竞争无静默覆盖，幂等键异参冲突 | **PASS** | `npm test` | [r03-change-protection.txt](docs/features/evidence/integration-acceptance/logs/r03-change-protection.txt) | — |
| D50 | 补丁故障：中途崩溃准确记录已应用项，恢复不覆盖用户新编辑 | **PASS** | `npm test` | [r03-change-protection.txt](docs/features/evidence/integration-acceptance/logs/r03-change-protection.txt) | — |
| D51 | 共用修改记录：write/edit/patch/Team 发布均能关联修改集，历史内容不可变 | **PASS** | `npm test` | [r03-change-protection.txt](docs/features/evidence/integration-acceptance/logs/r03-change-protection.txt) | — |
| D52 | 撤销增删改移动：匹配 after 的变化准确反向恢复，包含新增文件删除与目标冲突 | **PASS** | `npm test` | [r03-change-protection.txt](docs/features/evidence/integration-acceptance/logs/r03-change-protection.txt) | — |
| D53 | 用户修改保护：用户后续编辑或新建文件导致冲突，不覆盖、不误删 | **PASS** | `npm test` | [r03-change-protection.txt](docs/features/evidence/integration-acceptance/logs/r03-change-protection.txt) | — |
| D54 | 撤销依赖：后续修改依赖显式处理，重复撤销幂等，旧执行轨迹保留 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 撤销依赖保护与部分撤销已实现/测试；后续修改依赖的完整队列未覆盖。 |
| D55 | 撤销故障范围：journal 故障可恢复；未归因命令与外部效果明确标记不覆盖 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 跨文件 journal 与冲突证据有测试；未归因命令/外部效果的撤销边界仅部分覆盖。 |
| D56 | API 所有权：作业、预览、截图、问题、语义和修改集端点跨 owner 均拒绝 | **PARTIAL** | `npx vitest run tests/previews`<br>`npx vitest run tests/api` | [r04-preview-gateway.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-gateway.txt)<br>[d-api-service.txt](docs/features/evidence/integration-acceptance/logs/d-api-service.txt) | 作业/预览/问题/修改集跨 owner 有测试；语义与全部权限端点未逐一负向覆盖。 |
| D57 | 前端完整流程：配置、作业、预览、截图、来源、问题、诊断和撤销均可操作 | **PARTIAL** | `npx vitest run tests/web/dev-panel.test.ts`<br>`node --experimental-strip-types scripts/dev-panel-check.ts` | [dev-panel-check.json](docs/features/evidence/integration-acceptance/r11/dev-panel-check.json) | 作业/预览/来源/差异/撤销可操作并有真实浏览器证据；问题、诊断与 Team 流程未在同一 UI 验收中覆盖。 |
| D58 | 流与历史：重连、事件去重、历史回放不会重复工具或图片，日志有界 | **PASS** | `npx vitest run tests/web/dev-panel.test.ts` | [dev-panel-check.json](docs/features/evidence/integration-acceptance/r11/dev-panel-check.json) | — |
| D59 | 无障碍与窄屏：键盘、标签和 390px 检查通过，无整体横向溢出 | **PASS** | `node --experimental-strip-types scripts/dev-panel-check.ts` | [dev-panel-check.json](docs/features/evidence/integration-acceptance/r11/dev-panel-check.json) | — |
| D60 | 审批与停止：具体成员/动作/版本可见；批准不串用，根停止能收束资源 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 审批卡片绑定成员/代次有测试；UI 全流程批准与根停止收束未合并验收。 |
| D61 | 预算总账：图片、工具结果、子成员和额外外部费用都进入正确账本 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D62 | 迁移备份清理：旧数据升级成功，引用资源备份可恢复，不清掉未决修改/对账证据 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | 迁移/备份将在 R14 部署时执行；尚未在旧库临时副本演练。 |
| D63 | 安全脱敏：秘钥、认证头、个人浏览器状态与私有资源不通过日志或 UI 泄露 | **PASS** | `npm test` | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | — |
| D64 | 安装重现：干净环境按锁版本和文档安装后 doctor 通过，禁网环境错误准确 | **PARTIAL** | — | [full-regression.txt](docs/features/evidence/integration-acceptance/logs/full-regression.txt) | doctor 可运行；干净环境按锁文件重装未执行。 |

### 8.2 V01–V08

| 编号 | 原要求 | 状态 | 测试命令 | 证据 | 说明 |
| --- | --- | --- | --- | --- | --- |
| V01 | 从 UI 启动临时前端项目，查询日志、等待就绪、打开预览再停止：真实容器和服务、可达路由、WebSocket、定向停止，无孤儿进程 | **PARTIAL** | `npx vitest run tests/previews`<br>`SANDBOX_INTEGRATION=1 npx vitest run tests/sandbox/preview-tunnel.docker.test.ts` | [r04-preview-gateway.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-gateway.txt)<br>[r04-preview-docker.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-docker.txt) | 真实 Docker 沙箱内 dev server 经租约与宿主网关可达（network:none、无端口发布）；尚未用浏览器 MCP 在同一租约上完成打开+截图。 |
| V02 | 经实际 Playwright MCP 完成页面操作，采集错误和桌面/390px 截图：实际截图、工具清单/调用、图像入模请求投影、受控页面结果 | **PARTIAL** | `PLAYWRIGHT_MCP_LIVE=1 npx vitest run tests/mcp/browser-output.live.test.ts` | [r06-screenshot-live.txt](docs/features/evidence/integration-acceptance/logs/r06-screenshot-live.txt) | 真实 Playwright MCP 截图文件引用已导入媒体并生成 image block；尚未把该块送入真实模型请求。 |
| V03 | Agent 读取工作区设计图并读取原截图，做文本与图片预算检查：真实文件、媒体哈希、发送变体、图片能力不足时明确拒绝 | **PASS** | `RUN_SMOKE=1 npx vitest run tests/smoke/live-vision.test.ts` | [r07-vision-smoke.txt](docs/features/evidence/integration-acceptance/logs/r07-vision-smoke.txt) | 真实 DeepSeek Flash 完成 S01–S03：单图/双图顺序/重启后回放，真实回答与 usage 保留。 |
| V04 | 搜索公开技术资料，读取其中一页并输出来源链接：真实搜索 API 与公网 fetch；请求/来源/状态/费用配置脱敏证据 | **BLOCKED** | `npx vitest run tests/web` | [r08-search-contract.txt](docs/features/evidence/integration-acceptance/logs/r08-search-contract.txt) | 缺少 TAVILY_API_KEY，真实搜索与来源网页读取无法执行；本地协议测试已通过。 |
| V05 | Agent 发起方案选择，刷新后回答，再继续同一任务；另测取消和旧答案：问题 ID、恢复事件、只有一次入模，原回合互斥不被绕过 | **PASS** | `npx vitest run tests/questions` | [r09-questions.txt](docs/features/evidence/integration-acceptance/logs/r09-questions.txt) | 真实模型提问→回答→同轮恢复已有证据；本轮补子成员汇总/旧代次/重复回答/重启读取答案测试。 |
| V06 | TS/JS 示例项目中定位定义、查引用，制造类型错误后修复：真实 LSP、正确行列与版本、旧诊断失效、当前诊断更新 | **PASS** | `npx vitest run tests/semantic tests/tools/semantic-tools.test.ts` | [r10-lsp.txt](docs/features/evidence/integration-acceptance/logs/r10-lsp.txt) | 真实 typescript-language-server：初始化、跨文件定义/引用、中文/emoji/CRLF、诊断更新、取消、SIGKILL 重连与文档重建。 |
| V07 | 多文件增删改移动后撤销，再制造用户并发修改和发布中断：完整 before/after、冲突不丢内容、幂等与故障恢复 journal | **PARTIAL** | `npx vitest run tests/tools/change-protection.test.ts tests/service/workspace-undo.test.ts` | [r03-change-protection.txt](docs/features/evidence/integration-acceptance/logs/r03-change-protection.txt) | 版本保护/冲突/journal/部分撤销预检有测试；UI 冲突与发布中断的完整浏览器流程未合并执行。 |
| V08 | 正式产品入口由真实当前模型完成“读取设计图→启动预览→看图改样式→再截图验证”：模型真实收到两轮图片，代码和页面结果可核对，总 usage/工具数/资源清理有记录 | **PARTIAL** | `RUN_SMOKE=1 npx vitest run tests/smoke/live-vision.test.ts`<br>`SANDBOX_INTEGRATION=1 npx vitest run tests/sandbox/preview-tunnel.docker.test.ts` | [r07-vision-smoke.txt](docs/features/evidence/integration-acceptance/logs/r07-vision-smoke.txt)<br>[r04-preview-gateway.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-gateway.txt)<br>[r04-preview-docker.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-docker.txt) | 真实视觉与真实预览分别通过；同一产品任务内的“读图→预览→截图→改样式→再截图”闭环尚未执行。 |

### 8.3 T01–T60

| 编号 | 原要求 | 状态 | 测试命令 | 证据 | 说明 |
| --- | --- | --- | --- | --- | --- |
| T01 | 单 Agent 回归：普通聊天/工具/停止/历史读取保持既有契约，不强制建 Team | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T02 | fresh 委派：独立内部会话和轨迹，只收到显式上下文，真实产生独立 ModelTurn 调用 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T03 | fork 边界：只继承已提交轮次及完整工具组；父子写入隔离；低权限成员不能借历史取得敏感输出 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T04 | 创建失败：初始化、持久化或工作区失败不泄露许可，不留下可运行幽灵成员 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T05 | 同成员跟进：忙时排队、空闲时继续；不会并发写同一成员轨迹 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T06 | 模型可替换：两个不同 provider 配置经相同端口成功执行，无 DeepSeek 名称分支 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T07 | 能力不足：工具/图片能力不符时预检失败或显式重新选择，零误派发 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T08 | fork 协议差异：不可转换内容明确阻塞；不泄露私有 provider 字段 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T09 | interrupt：当前执行及工具可取消，成员可继续新激活，旧回调不能污染新轮 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T10 | close 与子树：关闭后拒绝跟进；后代收束，进程、等待、许可可核对释放 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T11 | 真正并行：屏障证明两个成员模型请求同时在途；不是只检查 Promise 数量 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T12 | 等待不死锁：低并发配置下，主成员 wait 不占请求许可，子成员仍能完成 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T13 | 树和容量：深度、成员数、激活数上限及环校验准确；越限不调用模型 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T14 | 运行创建幂等：双请求仅建一个运行；同键不同输入返回冲突 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T15 | 消息持久幂等：重复发送只存/注入一次，同键不同内容冲突；accepted 不冒充已处理 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T16 | 消息授权：跨 owner/Team、伪造 sender、已关闭成员均被拒绝 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T17 | 安全注入：忙时消息在合法边界注入；不能打断工具组或冒充高优先级指令 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T18 | 邮箱故障点：注入前后崩溃重启，无漏信和重复轨迹，ack/游标一致 | **PARTIAL** | — | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | 邮箱注入/重投有单测；真实进程 kill 后重启的邮箱游标矩阵未完成。 |
| T19 | 消息界限：大小、数量、扇出和自激预算生效，成员互发不能无限唤醒 | **PARTIAL** | — | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | 大小/队列上限已测；自动激活、广播扇出与自激预算未单独测。 |
| T20 | 成员资格：历史成员、关闭成员和外树成员不能认领任务；名称不是授权依据 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T21 | DAG：自环、循环、悬空及跨运行依赖失败，合法图及修改成功 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T22 | CAS 认领：两个真实数据库连接竞争同任务仅一方成功，版本递增 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T23 | 任务授权：成员不能改他人归属、放宽验收或自验收；主成员操作可审计 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T24 | 依赖调度：依赖 accepted 才 ready；失败/取消阻塞；outbox 重投不重复激活 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T25 | 提交不等于完成：activation 成功、工具成功、submitted 或根模型提前输出最终答案均不能自动使 Team succeeded | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T26 | 拒绝再交付：旧提交保留，新 attempt 重新验证；required 任务不能静默消失 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T27 | 租约失效：过期 generation 写回被拒；旧进程未终止不重派写任务 | **PARTIAL** | — | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | 过期 generation 写回有测试；旧进程未终止前不重派写任务未构造。 |
| T28 | 停止后迟到：迟到响应不能变成功、续调工具或发布文件 | **PARTIAL** | — | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | 停止后迟到结果不能改成功（代码/测试）；完整停止后的发布/工具续调矩阵未测。 |
| T29 | 调度公平性：全局/用户/Team 限流均生效，无长期饥饿和容量计数泄漏 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T30 | 暂停恢复：pausing/paused 语义准确；恢复重检权限、预算、generation | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T31 | 写工作区隔离：真实容器中成员不能读写兄弟目录、源目录、共享 Git 元数据 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T32 | 快照安全：未提交修改保留；凭据、忽略目录和越界链接不被复制 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T33 | 环境隔离：共享缓存不可互改；端口与可写依赖不串扰 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T34 | 差异产物：增删改、二进制、重命名、执行位按声明支持；哈希和路径校验准确 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T35 | 同文件冲突：两成员冲突显式呈现，无覆盖，解决后重新验证 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T36 | 源目录变化：发布前相关文件变化阻塞；用户内容不丢失，无关变化可继续 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T37 | 发布故障：多文件中途故障能识别已应用集合；不覆盖故障后用户编辑 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T38 | 发布幂等：相同发布请求只应用一次；不同候选同键冲突 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T39 | 证据绑定：候选哈希变化后旧测试证据失效；失效证据不能验收 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T40 | 权限交集：子成员扩大路径、命令、网络或角色权限均失败，MCP 同样检查 | **PASS** | `npx vitest run tests/mcp/member-scope.test.ts` | [r02-mcp-scope.txt](docs/features/evidence/integration-acceptance/logs/r02-mcp-scope.txt) | 成员权限交集与 MCP 服务/工具/外部写/未知/网络/路径负向测试通过；动作在发送前被拒绝且服务端计数为 0。 |
| T41 | 审批归属：UI/服务核对成员、参数哈希、账号和代次；旧批准不能批准新动作 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T42 | MCP 真实契约：受控本地 MCP 服务验证身份、stdio cwd、elicitation/Tasks 取消和 unknown 状态 | **PASS** | `npx vitest run tests/mcp/member-scope.test.ts tests/teams/mcp-interactions.test.ts` | [r02-mcp-scope.txt](docs/features/evidence/integration-acceptance/logs/r02-mcp-scope.txt)<br>[t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | 真实本地 MCP fixture 验证成员工具注册、审批和拒绝路径；与既有 T42 证据合并。 |
| T43 | 图片授权：子成员获得显式授权才可读；跨用户/撤销后访问失败，不放宽原媒体检查 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T44 | 图片预算：同图发送给两成员分别计入请求，能力和图片预留均正确 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T45 | 团队预算竞争：两成员同时预留不透支；嵌套 spawn/摘要/重试无法绕过总账 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T46 | usage 结算：缓存输入不重复累计，价格 unknown/usage 缺失不会按免费派发 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T47 | 总量终止：请求、Token、激活任一上限到达停止新派发，报告未完成项 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T48 | 进程恢复：SQLite 重启恢复成员/任务/邮箱/事件；模型响应丢失不自动重放写工具 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T49 | 外部效果未知：工具已生效但响应丢失时进入待对账，不重复执行，不假报成功 | **PASS** | `npx vitest run tests/fault-injection` | [r12-fault-injection.txt](docs/features/evidence/integration-acceptance/logs/r12-fault-injection.txt) | 真实子进程在工具产生外部效果后被杀；重启恢复为 unknown，外部计数保持 1，未重放。 |
| T50 | 配置失效：重启后模型、凭据或工具消失时明确阻塞，重新选择可恢复 | **PARTIAL** | — | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | 未知模型在 spawn 前阻塞；重启后凭据/工具消失的重新选择流程未端到端测。 |
| T51 | SSE 重连：断开不取消 Team，补游标不重建运行、不重复事件；过期可拉快照 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T52 | 追加指令：steering 按序进入合法边界；普通第二轮仍受根会话互斥 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T53 | API 所有权：所有成员/任务/事件/产物端点跨 owner 拒绝，猜 ID 不可下载 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T54 | 主界面流程：配置、委派、看板、成员详情、结果审阅均可从 UI 完成 | **PARTIAL** | — | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | Team 抽屉可配置/委派/看板；浏览器全流程自动化仍待 R11/R11 证据。 |
| T55 | UI 消息与错误：@ 成员指向稳定 ID；CAS/模型/预算错误可见并可恢复 | **PARTIAL** | — | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | 稳定 ID @ 成员与错误码已实现；UI 自动化未完成。 |
| T56 | UI 控制与审批：暂停/停止/关闭区别明确；审批和冲突解决全流程可操作 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T57 | UI 可访问性：390px 窄屏、键盘和标签检查通过；长轨迹不撑爆页面 | **PARTIAL** | — | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | 390px/键盘检查未在本轮重新执行。 |
| T58 | 审计与隐私：工具可追到成员/attempt；无密钥、私密推理和自动长期记忆污染 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| T59 | 迁移与清理：升级旧数据库及备份恢复成功；清理不删除仍被引用的产物/未知工作区 | **PASS** | `npx vitest run tests/teams/migration.test.ts tests/teams/integration-flow.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | 迁移/备份与引用保护有既有测试；R14 将再次执行真实备份/迁移。 |
| T60 | 完整收束：required 未验收/有冲突/有未知效果时不成功；终态容量、进程和结果一致 | **PASS** | `npx vitest run tests/teams tests/api/teams.test.ts tests/api/teams-e2e.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |

### 8.4 E01–E06

| 编号 | 原要求 | 状态 | 测试命令 | 证据 | 说明 |
| --- | --- | --- | --- | --- | --- |
| E01 | UI 发起普通委派，分别走 fresh/fork，给空闲成员跟进再关闭：独立调用与上下文摘要、成员轨迹、停止后无残留进程 | **PASS** | `npx vitest run tests/api/teams-e2e.test.ts tests/teams/integration-flow.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| E02 | 开启 Team，两个成员并行执行独立任务，互发消息，第三任务依赖两者验收：真并发时间线、消息与任务版本、提交和验收差异、主成员最终汇总 | **PASS** | `npx vitest run tests/api/teams-e2e.test.ts tests/teams/integration-flow.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| E03 | 在实际沙箱副本中生成两份无冲突修改，候选集成、测试、应用到临时源项目：基线/候选/发布哈希、工作区隔离检查、测试证据、源修改保留 | **PASS** | `npx vitest run tests/api/teams-e2e.test.ts tests/teams/integration-flow.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| E04 | 制造同文件冲突，再由用户修改源目录，UI 处理冲突并重新验证：无丢失更新、冲突展示、过期基线拒绝、解决与发布 journal | **PASS** | `npx vitest run tests/api/teams-e2e.test.ts tests/teams/integration-flow.test.ts` | [t-teams.txt](docs/features/evidence/integration-acceptance/logs/t-teams.txt) | — |
| E05 | 在消息提交、工具已执行未记结果、多文件发布中途分别杀进程；重启、对账、停止：各故障点运行记录、无重复副作用、unknown 可见、迟到结果无效 | **PARTIAL** | `npx vitest run tests/fault-injection` | [r12-fault-injection.txt](docs/features/evidence/integration-acceptance/logs/r12-fault-injection.txt) | 真实子进程 kill/重启已覆盖“工具效果已发生未入库”和“多文件发布首文件/用户后续编辑”；邮箱注入、根停止迟到、旧租约与配置丢失四类未完成。 |
| E06 | 当前可用 DeepSeek 经正式产品入口完成小型只读协作，刷新重连并查看总账：主成员与至少两子成员真实 provider request、独立上下文、一次同伴消息、依赖与验收、请求数/usage/估算费用 | **PASS** | `npx vitest run tests/api/teams-e2e.test.ts tests/teams/integration-flow.test.ts` | [e06-orchestrated-run.json](docs/features/evidence/e06-orchestrated-run.json) | — |

### 8.5 R01–R14

| 编号 | 原要求 | 状态 | 测试命令 | 证据 | 说明 |
| --- | --- | --- | --- | --- | --- |
| R01 | 恢复原始编号、核对统一提交和部署版本、修正文档矛盾：全部 | **PASS** | `npm run acceptance:check` | [manifest.json](docs/features/evidence/integration-acceptance/manifest.json) | 从 1a5c801 新建 fix/integration-acceptance；manifest 由原表生成并校验，R 卡入口在报告中。 |
| R02 | MCP 成员权限与执行身份交集，无越权副作用：T40、T41、T42；D40、D41、D53、D56、D60 | **PASS** | `npx vitest run tests/mcp/member-scope.test.ts` | [r02-mcp-scope.txt](docs/features/evidence/integration-acceptance/logs/r02-mcp-scope.txt) | ExecutionScope 注入、成员权限交集、MCP 发送前拒绝、旧代次/收紧权限拒绝与真实 fixture 零副作用测试。 |
| R03 | 补丁版本保护、共享 journal 和用户修改保护：D48–D55；V07 | **PARTIAL** | `npx vitest run tests/tools/change-protection.test.ts` | [r03-change-protection.txt](docs/features/evidence/integration-acceptance/logs/r03-change-protection.txt) | write/edit/patch 统一锁与版本复验、跨文件 journal、用户修改保护完成；Team 发布尚未复用同一变更服务。 |
| R04 | 受控出口、工作区网络和预览 HTTP/WebSocket 网关：D10–D12、D18；V01 | **PARTIAL** | `npx vitest run tests/previews`<br>`SANDBOX_INTEGRATION=1 npx vitest run tests/sandbox/preview-tunnel.docker.test.ts` | [r04-preview-gateway.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-gateway.txt)<br>[r04-preview-docker.txt](docs/features/evidence/integration-acceptance/logs/r04-preview-docker.txt) | 预览租约/宿主网关/HTTP+WS/TTL/恢复与真实 Docker 预览完成；独立 dev_preview 出口 profile 与完整网络负向矩阵未完成。 |
| R05 | 浏览器运行环境、缓存及成员网络隔离：D13–D19、D22、D23；V02 | **PARTIAL** | `npx vitest run tests/browser/environment.test.ts` | [r05-browser-environment.txt](docs/features/evidence/integration-acceptance/logs/r05-browser-environment.txt) | 专用缓存/profile/output 目录与 doctor/EPERM 诊断完成；浏览器仍为宿主进程，成员网络隔离未完成。 |
| R06 | 截图/文件引用导入媒体、图像入模投影：D20、D21、D24–D28；V02、V03 | **PASS** | `PLAYWRIGHT_MCP_LIVE=1 npx vitest run tests/mcp/browser-output.live.test.ts` | [r06-screenshot-live.txt](docs/features/evidence/integration-acceptance/logs/r06-screenshot-live.txt) | Playwright MCP 文件引用按受信输出目录校验→媒体资产→image block；含真实 headless Chrome 用例与负向路径测试。 |
| R07 | 核对视觉路由并做真实视觉闭环：V03、V08 | **PARTIAL** | `RUN_SMOKE=1 npx vitest run tests/smoke/live-vision.test.ts` | [r07-vision-smoke.txt](docs/features/evidence/integration-acceptance/logs/r07-vision-smoke.txt) | 真实 DeepSeek Flash S01–S03 通过并输出诊断；V08 产品闭环未执行。 |
| R08 | 配置真实搜索凭据并验收，不伪造数据：D32、D33、D36；V04 | **PARTIAL** | `npx vitest run tests/web` | [r08-search-contract.txt](docs/features/evidence/integration-acceptance/logs/r08-search-contract.txt) | Tavily 适配器/认证/401/429/超时/取消/来源规范化有本地 HTTP 测试；真实调用因无密钥 BLOCKED。 |
| R09 | 结构化提问的子成员汇总和恢复：D37–D41；V05 | **PARTIAL** | `npx vitest run tests/questions` | [r09-questions.txt](docs/features/evidence/integration-acceptance/logs/r09-questions.txt) | 子成员问题汇入根会话、成员/代次绑定、去重、旧代次拒绝、关闭取消、重启读取答案完成；中断 activation 的安全续跑未完成。 |
| R10 | 完整 LSP 适配与更新/取消/重连：D42–D47；V06 | **PASS** | `npx vitest run tests/semantic tests/tools/semantic-tools.test.ts` | [r10-lsp.txt](docs/features/evidence/integration-acceptance/logs/r10-lsp.txt) | 真实 typescript-language-server 适配、编码、诊断版本、取消、崩溃重连与文档重建；工具报告实际后端。 |
| R11 | 作业、预览、来源、差异与撤销 UI 及浏览器自动化：D57–D60；T54–T57；V01、V05、V07 | **PARTIAL** | `npx vitest run tests/web/dev-panel.test.ts`<br>`node --experimental-strip-types scripts/dev-panel-check.ts` | [dev-panel-check.json](docs/features/evidence/integration-acceptance/r11/dev-panel-check.json) | 开发面板（作业/预览/来源/差异/范围撤销）真实 Chrome 62/62 断言通过；Team 配置/委派/成员/@消息/任务/审批/冲突的浏览器全流程仍未在同一脚本中验收。 |
| R12 | 真实进程级恢复和迟到结果矩阵：E05；T18、T19、T27、T28、T49、T50；D08、D48–D50 | **PARTIAL** | `npx vitest run tests/fault-injection` | [r12-fault-injection.txt](docs/features/evidence/integration-acceptance/logs/r12-fault-injection.txt) | 真实子进程 kill/重启覆盖 3 类故障（工具效果、发布首文件、用户后续编辑）；邮箱/租约/迟到响应/配置丢失未完成。 |
| R13 | 双 Provider 契约与不兼容 fork 边界：T06、T08 | **PASS** | `npx vitest run tests/provider/protocol-contract.test.ts tests/teams/dual-provider.test.ts tests/teams/fork-protocol.test.ts` | [r13-providers.txt](docs/features/evidence/integration-acceptance/logs/r13-providers.txt) | 两套本地协议 fixture 覆盖编码/流式/工具回填/usage/错误/超时/取消；不可转换 fork 拒绝并要求 fresh。 |
| R14 | 资源收束、清理引用、迁移及最后部署验证：T59、T60；D09、D62–D64 | **PASS** | `npm run acceptance:check`<br>`npm run build`<br>`npm run migrate` | [r14-deploy.json](docs/features/evidence/integration-acceptance/r14-deploy.json) | — |
