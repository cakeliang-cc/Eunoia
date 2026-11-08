# ADR 027 — 同一会话的回合准入与请求幂等

**状态：** 已接受
**日期：** 2026-11-08
**相关：** ADR 006（客户端/服务端边界）、ADR 016（SQLite）、ADR 025（打断与继续）、
ADR 026（消息操作与上传）

---

## 1. 决策

一个会话同一时刻只允许**一个在途回合**；同一请求 id 的重试**不再执行模型**。

1. 准入是存储层的一次原子写，不是 UI 规则：第二个请求在写入任何消息之前得到
   `409 conversation_busy`。
2. 每个请求带一个 `requestId`，与 `(user, conversation, 请求内容)` 的摘要一起落库；
   相同 id + 相同摘要 = 重试，返回记录里的结果；相同 id + 不同摘要 = `409 request_conflict`。
3. 执行状态持久化：`running → completed | interrupted | failed`，附带
   `finish_reason`、回复、`messageId` 与验收结果。

## 2. 背景

同时向同一会话发 A、B 两条消息，两个回合会并行进入：

```
用户 A → 用户 B → 助手回答 A → 助手回答 B
```

A 的模型输入包含 B，B 的输入包含 A。原来的 `activeTurns: Map<turnId, controller>`
只用于停止请求寻址，没有建立"按会话互斥"。前端禁用发送按钮挡不住第二个标签页，
也挡不住直接调用 API。

## 3. 准入模型

### 3.1 锁是数据库里的唯一索引

```sql
CREATE UNIQUE INDEX turn_requests_active_idx
  ON turn_requests (conversation_id) WHERE status = 'running';
```

`BEGIN IMMEDIATE` + 同步驱动让"检查 + 插入"不可分割；索引让**第二个**插入失败，
而不是两个调用都读到"空闲"。进程内的 `Map` 只用于 abort controller，不再承担正确性。

应用层的 SELECT-then-INSERT 挡不住并发：两条请求可以在两个 `await` 之间都通过检查。
单进程里它看起来能用，多进程或两个浏览器标签页同时到达时就不行。

### 3.2 拒绝而不是排队

第一版返回 `409`，body 带 `code`：

| code | 含义 |
|---|---|
| `conversation_busy` | 该会话已有在途回合，附 `activeTurnId` |
| `request_in_flight` | 同一 requestId 仍在执行，附 `turnId` |
| `request_conflict` | 同一 requestId 绑定了不同内容/用户/会话 |

排队需要定义"排队中的回合所在会话被删了怎么办""连续误发五条怎么办"，
在定义清楚之前，明确拒绝比假装支持更诚实。

### 3.3 幂等摘要

摘要覆盖 `kind`（chat/regenerate）、用户、会话、消息文本、`continue` 与附件路径。
只对文本取摘要不够：同一个 id 被另一个用户或另一个会话复用时，返回别人的回复是
比重复执行更严重的问题。

## 4. 请求协议

`POST /api/chat`、`POST /api/chat/regenerate` 新增可选 `requestId`（uuid）：

- 缺省时回退到 `turnId`（客户端本来就为每次发送生成一个）；
- 客户端重试必须复用同一个 `requestId`；
- 重试命中已结束记录时，服务端以**同样的 SSE 形状**重放结果，末帧带 `replayed: true`，
  不再调用模型。

失败请求的重试也重放：末帧是 `error` + `replayed: true`，而不是重新执行。
"再试一次同一个问题"是一个新的 `requestId`，那才是新的回合。

## 5. 持久化

schema v8 新增 `turn_requests`：

| 列 | 作用 |
|---|---|
| `id` | requestId，主键 |
| `turn_id` | 流/停止寻址用的 id |
| `request_hash` | 幂等摘要 |
| `status` | `running / completed / interrupted / failed` |
| `finish_reason` | 结束原因（ADR 029） |
| `reply` / `message_id` | 重放所需的结果 |
| `accepted` / `acceptance` | 独立验收结果（ADR 029） |
| `steps` / `context_tokens` | 执行诊断 |

`agent_runs` 同时新增可空的 `finish_reason`，不重建表。

## 6. 与已有机制的关系

- **沙箱命令**已有 `(sandboxId, idempotencyKey)` 幂等；本 ADR 补的是**聊天请求**的
  端到端幂等。模型重新生成一次会得到新的工具调用 id，旧命令幂等键不会自动去重，
  所以两层不能互相替代。
- **停止**仍按 `turnId` 投递 abort；停止后的落库与 `interrupted` 事件不变（ADR 025）。
- **断线**：`runTurn` 在 `finally` 里结算记录，消费端中途停止读也会把回合标成
  `interrupted`，不会把会话锁到进程重启。

## 7. 备选方案

| 方案 | 为什么不选 |
|---|---|
| 只在前端禁用发送按钮 | 第二标签页、直接调 API 仍然并发 |
| 进程内 `Map<conversationId>` 互斥 | 单进程可用，重启即丢；数据库索引才是同一份真相 |
| SELECT 后 INSERT | 两个 `await` 之间两个请求都能通过检查 |
| 排队 | 语义未定义，先明确拒绝 |
| 幂等键只哈希消息文本 | 不同用户/会话复用同一 id 会拿到别人的回复 |
| 重复请求直接重新执行 | 模型与工具副作用执行两次，超时重试会重复写文件 |

## 8. 测试

- **service**：第二个回合被拒并带 `activeTurnId`；`Promise.all` 同时发起只有一个成功；
  结束后可开新回合；相同 id + 相同摘要重放；执行中重复为 `in_flight`；相同 id 不同内容
  或不同用户为冲突；摘要覆盖用户/会话/`continue`。
- **api**：真实 socket 上第二个请求 `409 conversation_busy` 且**没有写入用户消息**；
  重试命中记录时 `replayed: true` 且模型只被调用一次；执行中重复为 `request_in_flight`；
  失败重放为 `error` 帧；不存在的会话/别人的会话是 `404`。
- **db**：唯一索引拒绝第二个 running 行、不同会话互不影响；`finish` 幂等且只认第一次；
  turn events 的 seq 与 payload 往返；删除会话级联；v7 文件迁移后新表存在、
  `agent_runs.finish_reason` 存在且旧行保留。

## 9. 边界与后果

- **单进程仍是前提。** SQLite 文件 + 一次 `createApp` 是部署形态；索引语义在第二个
  进程连接同一文件时依然成立，但驱动层只有一个写者。
- **重放不是断线续传。** 它重放的是**已结束**的一次执行；仍在运行的请求得到 409，
  不做 SSE 补发。
- **心跳与 409 的顺序**：准入发生在写 SSE 头之前，所以忙的请求得到 JSON 错误而不是
  一个刚打开就断的流。
