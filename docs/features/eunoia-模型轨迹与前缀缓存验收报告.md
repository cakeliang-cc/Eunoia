# Eunoia 模型轨迹与前缀缓存验收报告

日期：2026 年 11 月 8 日。实现 ADR：`docs/adr/032-model-transcript-and-prefix-cache.md`。
基线提交：`824d369`。数据库 schema：v9 → **v10**。

本报告只记录实际运行过的结果。离线契约全部通过；真实 smoke S01–S03 使用本地
`.env` 中的 DeepSeek 凭据，限制为总计 24 次请求、200,000 输入 Token、单次输出
2048 Token。所有费用是按文档参考单价折算，不是账户扣费核对。

## 1. 交付内容

| 层 | 落点 |
|---|---|
| 类型与哈希 | `src/session/model-transcript.ts` |
| 存储端口 | `src/session/model-transcript-store.ts` |
| SQLite v10 迁移与实现 | `src/db/sqlite-schema.ts`、`src/db/sqlite-store.ts` |
| 内存存储同契约 | `src/db/in-memory-store.ts` |
| 背景块投影 | `src/agent/context-projection.ts`、`src/agent/runtime-context.ts` |
| loop 回放钩子 | `src/agent/loop.ts`、`src/agent/model-port.ts`、`src/agent/model-turn.ts` |
| durable 编排 | `src/service/model-transcript.ts`、`src/service/chat.ts` |
| 开关 | `src/session/model-transcript.ts`、`src/api/server.ts`、`.env.example` |
| 用量 | `src/session/turn-types.ts`、`src/agent/events.ts`、`src/db/*-store.ts` |
| 实验脚本 | `scripts/model-transcript-experiment.ts` |
| 测试 | `tests/session/model-transcript.test.ts`、`tests/db/model-transcript.test.ts`、`tests/agent/context-projection.test.ts`、`tests/agent/model-replay.test.ts`、`tests/service/model-replay.test.ts`、`tests/agent/model-turn.test.ts` |

## 2. 数据库迁移

- `model_epochs`：id、user/conversation、父阶段、原因、实际提示词、提示词版本、
  工具声明全文与哈希、provider/model、协议与编码版本、活动窗口 item ids、窗口
  revision、seed 边界、active/ended。
- `model_items`：不可变条目，`(conversation_id, idempotency_key)` 唯一、
  `(conversation_id, seq)` 唯一；payload 存完整模型输入/输出，图片只存 assetId。
- `model_steps`：每次尝试，`(request_id, step, attempt_no)` 唯一；按序 input/output
  item ids、请求配置摘要、编码投影、状态、responseId、usage、错误与结束原因。
- `model_context_state`：`(epoch_id, key)` 主键，含 content hash、renderer 版本、
  revision、latest item id、cleared。
- `turn_requests.turn_usage`：整轮已知 usage 汇总。

迁移是增量的，`IF NOT EXISTS` / `PRAGMA table_info` 检查，可重跑；A01 在 v9 fixture
上关闭、重开、再次迁移，旧消息与 turn 记录不变。删除会话/用户级联删除轨迹；媒体
引用统计同时检查 `model_items.payload`。

## 3. 离线验收 A01–A32

全量命令：

```sh
npm test
```

结果：**1371 passed，27 skipped，103 个测试文件通过，4 个文件按条件跳过**（skip 为
既有的 sandbox/Docker 等条件测试，不是本次新增测试）。类型检查、lint、build 见 §6。

