# 重构计划

由 spec §42（"建立渐进式 roadmap"）与 §43（"先记录到
`docs/REFACTORING_PLAN.md`"）所要求。在此之前它一直缺失；本文件就是那份文档。

spec 里有两条规则决定它怎么用，两条都是承重的：

- **§42：不要一次完成全部阶段。** 这是一份 roadmap，不是一个队列。某个阶段被写在这里，
  不等于承诺要建它。
- **§28：Start simple。** 下面每一项的规模划分都遵循这条：最小可用的版本先做，其余部分
  以明确的理由显式推迟。一个不经过大规模改动就无法启动的阶段，是应该被拆分的阶段，而
  不是应该被排期的阶段。

状态是诚实的，而不是愿望式的。凡是刻意没有建的东西，理由都写了下来，因为在一个仓库
里，"尚未"和"被遗忘"看起来一模一样。

---

## 项目相对 spec §42 的位置

| # | 阶段 | 状态 |
|---|---|---|
| 0 | 仓库审查 | ✅ `CURRENT_STACK.md`、ADR 001–005 |
| 1 | 参考集成 | ✅ 读了 hello-agents，没有照抄（§6–§11）；没有取用任何代码 |
| 2 | 架构稳定化 | ✅ 客户端/服务端边界，ADR 006 |
| 3 | Agent 核心 | ✅ 一个 agent，四个 lens，ADR 001 |
| 4 | 会话 / Session | ✅ 会话、消息、历史、命名 |
| 5 | 记忆 | ✅ 四层减去 preference（ADR 003）；写入策略；打分检索（ADR 007） |
| 6 | 上下文工程 | ✅ 自动记忆注入 + 风险（ADR 008）；relationship 与 narrative 块已组装（ADR 012） |
| 7 | INFP 人格 | ✅ 提示词文档（ADR 011），五条原则，四个 lens，已评测 |
| 8 | 关系 + 叙事 | ✅ 两者都已建成；narrative 的推迟与反转都在 ADR 012 里 |
| 9 | 工具 | ⏳ 六个中的三个（§26） |
| 10 | 评测 | ⏳ 30 个 case，§43 的 12 个维度中的 9 个 |
| 11 | 前端集成 | ⏳ web 客户端已交付（ADR 006）；mini-program adapter 按设计推迟 |
| 12 | 生产加固 | ❌ 未开始；阻塞项列在 `CHANGELOG.md` 里 |

---

## 评测维度（spec §43）

spec 列出了十二个，并说"第一阶段不要全部实现"。这张表记录的是哪些维度真的被测量了，
以及——更有用的——哪些没有。

| 维度 | 由什么测量 | 状态 |
|---|---|---|
| Personality Consistency | `persona_consistency`（2 个 case） | ✅ |
| Emotional Attunement | `emotional_attunement`（2） | ✅ |
| Value Clarification | `no_premature_solving`（3） | ✅ |
| Non-directiveness | `boundary`（3）、`question_discipline`（2） | ✅ |
| Gentle Challenge | `gentle_challenge`（2） | ✅ |
| Memory Accuracy | `memory`（3）、`no_fabricated_memory`（2） | ✅ |
| Memory Relevance | `tests/memory/` 里的预算与门控测试 | ✅（离线，不是一个 case） |
| Reality Grounding | `no_judgment`（2）——事实/解释之分 | ✅ |
| Response Helpfulness | `light_intent`（4） | ⏳ 部分 |
| Narrative Continuity | `narrative_continuity`（1） | ✅（一个 proxy，并且被当作 proxy 记录） |
| Relationship Continuity | `relationship_continuity`（1） | ✅ |
| Context Relevance | 检索测试，不是一个 case | ⏳ 部分 |

阶段 8 关闭了那两行 ❌，而它们按这个顺序关闭是有原因的：一个既没有 case、*也*没有
功能在背后的维度，不是套件里的缺口，而是产品里的缺口——即便它有 case，套件也看不见
它。这就是 `light_intent` 教出来的教训，也是这里两个 case 都在 relationship 块存在
之前就被写好并跑过一遍的原因——那条"之前"的回复就是功能确有必要的证据，它被引在
ADR 012 里。

`Narrative Continuity` 是 ✅，但附带的那句说明比这个勾更有价值：它唯一的检查匹配的是
"回指一个持续主题"的*形状*，而不是那个主题本身，这使它成为一个 proxy——而写它的过程
在一个下午里错了两次（一份列表漏掉了 `老家`，接着一份在*"梦里常回去"*里匹配到了
`回去`，在*"反复梦见同一个地方"*里匹配到了 `反复`）。这些模式现在命名的是主语，而
不是词。一个被重写两次的 proxy 不是一种测量，而这一行诚实的状态是"✅，薄"。

