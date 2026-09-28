# 实施计划

源自 spec §18（Implementation Phases），并按已被验证的环境做了调整。每个阶段都以一道
**验证门**收尾：只有代码可编译、lint 通过、测试通过、CHANGELOG 已更新（spec §19），
该阶段才算完成。

**阶段 0–4 已完成。阶段 5 进行中。** 各阶段实际交付了什么、它的验证门抓住了哪些 bug，
见 `CHANGELOG.md`。

---

## 已锁定的决策

| # | 决策 | 选择 | ADR |
|---|---|---|---|
| D1 | 数据库 | PostgreSQL + pgvector，Docker（`pgvector/pgvector:pg17`），端口 5433 | [002](adr/002-postgres-pgvector.md) |
| D2 | Embeddings | 先做打分（`w_s = 0`）；`embedding` 列与扩展在 migration 1 中创建；之后再回填 | [004](adr/004-context-retrieval.md) |
| D3 | Agent 运行时 | 在 DeepSeek 的 OpenAI 兼容接口（Responses API）上使用 OpenAI Agents SDK。不需要 OpenAI 账号 | [005](adr/005-agent-runtime.md) |
| D4 | 客户端/服务端边界 | Core 产出 `AsyncIterable<AgentEvent>`；`src/api/` 负责 HTTP/SSE；边界由测试强制。先交付 web，mini-program 稍后 | [006](adr/006-client-server-separation.md) |
| D5 | 检索门控 | `minSimilarity` 是相关性门；`minScore` 是保底的下限。两条检索路径的宽度不同，是有意为之 | [007](adr/007-retrieval-gates.md) |
| D6 | 危机处理 | 危机轮次先被缓冲，并在任何内容渲染之前接受机械检查；检查不通过则替换为固定文本 | [008](adr/008-safety-buffered-turns.md) |
| D7 | 身份 | 服务端生成的、不可猜的 UUID handle。明确不是认证 | [009](adr/009-identity-handle-not-auth.md) |
| D8 | 推理阶段 | 以 `thinking_delta`/`thinking_done` 转发；模型的 reasoning effort 保持默认值 | [010](adr/010-reasoning-is-forwarded.md) |
| D9 | 提示词来源 | system prompt 是一份在启动时读取的文档；过去用来渲染它的那套策略，如今是一份清单，该文档要对着这份清单接受测试 | [011](adr/011-prompt-is-a-document.md) |

## 需要用户行动的阻塞项

无。阶段 0 列出的三个阻塞项都已解决：Docker daemon 正在运行，Postgres 17.11 +
pgvector 0.8.6 已就绪，git 身份也已配置（`cakeliang-cc <xxwwliang@gmail.com>`）。

**仍有一个阻塞项无法在项目内部解决：** 没有 embedding provider（ADR 004，重新探测
过，结论未变）。在它出现之前，检索跑在词法相似度上；相似度函数是注入的，因此替换只
涉及一个函数。

---

## 阶段 0 — 侦察 ✅ 完成

- `CURRENT_STACK.md` 已撰写；环境与端点以实证方式探测。
- `CHANGELOG.md` 已创建。
- ADR 001–005 已撰写。
- **验证门通过：** 发现三处架构冲突并上报，而不是默默解决；未写任何代码（spec §23）。

## 阶段 1 — 最小 agent ✅ 完成（2026-09-28）

**目标：** 一条用户消息端到端地产出 INFP 陪伴者的回复。

**验证门结果：** typecheck、lint 和 35 个离线测试全部通过；针对 DeepSeek 的 live smoke
test 流式返回真实回复；tracing 输出的 span 层级中，内容带有指纹；SSE 已在真实 HTTP 上
验证。

两个 bug 是被 live test 发现并修复的，而不是靠推理发现的——SDK 重命名了 provider 的
text-delta 事件，以及 run 还没完成就读取了最终输出。两者现在都被测试钉住。值得注意的
一点：前者产生的回复*看起来*正确，而流式已经完全坏掉，而这正是只有端到端运行才能抓住
的那一类故障。

## 阶段 2 — 记忆 ✅ 完成（2026-09-28）

**目标：** §4 的四层记忆、§6 的检索、§7 的写入策略。

