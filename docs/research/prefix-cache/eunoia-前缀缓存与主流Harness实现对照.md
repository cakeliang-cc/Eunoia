# Eunoia 前缀缓存与主流 Harness 实现对照

研究日期：2026 年 11 月 8 日。结论：建议近期补齐可恢复的模型轨迹，在正常轮次保留前缀、状态变化时追加更新、压缩时明确建立新边界。将它列为多模态接口与执行恢复稳定后的下一项基础改进。

本地真实长回复复测已经显示输入费用收益；主流实现进一步说明，这项能力同时关系到会话恢复、工具历史和动态状态的一致性。当前完成研究与范围设计，未修改生产代码。

后续选型已确定：结合 DSH 的背景快照与顺序回放、Codex 的状态基线与恢复边界；OpenCode 仅保留为研究对照，不作为实施参考。可交给 DSH 的任务见 [实施清单与验收](../../plans/eunoia-模型轨迹与前缀缓存实施清单.md)，对外介绍见 [当前能力与亮点](../../features/eunoia-前缀缓存与模型轨迹亮点介绍.md)。

## 四个项目分别怎么做

### Codex

Codex 的 `ContextManager` 保存有序模型条目，包括模型生成内容和工具结果；世界状态保存比较基线，由 `render_history_diff()` 生成当前状态相对于基线的更新。环境状态比较涉及目录、日期、时区、网络和文件系统等字段。其设计提供了“初始上下文加后续状态更新”的机制。[模型历史与状态基线](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/context_manager/history.rs)，[状态差异生成](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/context/world_state/mod.rs)，[环境状态比较](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/context/world_state/environment.rs)。

传输层也利用这个性质：WebSocket 续传先检查请求配置是否一致，再验证当前输入是否以“上次输入加服务端返回的输出”为前缀，通过后仅发送新增条目。完整逻辑历史仍然存在；传输增量与服务端 KV 缓存是两个不同机制。Eunoia 可以先复用前者所依赖的轨迹稳定性，不需要一并实现 WebSocket 续传。[增量输入检查](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/core/src/client.rs)。

