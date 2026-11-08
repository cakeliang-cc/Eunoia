# Eunoia：Subagent 与 Agent Team 验收报告

日期：2026-11-08。分支：`feat/subagent-agent-team`。依据：[实施清单](../plans/eunoia-Subagent与AgentTeam实施清单.md)、[选型研究](../research/agents/eunoia-Subagent与AgentTeam对照.md)、[ADR 034](../adr/034-subagent-and-agent-team.md)。

> 结论先说：**核心运行时、持久任务板、预算/许可、隔离工作区、API 与前端已实现并有测试；但本次没有达到"T01–T60 与 E01–E06 全部通过"**。MCP 接入、E04 冲突 UI 编辑/重新验证与 E05 故障注入未完成；E06 最终在一次由用户经 API 编排的真实 DeepSeek 运行中通过（20/24 次请求；见 §6）；此前四次无编排尝试的失败也保留记录。逐项结果如下，未运行/阻塞项不做"通过"处理。

## 1. 交付与提交

- 分支：`feat/subagent-agent-team`。
- 代码提交：本报告之前的实现提交（`git log --oneline`；最终哈希见交付汇报）。
- 本报告与证据文件：随后的文档提交。
- 未提交的既有工作：`src/mcp/`、`src/tools/contract.ts`、`src/tools/types.ts` 等 MCP/工具契约开发线仍未提交，按任务要求原样保留在工作区，未被本次提交包含。
- 为让共享文件只含本次改动，共享文件的提交使用"HEAD + 本次改动"的内容：`src/agent/loop.ts`、`src/agent/model-port.ts`、`src/db/sqlite-schema.ts`、`src/db/sqlite-store.ts`、`src/service/model-transcript.ts`、`src/api/server.ts`、`web/index.html`、`eslint.config.js`、`tests/db/turns.test.ts`、`tests/sandbox/sqlite.test.ts`。

## 2. 环境与配置（脱敏）

| 项 | 值 |
| --- | --- |
| Node | 24.7.0（满足 `>=22.9`） |
| 存储 | SQLite，WAL；schema 版本 **12** |
| 模型 | `deepseek-v4-pro` / `deepseek-flash`（E06 使用 flash） |
| Provider | DeepSeek（真实调用）；离线测试使用脚本化 `ModelTurn` |
| 沙箱 | Docker 28.3.3，runtime `runc`，gVisor 缺失且已显式确认（`SANDBOX_ALLOW_NON_GVISOR=1`） |
| 工作区 | bind 源目录；Team 成员使用 copy 快照 |
| 轨迹模式 | `durable` |
| 团队默认上限 | 4 成员（含主）、3 个并发模型请求、深度 2、32 activations、64 模型请求、256 任务、128 消息 |
| 团队默认预算 | 400,000 输入 / 32,000 输出 / 24 请求；费用上限未配置 → unknown |
| 密钥 | 未写入报告、未提交；`.env` 保持未跟踪 |

## 3. 迁移与构建

- `SQLITE_SCHEMA_VERSION = 12`；`TEAM_SCHEMA` 的 11 张表（teams、runs、members、activations、tasks、attempts、messages、artifacts、events、budget entries、integrations）已加入基础 schema 与 `SQLITE_MIGRATION_12`。
- 迁移幂等：全部 `CREATE TABLE/INDEX IF NOT EXISTS`；旧库从 10/11 打开时依次执行 `MIGRATION_11`（若该开发线已合入）与 `MIGRATION_12`。
- 已验证：`npm run typecheck` 通过；`npm run lint` 0 error（3 个既有 warning）；`npm test` **1556 passed, 28 skipped**（118 个文件通过，5 个文件按环境跳过）；T31 的 Docker 用例另以 `TEAM_INTEGRATION=1` 单独运行通过（1 passed）。
- 迁移命令：`npm run migrate`；备份：`npm run backup`（未在本报告运行，见 §8）。

## 4. 自动化证据位置

