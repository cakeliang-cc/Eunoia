# Eunoia — INFP 陪伴 Agent

一个从 0 到 1 长出来的长期陪伴 Agent。

它不是一个人畜无害的聊天机器人。这个产品的承诺更窄，也更难：
**一个 Agent，具备稳定的人格行为、长期个人记忆、情绪与价值澄清、叙事连续性、
受控的工具调用、可观测、可评测，以及一份持续更新的 changelog。**

一切通过 OpenAI Agents SDK 跑在 **DeepSeek** 上，不需要 OpenAI 账号。

---

## 缘起

这个产品的第一个用户是我自己。

我是一个 INFP，渴望自由，脑子里堆着很多不切实际的浪漫。这两样东西合在一起，让我在旅行时本能地不做攻略——不是懒，是抗拒。攻略会把一件本来还悬着的事变成一张清单，把「也许会遇见什么」提前兑换成「几点在哪里打卡」。我偏爱的是自然，是那种没有名字、也没打算被谁拍下来的地方。

后来我读到自己性格里的结构，才明白这份抗拒不是任性。Fi 关心的是「这感觉对不对」，Ne 要的是「还有没有别的可能」——而攻略恰恰是这两者的反面：它替你把所有可能性收拢成一条最优路径。本雅明写波德莱尔笔下的「游荡者」，说他在城市里没有目的地地走，而收获恰恰来自没有目的地。攻略是漫游的反面。可我还是得搜点什么，而搜出来的东西大多很重——信息重，人也重，期待的重量更重。它们服务的是「去过」，不是「在那儿」。我常常翻了半小时，最后关掉手机随便走走，那反而是整趟里最好的半天。

再后来，我遇见了许多和我一样的人。

在我人生的某个处境里，我在网上遇见了一群 INFP。原来「搜不到合适的东西」不是我的个人缺陷，是一整类人在同一件事上反复碰壁。那一刻我想，也许该有人专门为一类人做一个 AI，而不是做一个对所有人都勉强及格的通用助手。

于是我做了这个。

它现在还很单薄：一个单兵的 Agent，从旅行开始。git log顺便是自己的Agent学习之旅。
但我想让它去的地方不止旅行——吃食、生活、工作、看书、coding、 拍美丽的风景。
我想让它记住的也不只是「你去过哪」，而是你为什么在那里觉得舒服，为什么某个下午突然想换一条路。未来也许它不再是一个 Agent，而是一支 INFP Agent team，各守一块，又能彼此联动。

暂时只为 INFP。以后也许会扩到其他人格——但那是以后的事。我暂时不打算在还没真正懂一类人之前，假装懂所有人。

---

## 快速开始

```bash
npm install
cp .env.example .env       # 填 DEEPSEEK_API_KEY，并生成同一个 POSTGRES_PASSWORD / DATABASE_URL 密码
docker compose up -d       # Postgres 17 + pgvector，端口 5433，只绑 127.0.0.1
npm run migrate            # 应用 migrations/001_init.sql
npm run dev                # http://127.0.0.1:8787
```

`npm run dev` 会读取 `.env`。**默认必须连 Postgres**：没有 `DATABASE_URL`
时会退回内存 store，功能都是好的，只是重启后什么都不剩。这条退路是为了让
`npm test` 不需要容器，不是拿来真的用的。`/health` 会返回当前用的 store：

```json
{"status":"ok","store":"postgres","persistent":true,"single_user":true}
```

HTTP 默认只绑 `127.0.0.1`，Postgres 也只绑 `127.0.0.1:5433`。要远程访问，
先加认证；在只有单用户、没有登录的情况下，`HOST=0.0.0.0` 等于把整个记忆库
交给同网段的任何人。

启动前先设好密钥（写进 `.env` 或从 shell 继承）：

```bash
export DEEPSEEK_API_KEY=...        # 推荐
# 或者复用当前环境里已有的那个：
export ANTHROPIC_AUTH_TOKEN=...
```

见 `.env.example`。

## 单用户模式（当前默认）