OpenAI API 官方文档建议追加新消息而非重写旧轮次，并指出压缩和截断会改变前缀。会话存在本身并不保证缓存命中。[OpenAI 官方缓存文档](https://developers.openai.com/api/docs/guides/prompt-caching)。

### Claude Code

官方文档描述了固定系统指令、项目背景和增长中的消息/工具历史。团队文章明确说明：时间、文件等状态变化可通过后续消息中的提醒传入，以保留之前的前缀；摘要请求也尽量沿用主会话的指令、工具和历史，再追加摘要要求。摘要替换历史后，旧会话前缀仍会改变。[Claude Code 缓存说明](https://code.claude.com/docs/en/prompt-caching)，[Claude Code 团队文章](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)。

这里依据官方产品文档和团队文章，没有把公开发行仓库视为完整核心源码核验。

### DeepSeek Harness

DSH 的 `RuntimeContextProjection` 记住当前保留的背景快照：文本相同则不生成新消息，变化则形成新的有来源标记的 user 消息，交给循环追加到持久会话中。背景清空也有明确撤销旧快照的标记。该组件比较的是整个快照，不应称为按字段计算最小差量。[动态背景投影](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/runtime-context.ts)，[循环提交与请求构建](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts)。

时间是单独的上下文插件，在符合刷新条件时追加有来源的时间消息。系统提示词更新则检查适配器能力：支持在历史中更新的连续请求可以追加；不支持的路由或特定边界会重新整理系统节点。因此“追加 system 即可适配全部模型”并不是 DSH 的做法。[时间注入](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/context/time-context/src/index.ts)，[系统提示词更新策略](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/runtime-context.ts)。

压缩插件把选中的历史区间替换为摘要节点；生成摘要时会恢复系统头、工具声明及待压缩消息的顺序，以争取复用已有缓存。正常追加和压缩替换有不同的会话操作。[压缩区间与摘要输入](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/region.ts)。

### OpenCode

本次核对当前 dev 源码和 V2 文档。`InstructionState` 保存本阶段的初始指令值与当前值；初始化建立基线，后续变化生成带冻结文本的持久事件，避免重放时从外部文件重新渲染旧更新。`advanceEpoch()` 会把当前值提升为新阶段基线。[指令状态与更新](https://github.com/anomalyco/opencode/blob/da8c0211f7c00afbf1dd96e629801fe84d205541/packages/core/src/session/instruction-state.ts)。

请求组装使用初始指令和模型消息；缓存策略在独立 AI 层处理，对需要显式标记的协议放置工具、system 和消息尾部断点，按路由适配。它不会对所有模型统一注入某一种供应商字段。[请求组装](https://github.com/anomalyco/opencode/blob/da8c0211f7c00afbf1dd96e629801fe84d205541/packages/core/src/session/model-request.ts)，[缓存策略](https://github.com/anomalyco/opencode/blob/da8c0211f7c00afbf1dd96e629801fe84d205541/packages/ai/src/cache-policy.ts)。

V2 在接近窗口上限时以摘要替换旧对话，同时保留近期内容，原始消息仍存储在数据库中。文档也区分供应商原生压缩与本地摘要，原生不透明检查点具有模型/供应商限制。[OpenCode V2 压缩说明](https://dev.opencode.ai/docs/compaction/)。

## Eunoia 的具体缺口

当前 `src/service/chat.ts` 从数据库重建历史时只选择 user 和 assistant；`buildRunInput()` 再附加本轮 user 与动态背景。旧动态背景没有进入下一轮重放。工具调用、结果和 reasoning 虽在本轮循环的输入数组中追加，这个跨轮入口没有重建同样的完整条目序列。

所以，“聊天记录保存了”与“下一轮重现模型之前看到的输入”并不等价。长 assistant 回复的前缀损失已通过本地实验观测；工具轨迹改变的费用和质量影响尚未通过真实工具任务测量。

当前项目已有数据库会话、追踪记录、摘要与预算机制，可在这些能力上补充模型回放。已有的存储 system 行含业务记账用途，不能简单取消 role 过滤、把所有 system 行送给模型。

此外，循环的 usage 当前保存最后一步，用于展示的最后一次上下文大小与整轮累计费用有不同含义。后续比较应累加每次实际请求 usage；缓存量缺失要保留未知状态，不能凭空补成命中。

## 建议的最小完整范围

1. **保存可回放的模型条目。** 为会话维护有序轨迹，覆盖实际纳入请求的上下文、assistant 内容、工具调用和结果；复用既有追踪存储时明确转换规则。UI 聊天消息继续承担展示用途。图片引用固定资产与发送版本，供应商私有回放元数据单独标识兼容范围。
2. **背景按块比较，变化时追加。** 对目录、权限、记忆和技能说明维护当前版本；同一块未变化不重复发送。第一版允许块级完整快照，不必实现任意文本差异算法。删除或清空必须显式表达，不能仅省略该块。时间独立控制刷新，避免一个时钟变化触发全部背景重发。
3. **明确生效与提交语义。** 新状态带适用范围和生效位置，旧状态作为历史保留；工具执行始终读取当前真实策略。仅在上下文确实纳入请求后推进“模型已知状态”基线。重试、恢复和取消时避免重复追加或错误跳过更新。
4. **沿用预算并统一压缩边界。** 常规轮次追加；压缩、回退或编辑历史时建立明确边界，重新装入当前状态并重置比较基线。压缩后允许缓存从新前缀建立。不能因为命中而漏算窗口 Token，也不能让压缩器随意制造无配对的工具调用和结果。
5. **供应商适配和逐请求计量。** 核心负责轨迹与状态；适配器负责角色、内容顺序、显式缓存字段、推理签名和原生检查点兼容性。换模型时保留可移植内容，重建新模型前缀；不兼容内容按明确策略处理。费用比较使用每一步实际 usage，区分输入费用、输出费用和窗口占用。

暂缓 WebSocket 增量传输、完整事件溯源框架、后台摘要以及复杂缓存路由优化。它们不是获得这次已观测收益的前提。

## 用一个会话说明目标行为

下面是逻辑条目顺序，实际 wire 角色由供应商适配器决定：

```text
第一轮：固定指令/工具 → 用户1 → 状态v1 → 助手1
第二轮：固定指令/工具 → 用户1 → 状态v1 → 助手1 → 用户2 → 助手2
第三轮：固定指令/工具 → 用户1 → 状态v1 → 助手1 → 用户2 → 助手2
                         → 用户3 → 状态v2（目录改变）→ 助手3

达到预算后：固定指令/工具 → 摘要检查点 → 当前状态基线 → 保留的近期轨迹 → 后续条目
```

第二轮状态未变，无需重新附上整个背景；第三轮目录变化则追加目录更新。压缩时保留轨迹的选择、当前状态放置及摘要内容必须一起定义，确保保留的旧更新不会覆盖新基线。缓存复用始终以最终请求和供应商实际 usage 为准。

## 验收要证明什么

- 未压缩、未切模型的普通轮次，适配后的已发送历史内容及顺序保持一致；下一轮为同一已知轨迹追加新条目。显式缓存标记可按供应商规则移动，不能只比较内部数组就声称 wire 前缀稳定。
- 至少覆盖长回复、两步工具调用、状态不变、状态改变、状态清空、重启恢复、重试去重、取消中断和模型切换。未完成调用应明确恢复或终止，不能盲目重跑有副作用的工具。
- 压缩后所有仍生效的状态得到重新建立，工具调用与结果保持合法配对；原始记录可查询；预算包含图片、工具声明和预留输出。
- 相同权限变化脚本下，模型得到新的状态提示，执行器也按当前策略拒绝不允许的工具动作。文字回答检查不能替代真实策略执行检查。
- 真实对照从项目实际适配器发送，长回复逐字回填并包含工具轮次；交换运行顺序，报告累计未命中 Token、输入费用、总费用和实际窗口长度。32.07% 是现有合成长回复样本的结果，不作为硬编码验收阈值，也不能把结构稳定等同于服务端必然命中。

现有 16 请求实验是设计方向的依据，绕过了项目实际模型适配器，并未覆盖工具、推理回放或长会话压缩。上线验收应补齐以上针对性检查，不需要先建设沙箱 Bench 或通用评测平台。

## 版本与关联记录

源码依据以下提交固定：Codex `748ab55ca7de0b647d9a7a9d9a8e70e00f28666d`；DSH `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`；OpenCode `da8c0211f7c00afbf1dd96e629801fe84d205541`。官方产品文档按研究日期读取。

- [本地对照实验与修正结论](eunoia-前缀缓存方案对照评估.md)
- [多模态实施计划与验收](../../plans/eunoia-多模态实施计划与验收.md)
- [图片 Token 与请求预算](../../design/eunoia-图片Token与请求预算.md)