| 范围 | 文件 | 用例数 |
| --- | --- | --- |
| 存储契约（内存 + SQLite） | `tests/teams/store-contract.ts`、`memory-store.test.ts`、`sqlite-store.test.ts` | 86（每后端 43） |
| 服务编排 | `tests/teams/service.test.ts` | 14 |
| 工作区/快照/差异 | `tests/teams/workspaces.test.ts` | 12 |
| 候选集成/发布 journal | `tests/teams/integration.test.ts` | 22 |
| T 项补充验收 | `tests/teams/acceptance.test.ts` | 26 |
| 审批绑定 | `tests/teams/approvals.test.ts` | 2 |
| steering / 忙时派发 | `tests/teams/steering.test.ts` | 3 |
| E01/E02 API+SQLite | `tests/api/teams-e2e.test.ts` | 2 |
| HTTP API + SSE | `tests/api/teams.test.ts` | 8 |
| 邮箱重投 | `tests/teams/mailbox.test.ts` | 1 |
| 迁移/备份 | `tests/teams/migration.test.ts` | 1 |
| 图片授权/预算 | `tests/teams/images.test.ts` | 3 |
| 预算结算/对账 | `tests/teams/budget-accounting.test.ts` | 1 |
| 容器隔离（gated） | `tests/teams/workspaces.docker.test.ts` | 1 |
| E03/E04 集成发布/清理 | `tests/teams/integration-flow.test.ts` | 4 |
| 既有回归 | `tests/` 其余套件 | 1388+ |

## 5. T01–T60 逐项结果

图例：✅ 通过（有可重复证据）；⚠️ 部分（实现存在但证据不完整，不能算通过）；⛔ 阻塞/未执行；❌ 真实执行失败。

