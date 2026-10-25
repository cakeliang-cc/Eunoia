# ADR 014 — 工具系统与 Agent loop：从「一个陪伴者」到「可以碰代码的陪伴者」

## 背景

产品一直只有一个 Agent，它的工具只有三个记忆工具（ADR 001、ADR 005）。
这足够陪一个人说话，但不够和 ta 一起改一个仓库：模型看不到文件、不能搜索、
不能运行测试，于是任何关于代码的回答都只能基于用户在对话里粘贴的片段。

下一步是 coding。它需要两件此前没有的东西：

1. **一个工具系统。** 工具要有 schema、副作用分类、执行边界、输出截断和可观察的
   调用记录，而不是每加一个能力就改一次 Agent 的构造。
2. **一个能循环的 Agent loop。** 读一个文件、根据结果再读一个、改完跑测试——
   这是一轮对话里的多步，不是一次模型调用。

参考项目是 [WhalePod](https://github.com/Timothyhay/whale-pod)：一个 Python CLI
coding agent。它最值得借的不是代码，而是四个判断——两区上下文、文件读取账本、
工具自带规则、写入默认要确认。

## 决定

### 1. 工具是项目自己的类型，不是 SDK 的类型

`src/tools/` 定义 `ToolDefinition`：名字、描述、Zod schema、副作用分类、
是否只读、guidelines、超时和执行函数。`ToolRegistry` 负责唯一性、序列化成
模型看到的 JSON Schema，以及从「实际提供的工具」派生使用说明。

不直接用 Agents SDK 的 `tool()`，因为循环需要的东西 SDK 的 `FunctionTool`
不暴露：按调用顺序调度、并发读、逐调用策略拒绝、每轮读取账本、带摘要的工具事件。
工具本身也不该知道调用它的是哪个循环。

### 2. 循环是项目自己的，模型传输仍然是 SDK 的

`src/agent/loop.ts` 拥有迭代：模型一步 → 解析 tool calls → 检查策略 → 执行 →
把结果喂回 → 下一步。它只认识 `ModelTurn` 端口：

```ts
type ModelTurn = (request: ModelTurnRequest) => AsyncIterable<ModelTurnEvent>;
```

`src/agent/model-turn.ts` 是唯一实现，把端口翻译成 SDK 的 `ModelRequest` 和
`getStreamedResponse()`。这样做的理由不是「自己写更酷」，而是 SDK 的 runner
不提供本产品需要的四件事：

- **逐调用策略。** 写文件和跑命令必须在 `execute` 之前被拒绝，而不是在工具里
  自己判断。
- **并发读、串行写。** 两个读可以同时跑；两个写不能。
- **读取账本。** 同一段文件本轮只进一次上下文。
- **工具事件。** 参数摘要、结果摘要、耗时、失败原因要能到达 SSE 和 UI。

ADR 005 说「不要重新实现 harness」，这条决定修订的是「harness 的哪一部分」：
transport（Responses API、流式、reasoning、usage）仍然交给 SDK；编排不再交给它。
供应商仍然只在一个模块里构造。

### 3. 写入和命令是进程级权限，默认关闭

聊天传输是单向 SSE，服务端无法在回合中间问「允许这次写入吗？」。因此同意发生在
回合之前，由进程配置给出：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `WORKSPACE_ROOT` | 未设 | 不设就没有文件工具；设了才有只读工具 |
| `WORKSPACE_WRITES` | 关 | 允许 `write_file` / `edit_file` |
| `WORKSPACE_COMMANDS` | 关 | 允许 `run_command` |
| `WORKSPACE_ALLOW_SENSITIVE` | 关 | 允许读写 `.env`、`*.pem` 等 |

拒绝是 fail-closed 的：策略在工具执行前返回一个模型可见的错误，工具永远不会
被调用。模型被告知停下来告诉用户，而不是换一条路径重试。

没有做「每次调用弹确认」，不是因为它不好，而是因为它需要一个回合中间的
双向通道；在 SSE 上做这件事会引入一个挂起的 turn 和一套批准/恢复状态机，
而这一版的收益不足以抵消它。如果以后需要，`ToolPolicy` 可以变成一个异步
`approve(tool, args)` 端口，循环和工具都不必改。

### 4. 工作目录是路径沙箱，不是进程沙箱

`src/tools/workspace.ts` 对每个路径做两次检查：

1. 词法检查：拒绝绝对路径和 `..`；
2. `realpath` 检查：拒绝指向目录外的 symlink。

只做第一次是常见的错误，而且在 review 里看起来完全够用。凭据文件
（`.env`、`*.pem`、`id_rsa` 等）默认不读不写、不列、不 grep。

`run_command` **不是**沙箱：它用真实 shell、真实环境、真实用户跑。这是有意的——
一个只能跑白名单命令的「coding agent」连项目的测试都跑不了。因此它的安全边界
是 `WORKSPACE_COMMANDS` 这个开关，而不是这个类。

### 5. 上下文账本每轮一份，不跨轮

`TurnReadLedger` 记录本轮已经交付过的文件范围、mtime 和大小。同一段再读时返回
指针而不是内容。账本不跨轮：下一轮的窗口是从数据库重建的，上一轮的「内容就在
上面」在那时是假的。

### 6. 工具事件只带摘要

`tool_call` 带 `summary`（路径、行范围、命令、搜索词），`tool_result` 带
`summary`、耗时和失败原因。完整工具输出不上 SSE，也不进日志。文件内容已经
经过一次模型请求，不需要再在事件流里活一次。

## 备选方案

1. **继续用 SDK 的 `run()`，只把 coding 工具包成 `FunctionTool`。**
   可行，改动最小，被否决的原因是上面列的四件事都要么做不到要么要绕过 SDK 的
   runner。工具会变成「SDK 工具 + 一层自己的策略」，循环仍然不可测。
2. **用 `openai` SDK 直接写 Responses API 循环。**
   能拿到同样的控制，但会重复 transport：流事件命名、reasoning 包装、usage、
   provider 兼容。ADR 005 的教训是这些细节里已经藏过一个静默的 bug。
3. **每次写入弹确认。**
   被推迟，不是被否定。理由见「写入和命令是进程级权限」。
4. **把 coding 做成第二个 Agent / 第二种人格。**
   否决。ADR 001 的一个 Agent 仍然成立：同一份稳定提示词加一个「工作目录与代码」
   小节，工具只在配置了目录时存在。代码能力和陪伴人格不是两个产品。

## 后果

- **默认行为不变。** 没有 `WORKSPACE_ROOT` 时，工具列表就是原来的三个记忆工具，
  提示词里的 coding 小节是一段「没有目录就不要假装」的说明。
- **coding 能力是进程级的，不是会话级的。** 一个服务实例只有一个工作目录。
  多目录需要按请求选择 root，而那是一个需要先有身份/授权的问题（ADR 009）。
- **工具调用不跨轮持久化。** 数据库仍然只存 user/assistant 文本。下一轮模型能
  看到上一轮的回答，但看不到上一轮的 tool results；它需要重新读。这是这一版
  的已知限制，不是遗漏。
- **原生循环不创建 SDK trace span。** SDK 的模型层在 `tracing` 打开时会要求
  一个已存在的 trace，而 runner 才会创建它；这一版的原生循环没有。回合与工具
  的结构化日志仍在（`agent.turn_completed` / `agent.turn_failed`），但没有
  `trace.start` / `span.*`。把 SDK span 接回来需要在循环外面显式创建 trace，
  那是一个独立改动，而不是顺手打开一个布尔值。
- **原生循环已经有一个 live 工具回合，但还不是系统性验证。** 2026-10-25 用真实
  key 发起「读 package.json」，模型调用了 `read_file`，两步入模，服务端记录
  `used_tools=true`、`steps=2`、`cache_hit_rate=0.9834`；provider 接受了这套
  `ModelRequest` 和 tool-call 形状。`tests/smoke/live-tools.test.ts` 仍然要跑，
  一次成功不等于每次成功。
- **SDK 的 trace span 关闭了。** `ModelRequest.tracing = false`，因为原生循环不在
  SDK runner 创建的 `Trace` 里；打开会让模型层抛 `No existing trace found`。
  回合/工具的 `agent.turn_completed` 等结构化日志仍在，但 `trace.start` /
  `span.*` 没有。恢复它需要在循环外显式创建 trace。
- **每轮多一次或多次模型调用。** 这是多步工具使用的固有成本；`AGENT_MAX_STEPS`
  是它的上界，达到上界时返回部分回答和一个「说继续」的提示，而不是丢掉已经做完
  的事。

## 相关文件

- `src/tools/` — 工具类型、注册表、策略、截断、账本、工作目录、coding 工具
- `src/agent/loop.ts` — 多步循环、并发读、策略、事件
- `src/agent/model-port.ts` / `model-turn.ts` — 端口与 SDK 适配
- `src/agent/events.ts` — `tool_call` / `tool_result` / `loop_exhausted`
- `src/service/chat.ts` — 组装工具、工作目录块和运行
- `src/api/server.ts` — 进程级工作目录与权限
- `tests/tools/`、`tests/agent/loop.test.ts`、`tests/smoke/live-tools.test.ts`
