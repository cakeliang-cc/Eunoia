# Eunoia：Subagent 与 Agent Team 验收报告

日期：2026-11-08。分支：`feat/subagent-agent-team`。依据：[实施清单](../plans/eunoia-Subagent与AgentTeam实施清单.md)、[选型研究](../research/agents/eunoia-Subagent与AgentTeam对照.md)、[ADR 034](../adr/034-subagent-and-agent-team.md)。

> 结论先说：**核心运行时、持久任务板、预算/许可、隔离工作区、API 与前端已实现并有测试；但本次没有达到"T01–T60 与 E01–E06 全部通过"**。MCP 接入、Team 审批绑定、图片授权、候选发布的端到端 UI 以及 E03–E05 的端到端脚本未完成；E06 已用真实 DeepSeek 执行四次，均未在 24 次请求预算内完成 required 任务，被正确记录为失败/等待而非成功。逐项结果如下，未运行/阻塞项不做"通过"处理。

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
- 已验证：`npm run typecheck` 通过；`npm run lint` 0 error（3 个既有 warning）；`npm test` **1539 passed, 27 skipped**（112 个文件通过，4 个文件按环境跳过）。
- 迁移命令：`npm run migrate`；备份：`npm run backup`（未在本报告运行，见 §8）。

## 4. 自动化证据位置

| 范围 | 文件 | 用例数 |
| --- | --- | --- |
| 存储契约（内存 + SQLite） | `tests/teams/store-contract.ts`、`memory-store.test.ts`、`sqlite-store.test.ts` | 86（每后端 43） |
| 服务编排 | `tests/teams/service.test.ts` | 14 |
| 工作区/快照/差异 | `tests/teams/workspaces.test.ts` | 12 |
| 候选集成/发布 journal | `tests/teams/integration.test.ts` | 22 |
| T 项补充验收 | `tests/teams/acceptance.test.ts` | 21 |
| steering / 忙时派发 | `tests/teams/steering.test.ts` | 3 |
| E01/E02 API+SQLite | `tests/api/teams-e2e.test.ts` | 2 |
| HTTP API + SSE | `tests/api/teams.test.ts` | 8 |
| 既有回归 | `tests/` 其余套件 | 1371+ |

## 5. T01–T60 逐项结果

图例：✅ 通过（有可重复证据）；⚠️ 部分（实现存在但证据不完整，不能算通过）；⛔ 阻塞/未执行；❌ 真实执行失败。