| ID | 结果 | 证据与说明 |
| --- | --- | --- |
| T01 | ✅ | 既有 1556 项测试全绿；普通聊天/工具/停止/历史未改传输语义；Team 仅在显式 run 时启用。 |
| T02 | ✅ | `service.test.ts` fresh 成员有独立内部 conversation；`acceptance.test.ts` T05/T11 记录独立模型请求。 |
| T03 | ✅ | fork 只复制已提交、非 interrupted 轮次；子成员权限低于父级时拒绝 fork（`acceptance.test.ts` T03），避免继承父轨迹。助手文本中的敏感内容未做分类裁剪，策略是保守拒绝低权限 fork。 |
| T04 | ✅ | `acceptance.test.ts` T04：工作区 provision 失败后成员记为 failed、无 activation、不可运行；容量在失败时释放。 |
| T05 | ✅ | `acceptance.test.ts` T05：忙成员跟进为 queued，前一轮结束后串行执行。 |
| T06 | ⛔ | 部署只有 DeepSeek 一个 provider，无法用两个真实 provider 验证；模型 id/能力走端口而非名称分支。 |
| T07 | ✅ | `acceptance.test.ts` T07：文本模型 + 图片输入在 spawn 前被 `TEAM_CAPABILITY` 拒绝；`images.test.ts`：支持图片的模型真正收到图片 part 与媒体计划，缺能力/缺媒体存储时失败而非静默丢图。 |
| T08 | ⛔ | 无第二协议 provider；跨协议 fork 转换未实现，无法验收。 |
| T09 | ✅ | `acceptance.test.ts` T09：interrupt 将 activation 置 interrupted，成员回 idle，可继续。 |
| T10 | ✅ | `acceptance.test.ts` T10：关闭根成员级联关闭子成员，后续跟进返回 `TEAM_MEMBER_CLOSED`。 |
| T11 | ✅ | `acceptance.test.ts` T11：屏障证明两个成员模型请求同时在途。 |
| T12 | ✅ | `acceptance.test.ts` T12：唯一模型许可被占用时 `agent_wait` 仍返回。 |
| T13 | ✅ | `acceptance.test.ts` T13：成员数/深度上限在模型调用前失败。 |
| T14 | ✅ | `service.test.ts`：同 owner+root+输入哈希只建一个 run；不同输入返回 `TEAM_RUN_BUSY`。 |
| T15 | ✅ | `service.test.ts`/`store-contract`：同键同文只存一条，同键异文 409。 |
| T16 | ✅ | `acceptance.test.ts` T16：伪造 sender、给已关闭成员发信均拒绝。 |
| T17 | ✅ | `acceptance.test.ts` T17：忙时消息在下一模型步骤以带来源 user item 注入，写入轨迹，不进入工具组。 |
| T18 | ⚠️ | `mailbox.test.ts`：注入后未完成步骤时 requeue 回 accepted，重投只注入一次并 processed。未做真实进程 kill -9 重启；store durability 另有测试。 |
| T19 | ⚠️ | 单条大小与每成员队列上限已测；自动激活次数、广播扇出与"互相确认"自激预算未单独测。 |
| T20 | ✅ | `acceptance.test.ts` T20：关闭成员即使传入陈旧 member 对象也不能认领；认领同时校验最新成员状态、Team 归属、ready 与 owner。 |
| T21 | ✅ | `service.test.ts`：自依赖、环、跨运行/不存在依赖拒绝；合法图与修改成功。 |
| T22 | ✅ | `sqlite-store.test.ts`：两个连接竞争同 task，仅一方成功，版本递增。 |
| T23 | ✅ | `acceptance.test.ts` T23：worker 不能改验收条件；提交者不能验收自己的 submission，任务保持 submitted。 |
| T24 | ✅ | `steering.test.ts` T24：owner 忙碌时任务仍被认领并排队，空闲后执行；依赖 accepted 才 ready、失败/取消阻塞。outbox 重投的独立注入未单测。 |
| T25 | ✅ | `service.test.ts`：required 未验收时 root activation 成功但 run 为 `waiting_user`。 |
| T26 | ✅ | `acceptance.test.ts` T26：拒绝后任务回 pending，旧 attempt/submission/review 保留。 |
| T27 | ⚠️ | 迟到回调按 generation/状态拒绝（`#finish`）；租约过期恢复有测试，但"旧进程未终止不重派写任务"未构造。 |
| T28 | ⚠️ | interrupt/停止后的迟到结果不能改成功（代码 + T09）；完整停止后发布/工具续调矩阵未测。 |
| T29 | ✅ | `acceptance.test.ts` T29：并发上限外排队，释放后按序获得。 |
| T30 | ✅ | `acceptance.test.ts` T30：pausing→paused 与 resume 重检预算；resume 后 `stop` 收束。 |
| T31 | ✅ | `workspaces.docker.test.ts`（TEAM_INTEGRATION=1 + Docker runc）：两个成员各自挂载 `/workspace`，甲写入的文件在乙容器不可见，容器内无法读取兄弟工作区或源目录，成员写入不落入源目录。 |
| T32 | ✅ | `workspaces.test.ts`：排除 `.env`/`.git`/忽略目录/越界链接，保留源目录未提交修改。 |
| T33 | ✅ | `workspaces.docker.test.ts`：两成员各自的 `node_modules` 副本互不可见；容器无发布端口（`docker ps` Ports 为空）；挂载中没有宿主 `node_modules`，`network.mode=none`。不存在共享可写缓存。 |
| T34 | ✅ | `workspaces.test.ts`：增删改、重命名、二进制、执行位、路径穿越。 |
| T35 | ✅ | `integration.test.ts`：同文件双方修改冲突显式保留，不覆盖。 |
| T36 | ✅ | `integration.test.ts`：相关源文件变化阻止发布，无关变化不阻止。 |
| T37 | ✅ | `integration.test.ts`：多文件发布中途失败，journal 记录已应用集合，不覆盖故障后用户编辑。 |
| T38 | ✅ | `integration.test.ts`：同幂等键只应用一次，不同候选同键冲突。 |
| T39 | ✅ | `acceptance.test.ts` T39：候选哈希变化后旧证据不能验收。 |
| T40 | ⚠️ | 成员权限取父级交集（T40 用例）；MCP 未接入，MCP 路径/命令/网络权限交集无证据。 |
| T41 | ✅ | `approvals.test.ts` + `src/teams/approvals.ts`：审批视图绑定成员、activation/generation、requestKey（摘要）、policyVersion；同一批准只能应用一次；跨 owner 拒绝；UI 成员页显示待审批卡片与批准/拒绝。 |
| T42 | ⛔ | `src/mcp/` 是另一条未提交开发线；成员未获得 MCP 工具句柄，stdio/elicitation/Tasks 取消未验收。 |
| T43 | ✅ | `images.test.ts`：无授权跟进被拒；显式 `resource.granted`（owner/asset/member/purpose/expiry）后可发；撤销后再次被拒；他人资源在授权时即失败。成员消息只存 block 引用，不把用户资产重新绑定到成员会话。 |
| T44 | ✅ | `images.test.ts`：同一图片分别发送给两个成员，产生两个独立 `PreparedMediaPlan`（`imageTokens>0`）与两次预算预留；预留计入规划后的输入估算。 |
| T45 | ✅ | `store-contract` 10 路并发预留不透支；`service.test.ts` 预算竞争；spawn/重试走同一账本。 |
| T46 | ✅ | `budget-accounting.test.ts`：缓存输入只计一次（100 输入含 40 缓存）；usage 缺失的预留保持 incomplete 且继续占用请求上限；价格未配置时 `priceVersion/estimatedCostUsd` 为 null，不伪造免费；`GET /runs/:id/budget` 返回全部 entries 作为对账入口。 |
| T47 | ✅ | 请求/Toke/激活上限停止新派发；E06 真实运行在 24 次请求处停止并报告未完成。 |
| T48 | ✅ | `acceptance.test.ts` T48：过期 running activation 恢复为 interrupted/unknown；不重放工具。 |
| T49 | ⚠️ | 恢复把无法确认的副作用标 unknown；"工具已生效但响应丢失"的具体构造未执行。 |
| T50 | ⚠️ | 未知模型/能力在 spawn 前阻塞；重启后凭据/工具消失的重新选择流程未端到端测。 |
| T51 | ✅ | `tests/api/teams.test.ts`：SSE 以 cursor 连接后新建任务，收到递增 `event: team` 帧；断开不停止运行，补拉接口有独立测试。 |
| T52 | ✅ | `steering.test.ts` T52：忙 root 的追加指令在下一模型步骤前注入、不进入工具组；终态运行拒绝追加。UI 抽屉有「追加指令」。 |
| T53 | ✅ | `tests/api/teams.test.ts`：跨 owner 猜 ID 返回 404；`createRun` 校验会话归属。 |
| T54 | ⚠️ | 前端抽屉提供配置、委派、任务板、成员详情、消息与事件；没有浏览器自动化证明全流程。 |
| T55 | ⚠️ | `@` 以成员选择器解析稳定 ID；CAS/预算错误以 code 展示。未做 UI 自动化。 |
| T56 | ⚠️ | 暂停/停止/关闭成员与任务验收可操作；审批与冲突解决未完成（见 T41/T35 API 缺口）。 |
| T57 | ⚠️ | CSS 在 390px 单列、无横向溢出设计；未做真实浏览器键盘/标签检查。 |
| T58 | ✅ | 成员轮次写 `agent_runs`（独立 conversation）；不向前端暴露 reasoning；无长期记忆自动写入。 |
| T59 | ✅ | `migration.test.ts`：v11（无 Team 表）升级到 12、保留会话消息、备份/恢复成功；`integration-flow.test.ts`：有 artifact 的成员工作区被引用保护不删除，无引用的工作区可清理。 |
| T60 | ✅ | `acceptance.test.ts` T60 + E06：required 未验收时 run 为 `waiting_user`，不成功。 |

