# ADR 029 — 结束原因与独立验收

**状态：** 已接受
**日期：** 2026-11-08
**相关：** ADR 010（推理转发）、ADR 014（agent loop）、ADR 025（打断与继续）、
ADR 027（回合准入）、ADR 028（执行历史与恢复）

---

## 1. 决策

把"有输出""正常完成""任务成功"拆成三个独立判断：

| 判断 | 数据 | 回答的问题 |
|---|---|---|
| 有输出 | `reply` 非空 | 用户看到了什么 |
| 正常完成 | `finish_reason` | 模型/循环是怎么结束的 |
| 任务成功 | `acceptance` 检查 | 结果是否满足成功条件 |

`finish_reason` 取值：

| 值 | 含义 |
|---|---|
| `completed` | 模型给出了最终回答 |
| `cancelled` | 用户停止或连接断开 |
| `incomplete_stream` | 流在没有完成事件的情况下结束（文本保留） |
| `loop_exhausted` | 达到工具步数上限 |
| `budget_exhausted` | 上下文预算放不下下一次请求 |
| `failed` | 错误结束 |
| `crashed` | 恢复扫描发现进程已死（ADR 028） |

## 2. 背景

复现的第二个问题：

```
模型流输出一段文字 → 连接结束，没有 response_done → 适配器仍生成 done
→ Agent 按正常完成处理
```

这是有意的取舍（保留已展示的文字，不丢回复），但"保留文字"与"判定完成"被绑成了
同一个决定。于是"我已经准备开始……"这样只写了一半的回答，也会被存成正常完成。

同类问题还有：达到步数上限时循环先发 `loop_exhausted` 再发 `completed`，两者都出现，
客户端与统计各自选择相信其中一个。

## 3. 结束原因如何产生

- **适配器**（`model-turn.ts`）：流结束但没有 `response_done` 时，若有文本则发
  `incomplete` 而不是 `done`；没有文本仍然抛错（一个字符都没有，就没有可保留的东西）。
- **循环**（`loop.ts`）：`incomplete` 一旦出现，整轮都记 `incomplete_stream`（后续步骤
  干净也不能把前面被截断的部分补成完整）；步数上限发 `loop_exhausted`；预算不足发
  `budget_exhausted`；正常路径 `completed`；异常 `failed`。
- **编排**（`chat.ts`）：把 runner 的原因传进终态事件，并写入 `agent_runs.finish_reason`
  与 `turn_requests.finish_reason`。

`completed` / `interrupted` / `error` 事件都带 `finishReason`，客户端不需要从"有没有某个
字段"反推原因。

## 4. 验收是独立检查

`evaluateTurnOutcome()` 计算四项：

| check id | 通过条件 |
|---|---|
| `finished` | `finish_reason === 'completed'` |
| `has_output` | 回复去掉空白后非空 |
| `tools_ok` | 没有工具调用返回错误 |
| `tools_resolved` | 没有"有调用、无结果"的工具调用 |

`accepted = 四项全通过`。结果同时：

- 进入 `completed` 事件（`accepted` / `acceptance`）；
- 写入 `turn_requests.accepted` / `acceptance`；
- 被重放请求原样返回（重试不会得到另一个结论）。

典型组合：

| 场景 | finish_reason | has_output | accepted |
|---|---|---|---|
| 正常回答 | `completed` | ✓ | ✓ |
| 正常回答但工具报错 | `completed` | ✓ | ✗（`tools_ok`） |
| 流被截断但有文本 | `incomplete_stream` | ✓ | ✗（`finished`） |
| 达到步数上限 | `loop_exhausted` | ✓ | ✗（`finished`） |
| 崩溃恢复 | `crashed` | 可能有 | ✗（`finished`） |

## 5. 持久化

- `agent_runs.finish_reason`（可空）：不重建表的列迁移；
- `turn_requests.finish_reason` / `accepted` / `acceptance`：随回合记录落库。

`agent_runs.status` 保持原有取值（`completed/failed/safety_replaced/interrupted`），
因为它是"类别"，`finish_reason` 才是"原因"。把七种原因塞进 status 会让每次新增原因都
要重建表（SQLite 不能改 CHECK 约束），也会让统计口径被枚举值绑架。

## 6. 备选方案

| 方案 | 为什么不选 |
|---|---|
| 连接关闭就当完成 | 截断的回答被存成完整回复，用户最后看到半句话 |
| 连接关闭就丢弃文本 | 用户已经看到的文字不能收回 |
| 加一个 `incomplete` 布尔 | 七种原因需要七个布尔，且无法回答"为什么" |
| 把成功/失败也写进 status | 每加一种原因都要重建 CHECK 约束；类别与原因被混为一谈 |
| 用模型自评判断成功 | 验收条件要可复现、可测试，模型自评不是条件 |

## 7. 客户端

`completed` 帧按 `finishReason` 显示提示：

- `incomplete_stream` → "回复可能未完整：连接在结束信号之前断开了"；
- `budget_exhausted` → "上下文预算用尽，这一轮先停在这里"；
- 旧的 `loop_exhausted` 事件保留（提示"达到 N 步工具上限"），两者不冲突。

不认识新字段的客户端行为不变：文本仍在，只是不显示提示。

## 8. 测试

- **model-turn**：无完成事件但有文本 → `incomplete`，文本保留。
- **loop**：正常 → `completed`；截断 → `incomplete_stream` 且文本保留；
  步数上限 → `loop_exhausted` 且保留半成品；异常 → `failed`。
- **turn-outcome**：正常、截断、工具失败、空回复、未结算工具、六种非 `completed` 原因。
- **service**：`completed` 事件带原因与验收；回合记录与 `agent_runs` 写入相同原因；
  截断回合 `accepted=false`。
- **api**：实时帧与重放帧都带 `finishReason` / `accepted` / `acceptance`。

## 9. 后果与边界

- **"正常完成"不再等于"任务成功"。** 依赖 `completed` 统计成功率的调用方需要改用
  `accepted`；这是有意的口径变化。
- **`safety_replaced` 仍算完成。** 安全替换的回复是完整的回复，只是内容被替换；
  它属于 `status` 而不是 `finish_reason`。
- **验收条件目前是固定的四项。** 按任务自定义验收（例如"必须生成某个文件"）需要把
  条件做成每回合数据，留待下一步。