| ID | 结果 | 证据与说明 |
| --- | --- | --- |
| T01 | ✅ | 既有 1539 项测试全绿；普通聊天/工具/停止/历史未改传输语义；Team 仅在显式 run 时启用。 |
| T02 | ✅ | `service.test.ts` fresh 成员有独立内部 conversation；`acceptance.test.ts` T05/T11 记录独立模型请求。 |
| T03 | ⚠️ | fork 只复制已提交、非 interrupted 轮次（`acceptance.test.ts`、`service.test.ts`）；低权限 fork 拒绝已实现，但"敏感工具输出裁剪"未单独构造用例。 |
| T04 | ⚠️ | 初始化失败写 `failed` 成员并释放，不产生可激活幽灵成员；工作区失败后的清理未单独断言。 |
| T05 | ✅ | `acceptance.test.ts` T05：忙成员跟进为 queued，前一轮结束后串行执行。 |
| T06 | ⛔ | 部署只有 DeepSeek 一个 provider，无法用两个真实 provider 验证；模型 id/能力走端口而非名称分支。 |
| T07 | ⚠️ | 未知模型/不支持工具在 spawn 前拒绝；图片能力只做预检，图片执行路径未接入。 |
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
| T18 | ⛔ | 注入前后崩溃重启的故障注入未执行；store 层 durability 有测试，但邮箱恢复路径无证据。 |
| T19 | ⚠️ | 单条大小与每成员队列上限已测；自动激活次数、广播扇出与"互相确认"自激预算未单独测。 |
| T20 | ⚠️ | 认领要求 ready/owner 匹配、关闭成员拒绝已实现；历史成员/外树成员不能认领未单测。 |
| T21 | ✅ | `service.test.ts`：自依赖、环、跨运行/不存在依赖拒绝；合法图与修改成功。 |
| T22 | ✅ | `sqlite-store.test.ts`：两个连接竞争同 task，仅一方成功，版本递增。 |
| T23 | ⚠️ | `acceptance.test.ts` T23：worker 不能改验收；验收人不能是提交者的代码存在但未单测。 |
| T24 | ✅ | `steering.test.ts` T24：owner 忙碌时任务仍被认领并排队，空闲后执行；依赖 accepted 才 ready、失败/取消阻塞。outbox 重投的独立注入未单测。 |
| T25 | ✅ | `service.test.ts`：required 未验收时 root activation 成功但 run 为 `waiting_user`。 |
| T26 | ✅ | `acceptance.test.ts` T26：拒绝后任务回 pending，旧 attempt/submission/review 保留。 |
| T27 | ⚠️ | 迟到回调按 generation/状态拒绝（`#finish`）；租约过期恢复有测试，但"旧进程未终止不重派写任务"未构造。 |
| T28 | ⚠️ | interrupt/停止后的迟到结果不能改成功（代码 + T09）；完整停止后发布/工具续调矩阵未测。 |
| T29 | ✅ | `acceptance.test.ts` T29：并发上限外排队，释放后按序获得。 |
| T30 | ✅ | `acceptance.test.ts` T30：pausing→paused 与 resume 重检预算；resume 后 `stop` 收束。 |
| T31 | ⛔ | 真实容器内的 Team 成员互读隔离未执行；`workspaces.test.ts` 只在宿主文件系统证明副本隔离。未在容器层验收，不能算通过。 |
| T32 | ✅ | `workspaces.test.ts`：排除 `.env`/`.git`/忽略目录/越界链接，保留源目录未提交修改。 |
| T33 | ⛔ | 共享缓存、端口与可写依赖隔离未在真实容器验证。 |
| T34 | ✅ | `workspaces.test.ts`：增删改、重命名、二进制、执行位、路径穿越。 |
| T35 | ✅ | `integration.test.ts`：同文件双方修改冲突显式保留，不覆盖。 |
| T36 | ✅ | `integration.test.ts`：相关源文件变化阻止发布，无关变化不阻止。 |
| T37 | ✅ | `integration.test.ts`：多文件发布中途失败，journal 记录已应用集合，不覆盖故障后用户编辑。 |
| T38 | ✅ | `integration.test.ts`：同幂等键只应用一次，不同候选同键冲突。 |
| T39 | ✅ | `acceptance.test.ts` T39：候选哈希变化后旧证据不能验收。 |
| T40 | ⚠️ | 成员权限取父级交集（T40 用例）；MCP 未接入，MCP 路径/命令/网络权限交集无证据。 |
| T41 | ⛔ | Team 审批没有把成员、参数哈希、账号与代次绑定到 UI/服务；沙箱审批与 Team 未串联。 |
| T42 | ⛔ | `src/mcp/` 是另一条未提交开发线；成员未获得 MCP 工具句柄，stdio/elicitation/Tasks 取消未验收。 |
| T43 | ⛔ | 图片授权（按 owner/资源/成员/期限）未实现；成员图片输入只做能力预检。 |
| T44 | ⛔ | 同图分成员计费、图片预留未接入；`PreparedMediaPlan` 未在成员执行路径使用。 |
| T45 | ✅ | `store-contract` 10 路并发预留不透支；`service.test.ts` 预算竞争；spawn/重试走同一账本。 |
| T46 | ⚠️ | 缓存输入不计入输出、usage 缺失记 incomplete、价格 unknown（不按免费）已实现；成本对账入口未提供。 |
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
| T59 | ⚠️ | 新库 schema 12 与 Team 表已测；旧库升级到 12 的完整备份/恢复演练未执行。 |
| T60 | ✅ | `acceptance.test.ts` T60 + E06：required 未验收时 run 为 `waiting_user`，不成功。 |