**验证门结果：** §18 的全部五项记忆要求都通过测试——显式偏好被记住；不相关的记忆
*不会*被注入；相关的会被注入；推测不被存储；记忆可更新。预算上限是被断言出来的，而
不是被信任的，其中包括一个断言检索永远不会返回全部内容的测试。Postgres store 针对
真实数据库通过了 19 个集成测试。

已交付：`docker-compose.yml`、`migrations/001_init.sql`（完整 schema）、
`src/db/{pool,migrate,postgres-store,in-memory-store}.ts`、
`src/memory/{types,store,retrieval,writer,render,working-memory}.ts`、
`src/tools/memory-tools.ts` + `src/agent/tools.ts`、
`src/service/{chat,context}.ts`。

实现期间学到两件事，它们后来成了 ADR 007：分数下限无法表达相关性，而两条检索路径想要
的取舍正好相反。

## 阶段 3 — 人格评测 ✅ 完成（2026-09-28）

**目标：** §13 的框架、≥20 个 case（§18），覆盖 §12 的标准场景。

**验证门结果：** 24 个 case 覆盖全部 10 个类别，§12 的七个标准场景全都在场，baseline
已记录——

```
evaluation live · prompt 54af13d10076 · deepseek-v4-pro
24/24 passed · mean score 0.945 · 0 violation(s)
```

禁止行为的违规被报告为**失败**，而不是警告。case 的完整性本身也是被测的（id 唯一、
类别已覆盖、每个 regex 都能编译、每个具名的 tool 都存在），因此一个格式错误的 case
会让套件失败，而不是悄无声息地永不触发。

**这道验证门在一个真实 bug 被误当成合格成绩之前就抓住了它：** `npm run eval` 完全
跑不起来——CLI 从未安装 model provider，24 个 case 全部失败，报出的信息读起来像是
API key 有问题。

## 阶段 4 — 安全 ✅ 完成（2026-09-28）

**目标：** §10——是陪伴者，不是治疗师；安全优先于人格。

**验证门结果：** 三个 safety case 都路由到安全行为，而不是反思式提问（`crisis`、
`crisis`、`elevated`），而且没有一个用上兜底——模型自己的回复通过了检查。测试断言
INFP 人格**不能**覆盖安全响应：指令用自己的话说明了这一点（"安全优先于人格设定"、
"让位"），而这段文本是被断言的。

**这道验证门发现了四个真实的检测缺口和一个输出检查缺口**，每一个都是靠测试人实际
怎么写、而不是靠想象模式该是什么样发现的：`活着没什么意思了`、`割了自己一下`、
`killing myself`、`他在家里打我`，以及那条打了折扣的 `你可能得了抑郁症`。五个都已
修复并被钉住。

## 阶段 5 — 产品打磨 ⏳ 进行中（2026-09-28）

**目标：** UI、记忆可见性、用户可控的记忆、对话历史、反馈采集、延迟优化。按设计
推迟——spec §18。

已交付：`src/api/identity.ts`（ADR 009）；由 `GET /api/memory` 支撑的记忆面板，支持
逐条 `PATCH`/`DELETE`，操作者记录为 `user`；一个记忆开关，关闭时被兑现为*不查阅*，而
不是查阅后隐藏；反馈采集（upsert）；会话列表与消息历史端点；带记忆抽屉的流式 web
客户端；`README.md`。API 层在真实 HTTP 上通过 30 个测试，包括 SSE 分帧与 abort。

延迟方面的工作暂且做完：等待不是模型造成的，而是一个被丢弃的事件流造成的（ADR 010）；
把推理过程转发出去，让 time-to-first-frame 从 17.83s 降到 1.22s，且没有动模型的任何
设置。

提示词被完全改为中文（spec §11），随后按 §20 要求跑的评测 run **发现的缺陷在评测里，
而不在提示词里**——机械检查无法区分一条*提到*违禁短语的回复和一条*使用*了它的回复，
因而误判了两条正确的回复。新的 baseline 是 24/24，均值 **0.958**，0 违规，位于
`prompt e9eb3bc57a41`。在相信一次全绿的 run 之前，这段细节值得一读：`CHANGELOG.md`
→ Evaluation。

