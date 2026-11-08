# ADR 032 — 模型轨迹、背景快照与阶段边界

**状态：** 已接受（离线契约与真实 smoke 已通过；默认值见 §9）
**日期：** 2026-11-08
**相关：** ADR 014（agent loop）、ADR 016（SQLite）、ADR 025（停止与继续）、
ADR 027（回合准入与幂等）、ADR 028（执行历史与恢复）、ADR 030（每请求预算）、
ADR 031（多模态）

---

## 1. 决策

把「聊天消息」和「模型轨迹」拆成两个持久化事实：

- `messages` 继续服务 UI、搜索、导出和旧客户端；
- `model_items` 保存模型实际看到/产生的有序条目，`model_epochs` 保存一套稳定
  提示词、工具声明、provider/model 与编码版本下的回放区间，`model_steps` 保存
  每一次请求尝试，`model_context_state` 保存背景块的比较基线。

普通回合在活动 epoch 内追加；压缩、回退、提示词/工具变化、模型/provider 变化、
停止后恢复或无配对工具调用时开启新 epoch，并记录原因。回放只重放数据，**不执行
工具**；工具副作用仍由 ADR 028 对账。

## 2. 背景

原先 `runtime-context.ts` 把关系、时间、目录、记忆等拼成一个尾部字符串，每轮
重新发送。它有三个问题：

1. 无法判断哪一个块变了，所以无法只追加变化；
2. 重启后只能从当前文件重新生成旧文本，历史前缀可能被改写；
3. 工具结果只存在 2000 字符的审计副本里，不能作为完整模型输入回放。

DSH 的 `RuntimeContextProjection` 给出了「未变化不追加、变化追加快照、清空显式
表达」的顺序回放；Codex 的 `ContextManager` / world state 给出了状态比较基线与
历史替换边界的做法。本 ADR 采用这两个机制，但落在 Eunoia 自己的 SQLite、原生
loop、ModelTurn、媒体规划与回合准入口上，不引入外部 Harness。

## 3. 数据模型

| 表 | 职责 | 关键约束 |
|---|---|---|
| `model_epochs` | 冻结的提示词/工具/provider/model/编码版本 + 活动窗口 | 每个会话至多一个 `active = 1`；旧 epoch 只读 |
| `model_items` | 不可变、有序的回放条目 | `(conversation_id, idempotency_key)` 唯一；`(conversation_id, seq)` 唯一 |
| `model_steps` | 一次请求尝试 | `(request_id, step, attempt_no)` 唯一；记录输入/输出 item id、usage、状态 |
| `model_context_state` | 背景块基线 | `(epoch_id, key)` 主键；`cleared` 是真实状态 |

条目正文存在私有数据库；图片继续引用 `media_assets` 的 `assetId`，不复制 Base64。
窗口是 item id 的有序视图，不是每轮复制一份历史。`prepareStep` 在同一事务里写
新条目、请求尝试、窗口修订和状态基线；失败时模型调用不会发生。

## 4. 背景块与作用域

固定顺序：`relationship`、`narrative`、`permission`、`workspace`、`skills`、
`toolGuidelines`、`clock`、`retrievedMemory`、`attachments`、`continuation`、
`safetyDirective`、`archivedSummary`。

- **persistent**（关系、叙事、权限、目录、技能、工具说明、时钟）：同 key 文本
  未变则不追加；变化时追加完整快照；清空时追加 tombstone；重新出现使用新 revision。
- **turn**（本轮记忆、附件、继续指令、安全指令）：每个真实用户回合都追加，即使
  文字与上轮相同；下一回合自动失效，不产生 tombstone。
- **stage**（更早摘要）：属于阶段检查点，不按普通状态块每轮重发。

时钟只在分钟变化时更新；循环内不每步刷新。背景在 wire 上可以是 user 角色（DSH
的顺序回放更利于缓存），但预算保护、用户计数和回合边界按条目 `source` 判断，
不看 `role === 'user'`。

## 5. 模型调用与提交顺序

每个模型步骤：

1. 确认会话准入与活动 epoch；
2. 媒体预检/固定发送变体；
3. 读取权威状态，生成必要的背景更新；
4. 组装逻辑输入并计算预算；裁剪时提交新的活动窗口；
5. `prepareStep` 事务：条目 + prepared 尝试 + 窗口 + 状态；
6. 适配器编码，捕获可比较请求投影（提示词、工具、消息顺序、图片摘要），
   不保存凭据、请求 id 或 Base64；