还没有登录功能，所以开发时所有请求都属于同一个人：

```bash
# .env
SINGLE_USER_ID=00000000-0000-4000-8000-000000000001
```

设了它之后，cookie 不再决定身份。换浏览器、清 cookie、开隐私窗口，看到的都是
同一份历史和记忆；路由仍然传 `userId`，只是它对这个进程来说是常量。留空则退回
按 cookie 区分用户，测试和将来接登录时用。

这不是认证：它假设这台机器只有一个使用者。要放到别人能访问的地方之前，仍然需要
真正的登录和授权。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动服务（web 客户端在 `/`） |
| `npm test` | 离线测试套件——不需要网络，不需要容器，约 1.5 秒 |
| `npm run smoke` | 对 DeepSeek 的真实对话（需要 `RUN_SMOKE=1`） |
| `npm run eval` | 人格评测，真实调用；产出一份可重放的记录 |
| `npm run eval:replay` | 对最近一次记录重新打分，免费且即时 |
| `npm run cleanup` | 保留期清扫——用 `--dry-run` 先看它会删什么 |
| `npm run backup` | 用 `pg_dump` 备份到 `backups/`，并校验 dump 可读 |
| `npm run typecheck` / `npm run lint` | 另外两道门禁 |
| `npm run migrate` | 应用 migration |
| `npm run build` / `npm start` | 编译到 `dist/`，然后运行。日常开发用不到 |

`npm run build` 不属于日常循环：`npm run dev` 直接通过 Node 的类型擦除跑源码，
所以磁盘上的文件就是模型收到的文件。build 是为那种做不到这一点的部署准备的，
它会把 prompt 文档一并复制到编译产物旁边——`tsc` 对 `.md` 文件没有意见，
而 `src/agent/instructions.ts` 是相对自身解析 prompt 的。

Postgres 集成测试在没设 `DATABASE_URL` 时会自动跳过，因为一个需要容器的测试套件，
就是赶时间的人一定会跳过的那个：

```bash
DATABASE_URL='postgres://designfree:<password>@127.0.0.1:5433/designfree' npm test
```

备份：

```bash
npm run backup
# backups/designfree-<timestamp>.dump
```

备份文件在 `.gitignore` 里，不会进仓库；默认权限是 `600`。恢复前先确认
`pg_restore --list` 能读出它，再恢复到临时库验证，不要直接覆盖正在用的库。

## 架构

```
客户端（web/，以后是小程序）
        │  HTTP + SSE
        ▼
src/api/          ← 唯一感知 HTTP 的一层
        │  AsyncIterable<AgentEvent>
        ▼
src/service/      ← 一轮对话的编排：retrieve → assess → run → check → persist
        │
        ├── src/agent/         一个 Agent、它的 prompt、它的工具（ADR 001）
        ├── src/memory/        四层记忆、打分、写入策略、关系（ADR 003, 004, 007, 012）
        ├── src/safety/        风险检测、指令、输出检查（ADR 008）
        ├── src/db/            Store 接口 + Postgres 与内存两种实现
        └── src/evaluation/    用例、打分器、运行器、报告（ADR 004）
```

这条边界是**由测试强制**的，不是靠约定——核心里没有任何东西 import HTTP，
也没有任何产品逻辑层 import 厂商 SDK。写在 README 里的一句约定，
撑不过第一次赶工的提交。

核心只发出事件，从不发出响应。这正是让计划中的小程序迁移变成一次适配器改造、
而不是一次重写的原因（ADR 006）。

## 读代码前值得先知道的设计决定

