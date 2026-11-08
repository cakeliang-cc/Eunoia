# ADR 038：开发工具补齐——进程、浏览器、图片、联网、提问、语义、补丁与撤销

- 状态：已实施（部分验收项受环境阻塞，见验收报告）
- 日期：2026-11-08
- 关联：[实施清单](../plans/eunoia-开发工具补齐实施清单.md)、[选型研究](../research/tools/eunoia-开发工具现状与选型.md)、[验收报告](../features/eunoia-开发工具补齐验收报告.md)

## 背景

Eunoia 已有文件读写、一次性 `bash`、MCP Host、Team、媒体管线、checkpoint 和按轮撤销的基础。仍缺少：开发服务器预览、浏览器观察、工作区图片读取、联网搜索/正文、通用用户提问、可调用的代码语义、多文件补丁，以及把补丁纳入按轮撤销。

这些能力不能都做成“在 agent loop 里加一个工具名分支”。进程、预览、浏览器、联网、提问、语言服务、修改集各自有生命周期和清理规则，必须是领域服务；模型工具、Web API 和 UI 调用同一服务。

## 决策

### 1. 原生工具与 MCP 分工

| 能力 | 归属 | 理由 |
| --- | --- | --- |
| 进程/预览 | 原生，走沙箱 `ToolExecutor` | 复用路径、权限、cgroup 和审计；禁止宿主执行回退 |
| 浏览器 | Playwright MCP（锁定 `@playwright/mcp@0.0.80`） | 页面操作、截图、控制台和网络观察由上游维护；不注册同义原生工具 |
| 图片 | 原生 `read_image` | 必须走工作区路径守卫和私有媒体管线 |
| 搜索/网页 | 原生契约 + 可替换 Provider | Tavily 只是 SearchProvider；网页读取内置 HTTP 客户端 |
| 提问 | 原生服务 + SQLite + API/UI | 需求答案与权限批准是两件事 |
| 语义 | 原生 TypeScript LanguageService | 有界内存快照；不立即建全仓库索引 |
| 补丁 | 原生 `apply_patch` | 上下文匹配比行号更可靠；先预检后写 |
| 撤销 | 复用 ADR 036 变更集 | 增删改、移动都落在同一份证据上 |

### 2. 进程在容器里，控制面在服务里

`process_*` 不直接 `child_process`。它通过现有 `ToolExecutor` 在一个 detached 进程组里启动命令，把 pid、marker、stdout/stderr、exit code 放在容器内 `/tmp/eunoia-jobs/<id>`。每次状态查询都通过一次短命令读取这些文件：

- `kill -0` 且 `/proc/<pid>/cmdline` 含该作业目录 → `running`；
- 有 exit 文件 → `exited` + 退出码；
- 两者都没有 → `unknown`（容器重启/PID 复用），不补启动、不谎报失败。

启动返回作业句柄，不等待开发服务器退出。`process_read` 用字节游标读 append-only 日志；日志回绕时返回明确缺口。`process_stop` 先向进程组发 TERM，宽限后 KILL，再核对进程已消失。一次 `toolCallId` 只对应一个作业：同键同命令返回原作业，同键异命令返回冲突。

### 3. 预览需要端口发布，没发布就明说

沙箱默认 `network: none`，容器端口没有宿主映射。`preview_start` 会在容器内用 HTTP 探测就绪状态，但返回 `userUrl: null`，并写明“宿主地址不可用”。不把 `127.0.0.1:<port>` 冒充用户能打开的地址，也不让浏览器 MCP 把宿主 localhost 当容器服务。

### 4. 网页快照不可变

`web_fetch` 第一次请求后把正文、最终 URL、状态、时间、摘要写入 `web_documents`，返回的 cursor 编码 `(documentId, offset)`。后续 cursor 只读这份快照，页面在中途改版不会替换模型正在读的内容。SSRF 防护分两层：URL 字符串检查和连接时的 DNS 结果检查；每次重定向重新检查。登录页（含密码框的短页面）、PDF/图片、401/403/429 都有独立错误。

### 5. 搜索是独立计费的后端

Tavily 适配器只请求基础结果：`include_answer=false`、`include_raw_content=false`、`include_images=false`，最多 3 个 query、每个 5 条。密钥只放请求体并注册到脱敏器。未配置密钥时返回 `WEB_NOT_CONFIGURED`，不用空结果冒充成功。`billed: true` 如实记录这是外部计费调用。

### 6. 提问有独立生命周期

`ask_user_question` 写入 `user_questions`，生成 `pending` 状态和过期时间；UI 轮询后展示字段，答案按 schema 校验并原子地从 `pending` 改为 `answered`。等待中的工具在答案到达、取消、超时三种情况下分别结束。答案不是权限：批准仍然走 MCP/工具的审批通道。同一 `toolCallId` 重复提问是同一条；同键不同问题返回冲突。服务重启后 pending 问题仍可回答，但不会假装自动续跑原回合。

### 7. 补丁先证明再写

`apply_patch` 语法是 `*** Begin Patch` / `*** Add File` / `*** Update File`（可 `*** Move to`）/ `*** Delete File`。所有目标先读一遍并计算新内容；hunk 必须精确匹配，匹配多处直接拒绝。任意一步失败，已经写入/删除的文件用预检缓存回滚。写前调用 ADR 036 的 journal，因此补丁回合产生的增删改和移动都进入同一份变更集，撤销能恢复原文件、删除新增、还原移动。

### 8. 语义位置按 Unicode 码点

行列都是 1-based；列按 Unicode 码点计数，不按 UTF-16 单元。中文和 emoji 之前的位置不会偏移。语义项目只加载 TS/JS，有界 800 文件/8 MiB；lib 与 `@types/node` 从工具链读取。非 TS/JS 明确拒绝，不用文本搜索冒充。新增 `list_symbols` 返回声明种类和位置。

## 持久化（schema 14）

新增 `web_documents`、`dev_jobs`、`dev_previews`、`user_questions`。`dev_jobs` 的 `user_id`、`conversation_id`、`tool_call_id` 唯一索引是进程启动幂等键。迁移是增量的；版本号 14 避免与并行分支的 12/13 冲突。

## 已知边界

- 浏览器以宿主进程方式运行（`MCP_ALLOW_HOST_PROCESS=1`），`--isolated` 使用临时 profile；不是容器隔离。生产多租户部署需要独立浏览器容器。
- Playwright MCP 的截图以文件形式返回文本，尚未把文件自动导入媒体管线。
- Tavily 需要账号密钥；没有密钥时搜索是 BLOCKED，不是 PASS。
- 预览没有宿主端口映射；WebSocket/iframe/Cookie 隔离策略尚未实现。
- 语义工具目前用 TypeScript 编译器 LanguageService；`typescript-language-server` 已安装并纳入 doctor，但 LSP 适配器尚未接线。
