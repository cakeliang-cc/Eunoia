# Eunoia：Subagent 与 Agent Team 选型研究

研究日期：2026-11-08。用途：确定开发范围；执行入口见[完整实施清单](../../plans/eunoia-Subagent与AgentTeam实施清单.md)。本文记录核对到的开源实现，不表示 Eunoia 已实现这些能力。

## 结论

**DSH 已有 Agent Team，因此按本次需求选择完整 Team：用同一套 Subagent 运行时承载成员，再增加共享任务、依赖、归属与协作。** 不需要先交付一套将来推倒重来的子 Agent 系统。

Codex 已有独立子线程、委派和成员通信能力；本次核对的公开接口不能直接证明它具备与 DSH 相同的共享任务板。这个结论是核对范围的边界，不是断言 Codex 所有产品形态都没有 Team。

## 两者到底差在哪里

| 能力 | Subagent | 本项目所说的 Agent Team |
| --- | --- | --- |
| 独立工作 | 子 Agent 有自己的上下文、模型调用与工具执行 | 复用同一能力 |
| 委派 | 主 Agent 指定任务，等待结果，必要时追问 | 仍然支持 |
| 成员通信 | 可以有；有通信不代表自动具备共享任务管理 | 支持主成员、成员间通信 |
| 工作归属 | 通常由主 Agent 在上下文中记住 | 持久任务板记录谁在做、依赖谁、交付什么 |
| 一致性 | 重点是子执行的生命周期 | 还要处理抢任务、重复执行、版本冲突、结果验收 |
| 模型要求 | 能执行普通工具调用和多轮循环即可 | 同样由 Harness 编排，不要求模型厂商提供“Team API” |

一个提示词写三个角色、一次调用返回三段答案，或同时运行四个只读工具，都不构成这里的 Subagent。

## DSH：以 Subagent 为底座的真实 Team

固定源码版本：`deepseek-ai/deepseek-harness@fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。以当前 `packages/team/` 为准，不混用旧实验目录的接口。

DSH 的 `dsh-agent-team` 提供持久共享任务板，`dsh-tool-agent-team` 提供模型可调用的任务工具；成员创建、发现和通信复用 Subagent。新会话默认关闭 Team，可在根会话启用。[服务说明](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/agent-team/README.md)

模型侧有四个任务工具：`team_task_create/list/get/update`。启动成员使用 `subagent` 或继承已完成轮次的 `subagent_fork`，通信使用 `send_message` 等原有工具。任务更新不会自动唤醒成员，需要显式通知。[工具与策略](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/tool-agent-team/README.md)

任务有版本号、归属、依赖和状态；修改携带 `expectedRevision`，过期修改失败。依赖需要保持无环。工作路径 `writeScopes` 只提供冲突提示，不能当成文件写锁。[类型](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/agent-team/src/types.ts)、[任务板实现](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/agent-team/src/task-board.ts)

需要特别注意：DSH 此实现共享一个 checkout，不负责跨进程协调，也不会自动释放任务归属。Eunoia 借鉴其组合边界，但并行写代码采用独立工作区，并用数据库处理竞争和恢复；这些是本项目的设计选择，不冒充 DSH 原有保证。[限制说明](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/agent-team/README.md)

## Codex：重点借鉴子运行时和执行边界

固定源码版本：`openai/codex@748ab55ca7de0b647d9a7a9d9a8e70e00f28666d`。

官方文档支持独立子线程、不同指令或模型配置、委派、跟进和收集结果；也说明并行会增加 Token 消耗，适合可独立分解的工作。[Subagents 文档](https://developers.openai.com/codex/multi-agent/)

源码可以核对 `spawn_agent`、消息发送、等待与 mailbox 控制。因此不能说 Codex 只有串行聊天，也不能仅凭这些接口便宣称它和 DSH 的任务板完全相同。[创建](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)、[发送](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs)、[等待](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)、[邮箱](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/agent/control/mailbox.rs)

Codex 的 Git worktree 提供独立工作目录，但共享 Git 元数据。由此推导：独立目录不等于安全隔离，Eunoia 仍需沙箱、权限检查和受控集成。[Worktree 文档](https://learn.chatgpt.com/docs/environments/git-worktrees)

## Eunoia 当前差什么

本次阅读的工作区处于其他功能开发中，实施前需重新核对最新提交。

| 当前位置 | 已有基础 | 本次需要补齐 |
| --- | --- | --- |
| `src/agent/loop.ts`、`model-port.ts` | 原生多轮循环、模型端口、工具与取消 | 独立子激活、成员生命周期、协调工具 |
| `src/service/turns.ts`、`src/session/turn-store.ts` | 每会话运行互斥、请求幂等 | 成员独立内部会话、Team 与激活的关联 |
| `src/session/model-transcript*`、`src/service/model-transcript.ts` | 模型轨迹与恢复基础 | 成员轨迹、fork 快照、消息进入上下文的提交位置 |
| `src/sandbox/workspace-manager.ts` | bind/copy 工作区 | 并行写隔离、基线快照、差异产物与冲突集成 |
| `src/models/types.ts` | Provider、ModelProfile、能力配置 | 成员选择与降级策略，避免写死 DeepSeek |
| `src/api/server.ts`、`web/app.js` | 聊天、SSE、停止 | 后台 Team 作业、可重连事件、成员和任务界面 |
| 正在开发的 MCP 和统一工具契约 | 工具扩展基础 | 子成员权限、审批和副作用审计复用 |

没有发现可用的生产 Subagent/Team 服务。现有并行只读工具不等于多个 Agent；旧 `ADR 001` 的单 Agent 决策也不能当作本次已经有实现。

## 用一个例子看价值

用户要求“给文件系统增加 S3 实现，同时保证现有本地实现仍然可用”。主 Agent 建三个有验收条件的任务：

1. 成员 A 在自己的工作区实现 S3 适配器，产出带基线哈希的修改。
2. 成员 B 并行审查文件系统契约和调用点；直接把边界问题发给 A。它有独立上下文，可以继续追问。
3. A 的产物集成后，成员 C 在集成快照上验证本地与 S3 行为。验证记录绑定实际产物哈希。

主 Agent 收集结果、解决冲突并验收。C 不能只因为 A 说“完成了”便提前通过，A/B 也不能覆盖用户原工作目录中尚未提交的修改。

如果只是“帮我搜索三个文件并总结”，普通 Subagent 已足够；此时不必创建复杂任务图。两种用法共享底层运行时，Team 开关控制是否启用任务协作。

## 取舍与对外亮点

值得做的是独立上下文、真正并行的模型请求、显式任务归属、可追溯验收，以及继承现有沙箱和模型适配能力。不能把“用了多个 Agent”直接写成速度更快、效果更好或费用更低的证据。

本次选型：**DSH 学任务板与工具组合；Codex 学独立子执行与通信；Eunoia 按自己的持久化、沙箱、预算和 MCP 架构完成整合。** 是否能对外声称具备 Team，以实施清单全部验收为准。