| ADR | 决定 |
|---|---|
| [001](docs/adr/001-single-agent.md) | 一个 Agent。Fi/Ne/Si/Te 是它内部的几种视角，不是四个协作的 agent。 |
| [002](docs/adr/002-postgres-pgvector.md) | Postgres + pgvector，Docker 镜像锁版本，端口 5433。 |
| [003](docs/adr/003-memory-model.md) | 四层记忆；工作记忆**永不**落盘。 |
| [004](docs/adr/004-context-retrieval.md) | 打分且带预算的检索；embedding 推迟，藏在注入进来的相似度项背后。 |
| [005](docs/adr/005-agent-runtime.md) | OpenAI Agents SDK，跑在 DeepSeek 的 OpenAI 兼容接口上。 |
| [006](docs/adr/006-client-server-separation.md) | 核心发出事件；`src/api/` 独占 HTTP。 |
| [007](docs/adr/007-retrieval-gates.md) | 相关性由 `minSimilarity` 把关，不是 `minScore`；两条检索路径的宽度是故意不一样的。 |
| [008](docs/adr/008-safety-buffered-turns.md) | 危机轮次先缓冲、先机械检查，之后才渲染任何东西。 |
| [009](docs/adr/009-identity-handle-not-auth.md) | 身份是一个不可猜的 handle，明确**不是**认证。 |
| [010](docs/adr/010-reasoning-is-forwarded.md) | 模型的推理作为独立事件转发，不丢弃。 |
| [011](docs/adr/011-prompt-is-a-document.md) | 系统提示词是一份 markdown 文档（`src/agent/prompts/companion.md`）；只有它的拼装是代码。 |
| [012](docs/adr/012-relationship-and-narrative.md) | 关系状态由计数推导、每轮渲染；叙事主题不过相似度闸门，因为一个主题永远不会和谈论它的那句话共享词汇。记录了决定**和它的反转**。 |
| [013](docs/adr/013-retention-and-deletion.md) | 什么会留下、留多久，以及删除一个人意味着什么。`users.external_id` 是清扫唯一信任的标记。 |

其中几条值得在 README 里直说，因为它们出乎意料：

- **危机轮次不流式输出。** 它的回复会被扣住，直到通过一项机械的安全检查。
  已经渲染出去的 delta 收不回来，所以检查必须先发生。它的推理也一并被扣住。
- **两条检索路径的行为不同，是故意的。** 自动注入窄且有闸门；`search_memory`
  工具更宽且不过闸门，因为模型能判断一个候选，而自动路径不能。
- **推理阶段会抵达客户端。** 推理模型在吐出第一个字之前要想好几秒，当时的选项
  只有两个：把这段思考直播出来，或者给一个长时间的静态 `…`。见 ADR 010——
  并且注意，一个客户端完全可以忽略 `thinking_delta` 而仍然是对的。
- **系统提示词是一个 markdown 文件，不是代码。** 它是
  `src/agent/prompts/companion.md`，启动时读一次；`instructions.ts` 只决定它
  周围放什么。改这个伙伴的说话方式，就是改一份文档——而 `PROMPT_VERSION`
  哈希的是模型真正收到的那些字节，所以一次记录下来的评测可以归因到产生它的
  那份 prompt。见 ADR 011。
- **提示词是中文，但里面的标识符不是。** 模型**读到**的每个词都是中文，因为
  产品面向中文用户。工具名（`search_memory`）、它必须吐出的枚举值
  （`user_explicit`）、schema 字段名（`source`、`confidence`）保持英文，因为
  代码要拿它们做匹配，翻译一个就会弄坏一次工具调用。`Fi`/`Ne`/`Si`/`Te`
  也保持原样——它们是 spec 给这四种视角起的名字，就像 INFP 一样。

推理会显示成回复上方一块灰掉的区域，收起时带上它花了多久；展开可以看模型当时
在想什么。它是页边的批注，不是答案的一部分，这也是它为什么是一个独立事件，
而不是更多的 `text_delta`。

## 评测

13 个类别共 30 条用例，从 spec 的经典场景翻译而来——其中 24 条是艰难时刻，
4 条（`light_intent`）是普通回合，2 条关乎长期的连续性。这个切分在两个方向上
都是刻意的：一个只有艰难时刻的套件，会给一个用「你心里什么感受」回答
「周末去哪儿」的伙伴发合格证；而一个没有连续性用例的套件，看不见一个把陌生人
当老朋友打招呼的伙伴。打分在能机械化的地方就机械化（`src/evaluation/scorers.ts`
里的 `CheckKind`），出现禁止行为时是**报告出来**，而不是悄悄警告。

