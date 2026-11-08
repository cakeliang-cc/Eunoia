# Eunoia 简历项目经历

## 简历正文

**Eunoia｜多模态 AI 编程 Agent**

**技术栈：** TypeScript、Node.js、DeepSeek API、OpenAI Agents SDK、SQLite、Docker、SSE、Zod、Vitest。

**项目简介：** 面向代码仓库理解与修改的 Web AI 编程助手，支持文件检索编辑、命令执行、图文输入和技能按需加载。自主构建 Agent 执行循环，围绕工具执行边界、会话可靠性和上下文预算实现工程闭环。

- **Agent 运行时：** 实现“模型推理—工具调用—结果回填”的多步执行循环，通过 ModelTurn 端口隔离模型传输与业务编排；结合 Zod 参数校验、并发读取、串行写入和工具超时控制，支持仓库搜索、文件编辑及命令执行。
- **执行边界：** 构建 Sandbox Gateway 统一工具入口，命令通过 Docker 沙箱运行，设置非 root、只读根文件系统、默认禁网及 CPU/内存/PID 限制；文件操作结合路径与符号链接校验、敏感文件限制和权限审批，控制执行范围。
- **会话可靠性：** 基于 SQLite 事务与部分唯一索引实现会话级回合互斥，通过 requestId 与请求内容摘要实现幂等重放；持久化工具调用和执行结果，崩溃后对账沙箱状态，将不可确认结果标记为 UNKNOWN，避免恢复过程自动重跑副作用。
- **上下文管理：** 分离稳定提示词与动态背景，实现 SKILL.md 技能索引、正文和资源的渐进加载；每次模型请求前核算提示词、工具声明、历史及图片预算，结合滚动摘要、工具结果压缩和调用/结果成组裁剪控制上下文增长。
- **多模态接入：** 设计有序图文内容块和私有不可变图片资源，贯通上传、存储、历史回放及协议编码；采用模型能力三态预检，分别计算图片 Token 与请求体字节预算，并绑定实际发送变体，防止静默丢图和估算/发送不一致。
- **全栈交互：** 基于 SSE 实现文本、推理和工具状态流式展示，支持主动中断、保留部分回复、继续生成与重新生成；完成图片选择/粘贴/拖放、草稿状态机和失败重试，并通过 Vitest 覆盖服务、存储、协议及前端交互边界。

## 面试开场介绍

Eunoia 是一个面向代码任务的多模态 Agent。我主要围绕“模型如何可靠地调用工具”做工程设计：运行时自己控制多步循环，模型传输通过适配端口接入；命令执行有沙箱和权限边界，请求重试有数据库幂等保障，崩溃后按执行证据恢复。上下文方面，每次模型调用前重新计算预算，图片按实际发送变体计数。这些机制让它能从对话推进到读代码、修改文件和运行命令的完整流程。

## 根据投递方向取舍

- AI 应用开发岗位优先保留运行时、上下文管理、多模态和会话可靠性。
- 后端开发岗位优先保留运行时、执行边界、会话可靠性和预算控制。
- 全栈岗位保留全栈交互，并压缩其余条目的文字；简历版面不足时选最熟悉的四至五点。

项目时间和角色按真实经历填写。技术栈只保留能够解释原理和实现细节的部分。

## 事实依据与成果边界

核对日期：2026 年 11 月 8 日。参考基线 `824d369` 与当前代码；持久模型轨迹已在本次交付完成并通过 A01–A32 与真实 smoke S01–S03，可作为上下文管理条目的补充介绍。

| 简历条目 | 代码或验收依据 |
| --- | --- |
| 运行时、工具调度与参数校验 | `src/agent/loop.ts`、`src/agent/model-port.ts`、`src/agent/model-turn.ts`、`src/tools/registry.ts`、`src/tools/schema.ts` |
| 命令沙箱与文件边界 | `src/sandbox/runtime/oci-args.ts`、`src/sandbox/gateway.ts`、`src/sandbox/gateway-files.ts`、`src/sandbox/permissions/permission-manager.ts` |
| 互斥、幂等与执行对账 | `src/service/turns.ts`、`src/service/recovery.ts`、`src/service/turn-recorder.ts`、[ADR 027](../adr/027-turn-admission-and-idempotency.md)、[ADR 028](../adr/028-execution-history-and-recovery.md) |
| 上下文预算与技能加载 | `src/agent/context-budget.ts`、`src/session/service.ts`、`src/skills/registry.ts`、`src/tools/skill.ts`、[ADR 030](../adr/030-per-request-context-budget.md) |
| 多模态 | `src/agent/content.ts`、`src/agent/request-plan.ts`、`src/media/`、[ADR 031](../adr/031-multimodal.md)、[一期验收报告](../multimodal-acceptance.md) |
| 模型轨迹与状态边界 | `src/session/model-transcript.ts`、`src/service/model-transcript.ts`、`src/agent/context-projection.ts`、[ADR 032](../adr/032-model-transcript-and-prefix-cache.md)、[验收报告](./eunoia-模型轨迹与前缀缓存验收报告.md) |
| Web 与流式协议 | `web/app.js`、`src/api/sse.ts`、`tests/web/`、`tests/api/` |

以下数据只适合附带对应证据介绍，不直接写成生产收益：

- 多模态一期验收报告记录 1325 项测试通过、27 项跳过，以及 3 项真实端点 smoke 通过。这是该次交付记录，不是本次重新执行全仓测试的结果。
- 前缀缓存合成长回复对照中，输入参考费用下降 32.07%、含输出总参考费用下降 12.46%。该实验绕过了项目实际 SDK 适配器，不能描述为线上调用成本已降低 32%。详见 [实验评估](../research/prefix-cache/eunoia-前缀缓存方案对照评估.md)。

正文不宣称生产环境已部署 gVisor、全部文件操作均在容器内执行，或模型间缓存可迁移。持久模型轨迹已实现并验收，但真实费用收益只按 S01 小样本表述（输入长度 +36.46%、总参考费用 −2.47%），不宣称固定节省。
