# CURRENT_STACK.md

Phase 0 侦察输出。以下所有结论，都在 2026-09-28 通过探测本地机器与已配置的模型端点
得到验证。此处没有任何假设。

> **更新 —— 2026-09-28，0.2.0 之后。** 本文档作为侦察记录保留，而不是被重写，
> 这样产生该架构的推理过程就仍然可审计。它点出的阻塞项中有三个现已解决：
>
> | 当时 | 现在 |
> |---|---|
> | Docker daemon 未运行 | **运行中**；`designfree-db` 已启动且健康 |
> | 无 Postgres 服务端 / pgvector | **已就绪** —— PostgreSQL 17.11 + pgvector 0.8.6，位于 `pgvector/pgvector:pg17`，宿主端口 **5433** |
> | 无 git 身份 | **已配置**（`cakeliang-cc <xxwwliang@gmail.com>`） |
>
> **仍然成立，而且是承重的：** 没有 embedding provider（已重新探测，没有变化）
> —— 因此 ADR 004/007 采用词法相似度。而端点的双模型命名空间也没有变化。
>
> 当前运行的技术栈是：Node 24.7 + TypeScript（原生类型擦除，开发期没有构建步骤）
> + 经 Docker 运行的 Postgres 17/pgvector + 跑在 DeepSeek 的 OpenAI 兼容接口上的
> OpenAI Agents SDK。`src/db/in-memory-store.ts` 仍作为无容器时的退路保留，
> 所以离线测试套件什么都不用装。
>
> **更晚，2026-09-29：** 「开发期没有构建步骤」仍然成立，并且现在为不是开发的那种
> 情形补了一个构建——`npm run build` 产出 `dist/`，`npm start` 运行它。在那之前
> 它只是一个跑不起来的脚本；见 `CHANGELOG.md` → Fixed。
>
> **更晚，2026-10-25：** 项目更名为 **Eunoia**，远程仓库在
> `github.com/cakeliang-cc/Eunoia`。**数据库标识没有跟着改**——容器、库、用户和
> 卷仍然叫 `designfree`，因为数据已经在里面；改它们是 dump/restore，不是重命名。

---

## 1. 当前技术栈

**不存在任何既有的技术栈。** 侦察时 `/Users/Zhuanz/Projects/designFree` 是空的
（没有文件、没有 `package.json`、没有 `.git`、没有配置）。这是一次 greenfield
构建，因此没有既有的基础设施可复用或需保护。

因此，「既有架构」与「可复用组件」两节为空，是事实使然，而不是遗漏。

### 已验证的本地工具链

| 工具 | 版本 | 状态 |
|---|---|---|
| Node.js | v24.7.0 | 可用 |
| npm | 11.5.1 | 可用 |
| TypeScript | — | 未安装（经由 `devDependencies` 引入） |
| Python | 3.13.5 (miniconda) | 可用 |
| PostgreSQL **客户端**（`libpq`） | 17.6 | 可用 |
| PostgreSQL **服务端** | — | ~~未安装~~ → **17.11，在 Docker 里，端口 5433** |
| pgvector | — | ~~未安装~~ → **0.8.6，扩展已安装** |
| Docker CLI | 28.3.3 | 已安装 |
| Docker daemon | — | ~~未运行~~ → **运行中** |
| git | — | 可用；~~无全局身份~~ → **已配置** |

被划掉的单元格是侦察时的状态，保留它们是为了让阻塞项的历史可读。箭头之后是
截至 0.2.0 的状态。

`psql` 指向 `/opt/homebrew/opt/libpq/bin/psql`。`libpq` 只是客户端库；本机不存在
`postgres` 服务端二进制（`which postgres` → 未找到），也不存在数据目录
（`/opt/homebrew/var/postgres*` → 无匹配）。`pg_isready` 在 `/tmp:5432` 上报告
无响应。

### 已验证的模型端点

环境中唯一可用的模型凭据是：