7. 标记 sending 并发送；
8. 终态输出按供应商顺序保存，且只保存一次；
9. 有工具调用时，先可靠保存调用事实，再执行；结果可靠保存后才发下一次请求；
10. 结算每步 usage，再继续循环。

写失败语义：准备失败 → 不发模型；调用事实失败 → 不执行工具；工具已执行但结果
保存失败 → 不继续下一步、不自动重跑，保留已显示文本并交给 ADR 028 对账。稳定错误码
是 `MODEL_TRANSCRIPT_UNAVAILABLE`。

## 6. 恢复与边界

- 重启恢复同一活动 epoch、条目顺序、背景基线与已完成工具结果；
- `sending` 没有可靠终态时转 unknown；
- 活动窗口中有 `tool_call` 没有配对 `tool_result` 时，开启 `recovery-boundary`
  epoch：移除未闭合调用，追加有来源的中断说明「结果未知，未自动重跑」；
- 停止：保存实际显示的半截文本为 `incomplete` 助手条目，不伪造 reasoning 签名；
- 重新生成：活动视图回退到用户条目，旧助手/工具条目保留在旧 epoch 供审计；
- 安全替换：丢弃本轮内部答案条目，以实际安全答复建立 `safety-replaced` epoch；
- 压缩：以摘要 + 近期闭合轨迹 + 最新权威状态建立 `compaction` epoch；
- 模型/provider/提示词/工具声明变化：建立对应 epoch，不跨供应商复制 reasoning
  签名或私有检查点。

## 7. 计量

`model_steps.usage` 保存每次尝试的 input/output/total/cached/cache-write 与响应模型。
缺失字段是 `null`，不是 0。三个口径分开：

- `lastRequestUsage`：最后一次请求，兼容原 `completed.usage`；
- `turnUsage`：本轮已知 usage 求和，附 `measuredSteps`、`totalSteps`、`incomplete`、
  `missingUsageSteps`、`missingCacheSteps`；
- `contextTokens`：最近一次请求的本地窗口估计，不累计。

`turn_requests.turn_usage` 保存整轮汇总；`usage` 继续保存最后一次请求。客户端可以
忽略新增字段。

## 8. 兼容与开关

- 服务端 `MODEL_TRANSCRIPT_MODE=legacy|durable`，客户端不能逐请求选择。
- 代码默认 `legacy`：已有安装升级数据库（schema v10）时，回放语义不在同一次重启
  中改变。本部署在 `.env` 显式设为 `durable`，保留 legacy 作为单变量回滚。
- 旧库首次 durable：以现有摘要 + user/assistant/图片创建一次 `legacy-seed` 基线；
  无法从 2000 字符审计片段虚构完整工具结果，文档如实标记旧轨迹不完整。
- 新表随会话/用户级联删除；媒体引用统计同时检查聊天行与可回放轨迹，避免重新生成
  删除 UI 行后图片先被 GC；备份包含数据库快照，因此包含新表。

## 9. 验收与结论

- 离线 A01–A32 映射在 `tests/session/model-transcript.test.ts`、
  `tests/db/model-transcript.test.ts`、`tests/agent/context-projection.test.ts`、
  `tests/agent/model-replay.test.ts`、`tests/service/model-replay.test.ts` 与既有
  回归中；全量测试 1371 passed / 27 skipped。
- 真实 smoke S01–S03 见
  [验收报告](../features/eunoia-模型轨迹与前缀缓存验收报告.md)：
  S01 输入长度 +36.46%、总参考费用 -2.47%；S02 工具往返通过；S03 同 epoch 重启、
  工具零重跑、时钟状态更新。
- 这不是「固定节省 32%」的产品保证。S01 的净收益很薄，且没有覆盖长会话压缩、
  图片与 reasoning 的完整成本；因此默认开关按 §8 保守处理，报告如实列出。

## 10. 不做什么

不引入通用事件溯源框架、多 Agent 平台、Cordis、沙箱 Bench、后台摘要或 WebSocket
增量传输；不建设新的统计面板；不把审计摘要当完整工具结果；不把回放当工具执行。