**人格设定能处理 light intents**（2026-09-29）。由用户在 2026-09-28 提出，并推迟到
之后的一次变更；按记录下来的顺序完成——先补四个 `light_intent` case，再改提示词——
因为一个没有任何 case 看得见的提示词改动，就是没有任何东西在验证的改动。这不是一个
小修复：用旧提示词对着新 case 测量，四个 light 轮次拿到的回答都是对对方内心状态的询
问，没有一个给出被请求的东西。成因在文档里（六个示例全是艰难时刻；一句没有限定范围的
"不替用户做决定"），所以修复也在文档里。新的 baseline 在 `prompt 1e0d7fcd97a2`；前后
对比与残留差距见 `CHANGELOG.md` → Evaluation。

**陪伴者知道自己认识你多久了**（2026-09-29）。这是 `docs/REFACTORING_PLAN.md` 里
阶段 8 的关系那一半，补上了两个 §43 维度——它们此前既没有 case，也没有功能在背后。
触发点是被测量出来的，不是被假设的：在没有历史记录的情况下问*"我们之前聊过吧？"*，
陪伴者用一份关于数据库查询的报告作答，因为在检索是它唯一工具的情况下，一个关于关系
的问题只能被读成一个检索问题。`src/memory/relationship.ts` 从已经存在的计数里推导出
这个状态，并把它渲染进每一轮——刻意不做相关性门控，因为一个带门控的块恰恰会在需要它
的那一轮缺席。

**叙事那一半走的是另一个方向，而且走了两次。** [ADR 012](adr/012-relationship-and-narrative.md)
的第一版仅凭一个观察就把它推迟了——模型自己通过 `search_memory` 触及了一个持续主题。
之后的四次 run 都没能复现，而机制最终被证明是确定性的：主题和消息不共享任何词项，所以
相似度门在模型看到它之前就把这条记忆丢了（`selected 0, dropped {below_min_similarity: 1}`）。
`src/memory/narrative.ts` 就是计划提议的那个块，它是在证据支持它之后才建的，而不是跟
关系那一块在同一轮里建的。**这次反转记录在 ADR 里**，而不只是记了结果——有意思的地方
在于，第一个决策的证据有多薄。

剩余：

- 首次真实使用所提示的任何其他事项。
- mini-program adapter 还没开始——按设计它属于更靠后的阶段（ADR 006）。

**一个不可能失败的检查只是装饰**（2026-09-29）。`no-therapy-probe` 被记录为"从四条
真实失败回复改写而来"，而它匹配不上记录引作该证据的任何一个短语——于是 `light-04`
在它本就是为了抓住的那条回复上拿到了干净的 1.00。这是通过把被引用的回复喂给真正的
打分器、而不是去读模式列表发现的。该列表现在是一个共享常量，里面装着观察到的说法，
两条失败都被判为违规，并且 `tests/evaluation/cases.test.ts` 新增了一个
`the checks do what they claim` 块，把每一个有记录的失败都拿给本该看见它的检查重放
一遍。删掉这些模式会让它的测试变红——是验证过的，不是假设的。

**Spec §44 的 `retention` 与 `deletion` 背后什么都没有**（2026-09-29），而这个缺口
自阶段 2 起就以已知问题的形式躺在 `CHANGELOG.md` 里：评测 run 会积累用完即弃的用户，
而没有任何东西删除它们。dev 数据库让它的规模变得具体——**589 个用户、355 个会话、
512 条消息**，基本上全是评测残留，其中没有一条能被项目里的任何代码删除。已由
[ADR 013](adr/013-retention-and-deletion.md) 关闭：`users.external_id` 在第一个
migration 中为稳定的外部身份而声明、却从未被任何东西写入，现在它是评测 run 留下的
标记；一次 run 按 id 删掉自己的用户，`npm run cleanup` 清扫其余部分，它的时间窗口
之所以存在，是为了避免与还在飞行中的 run 抢跑。`DELETE /api/me` 和抽屉里的两步点击
控件关掉了面向人的那一半。诚实的限度写在 ADR 里：早于这个标记的 587 行无法与真实账号
区分，被刻意留在原处。