```
ANTHROPIC_BASE_URL = https://api.deepseek.com     (SET)
ANTHROPIC_AUTH_TOKEN = SET (35 chars)
ANTHROPIC_API_KEY   = unset
OPENAI_API_KEY      = unset
OPENAI_BASE_URL     = unset
DEEPSEEK_API_KEY    = unset
DATABASE_URL        = SET (postgres://designfree@127.0.0.1:5433/designfree; password in .env)
SINGLE_USER_ID      = SET (单用户模式，cookie 不再决定身份)
```

该端点是 DeepSeek，它**同时**暴露 OpenAI 兼容与 Anthropic 兼容的 API。
按 DeepSeek 的文档：

```
base_url (OpenAI)    = https://api.deepseek.com
base_url (Anthropic) = https://api.deepseek.com/anthropic
models               = deepseek-flash, deepseek-v4-pro
```

> **更正声明。** 本文档的早期修订曾得出结论：「该端点只暴露 Anthropic Messages
> API 接口」，并认为 OpenAI 格式的路由返回 404。**该结论是错的。** 它来自一次
> 探测，而那次探测落在端点返回瞬时 404 的窗口期内——同一窗口里 `/v1/models`
> 也返回 404，现在却是好的。OpenAI 路由存在且可用。关于这次更正及其后果，见
> `CHANGELOG.md` 与 ADR 005。这条教训被记录下来，是因为它塑造了一个决定：
> **单次观察不是发现；先重新探测，再下结论。**

### 已验证 —— OpenAI 兼容接口（`https://api.deepseek.com`）

| 能力 | 结果 |
|---|---|
| `POST /v1/chat/completions`（OpenAI 格式） | **可用** |
| 工具调用（`tools` + `tool_choice`） | **可用** —— `finish_reason: "tool_calls"`，`tool_calls[]` 结构良好，`arguments` 是 JSON 字符串 |
| SSE 流式（`stream: true`） | **可用** —— 标准的 `chat.completion.chunk` 增量，推理流另有 `delta.reasoning_content` |
| `GET /v1/models` | **可用** —— 权威的模型列表 |
| 稳定性（连续 8 次调用） | **8/8 HTTP 200** |
| 用量上报 | `prompt_tokens_details.cached_tokens`、`completion_tokens_details.reasoning_tokens`、`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |

### 已验证 —— Anthropic 兼容接口

| 能力 | 结果 |
|---|---|
| `POST $ANTHROPIC_BASE_URL/v1/messages` | **可用** |
| 扩展思考块 | **可用**（`type: "thinking"`） |
| 工具使用 | **可用**（`tool_use`，`input` 已解析） |
| SSE 流式 | **可用** |
| `POST /anthropic/v1/messages` | 空响应（可用的是裸主机路径） |

### 权威模型列表

只存在**两个**真实模型 ID。其余全都是别名：

| 模型 ID | 上下文 | 最大输出 | 输入 | 备注 |
|---|---|---|---|---|
| `deepseek-flash` | 1,048,576 | 393,216 | text, image | 快速档；别名 `deepseek-v4-flash`、`deepseek-chat`、`deepseek-reasoner` 都解析到这里 |
| `deepseek-v4-pro` | 1,048,576 | 393,216 | text | 更强的档位，仅文本 |

**未知**的模型名在 OpenAI 路由上返回 HTTP **400**（消息里给出受支持的名称），
但在 Anthropic 路由上返回 HTTP **404**。正是这种模型名不对就 404 的行为，
让最初那次误诊显得可信。

### 不可用 —— embeddings

| 能力 | 结果 |
|---|---|
| `POST /v1/embeddings` | HTTP 404 |
| `POST /embeddings` | HTTP 404 |
| `POST /v1/embed` | HTTP 404 |
| `/v1/models` 里的任何 embedding 模型 | 没有 |

这一项在上面的更正之后被重新探测，结论**仍然成立**：DeepSeek 不暴露 embeddings
端点，模型列表里也没有 embedding 模型。因此 ADR 004 推迟处理 embedding 的决定
不受影响。

---

## 2. 既有架构

无。Greenfield。

## 3. 可复用组件

仓库里没有。

*环境*里有两样东西可复用：

1. **DeepSeek 端点，经由它的 OpenAI 兼容接口** —— 已验证在 agent 设计所需的每一项
   能力上都可用：chat completions、工具调用、流式与思考。由于它使用 OpenAI 的接口
   格式，OpenAI Agents SDK 可以用自定义 `baseURL` 驱动它，这就在没有 OpenAI
   账号的情况下满足了 spec §8。
2. **Node 24 / npm 11** —— 足以支撑 spec 所指向的 TypeScript 技术栈。
3. **一份既有凭据** —— `ANTHROPIC_AUTH_TOKEN` 是一个可用的 DeepSeek API key。
   开始工作不需要签发新 key。

## 4. 缺失的组件

spec 里目标架构所要求的一切，具体是：

| spec 要求 | 状态 | 阻塞项 |
|---|---|---|
| TypeScript / Node 项目 | **已构建** | 无 |
| OpenAI Agents SDK 运行时 | **已构建** | 无 —— SDK 指向 DeepSeek 的 OpenAI 兼容 `baseURL` |
| PostgreSQL 服务端 | **运行中** —— 17.11，Docker，端口 5433 | 无 |
| pgvector 扩展 | **已安装** —— 0.8.6 | 无 |
| embedding provider | **缺失** | 端点上没有 embeddings 路由（已重新探测，结论成立） |
| 追踪 / 可观测性 | **已构建** —— 结构化 span 处理器 + 不含内容的应用日志 | 无 |

## 5. 潜在冲突

这些是 spec 推荐的架构（§0, §8, §5）与已验证现实之间的冲突。按 spec §22，
它们被记录下来，而不是被静默解决。

### 冲突 A —— 已解决：没有冲突。OpenAI Agents SDK 可用。

这个冲突是**被错误提出的**，现予撤回。

- **Spec（§8）：** "优先使用 OpenAI Agents SDK."
- **当时的判断：** 该端点没有 OpenAI 格式的路由，所以没有 OpenAI 账号就用不了
  SDK。这来自一次瞬时 404，是错的。
- **已验证的现实：** DeepSeek 在 `https://api.deepseek.com` 暴露 OpenAI 兼容
  API。`/v1/chat/completions` 可用，工具调用返回结构良好的 `tool_calls`，流式
  可用，连续 8 次调用 8/8 成功。
