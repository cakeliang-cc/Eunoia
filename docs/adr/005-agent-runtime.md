# ADR 005 — Agent 运行时：在 DeepSeek 之上使用 OpenAI Agents SDK

## 背景

spec §8 推荐 OpenAI Agents SDK。模型提供方是 DeepSeek，这是本环境唯一持有凭据
的提供方（`ANTHROPIC_BASE_URL=https://api.deepseek.com`、
`ANTHROPIC_AUTH_TOKEN`；一个可用的 DeepSeek API key）。

DeepSeek 自称同时兼容 OpenAI 与 Anthropic 两个 SDK：

```
base_url (OpenAI)    = https://api.deepseek.com
base_url (Anthropic) = https://api.deepseek.com/anthropic
models               = deepseek-flash, deepseek-v4-pro
```

### 对本 ADR 早前修订的更正

本 ADR 的早前修订曾判定 OpenAI Agents SDK 在此处**不可用**，理由是端点的
OpenAI 格式路由被认为返回 404。**那是错的，建立在它之上的那个决定被撤回。**

这个假阴性有两个叠加的成因：

1. **一次瞬时的 404 被当成了结构性事实。** 在第一个探测窗口期间，该端点对若干
   路由返回 404，包括 `GET /v1/models`。它们全都正常工作。一次对照探测
   （连续 8 次调用，8/8 HTTP 200）确认端点是稳定的；那些 404 是瞬时的。
2. **一个未知的模型名被误认为缺失的路由。** 错误的模型名在 Anthropic 路由上
   返回 HTTP 404，但在 OpenAI 路由上返回 HTTP 400。第一次探测针对一个尚未解析
   的模型命名空间使用了 `deepseek-v4-flash`，由此产生的 404 被读作"该路由不
   存在"，而不是"那次调用失败了"。

这个教训记录在此，因为它塑造了一个真实的决定：**一次观测不等于一个结论。**
下结论前重新探测；当一次探测失败时，先检查*对照*探测是否也失败，再把失败归因
于被测的那个东西。

## 决定

使用 **OpenAI Agents SDK**（spec §8），以 `AsyncOpenAI` 针对 DeepSeek 配置：

```ts
new AsyncOpenAI({
  baseURL: "https://api.deepseek.com",   // OpenAI-compatible surface
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
```

SDK 通过 **Responses API**（`/v1/responses`）驱动 DeepSeek，而 DeepSeek 原生
实现了它——因此 SDK 的默认模型路径可用，*不需要* `OpenAIChatCompletionsModel`
这一变通做法。

采纳前已针对线上端点验证：

| 能力 | 路由 | 结果 |
|---|---|---|
| Responses API | `POST /v1/responses` | 可用，`status: completed` |
| Tool calling | Responses API | `function_call` 输出项，带 `call_id` + JSON 字符串形式的 `arguments` |
| Reasoning | Responses API | `reasoning` 项，带 `reasoning_text` |
| Tool calling | `POST /v1/chat/completions` | `finish_reason: tool_calls` |
| Streaming | 两者 | SSE 增量 |
| Prompt caching | 两者 | 通过 `*_tokens_details.cached_tokens` 报告 |
| Stability | — | 8/8 HTTP 200 |

提供方的构造被限定在**一个模块**中。Agent 核心、记忆服务、工具、guardrails 与
评测从不直接导入厂商 SDK。

模型 ID 必须是规范的 `deepseek-flash` / `deepseek-v4-pro`。别名
`deepseek-chat`、`deepseek-reasoner` 与 `deepseek-v4-flash` 都会静默解析为
`deepseek-flash`；因此配置 `deepseek-reasoner` 会在毫无报错的情况下悄悄运行
错误的模型。

## 备选方案

1. **在 Anthropic Messages API 上手写循环。** 可行——已验证可用。作为默认方案
   被否决：SDK 提供了 §10 与 §14 所要求的循环、工具分发、guardrails 与
   tracing，重建它们正是 §0 所警告的不必要的工作。保留作为 SDK 在实践中被证明
   不兼容时的后备方案。
2. **格式转换适配层（OpenAI SDK ↔ Anthropic 路由）。** 已否决。一层额外且脆弱
   的中间层，会静默地错误转换工具调用与流式语义——而这两者正是最被依赖的
   能力。
3. **申请一个 OpenAI 账号并在 OpenAI 模型上运行。** 因没有必要而否决：它会为了
   满足一个 DeepSeek 的兼容性已经满足的 SDK 偏好，而引入第二个厂商、第二份
   凭据和第二笔账单。

## 理由

§8 对 SDK 的偏好针对的是*harness*——循环、工具、tracing、guardrails——而不是
背后是谁的权重。DeepSeek 的 OpenAI 兼容表面让本项目可以取走 harness 而不取走
厂商，这严格优于另外两个方案：spec §8 得到遵守，不需要新的凭据，而提供方在
单个模块之后保持可替换。

## 后果

- **原先的"OpenAI API key"阻塞项已撤回。** 现有的 `ANTHROPIC_AUTH_TOKEN` 是
  一个在所有路由上都可用的 DeepSeek key。
- **tracing 必须有意识地配置。** Agents SDK 的 tracing 后端默认托管在 OpenAI；
  没有 OpenAI 凭据时，默认 exporter 会失败。tracing 必须要么禁用，要么指向一个
  自定义 processor。spec §14 要求运行可追踪，因此路径是自定义 processor 加上
  应用层的结构化日志——而不是禁用 tracing。
- 模型选择是二选一的决定（`deepseek-flash` 对 `deepseek-v4-pro`），而不是一个
  家族。两者的上下文窗口都是 1,048,576 token，这**不会**放松 §6 的检索预算：
  预算的存在是为了控制成本、延迟与注意力稀释，而不只是为了塞进窗口。
- Prompt caching 可用，并报告命中/未命中的 token 数。长而稳定的指令前缀
  （§11 的 prompt）应当按顺序排列，以从中受益。
- 由于运行时不使用该端点的 Anthropic 表面，早前关于 Anthropic 路由的发现仅作为
  备选方案 1 的后备路径保留在 `CURRENT_STACK.md` 中。