统计：✅ 34，⚠️ 17，⛔ 9，❌ 0（T 维度）。**未全部通过。**

## 6. E01–E06 端到端结果

| ID | 结果 | 证据 |
| --- | --- | --- |
| E01 | ✅ | `tests/api/teams-e2e.test.ts`：真实 HTTP + SQLite，fresh/fork 两个成员的内部会话不同；空闲后跟进 201，关闭后成员 closed、迟到跟进 409。未做浏览器点击与进程清单。 |
| E02 | ✅ | `tests/api/teams-e2e.test.ts`：真实 API + SQLite；两个成员独立执行、乙通过 `agent_send_message` 给甲发消息、B 依赖 A、A/B/C 全部验收、root 汇总后 run `succeeded`。未做浏览器时间线。 |
| E03 | ⛔ 未执行 | 工作区/集成模块测试通过，但没有"实际沙箱副本 → 候选 → 测试 → 应用到临时源项目"的完整编排。 |
| E04 | ⛔ 未执行 | 冲突与源变化模块测试通过，UI 冲突解决/重新验证/发布 journal 未串通。 |
| E05 | ⛔ 未执行 | 三处进程杀死与重启对账未执行。 |
| E06 | ❌ 执行失败 | 真实 DeepSeek 四次尝试均未完成：第 3 次 A/B accepted、C pending；第 4 次 A accepted、B failed、同伴消息 `accepted`，24 次请求耗尽，root 仍在运行/恢复后中断。见 [evidence/e06-agentteam-readonly-run.json](./evidence/e06-agentteam-readonly-run.json) 与 §6。 |

### E06 实际数据（2026-11-08）

- 四次真实尝试均在 24 次请求上限内未完成 required 任务：
  - 第 1 次 `run_33b87a4b…`：A/B accepted、C pending，24/24。
  - 第 2 次 `run_b2d221f4…`：A/B pending、协作消息被注入，24/24。
  - 第 3 次 `run_42f18a9c…`：A/B accepted、C pending、消息 accepted；输入 180,653 / 输出 15,550 / 缓存 130,560。
  - 第 4 次 `run_1853de61…`：A accepted、B failed、同伴消息 accepted；输入 165,310 / 输出 4,827 / 缓存 132,480；24/24，`exhausted=true`。
- 成员：主成员、甲、乙，模型 `deepseek-flash`，各自独立 internal conversation；协作消息确实由成员工具发出。
- 结论：模型编排在 24 次请求内不稳定，且存在 B 任务失败/消息未被消费；按计划"到上限未完成记失败，不自动放宽"，没有调高预算重试成"成功"。第 4 次还验证了预算停止与恢复：进程停止后恢复会把未完成运行标为 interrupted/unknown，而不会假报成功。

## 7. 失败、未执行与已知限制

1. **E06 未通过**：24 次请求预算内没有完成 required 任务；模型在根成员上消耗了较多请求，且一次尝试中协作消息未被消费。
2. **E03–E05 未执行**：E01/E02 已走真实 API+SQLite；E03 候选发布、E04 冲突 UI、E05 杀进程对账仍未串成端到端脚本。
3. **MCP（T42、T41 部分）**：MCP 宿主仍在另一条未提交开发线；本次没有把 MCP 工具授权、审批、Tasks/elicitation 接入成员。
4. **图片（T43/T44）**：成员执行路径没有 `PreparedMediaPlan`，仅能力预检；图片授权和图片预算未实现。
5. **UI 自动化（T54–T57）**：抽屉与响应式样式已实现，但没有浏览器自动化点击/键盘/390px 断言。
6. **候选发布编排**：`workspaces.ts`/`integration.ts` 有完整模块测试，但 Team API/服务没有把"物化候选 → 验证 → 发布 journal → UI 冲突编辑"串成一条可用链路。
7. **容器层**：Docker/runc 可用，但没有执行 Team 成员隔离的容器级用例（T31/T33），按计划不能以宿主测试替代。

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

