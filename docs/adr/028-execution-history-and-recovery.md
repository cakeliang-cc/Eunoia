# ADR 028 — 回合执行历史与崩溃恢复

**状态：** 已接受
**日期：** 2026-11-08
**相关：** ADR 014（agent loop）、ADR 016（SQLite）、ADR 017/018（sandbox）、
ADR 025（打断与继续）、ADR 027（回合准入）

---

## 1. 决策

一轮执行的过程要落库，而不只是结果。最小闭环：

```
模型请求工具 → 先写"模型要了什么"（tool_call, running）
            → 执行
            → 写"结果是什么"（tool_result, succeeded/failed，附 execution_id）
            → 交回模型（下一次请求）
```

进程崩溃后，启动时扫描仍为 `running` 的回合：

1. 用落库的事件回答"模型要求了什么、哪些工具执行过、结果是否交回"；
2. 运行中的调用与沙箱自己的执行记录**对账**：`SUCCEEDED` → 成功，
   `FAILED/TIMEOUT/CANCELLED/INTERRUPTED` → 失败，其余（含查不到记录）→ `UNKNOWN`；
3. 已产生的助手文本作为 `interrupted` 消息保留，供"继续"接着写；
4. 回合标记为 `interrupted`，`finish_reason = crashed`，验收为未通过。

**不自动重放。** 重放是模型（或人）的又一次决定，不是崩溃处理程序能推断的事。

## 2. 背景

ADR 025 已经实现"停止后保留半截回复再继续"，但它与"服务崩溃后恢复执行"是两件事，
ADR 025 §9 也写明了这个边界：

- 工具调用与结果原先只存在本轮循环的内存 `input` 里；
- 下一轮重建模型历史时只使用用户/助手的**文本**；
- 崩溃后，没有人能回答"这次写文件到底执行了没有、结果回给模型了没有"。

沙箱层已经有 `UNKNOWN` 语义和 `recovery.ts` 的对账，但会话层没有接上。

## 3. 事件模型

schema v8 新增 `turn_events`：

| 列 | 说明 |
|---|---|
| `turn_id` | 指向 `turn_requests.id`（requestId） |
| `seq` | 回合内单调，`(turn_id, seq)` 唯一 |
| `kind` | `tool_call` / `tool_result` / `assistant_text` |
| `call_id` | 模型给的调用 id，用来把调用和结果配对 |
| `tool_name` | 工具名 |
| `status` | `requested / running / succeeded / failed / unknown` |
| `execution_id` | 沙箱执行 id，对账的连接键 |
| `payload` | 调用参数、结果文本（有上限）、每步助手文本 |

两个刻意选择：

- **先写调用，再执行。** 事后写只能回答"它跑完了吗"，不能回答"它想跑什么"。
  崩溃时留下的"有调用、无结果"正是最需要的信息。
- **每步写一次助手文本，不按 delta 写。** 每个 token 一次写会让日志成为一轮里最慢的部分；
  一步是恢复能诚实重建的最小单位。

记录失败不能结束回合：`runTurn` 里每个写入都包在 `try/catch` 里，磁盘满只降低可恢复性，
不会夺走用户已经看到的回复。

## 4. 恢复规则

| 证据 | 结论 |
|---|---|
| 有 `tool_result` 行 | 采用其结果，不再询问沙箱 |
| 无结果行，有 `execution_id` 且沙箱记录为 `SUCCEEDED` | 调用成功 |
| 无结果行，沙箱记录为失败/超时/取消/中断 | 调用失败 |
| 沙箱记录为 `RUNNING/SUBMITTED/RECONCILING/RETRYABLE/UNKNOWN` | `UNKNOWN` |
| 没有沙箱记录（无沙箱、无 id、查不到） | `UNKNOWN` |

`RETRYABLE` 不算成功也不算失败：它是沙箱给出的"可以重试"的判断，不是对本次执行的观察。

恢复后的半截回复若已在 transcript 里（崩在消息写入与回合结算之间），采用已有消息 id，
不重复插入。

## 5. 接线

- `runTurn` 在 `persist && requestId` 时构造 `StoreTurnRecorder`，经 `AgentOptions` →
  `streamReply` → `runAgentLoop` 传入；
- 循环在**发出 `tool_call` 事件之前**写调用、在结果进入下一次请求之前写结果；
- `startServer` 在 `server.listen` **之前**执行 `recoverInterruptedTurns`，否则第一个请求
  会撞上残留的 `running` 锁并得到 409。

## 6. 备选方案

| 方案 | 为什么不选 |
|---|---|
| 只存最终回复 | 无法回答崩溃时执行到哪一步，也无法对账副作用 |
| 先执行再写调用 | 崩溃点恰好落在执行中时，什么都查不到 |
| 崩溃后自动重跑未完成回合 | 工具可能有外部副作用；重跑是新的决定 |
| 未观察到结果就标 `failed` | "没看见"不等于"失败"；`UNKNOWN` 是唯一诚实的值 |
| 把完整工具输出都存进审计 | 一次读文件就可能 200 KB；诊断只需有界片段 + 原始长度 |

## 7. 测试

- **agent**：日志顺序为 `text → call → result → text`；工具结果带上 `execution_id`；
  记录器抛错时回合照常完成；只调工具、没有文本的步骤不写文本行。
- **service/recovery**：沙箱说成功时调用结算为 `succeeded` 且半截回复落库（`interrupted`）；
  无记录时 `UNKNOWN` 且**不产生**第二次调用或结果；已有结果行时不再问沙箱；
  重复恢复不重复插入；崩在消息写入之后时采用已有消息；已结束回合不被改动。
- **db**：recorder 适配器的三类行往返；输出截断到 2000 字符但保留真实长度；
  v7 → v8 迁移保留旧行并新增表列。

## 8. 边界与后果

- **恢复不重建完整模型上下文。** 它保留文本与执行事实；把工具调用/结果重新拼成下一次
  模型请求属于事件溯源式恢复，不在本 ADR 范围。
- **单进程 + SQLite 是部署前提。** 沙箱执行记录与回合记录在同一个文件里，对账是同库读取。
- **外部副作用不回滚。** 已经写下的文件不会因为恢复而撤销；`UNKNOWN` 明确告诉人
  "这条命令可能已经执行"，由人决定下一步。
- **不覆盖 `UNKNOWN` 的后续处理。** 目前只记录，不提供人工确认入口；这是下一步。

---

## 2026-11-08 补充：与模型轨迹（ADR 032）的对齐

- `turn_events` 仍是执行事实的审计记录，工具结果最多保留 2000 字符；模型实际收到的
  有界完整结果改存 `model_items`，两者不是同一份数据。
- 可回放轨迹里的 `tool_call` 没有配对 `tool_result` 时，ADR 032 在恢复时建立
  `recovery-boundary` epoch，移除未闭合调用并追加「结果未知，未自动重跑」说明；
  这不改变本 ADR 的结论：未知结果不自动重跑，由人决定下一步。
- 工具已执行但模型轨迹结果保存失败时，后续模型步骤不发送，回合以
  `MODEL_TRANSCRIPT_UNAVAILABLE` 结束，对账仍按本 ADR 的 `unknown` 语义处理。