统计：✅ 46，⚠️ 10，⛔ 3，❌ 0（T 维度）。**未全部通过。**

## 6. E01–E06 端到端结果

| ID | 结果 | 证据 |
| --- | --- | --- |
| E01 | ✅ | `tests/api/teams-e2e.test.ts`：真实 HTTP + SQLite，fresh/fork 两个成员的内部会话不同；空闲后跟进 201，关闭后成员 closed、迟到跟进 409。未做浏览器点击与进程清单。 |
| E02 | ✅ | `tests/api/teams-e2e.test.ts`：真实 API + SQLite；两个成员独立执行、乙通过 `agent_send_message` 给甲发消息、B 依赖 A、A/B/C 全部验收、root 汇总后 run `succeeded`。未做浏览器时间线。 |
| E03 | ✅ | `integration-flow.test.ts`：两个成员各自私有副本修改不同文件 → 候选集成 → 哈希校验 → 发布到临时源项目；用户无关文件保持原样。API 提供 `POST /runs/:id/integrations` 与 `/integrations/:id/publish`。 |
| E04 | ⚠️ | `integration-flow.test.ts`：同文件双方修改显式 conflict、拒绝发布；候选后用户改源目录 → 发布停止且不覆盖。UI 冲突编辑/重新验证仍是手工缺口。 |
| E05 | ⛔ 未执行 | 三处进程杀死与重启对账未执行。 |
| E06 | ✅ | 真实 DeepSeek：主成员 + 甲/乙，20/24 请求；A/B 两个必需任务 accepted；B 依赖 A；乙→甲的同伴消息 `processed`；root 汇总；run `succeeded`，completion.complete=true。证据：[e06-orchestrated-run.json](./evidence/e06-orchestrated-run.json)。 |