| ID | 测试位置 | 实际观察 |
|---|---|---|
| A01 | `tests/db/model-transcript.test.ts` | v9 fixture 删除新表/列后重开，迁移到 v10；旧消息保留；再次重开幂等 |
| A02 | `tests/session/...`、`tests/db/...` | 相同幂等键只一份条目；同 attempt 只一份 step；非法会话引用被拒；窗口 revision 冲突显式报错 |
| A03 | `tests/service/model-replay.test.ts` | 相同 requestId 返回 in_flight；并发请求 busy；重放零模型、零轨迹、零计量 |
| A04 | 同上 | legacy→durable→legacy→durable 两次 seed；每条用户消息只出现一次；旧 epoch 保留 |
| A05 | `tests/agent/context-projection.test.ts` | 相同持续块连续三轮只首轮追加；时钟同分钟去重 |
| A06 | 同上 | 目录 a→b 只追加 workspace revision；新快照不含旧目录 |
| A07 | 同上 | 权限块变化；真实 `policyDenial` 拒绝写工具 |
| A08 | 同上 | narrative 清空发 tombstone；恢复时 revision+1 |
| A09 | 同上 | 本轮资料相同文字仍追加；缺席的 turn 块不 tombstone；固定顺序 |
| A10 | `tests/agent/model-replay.test.ts` | 长助手原文逐字回放，无占位替换、无 UI 汇总重复 |
| A11 | 同上 | 两步、工具调用/结果/中间文本顺序与 callId 正确，无孤立半组 |
| A12 | 同上 | 3000+ 字符工具结果尾部进入轨迹与下轮 wire；审计仍为 2000 字符 |
| A13 | 同上 + context-projection | 空格/换行/JSON 字段顺序未被改写；块哈希确定 |
| A14 | 同上（故障 store） | 准备失败零模型调用；调用事实失败零工具执行；错误码 `MODEL_TRANSCRIPT_UNAVAILABLE` |
| A15 | 同上 | 工具执行 1 次、结果保存失败后不再发模型、不重跑；已显示文本仍在事件流 |
| A16 | 同上 | 助手文本只入轨迹一次；incomplete 状态；reasoning 元数据保留且不泄露到回复 |
| A17 | `tests/service/model-replay.test.ts` | SQLite 关闭重开；同 epoch；前缀保持；不重跑工具 |
| A18 | 同上 | 未配对 tool_call → recovery-boundary；旧调用移出窗口；追加「结果未知，未自动重跑」 |
| A19 | 同上 | 停止保存半截文本为 incomplete；下一轮带继续指令，不伪造完成 |
| A20 | 同上 | regenerate epoch；旧回复保留在旧 epoch；活动视图回退；用户条目只有一份 |
| A21 | 同上 | compaction epoch 以摘要开头；最新状态块位于保留轨迹之后 |
| A22 | `tests/agent/model-replay.test.ts` | 压缩结果持久化并替换窗口；原结果仍可审计；重启后仍是压缩视图 |
| A23 | context-projection | 背景 user 消息不移动保护区；真实用户回合不被删除 |
| A24 | service replay + request-plan | 模型切换为纯文本后新建 epoch；历史图片 → `MODEL_INPUT_UNSUPPORTED` scope=history |
| A25 | service replay | 同一 asset 出现两次计为两次视觉输入 |
| A26 | `tests/agent/model-turn.test.ts` + service | provider A/B 同 modelId 得到不同模型对象；provider 变化新建 epoch |
| A27 | service replay | 提示词变化 → prompt-change；工具变化 → tools-change；旧 epoch 仍可审计 |
| A28 | 存储契约 + 级联测试 | 会话/用户删除清理轨迹与状态；备份通过数据库快照包含新表；媒体引用包含轨迹 |
| A29 | service replay | 两步 1000/20/800 与 1500/30/1200：turn=2500/50/2000，last=1500/30/1200，窗口不累加 |
| A30 | service replay | 缺 usage 的步骤保持 null；汇总 incomplete、missingUsageSteps=1 |
| A31 | service replay | completed 原有字段可用；新增 turnUsage/transcriptMode 可选；legacy 模式仍工作 |
| A32 | service replay + experiments | 普通回合前缀稳定；模型/提示词/工具/压缩边界有原因记录；最终请求长度可报告 |

> 说明：A07 的「真实策略拒绝 + 拒绝结果入轨迹」由 `policyDenial` 单测与 chat 的
> tool 失败路径组合覆盖；没有启动 Docker sandbox。A28 的备份验证使用 v10 数据库
> 快照包含新表的 schema 检查；没有在报告中伪造媒体逐字节恢复结果。

## 4. 真实 smoke S01–S03

命令（每次运行都是独立进程，预算独立，默认 dry-run）：

```sh
npm run experiment:transcript            # 离线 dry-run，不联网
npm run experiment:transcript:live -- --scenario=s01
npm run experiment:transcript:live -- --scenario=s02
npm run experiment:transcript:live -- --scenario=s03
```

结果文件：

- `docs/research/prefix-cache/experiments/model-transcript-live-2026-11-08T09-05-21-211Z.json`（S01）
- `docs/research/prefix-cache/experiments/model-transcript-live-2026-11-08T09-05-36-879Z.json`（S02）
- `docs/research/prefix-cache/experiments/model-transcript-live-2026-11-08T09-05-54-764Z.json`（S03）
- `docs/research/prefix-cache/experiments/model-transcript-dry-run-2026-11-08T09-02-16-371Z.json`（离线流程证据，不代表真实供应商）