`Response Helpfulness` 被有意标为部分：四个 light-intent case 测的是"它是否给出了被
请求的东西"，而那只是 helpfulness 的三分之一。温暖无法被机械检查，也没有任何 case
假装它可以。

那四个 case 里有两个测得比它们看上去的要少。`light-04` 在 changelog 点名为它的失败的
那条回复上拿了干净的 1.00，因为为那条失败写下的检查并不包含那个短语——于是一整个类别
的头条缺陷本可以在套件全绿的情况下回来。修复之道不是加更多模式，而是加一个证伪器：
`tests/evaluation/cases.test.ts` 现在把那四条有记录的失败，拿去给本该抓住它们的检查
重放一遍，而删掉这些模式的变异会让它变红。case 数量是一个关于覆盖率的声明；那个块是
让这个声明可被检验的东西——这也是这一行停在 ⏳ 而不是 ✅ 的原因，因为一个现在能失败
的类别，和一个已经完整的类别，不是一回事。

---

## 阶段 8 — 关系 + 叙事

**缺口。** 产品的前提是长期陪伴——一个随时间认识你的陪伴者。如今这个陪伴者知道一个人
的*事实*（memories），对*关系*却一无所知：它分不出第一次对话和第两百次对话，所以它
无法用不同的方式迎接一个熟悉的人和一个陌生人，也看不到一个人正身处其中的那个故事。
§43 的那两个维度就是从这一点掉出来的。

**设计，最小可用的版本：**

- **关系状态是推导出来的，从不存储。** 需要的一切都已经在 schema 里：他们第一次说话
  的时间、有多少个会话和多少条消息、有多少条记忆。存一份副本需要一次 migration（§1），
  会与它所概括的那些行漂移，而且什么都换不来——推导只是一条聚合查询。
- **它被渲染进每一轮**，像被检索到的记忆一样，因为连续性不受相关性门控。问一句
  "认识你三个月，跟这一轮相关吗？"本身就是答案——而一个受相关性门控的块，恰恰会在它
  被需要的那一轮缺席，因为"你还记得我吗"不提及任何话题。
- **叙事是一个独立的、预算卡得很紧的块**，取自 `narrative` 类型的记忆。`narrative`
  已经作为一种记忆类型存在，标签也已经写好（你正在经历的）；缺的是：没有任何东西把它
  渲染成连续性，而不是把它当成又一条争夺检索槽位的事实。
  → **已建成，在经历推迟、然后反转之后。** 最初的决策建立在一次 run 上——模型通过
  `search_memory` 触及了主题；之后四次都没能复现，而成因是确定性的——主题与消息不
  共享任何词项，所以 `selectMemories` 在模型看到任何东西之前，就把它丢在了
  `minSimilarity` 上。一个相似度门无法交付一个每次浮现时说法都不同的主题。这个决策的
  两半都写在 [ADR 012](adr/012-relationship-and-narrative.md) 里。
- **三个工具被推迟**（`getUserProfile`、`getRelationship`、`getNarrative`，§26），理由
  记录在 ADR 012 中：当同样的内容每一轮都已经在提示词里时，工具就是多余的，而每多一个
  工具，就是模型挑错的一个新途径。等内容大到常驻不再划算时，它们就变成对的了——而这
  是一个测量结果，不是一个猜测。
- **两个评测 case**（`relationship_continuity`、`narrative_continuity`），按记录下来的
  规则先写。

**不在本阶段内：** 附带行为规则的 relationship *阶段*（一套无人校准过的阶段分类法）、
关系时间线 UI，以及把关系存成自己一张表的任何做法。

**状态：完成。** `src/session/relationship.ts` 与 `src/memory/narrative.ts`，两个 store
上都有 `historyStats`，两个块都串过 `buildInstructions` → `createCompanionAgent` →
`runTurn`，提示词文档里还有两条规则（`# 你们之间已经发生的事`、`# ta 正在经历的事`）。
完整推理，包括那次反转，见 [ADR 012](adr/012-relationship-and-narrative.md)。

## 阶段 9 — 工具

§26 中剩下的：`getUserProfile`、`getRelationship`、`getNarrative`。**不再被阶段 8 阻塞
——而是由它决定**：同样的内容每一轮都在提示词里，所以为它做一个工具，只是通往一个已经
到达的结果的第二条路径。`getUserProfile` 与 preference store 和语义记忆已经提供的
东西重复，所以它先需要的是一个论证，然后才是代码。

## 阶段 10 — 评测

除了阶段 8 的两个 case 之外没有变化：`Response Helpfulness` 想要的不止四个 case，而
judge model 仍然没有——每个检查都是机械的，这也是为什么语气没有被覆盖，而且是被明说
没有覆盖的。

## 阶段 12 — 生产加固