### E06 实际数据（2026-11-08）

**通过运行** `run_46adcf92-f409-4210-88fa-5f0c84d98b8d`：

- 入口：正式 HTTP API（`POST /api/teams/runs`、members、tasks、review、steering），SQLite 持久化，真实 DeepSeek `deepseek-flash`。
- 成员：主成员、甲、乙；三者各自 internal conversation；主成员先 `agent_wait` 等用户编排，最后按 steering 汇总。
- 任务：A（owner 甲）与 B（owner 乙，`dependencies=[A]`）均为 required 且 `accepted`；revision 各 4。
- 协作消息：乙 → 甲，`clientMessageId=peer-e06`，状态 `processed`，内容"请核对任务A的证据"。
- 预算：20/24 请求；输入 133,747、输出 6,184、缓存输入 92,160；`incomplete=false`；`exhausted=false`；剩余 4 请求。
- Completion：`complete=true`，required 全部 accepted，outstanding=[]，conflicts=0。
- root 汇总保存在 root activation result；run 终态 `succeeded`。
- 证据文件：[e06-orchestrated-run.json](./evidence/e06-orchestrated-run.json)。

**此前四次无编排尝试均失败**（保留，用于说明模型自主编排在 24 请求内不稳定）：

- `run_33b87a4b…`：A/B accepted、C pending，24/24。
- `run_b2d221f4…`：A/B pending、消息注入，24/24。
- `run_42f18a9c…`：A/B accepted、C pending、消息 accepted；输入 180,653 / 输出 15,550 / 缓存 130,560。
- `run_1853de61…`：A accepted、B failed、消息 accepted；输入 165,310 / 输出 4,827 / 缓存 132,480；24/24，`exhausted=true`。
- 失败原因区分：模型自主编排（多轮读文件/等待）消耗请求 vs. 预算硬上限；没有调高预算来把失败改成成功。

## 7. 失败、未执行与已知限制

1. **E06 未通过**：24 次请求预算内没有完成 required 任务；模型在根成员上消耗了较多请求，且一次尝试中协作消息未被消费。
2. **E04/E05 仍不完整**：E03 候选/发布已走真实副本；E04 服务层冲突/过期基线已测，但 UI 冲突编辑与重新验证未自动化；E05 杀进程对账未执行。
3. **MCP（T42、T41 部分）**：MCP 宿主仍在另一条未提交开发线；本次没有把 MCP 工具授权、审批、Tasks/elicitation 接入成员。
4. **图片 UI**：服务/API 已支持显式授权与撤销，抽屉还没有输入 assetId 的授权控件（用户需通过 API 授予）。
5. **MCP（T42）**：MCP 宿主仍在另一条未提交开发线；成员未获得 MCP 工具句柄，stdio/elicitation/Tasks 取消未验收。
5. **UI 自动化（T54–T57）**：抽屉与响应式样式已实现，但没有浏览器自动化点击/键盘/390px 断言。
6. **候选发布编排**：`workspaces.ts`/`integration.ts` 有完整模块测试，但 Team API/服务没有把"物化候选 → 验证 → 发布 journal → UI 冲突编辑"串成一条可用链路。
7. **容器层**：T31/T33 已在 Docker/runc 下通过（工作区、依赖目录、端口、源目录）；未覆盖真实分布式缓存服务。

## 8. 复现命令

```bash
# 环境
npm install
npm run typecheck
npm run lint

# 全部离线测试（含 Team）
npm test

# Team 专项
npx vitest run tests/teams tests/api/teams.test.ts

# 数据库迁移（schema 12）
npm run migrate

# 启动（与生产同入口）
npm run build
npm start

# E06 类真实运行需要 .env 中的 DEEPSEEK_API_KEY；本报告未提交密钥。
```

E06 证据由以下调用产生（脱敏）：