- **后果：** OpenAI Agents SDK **可以**使用，通过自定义 `baseURL` 指向 DeepSeek。
  spec §8 得到满足，模型是 DeepSeek，并且**不需要任何 OpenAI 凭据。** 这移除了
  此前被记录为 Blocker 1 的那一项。
- **对模型选择的残余影响：** 只存在两个模型 ID（`deepseek-flash`、
  `deepseek-v4-pro`），所以模型选择是二选一，而不是一个模型族。模型 ID 必须写成
  规范名称——别名（`deepseek-chat`、`deepseek-reasoner`、`deepseek-v4-flash`）
  会静默解析到 `deepseek-flash`，这会让一份 `deepseek-reasoner` 配置悄悄跑起
  错误的模型。

### 冲突 B —— PostgreSQL + pgvector 不能假定存在

**已解决。** Docker 已启动，数据库从一个锁定版本的镜像运行。

- **Spec（§5）：** 默认采用 PostgreSQL + pgvector。
- **侦察时的现实：** 没有服务端二进制，没有数据目录，Docker daemon 未运行。
- **解决方式：** `docker compose up -d` 带着 healthcheck 预置
  `pgvector/pgvector:pg17`。端口用 **5433**，不是 5432 —— 默认端口通常已经被
  占用，而端口冲突带来的失败令人困惑，不是干净的失败。
- **当初的影响评估是对的**，这也是它在 Phase 2 之前而不是之中被解决的原因：
  §4 的整套 memory 架构与 §6 的检索策略都落在这个数据库上。

### 冲突 C —— 没有用于语义检索的 embedding provider