**用错了列，两次。** 第一次尝试让评测用户可以被 grep 到时，把 case id 塞进了
`users.id`，结果在针对 Postgres 的第一次 insert 就失败了，因为那一列是 `uuid`，而
in-memory store 接受任意字符串——所以任何离线测试都不可能抓住它。第二次，标记进了那个
一直等在那里、为它准备好的 `text` 列。

**`npm run build` 曾是一条跑不起来的命令**（2026-09-29）。它自阶段 1 起就被记为已知
问题，而不是留着被人发现，而那条记录做了已知问题能做的一件有用的事：它提前点出了
陷阱。`tsc` 不会输出提示词文档，`instructions.ts` 又是相对自身解析它的，所以天真的
`tsconfig.build.json` 会产出一个能成功的构建，和一个在第一轮就抛错的 server。
`scripts/copy-assets.ts` 遍历 `src/`，找出 `tsc` 不会产出的东西，而让这件事持续成立
的两个事实——配置会产出、资产会落在代码要去找的位置——由
`tests/architecture/build.test.ts` 针对 `PROMPT_FILE`（而不是某个硬编码路径）钉住。
这道验证门是一次真实的构建 **run**：产出的 server、live Postgres、与开发服务器相同的
`prompt_version`、一个流式轮次，以及 `DELETE /api/me`。在套件里跑 `tsc` 会让套件耗时
翻倍，而这件事一年才变两次；这个选择的诚实代价是：构建坏掉由人发现，而不是由 CI
发现，而目前还没有 CI。

**另一个方向结果更糟。** 为了区分抖动与回归，在*同一个*提示词上做的第二次 live run
发现，`relationship-01` **被它自己的检查在一条正确的回复上判为失败**：`no-diagnosis`
里列了裸名词 `你的记忆`，于是匹配上了*"我这边还没有关于你的记忆"*——而这正是该 case
存在的意义所在，奖励这种诚实的初次见面回答。一个永不触发的检查是一个缺口；一个在正确
回复上触发的检查则是对产品的谎言，而读到它之后的自然反应，是去改动本来就正确的行为。
那个名词被删掉了，也没有发明替代品——这个块现在也把那条回复钉住，所以重新加回这个
模式会让套件失败。

---

## 跨领域规则

- **CHANGELOG 与代码在同一次变更里更新**——绝不事后补写（spec §20，反模式 8）。
- **没有评测 run 就不改提示词**（反模式 7）。`PROMPT_VERSION` 是稳定指令的哈希，所以
  提示词改动在 run 历史里是可见的——可见，而不是被阻止。规则仍然是规则。哈希取自被
  加载的那份文档，而不是某个常量，因此这个版本描述的是发给模型的那串字节，而不是它们
  的副本（ADR 011）。
- **提示词是一份文档**（`src/agent/prompts/companion.md`），在启动时读取。编辑陪伴者
  的声音就是编辑 markdown；把散文写回 loader 里是一个测试失败
  （`tests/architecture/prompt-source.test.ts`）。
- 每次 schema 变更一个 migration；已应用的 migration 不可变（ADR 002）。
- 检索相关的改动必须让预算上限测试保持绿色。
- **只有 composition root 可以安装 model provider**，由
  `tests/architecture/boundaries.test.ts` 双向强制：其他任何地方都不可以，而每一个
  composition root 都必须。

## 截至 [Unreleased] 的测试套件

| 套件 | 数量 | 依赖 |
|---|---|---|
| 离线（`npm test`） | 490 通过，36 跳过 | 无 |
| Postgres（`tests/db/`） | 32 | `DATABASE_URL` |
| Live smoke（`npm run smoke`） | 4 | `RUN_SMOKE=1` + credential |
| Evaluation（`npm run eval`） | 30 个 case，均值 0.966–0.969（同一提示词下的两次采样） | credential |

离线套件是每次改动都会跑的那一套：无网络、无容器，约 1.5 秒。一切需要外部世界的东西
都会自行跳过，这是一个刻意的取舍——一套需要容器的套件，就是一套会被赶时间的人跳过的
套件，所以*唯一*被稳定执行的测试，是那些什么都不需要的测试。
