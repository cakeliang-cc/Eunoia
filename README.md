# Eunoia

![Eunoia](docs/cover.png)

一个为 INFP 设计的个人 AI。

它不试图对所有人及格。它记住你，理解你正在经历什么，在你需要的时候给出具体、可用的回答。

## 快速开始

```bash
npm install
cp .env.example .env       # 填 DEEPSEEK_API_KEY，并生成同一个 POSTGRES_PASSWORD / DATABASE_URL 密码
docker compose up -d       # Postgres 17 + pgvector，127.0.0.1:5433
npm run migrate
npm run dev                # http://127.0.0.1:8787
```

`npm run dev` 会读 `.env`。默认使用 Postgres；没有 `DATABASE_URL` 时会退回内存 store，功能可用，但重启后什么都不剩。

HTTP 和 Postgres 默认都只绑 `127.0.0.1`。当前没有登录，不要直接暴露到公网。

```bash
curl http://127.0.0.1:8787/health
# {"status":"ok","prompt_version":"...","store":"postgres","persistent":true,"single_user":true}
```

## 它有什么

- **稳定的人格行为。** 一个 Agent，不是四个协作的 agent；Fi / Ne / Si / Te 是它内部的四种注意力方向。
- **长期记忆。** 记住事实、偏好、关系和正在发生的事；记忆可见、可修正、可删除。
- **会话连续性。** 历史持久化；接近上下文预算时压缩成结构化 checkpoint，原始消息不删除。
- **安全边界。** 高风险轮次先缓冲、先检查，再渲染回复。
- **可换模型/provider。** 模型能力、会话预算和 provider 连接分开；每个会话可以 pin 一个模型。
- **前缀缓存友好。** 稳定提示词和历史在前，每轮变化的背景放在请求尾部。

## 快速看架构

```text
web/  ── HTTP + SSE ──▶  src/api/
                          │
                          ▼
                     src/service/       一轮对话的编排
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   src/session/      src/memory/       src/agent/
        │                 │                 │
        └─────────────────┴─────────────────┘
                          ▼
                       src/db/
```

`session` 和 `memory` 是平级的两层，彼此不 import；`src/store.ts` 是唯一把它们组合起来的地方。HTTP 只出现在 `src/api/`，厂商 SDK 只出现在 `src/agent/` 和 `src/provider/`。这些边界由测试强制，不靠约定。

## 会话与上下文

会话可以创建、改名、归档和删除；归档可逆，删除不可逆。接口都在 `/api/conversations` 下。

模型不会永远收到全部消息。接近输入预算时，较早历史会被压成滚动摘要，写进 `conversation_summaries`，边界记成 `messages.seq`。模型收到“摘要 + 边界之后的原文”；数据库里的原始消息一条都不删。

请求按固定顺序组装：

```text
稳定 instructions + tools + 追加的历史 + 当前用户消息 + 本轮背景
```

关系、时间、摘要、记忆和安全指令都在最后一段，不会因为一条新记忆就让整段历史失去缓存。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动服务，web 客户端在 `/` |
| `npm test` | 离线测试，不需要网络或容器 |
| `npm run smoke` | 真实对话 smoke test（需要 `RUN_SMOKE=1`） |
| `npm run eval` | 人格评测，真实调用并记录 |
| `npm run eval:replay` | 对最近一次记录重新打分，免费 |
| `npm run migrate` | 应用 migration |
| `npm run cleanup` | 保留期清扫，支持 `--dry-run` |
| `npm run backup` | `pg_dump` 到 `backups/`，并校验 dump |
| `npm run typecheck` / `npm run lint` | 类型和 lint 门禁 |

Postgres 集成测试在没设 `DATABASE_URL` 时会自动跳过。

## 评测

30 条用例，覆盖艰难时刻、普通回合和长期连续性。能机械化的检查就机械化；禁止行为会报告出来，而不是悄悄警告。

```bash
npm run eval
npm run eval:replay
```

真实调用是贵的那一步，记录会提交进仓库；之后的检查项迭代可以免费重放。基线在 [`CHANGELOG.md`](CHANGELOG.md) 的 `Evaluation` 一节。

## 隐私

日志不写原始用户内容，只写类别和指纹。记忆可查看、修正、删除；`DELETE /api/me` 会抹掉调用者和由他派生的一切。身份目前只是一个 handle，不是认证——不要把真实数据放在一个没有登录保护的公开实例后面。

## 文档

- [为什么做 Eunoia](docs/story.md)
- [ADR](docs/adr/)：一个 Agent、记忆模型、事件边界、安全缓冲、提示词文档、保留与删除
- [重构计划](docs/REFACTORING_PLAN.md)
- [实现计划](docs/implementation-plan.md)
- [当前环境](CURRENT_STACK.md)
- [变更记录](CHANGELOG.md)

## 状态

Phase 0–5 已完成。剩余的主要是生产化问题，而不是功能：身份还不是认证，也没有限流。完整路线图和“不做什么”的理由在 [`docs/REFACTORING_PLAN.md`](docs/REFACTORING_PLAN.md)。
