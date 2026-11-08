# Eunoia

![Eunoia](docs/cover.png)

你好，我是 Eunoia。

期待与你相遇。

## 快速开始

```bash
npm install
cp .env.example .env       # 填 DEEPSEEK_API_KEY
npm run dev                # http://127.0.0.1:8787
```

需要 Node **>= 22.9**（类型擦除运行源码、`--env-file-if-exists` 和 `node:sqlite`）。
数据库是一个文件，默认 `data/eunoia.sqlite`，不需要 Docker 或 Postgres。Node 版本也写在
`.nvmrc` 里，`nvm use` 即可。

## 多模态（图片输入）

- 输入框可以选择、粘贴、拖入 JPEG / PNG / WebP，最多 5 张、单张 10 MB、合计
  20 MB；只发图片不写字也可以。SVG、GIF/动态 WebP、多页图、PDF、音视频不是视觉
  输入，会明确返回 415。
- 默认模型 `deepseek-v4-pro` 是纯文本路由；要发图片，请用输入框右侧的模型选择器
  切到 **DeepSeek Flash（可看图）**。图片是私有不可变资源，历史、重新生成和重启后
  都引用同一张原图；重新生成失败会保留旧回复。
- 图片 Token 与 HTTP body 预算分开计算，按实际发送的请求变体计；详见
  [ADR 031](docs/adr/031-multimodal.md) 与
  [验收矩阵](docs/multimodal-acceptance.md)。
- 备份：`npm run backup` 会同时复制数据库、媒体文件和 SHA-256 清单；
  `npm run backup:verify -- <backup-directory>` 校验恢复前的文件。过期草稿用
  `npm run cleanup:media` 清理。


## 模型轨迹与前缀缓存

- 稳定提示词、动态背景和模型实际回放轨迹分开管理。`MODEL_TRANSCRIPT_MODE=durable`
  会把用户内容、背景更新、分步助手回复、reasoning 与工具结果按顺序存进 SQLite，
  重启后继续同一阶段；压缩、重生、换模型或崩溃恢复建立显式新阶段。
- 背景按命名块比较：未变不追加、变化追加快照、清空发 tombstone；本轮资料只对当前
  回合生效。回放不执行工具，未知结果不自动重跑。
- `MODEL_TRANSCRIPT_MODE` 代码默认 `legacy`（升级安全），本部署在 `.env` 设为
  `durable`；回滚改回 legacy 并重启即可。详见
  [ADR 032](docs/adr/032-model-transcript-and-prefix-cache.md) 和
  [验收报告](docs/features/eunoia-模型轨迹与前缀缓存验收报告.md)。
- 离线对照：`npm run experiment:transcript`；真实调用需显式 `--live`，并有请求与
  Token 上限。结果写入 `docs/research/prefix-cache/experiments/`，不覆盖旧结果。

## 撤销一轮修改

- Agent 改完后，回复下方会出现 **撤销本轮**。第一次点击只是确认，第二次才执行。
- 它只恢复“仍然保持本轮结束时内容”的文件：本轮新增的删除、修改/删除的用修改前
  内容恢复；你在本轮之后手动改过、删过或重建过的文件会列为冲突，不会被覆盖。
- 命令造成的改动通过本轮第一条命令前的检查点恢复；检查点已被清理时会明确说明
  无法恢复，不会编造内容。
- 撤销只针对工作区文件，不撤销外部 MCP 调用（远端写操作没有通用逆操作），也不
  创建 Git 提交。设计与接口见 [ADR 036](docs/adr/036-user-code-undo.md)。

## 语义代码工具

- 新增 `find_definition`、`find_references`、`list_symbols`、`diagnostics`，使用
  TypeScript 语言服务，不是文本搜索：跨文件的定义、调用点、声明和类型错误都能定位。
- 只支持 TypeScript/JavaScript；其它语言会明确报不支持，不会用文本搜索冒充。
- 每次调用读取有界的工作区快照（最多 800 个文件 / 8 MiB），只读，不启动语言服务器
  进程。行列为 1-based，列按 Unicode 码点计数。设计与边界见
  [ADR 037](docs/adr/037-semantic-code-tools.md)。

## 开发工具（进程、浏览器、图片、联网、提问、补丁）

- **后台作业。** `process_start` 在沙箱里启动开发服务器/监视器并立即返回作业 ID；
  `process_read` 用字节游标读 stdout/stderr，`process_wait` 可取消，`process_stop`
  先终止进程组再核对。作业不是 Web 工作台终端，也不会在宿主执行。
- **预览。** `preview_start` 会探测容器内 HTTP 就绪；当前部署没有发布容器端口，所以
  明确返回“宿主地址不可用”，不会给你一个打不开的 localhost。
- **浏览器。** 运行 `npm run toolkit:setup` 查看 Playwright MCP 配置，运行
  `npm run toolkit:doctor` 检查依赖。浏览器工具通过 MCP 发现，不另注册同义原生工具；
  本地单用户需要在 `.env` 显式设置 `MCP_ALLOW_HOST_PROCESS=1`（不是沙箱）。
- **图片。** 让 Agent 直接 `read_image` 工作区里的 PNG/JPEG/WebP；图片经媒体管线入库，
  源文件之后被改不会改变历史资产。
- **联网。** `web_search` 需要独立的 `TAVILY_API_KEY`；没有密钥会明确报未配置。
  `web_fetch` 抓取公网正文，拒绝私有地址、登录页和 PDF，并支持 cursor 分页。
- **提问。** Agent 用 `ask_user_question` 暂停并询问需求；答案按字段校验后返回同一轮，
  不是权限批准。
- **补丁。** `apply_patch` 一次改多个文件，先全量预检；上下文不唯一会拒绝，失败会回滚。
- 验收状态与阻塞项见
  [开发工具补齐验收报告](docs/features/eunoia-开发工具补齐验收报告.md)。

## 外部服务（MCP）

- 顶部 **外部服务** 可以添加 stdio 或 Streamable HTTP 的 MCP 服务；默认没有任何
  服务，也不会自动连接。
- 工具发现、参数校验、权限、事件、上下文预算和模型轨迹与内置工具共用一条管线；
  模型看到的名字带 `mcp__服务__工具` 前缀。
- 写操作和未知副作用会在调用前暂停，等待你在聊天里或抽屉里批准；批准只对那一次
  动作有效，刷新页面不丢失。
- 图片结果会导入私有媒体库并按“每次模型请求”重新计算预算；音频/视频明确标注
  “未发送给模型”，不会假装已读取。
- 配置与认证详见 [docs/mcp](docs/mcp/README.md)，设计与验收见
  [ADR 033](docs/adr/033-mcp-host.md) 与 [验收报告](docs/mcp/acceptance.md)。

## 文档

- [项目文档目录](docs/README.md)
- [为什么做 Eunoia](docs/story.md)
- [ADR](docs/adr/)
- [当前环境](CURRENT_STACK.md)
- [变更记录](CHANGELOG.md)