### S01 长回复对照

真实 `deepseek-flash`，4 组 × 3 轮，交换 legacy/durable 先后顺序；12 次请求，
38,022 输入 Token，6,762 输出 Token。

| 指标 | legacy | durable |
|---|---:|---:|
| 请求数 | 6 | 6 |
| 累计输入 Token | 16,080 | 21,942 |
| 输入参考费用 | $0.002950440 | $0.002877516 |

- 输入长度：durable **+36.46%**。
- 含输出总参考费用：durable **−2.47%**。
- 两组的助手回复逐字回填；每轮实际回复 407–910 字不等；没有用固定短句替换。
- 结论：这次样本里净收益很薄（2.47%），不足以宣称生产固定节省。费用下降来自
  durable 更高的缓存命中，而不是输入更短。

### S02 工具往返

- 1 次真实请求回合、2 个模型步骤；模型调用 `live_probe` 一次，结果返回 1 次。
- 回复原样引用了 `LIVE-MARK-730d3702`。
- 请求轨迹记录了 tool_call/tool_result 的顺序；回放本身没有执行工具。
- 结果文件中的 `checks[0].ok = true`。

### S03 重启与状态变化

- 同一会话、同一 SQLite 文件；第一次 turn 关闭 store，第二次 turn 用新 store 重开。
- 重启前后 epoch 数都是 1（同阶段）；第二轮没有再次调用工具（`toolCallsTurn2=0`）。
- 时钟从 10:00 变为 10:05，窗口里的 clock 块从 1 条增加到 2 条（revision 2）。
- 结果文件中的 `checks[0].ok = true`。

## 5. 限制与未声称的能力

- S01 只覆盖短会话（3 轮）与文本；没有覆盖长会话压缩、图片、reasoning 签名或
  第二家真实供应商。
- 缓存是否命中由供应商决定，无法强制冷缓存；费用是参考单价折算，不是账单。
- `MODEL_TRANSCRIPT_MODE` 代码默认仍为 `legacy`（升级安全）；本部署在 `.env`
  显式设为 `durable`。legacy 是单变量回滚，不是逐请求开关。
- 旧库没有完整工具结果，`legacy-seed` 只覆盖现有摘要与 user/assistant/图片，不能
  从 2000 字符审计片段虚构完整工具输出。
- 没有新的统计面板；诊断通过日志、`transcriptDiagnostics()` 与实验脚本导出。
- A28 未做真实媒体文件逐字节恢复演练；备份脚本本身复制数据库与媒体并校验 SHA-256，
  本次只验证了新表在快照 schema 中存在。

## 6. 检查命令与结果

```sh
npm run typecheck     # passed
npm run lint          # passed（见提交记录）
npm run build         # passed
npm test              # 1371 passed / 27 skipped
npm run browser:check # 见 docs/captures/browser-check.json
```

`browser:check` 使用仓库脚本的实际启动方式；本次验证了页面加载、刷新、停止/继续、
重新生成与错误路径的既有契约。没有真实浏览器能力时该项应标记为条件性结果，而不是
全部验收通过；本次记录以脚本输出为准。

## 7. 默认开关决定

- **代码默认：`legacy`。** 已有安装升级 schema v10 后，回放语义不在同一次重启中
  改变；这是 ADR 032 §8 的保守选择。
- **本部署：`MODEL_TRANSCRIPT_MODE=durable`**（`.env`，已写入 `.env.example` 说明）。
  依据是 A01–A32 全绿与 S01–S03 通过。
- 回滚：设 `MODEL_TRANSCRIPT_MODE=legacy` 并重启；schema 不做破坏性降级，轨迹继续
  保留，下次开启 durable 时新的聊天记录会建立新的 seed 边界。

## 8. 未解决问题

- `turn_requests.turn_usage` 在各 store 已支持，但本报告的 A29 以 completed 事件与
  `model_steps` 为证据；HTTP 层回放已完成请求时是否应返回整轮 usage，属于后续前端
  展示决策，本期不新增面板。
- 压缩后的原始条目仍保留在旧 epoch；保留期清理策略尚未单独增加命令，当前依赖会话/
  用户删除与备份保留。这是有意的最小实现，不声称已有独立 TTL。