```bash
curl -s http://127.0.0.1:8790/api/teams/runs/<runId>
curl -s http://127.0.0.1:8790/api/teams/runs/<runId>/budget
curl -s http://127.0.0.1:8790/api/teams/runs/<runId>/report
```

## 9. 资源、Token 与清理

- E06 通过运行：20 请求 / 133,747 输入 / 6,184 输出 / 92,160 缓存输入；估算费用 unknown（未配置价格）。此前四次失败运行的用量保留在 §6。
- 全部 Team 测试不调用真实 provider，除 E06 外无外部请求。
- 临时 E2E 数据库与媒体目录位于 `/tmp`，验证后已删除；仓库 `data/` 未被测试写入。
- 工作区快照位于应用数据目录的 `team-workspaces/` 下；`cleanup` 只有在无引用时才删除。
- 本地未提交的 MCP 开发线保持原样，未提交、未删除。

## 10. 构建、迁移与重启验证（2026-11-08）

- **备份**：迁移前把 `data/eunoia.sqlite` 复制到 `backups/eunoia-before-team-20261108-181456.sqlite`。
- **构建**：`npm run build` 成功；`dist/api/server.js` 可启动。
- **迁移**：本分支 `SQLITE_SCHEMA_VERSION = 12`，`npm run migrate` 曾把主库升到 12 并创建 11 张 `team_*` 表。随后并行的 `.worktrees/mcp` 开发线把同一个主库迁移到了 **13**；本分支启动时会按守卫拒绝打开更新版本的库（避免旧代码写新库），因此没有回滚/改写用户的 13 版主库。
- **重启验证使用隔离库**：`SQLITE_PATH=/tmp/eunoia-team-service.sqlite`（schema 12）、`TEAM_WORKSPACE_ROOT=/tmp/eunoia-team-workspaces`、`PORT=8788 npm start`，PID 87552（预算对账构建）。
- **健康**：`GET /health` → `status=ok, store=sqlite, team={enabled:true,persistence:store,recovery:on-start}`。
- **静态资源**：`/team.js` 200、`/team.css` 200、`/` 200；畸形 `//` 返回 400 且进程继续。
- **功能入口**：创建会话后 `GET /api/teams?conversationId=…` 返回默认 Team（4 成员 / 3 并发 / 24 请求 / 400k 输入 / 32k 输出）；不存在 run 的 `POST /steering` 返回 404；`GET /runs/:id/approvals` 返回 `{approvals:[]}`；`GET /runs/:id/integrations` 返回 `{integrations:[]}`；`/` 与 `/team.js` 200。健康检查启动的真实 run 已通过 stop 收束，未留下运行中的后台模型请求。
- **并行进程**：`127.0.0.1:8787` 仍由 `.worktrees/mcp` 的进程占用；本报告未终止并行开发进程。主库已是 v13，本分支的 12 版服务不能直接复用，需要等该开发线合入后再统一迁移版本。
- **修复的启动/健壮性问题**：Team 工作区根默认移到源目录外（`~/.eunoia/team-workspaces`，可用 `TEAM_WORKSPACE_ROOT` 覆盖；本机 DSH 沙箱下 home 不可写，验证用 /tmp）；畸形请求目标 `//` 返回 400 而非崩溃；关闭成员与激活收尾的竞争用 `closedAt` 修复；预算预留移到模型并发槽之后，避免排队请求提前占满输出预算；Team 工具使用 `workspace_state` 副作用类别，不再因“禁止命令”而被误拒。

## 11. 结论## 11. 结论

本次交付了可运行的 Subagent 运行时、持久 Team 任务板、CAS/租约/outbox、全队预算与模型许可、steering、图片授权/预算、隔离工作区与冲突集成发布、API、前端抽屉，以及 E01/E02/E03/E06 的真实端到端；但 **T01–T60 与 E01–E06 没有全部通过（E04 UI 未完成、E05 未执行）**，因此不能声称"具备完整 Team 能力"。按计划第 2 节和第 12 节，容器/MCP/真实模型相关项必须标记阻塞或失败，不应以替身测试冒充通过。后续补齐顺序建议：MCP 工具授权与审批 → 图片授权/预算 → E04 UI 冲突编辑/重新验证 → E05 故障注入。
