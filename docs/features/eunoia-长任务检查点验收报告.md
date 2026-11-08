# 长任务检查点验收报告

状态：已实现并通过离线契约验收；未运行真实模型压缩。
日期：2026-11-08
分支：`feat/task-checkpoints`
ADR：[035](../adr/035-task-checkpoints.md)

## 1. 结论

编码任务的压缩现在会留下可继续的工作状态，而不是一段只能读的摘要：

- 摘要模板按工作轨迹在「编码」与「陪伴」之间选择，编码模板固定保留任务与约束、已完成、文件与改动理由、验证、待确认、下一步、任务板和关键原话。
- 文件、命令、退出码、失败输出和未配对工具调用由 `turn_events` 构建，追加在叙述之后；模型不再负责回忆这些事实。
- 证据块每次压缩都从轨迹重建，不随旧检查点滚动复制；旧附录在送回模型前被剥离。
- Team 任务板通过 `TaskBoardSource` 端口进入检查点，`renderTaskBrief` 可把检查点交给 fresh 成员；本分支不包含 Team 运行时。
- 只读 API `GET /api/conversations/:id/checkpoint` 返回解析后的结构与边界元数据。

## 2. 交付内容

| 层 | 文件 | 作用 |
|---|---|---|
| 会话 | `src/session/checkpoint.ts` | 证据配对、三种验证态、模板判定、附录渲染、预算合成、解析、成员简报 |
| 会话 | `src/session/task-board.ts` | 看板快照、排序渲染、任务简报、`TaskBoardSource` 端口 |
| 会话 | `src/session/summary.ts` | 两套模板、按模式取版本、提示词携带证据 |
| 会话 | `src/session/service.ts` | 压缩时读轨迹/看板、选模板、重建附录、`checkpoint()` 读取 |
| 会话 | `src/session/config.ts` | `SESSION_CHECKPOINT_ENABLED`、`SESSION_CHECKPOINT_MODE` |
| 适配 | `src/service/checkpoint-evidence.ts` | `TurnStore` → `WorkLedger` |
| 存储 | `src/session/turn-store.ts`、`src/db/*` | 按会话、时间界、上限读取工具事件 |
| 接入 | `src/agent/summarizer.ts`、`src/api/server.ts` | 按请求模式选系统提示词、生产构造传入证据源、只读路由 |
| 文档 | `docs/adr/035-task-checkpoints.md`、`.env.example`、`CHANGELOG.md` | 决策、开关与变更记录 |

## 3. 验收用例

| 编号 | 场景 | 断言 | 结果 |
|---|---|---|---|
| C01 | 写入/编辑同一文件两次 | 合并为一条文件记录，`calls=2`，末次状态为成功 | 通过 |
| C02 | 同一文件末次写入失败 | `lastStatus=failed`，不被更早的成功覆盖 | 通过 |
| C03 | `bash` 退出码 1 | 归类为 `test`，`status=failed`，保留 `exitCode=1` 与输出尾部 | 通过 |
| C04 | 命令有调用无结果 | `status=unconfirmed`，同时进入「待确认」，不算通过 | 通过 |
| C05 | 结果状态 `unknown` | 进入「待确认」，原因为 `unknown_outcome` | 通过 |
| C06 | 只有工具轨迹、消息像闲聊 | 模板判为 `coding`；任务板存在也判为 `coding` | 通过 |
| C07 | 无轨迹的普通对话 | 模板判为 `companion`，提示词不含工作证据 | 通过 |
| C08 | 强制 `coding`/`companion` | 显式模式覆盖自动判断 | 通过 |
| C09 | 证据块回环 | 渲染后解析出文件、验证、待确认、任务板、证据索引 | 通过 |
| C10 | 旧检查点带附录 | 送给模型的 `previousSummary` 不含旧附录；不把 `src/old.ts` 带进新检查点 | 通过 |
| C11 | 预算不足 | 证据先占预算，叙述让位；证据不被整体截掉 | 通过 |
| C12 | 轨迹/看板读取抛错 | 压缩仍成功，仅缺附录；日志分别记录失败 | 通过 |
| C13 | 关闭检查点 | 使用陪伴模板，不读轨迹与看板，无附录 | 通过 |
| C14 | 只读 API | 未压缩返回 `null`；压缩后返回模式/章节/证据/边界；他人会话 404 | 通过 |
| C15 | SQLite 会话级事件 | 按时间升序、`before` 截止、`limit` 取最新、按会话隔离 | 通过 |
| C16 | 自动触发路径 | `prepare()` 越过触发比例时压缩，摘要包含证据块与正确边界 | 通过 |

## 4. 命令与结果

```text
npm run typecheck
> tsc --noEmit
（0 错误）

npm test
Test Files  105 passed | 4 skipped (109)
Tests       1412 passed | 27 skipped (1439)
Duration    22.35s

npm run lint
3 problems (0 errors, 3 warnings)
```

3 条警告全部来自既有 `scripts/browser-check.ts` 的 `no-explicit-any`，本分支未新增 lint 问题。

新增/扩大的测试：

- `tests/session/checkpoint.test.ts`（新增）
- `tests/service/checkpoint-evidence.test.ts`（新增）
- `tests/session/service.test.ts`（+8）
- `tests/session/summary.test.ts`（+3）
- `tests/session/config.test.ts`（+2）
- `tests/db/turns.test.ts`（+1）
- `tests/api/server.test.ts`（+1）

## 5. 未覆盖与限制

1. **没有真实模型压缩。** 摘要模型在测试中由固定函数替代，验证的是请求形状、模板选择、证据合成与存储；没有调用 DeepSeek 生成真实叙述。真实叙述质量需要一次 live 压缩观察，不能由本报告声称。
2. **Team 运行时不在本分支。** `src/teams/` 当前只有类型与 store 契约，且属于另一条未提交工作。检查点侧的端口、渲染与测试已完成；适配器需要在 Team 运行时落地时实现 `TaskBoardSource` 并传入 `SessionService`。
3. **证据按事件时间截止。** 边界取最后一条被压缩消息的 `createdAt`，不是工具调用与消息的精确映射；跨越边界的同一次执行可能少计一个事件。宁可少算，不把保留尾部的工作写进已压缩部分。
4. **事件读取上限 4000。** 超长会话取最新事件；更早的文件变更可能不在附录中。上限是检查点不是审计账本，原始 `turn_events` 仍完整保留。
5. **命令失败输出只保留 400 字符尾部。** 用于诊断，不试图替代测试报告。
6. **没有 UI。** 只有只读 API；前端展示与「从检查点继续」按钮不在本次范围。

## 6. 回滚

- `SESSION_CHECKPOINT_ENABLED=false`：回到单一陪伴模板，不读轨迹与任务板，不改变已有检查点文本；新压缩不再追加附录。
- 不需要数据库回滚：没有新增表或列。旧代码把整段文本当摘要读取，附录会作为普通文本被注入，不影响协议。
- 分支合并前主分支未包含本功能，回退一个 merge commit 即可。

## 7. 证据位置

- 决策与取舍：`docs/adr/035-task-checkpoints.md`
- 模板与证据格式：`src/session/summary.ts`、`src/session/checkpoint.ts`
- 任务板端口与简报：`src/session/task-board.ts`
- 压缩接入：`src/session/service.ts` 的 `compact()`、`#checkpointContext()`、`checkpoint()`
- 轨迹读取：`src/service/checkpoint-evidence.ts`、`src/session/turn-store.ts`、`src/db/sqlite-store.ts`
- 只读 API：`src/api/server.ts` 的 `GET /api/conversations/:id/checkpoint`
- 测试：上表列出的七个文件