- **Spec（§6, §13）：** 检索打分使用「语义相关性」（semantic relevance）；
  memory 表有一个 `embedding` 列；`memory_accuracy` / `memory_relevance` 是
  计分的评测维度。
- **现实：** 端点上没有 embeddings 路由（探测过的所有路径都是 404）。
- **影响：** 中等。检索仍然可以按 importance + recency + type + 词法重叠排序，
  但 spec 的向量相似度分量要么需要一个本地 embedding 模型，要么需要一个推迟的
  设计。

### 非冲突（已验证无问题）

- **语言/技术栈** —— 按 spec 用的是 TypeScript + Node；Node 24 已具备。
- **单 agent，无 multi-agent**（§8，反模式 4）—— 没有违反任何约束。
- **工具集** `search_memory` / `save_memory` / `update_memory`（§9）—— 工具使用
  已验证可用；这个窄工具集可以直接实现。
- **Guardrails**（§10）—— 可以在进程内实现；不需要厂商依赖。

## 6. 推荐的集成点

1. **模型访问** —— OpenAI Agents SDK，显式配置
   `AsyncOpenAI({ baseURL: "https://api.deepseek.com", apiKey: ... })`，并包在
   单一的 `ModelClient` 模块后面。把 provider 的构造收在一个文件里，这样 agent
   核心永远不会直接 import 厂商 SDK，端点变化时也不必碰 agent、memory 或评测
   代码。
2. **Agent 运行时** —— 一个 `INFPCompanionAgent`，使用 SDK 的 agent loop、
   工具分发与追踪。按 §8 与 ADR 001，只有一个 agent。
3. **持久化** —— Postgres。先引入 `MemoryStore` 接口并给出 Postgres 实现，
   这样临时换入一个嵌入式 store 时不必碰检索或写入策略代码。
4. **检索** —— `MemoryRetrieval` 消费一个打分函数，它的各个分量
   （importance、recency、type prior、similarity）可以逐个单独测试。similarity
   这一项是唯一受冲突 C 影响的部分。
5. **可观测性** —— SDK 追踪（spec §14）加上应用层的结构化日志。SDK 的追踪后端
   默认托管在 OpenAI；由于运行时现在指向 DeepSeek，追踪必须被刻意配置，而不能
   假定可用 —— 见 ADR 005。

---

## 已做出的决定（侦察时仍开放，现已与用户确定）

| # | 问题 | 结论 | ADR |
|---|---|---|---|
| D1 | Postgres 的准备方式 | Docker，`pgvector/pgvector:pg17`，锁定版本 | [002](docs/adr/002-postgres-pgvector.md) |
| D2 | Embeddings | 打分优先；`w_s = 0`；`embedding vector(384)` 列在 migration 1 里创建；之后再回填 | [004](docs/adr/004-context-retrieval.md) |
| D3 | Agent 运行时 | OpenAI Agents SDK，指向 DeepSeek 的 OpenAI 兼容 `baseURL`。**不需要 OpenAI 账号。** | [005](docs/adr/005-agent-runtime.md) |

### D3 的修订

D3 最初的答案是「在用户自备的 OpenAI key 上跑 OpenAI Agents SDK」，因为当时
得出了 DeepSeek 没有 OpenAI 格式路由的错误结论。经过上面的更正，D3 修订为：
同一个 SDK，端点已经提供的同样的模型，而且不需要新凭据。这严格优于原始 D3 和
手写循环这个备选，因此取代了二者。

### 当前的阻塞项

没有。三项 —— Docker daemon、Postgres 的准备、git 身份 —— 都已在 0.2.0 解决
（见文首的更新提示）。

唯一剩下的那条约束不是阻塞项，而是一条边界：**没有 embedding provider**，
所以检索跑在词法相似度上。那是一个决定（ADR 004），并且内置了退路
（一个注入进来的相似度函数），不是未完成的工作。

阶段计划见 `docs/implementation-plan.md`，每个阶段实际交付了什么见
`CHANGELOG.md`。
