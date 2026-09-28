# ADR 003 — 四层记忆模型

## 背景

spec §4 定义了四个层次：working、episodic、semantic-personal、narrative。它们
在生命周期、可变性，以及一个错误的值要付出多大代价上各不相同。

朴素的实现——用一张 `memories` 表装下所有东西——丢失了真正重要的那些区分。一个
持久的值（"真实性对我来说很重要"）与一个有日期的事件（"2026-09-20 在一家设计
公司面试"）有不同的更新语义、不同的检索触发条件、不同的失效模式。

## 决定

四层，每层有明确的生命周期与写入规则：

| 层次 | 作用域 | 存储 | 生命周期 |
|---|---|---|---|
| Working | 单个会话 | 进程内会话状态 | 会话结束时丢弃 |
| Episodic | 用户 | `memories` 行，`type='episodic'` | 长期，带日期，近乎不可变 |
| Semantic-personal | 用户 | `memories` 行，`type IN ('value','preference','pattern')` | 长期，可更新，追踪 confidence |
| Narrative | 用户 | `memories` 行，`type='narrative'` | 长期，**可更新且可纠正** |

episodic、semantic 与 narrative 共用一张表，以 `type` 作判别符，并共享一套治理
列，因为它们共享检索机制，并且都需要 `confidence` / `source` / 时间戳。working
memory *不*持久化到这张表——它是会话状态。

每条持久化的记忆行都携带：`confidence`、`source`、`created_at`、`updated_at`、
`last_accessed_at`、`expires_at`、`importance`。

## 备选方案

1. **一张不加区分的 `memories` 表。** 已否决——没有地方表达不同的写入与纠正
   规则，而且它让 §13 的记忆准确度评分失去意义（没有按类型区分的规则，就无从
   定义什么是"正确"）。
2. **每一层一张独立的表。** 在 MVP 中否决——三张带有相同治理列的表会把 migration
   与查询成本成倍放大，却毫无收益；检索需要跨层次一起排序。一个 `type` 判别符
   加每种类型一个 partial index 即可覆盖。
3. **把 narrative memory 存成自由文本的 profile blob。** 已否决。spec §4.4 要求
   narrative memory 可更新、可纠正、带 confidence——blob 无法被部分修订或评分，
   而且它会无声地变成 spec 所警告的那种"永久人格标签"。

## 理由

每一行上的 `confidence` 与 `source` 是让 spec §7 可执行的东西：系统可以拒绝
持久化低置信度的推断，并在此后区分用户实际说过的内容（`source='user_explicit'`）
与模型推断出的内容（`source='agent_inference'`）。这一区分是 eval case 07 所
要求的，也是 §7 那条反对把猜测当作事实存储的规则所要求的。

## 后果

- `memory_types.ts` 拥有类型联合与按类型的有效性规则；其他任何地方都不硬编码
  类型字符串。
- narrative memory 的更新必须**可修订**：在历史重要之处，纠正应当取代而非覆盖，
  因此 `memory_events` 记录这次变更。
- working memory 存在于会话状态中，绝不能写入 `memories` 表。
- eval 可以按层断言：显式偏好被存储（case 07）、猜测*不*被存储（§7）、narrative
  被纠正而不是被复制。
- 接受的取舍：单张带判别符的表意味着，类型专属的列对不使用它们的行来说是
  nullable 的。在 MVP 规模上这比三张表更便宜，日后可以在 `MemoryStore` 接口
  之后拆分。