- E06：四次 24 请求上限运行；第 3 次 180,653 输入 / 15,550 输出 / 130,560 缓存输入，第 4 次 165,310 / 4,827 / 132,480；估算费用 unknown（未配置价格）。
- 全部 Team 测试不调用真实 provider，除 E06 外无外部请求。
- 临时 E2E 数据库与媒体目录位于 `/tmp`，验证后已删除；仓库 `data/` 未被测试写入。
- 工作区快照位于应用数据目录的 `team-workspaces/` 下；`cleanup` 只有在无引用时才删除。
- 本地未提交的 MCP 开发线保持原样，未提交、未删除。

## 10. 构建、迁移与重启验证（2026-11-08）

- **备份**：迁移前把 `data/eunoia.sqlite` 复制到 `backups/eunoia-before-team-20261108-181456.sqlite`。
- **构建**：`npm run build` 成功；`dist/api/server.js` 可启动。
- **迁移**：本分支 `SQLITE_SCHEMA_VERSION = 12`，`npm run migrate` 曾把主库升到 12 并创建 11 张 `team_*` 表。随后并行的 `.worktrees/mcp` 开发线把同一个主库迁移到了 **13**；本分支启动时会按守卫拒绝打开更新版本的库（避免旧代码写新库），因此没有回滚/改写用户的 13 版主库。
- **重启验证使用隔离库**：`SQLITE_PATH=/tmp/eunoia-team-service.sqlite`（schema 12）、`TEAM_WORKSPACE_ROOT=/tmp/eunoia-team-workspaces`、`PORT=8788 npm start`，PID 43147。
- **健康**：`GET /health` → `status=ok, store=sqlite, team={enabled:true,persistence:store,recovery:on-start}`。
- **静态资源**：`/team.js` 200、`/team.css` 200、`/` 200；畸形 `//` 返回 400 且进程继续。
- **功能入口**：创建会话后 `GET /api/teams?conversationId=…` 返回默认 Team（4 成员 / 3 并发 / 24 请求 / 400k 输入 / 32k 输出）；不存在 run 的 `POST /steering` 返回 404。
- **并行进程**：`127.0.0.1:8787` 仍由 `.worktrees/mcp` 的进程占用；本报告未终止并行开发进程。主库已是 v13，本分支的 12 版服务不能直接复用，需要等该开发线合入后再统一迁移版本。
- **修复的启动/健壮性问题**：Team 工作区根默认移到源目录外（`~/.eunoia/team-workspaces`，可用 `TEAM_WORKSPACE_ROOT` 覆盖；本机 DSH 沙箱下 home 不可写，验证用 /tmp）；畸形请求目标 `//` 返回 400 而非崩溃；关闭成员与激活收尾的竞争用 `closedAt` 修复；预算预留移到模型并发槽之后，避免排队请求提前占满输出预算；Team 工具使用 `workspace_state` 副作用类别，不再因“禁止命令”而被误拒。

## 11. 结论## 11. 结论

本次交付了可运行的 Subagent 运行时、持久 Team 任务板、CAS/租约/outbox、全队预算与模型许可、steering、隔离工作区与冲突集成模块、API、前端抽屉，以及 E01/E02 的真实 API+SQLite 端到端；但 **T01–T60 与 E01–E06 没有全部通过**，因此不能声称"具备完整 Team 能力"。按计划第 2 节和第 12 节，容器/MCP/真实模型相关项必须标记阻塞或失败，不应以替身测试冒充通过。后续补齐顺序建议：MCP 工具授权与审批 → 图片授权/预算 → 候选发布 API/UI → E03–E05 自动化 → E06 在更小任务或更稳定的编排提示下重跑。