三个阻塞项里还剩两个，而它们正是需要这个项目所没有的东西的那两个：**身份是 handle
而不是认证**（ADR 009）需要真正的 auth，**没有限流**需要先决定用户是谁、他们可以花掉
什么。

第三个——**没有 retention sweep，于是评测 run 攒下了一堆用完即弃的用户**——由
[ADR 013](adr/013-retention-and-deletion.md) 关闭。当问题被重新表述为"一次 sweep 有权
触碰哪些行"，而不是"我们怎么识别一个评测用户"时，它就变成了可以在项目内部建出来的
东西：`users.external_id` 正是在第一个 migration 里为此声明的，且从未被写入。缺口的
度量在 ADR 里——仅评测 run 就产生了 589 个用户、355 个会话、512 条消息。

值得留下的那个教训，是这计划自己的措辞所掩盖的那一个。本节曾写道，三者中没有一个
"can be closed without a decision the user has not made"，而这对其中两个成立，对第三个
则是一个错误的等式：retention 不需要任何决策，只需要一个 schema 里早就存在的标记。

**第四项更不显眼地留在清单上，如今已经做完：`npm run build` 曾是一条跑不起来的
script。** 它是已知问题，而不是阻塞项——开发中没有任何东西依赖它，因为 `npm run dev`
是通过 Node 的类型剥离直接跑源码的——而这恰恰是它在这个项目里一直待着的原因。
`tsconfig.build.json` 和 `scripts/copy-assets.ts` 关掉了它，而复制那一步正是这个已知
问题早已预言过的部分：`tsc` 不会输出提示词文档，而 `instructions.ts` 是相对自身解析
它的。

**仍然不是一次部署。** `npm run build && npm start` 产出一个能跑的 server，这与一个
你会放到人前的 server 不是一回事：上面两个阻塞项没有变，没有 CI 来跑构建，Docker 也
没有写。这次构建移走的是一个借口，而不是那些理由。

## 尚未排期的输入 —— 记忆的巩固与遗忘

**这不是一个阶段，也没有被排期。** §42 说这份文档是 roadmap 不是队列，而下面这条
正好是那句话在用的样子：它记录的是输入，不是承诺。

`docs/research/memory-storage.md` 是"别人怎么存记忆"的调研。**目前落在文件里的是图／
学术派那四个**（Zep / Graphiti、Cognee、MemoryBank、Generative Agents）；抽取式
（mem0 / LangMem / Memobase）、分层自编辑（Letta / MemoryOS / A-MEM）与厂商原生
（OpenAI / Anthropic / Gemini）三部分已经拿到，尚未并入同一文件。每一条结论指向一手
来源，来源没说的标「未验证」。它对着的是两件事，而不是一件事：

- **工作记忆的裁剪**（`CHANGELOG.md` → `Known Issues`）。`memory-04` 已经量出了
  固定 20 条窗口的失败；现在由 `SessionService` 的摘要检查点处理——原始 `messages`
  保留，模型读“摘要 + 最近原文”。这一项不再是待办。
- **记忆的衰减、晋升与驱逐。** 四层里的 `episodic` / `semantic` / `narrative` 目前只有
  `status` 这一个生命周期列，没有任何东西执行它。这一条没有 case，也没有失败的证据，
  因此它留在"输入"这一侧：**先有测量，再有实现**——这个顺序在本仓库里已经被
  `light_intent` 和 `narrative` 各验证过一次。

## 刻意不做的事

| 不做 | 理由 |
|---|---|
| Multi-agent、event bus、workflow engine | §28。一个带工具的 agent 就覆盖了这个产品。 |
| 第二个数据库、真正的向量存储 | ADR 004：在 embedding provider 存在之前，检索是词法的。相似度函数是注入的，所以替换只涉及一个函数。 |
| 把关系状态存进一张表 | 一条查询就能推导；为一份缓存做一次 migration。 |
| 一套关系阶段分类法 | 没有人校准过这些分档。先要事实，等有了证据支持时再要标签。 |
| 为其他任何东西做常驻块 | 现存的两个块是无条件的，因为一段关系和一条持续主题不是那种*会变得*相关的东西。门控对别的所有东西都是对的，而扩大无条件的那部分，正是提示词变成状态报告的方式。 |
| 一个针对反刍的运行时检测器 | `RUMINATION_SIGNALS` 曾为此存在，已被删除。`question-01` 在 `toolsCalled: []` 的情况下对那个行为打出 1.00，说明提示词里的 Te lens 已经做到了；关键词列表分不清一个循环和一个已经做出的决定；而安全之所以用机械方式强制，只是因为在那里漏一次的代价不可挽回，反刍不是。完整论证见 `CHANGELOG.md` → Changed。 |
| 重写记忆层 | §32（不做无关清理）、§34（没有计划不做破坏性重构）。 |