两条连续性用例都是靠同一种方式挣来自己的位置的：它们在被评判的功能**之前**
就被写出来并跑过，所以那份「之前」的回复是「这个功能当时确实需要」的证据，
而不是对它的描述。`relationship-01` 当时回答的是*"我这次打开时没检索到存下来的
东西"*——一份关于数据库查询的报告；而 `narrative-01` 是那次让一个推迟决定反转的
测量。见 [ADR 012](docs/adr/012-relationship-and-narrative.md)。

用例数量是一个关于覆盖面的声明，而这个声明只有在检查项**能失败**的时候才值钱。
它们并非都能：`light-04` 在 changelog 点名为它失败的那条回复上拿了满分 1.00，
因为为那次失败写的检查项里根本没有那个短语。现在
`tests/evaluation/cases.test.ts` 会把每一条被记录过的失败，重放进那个本该抓住
它的检查项——删掉那些 pattern，它就会变红，而这正是这套测试此前缺的那个性质。
见 `CHANGELOG.md` → `Fixed`。

```
npm run eval              # 真实调用；写入 evaluation/recorded/<prompt>-<time>.json
npm run eval:replay       # 对那份文件按当前检查项重新打分
```

对于记录覆盖到的用例，`--replay` 是免费的；没覆盖到的会在报告里被点名，而不是
悄悄拿去重新问模型。带过滤的运行（`--case`、`--category`）完全不记录：
`--replay` 取的是最新的那份文件，所以一份残缺的会变成基线。

记录是提交进仓库的：真实调用是贵的那一步，而它的产物是之后免费迭代检查项的
唯一途径。每个文件都记着它当时的 `promptVersion`，不匹配会大声报出来——
在 prompt 改过之后重放旧回复，什么也测不到。

基线在 `CHANGELOG.md` 的 `Evaluation` 一节。

## 隐私

- **日志里没有任何原始用户内容。** 任何进入日志行的东西，要么是一个类别标签，
  要么是一个指纹（`len=42`）。这是硬规则（spec §14），并且有一个测试断言：
  一次风险评估永远不包含被匹配到的文本。
- **记忆可见、可删。** `GET /api/memory` 支撑一个面板，显示系统相信了些什么；
  `PATCH` 和 `DELETE` 让人修正或删除它。软删除的行仍然是行，因为
  `memory_events` 和 `superseded_by` 指着它们——所以「已删除」是在读的时候
  过滤掉的，而不是在写的时候禁止的。
- **人可以抹掉自己。** `DELETE /api/me` 删除调用者和由他派生的一切；记忆抽屉
  把它藏在一个需要点两次的控件后面。每一张存放内容的表都级联，只有一个刻意的
  例外——`agent_runs` 活下来，owner 变成 null，因为一次运行是尺寸和哈希，
  是某个 prompt 版本做过什么的唯一记录。
- **评测跑完会清理自己**，`npm run cleanup` 清扫那些中途崩掉、没来得及清理的。
  清扫只能碰到 `users.external_id` 里带 `eval:` 标记的用户；真实账号没有这个
  标记，这正是它不需要确认就能安全运行的原因。这个标记够不到什么，见
  [ADR 013](docs/adr/013-retention-and-deletion.md)。
- **本地身份不是认证。** 见 ADR 009。暂时不要把真实数据放在它后面。

## 状态

Phase 0–5 已完成，Phase 8 里关系/叙事的那一半也已完成。剩下的都记录在案，
而不是靠暗示；其中要紧的两个是生产环境的堵点而不是功能：**身份是一个 handle
而不是认证**（ADR 009），以及**没有限流**。这两个都需要一个这个仓库自己下不了的
决心。完整路线图、以及每件事**不做**的理由在 `docs/REFACTORING_PLAN.md`；
各阶段的门禁在 `docs/implementation-plan.md`；已验证的环境在 `CURRENT_STACK.md`。
