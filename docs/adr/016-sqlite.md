# ADR 016 — 存储：从 Postgres + Docker 切到 SQLite 单文件

## 背景

ADR 002 选了 PostgreSQL + pgvector，用 Docker 跑在 5433。当时的理由是：
memory 的 schema 会增长，检索以后可能要向量，数据库应该在一个真实的服务端上。

这个理由对多用户、多进程、远程部署成立。对现在这个产品不成立：

- 它是单用户、单进程、跑在一台 Mac 上的个人应用；
- `pgvector` 从未被读取。`memories.embedding` 从第一次 migration 起就存在，
  但 ADR 004 一直 deferred，没有任何查询用它；
- 为了一个本地文件服务，运行时要带着 Docker Desktop、一个 Postgres 容器、
  一个密码、五份 migration 和一个 837 行的 `PostgresStore`；
- 这套依赖已经真实地坏过：Docker 的宿主机端口转发卡住，服务只能退回
  `InMemoryStore`，于是“重启后记忆还在”这个承诺在用户不知情时变成了假的。

## 决定

使用 **SQLite 单文件**，通过 Node 内置的 `node:sqlite`（`DatabaseSync`）。

### 1. 存储位置与模式

默认：

```text
data/eunoia.sqlite
```

可用 `SQLITE_PATH` 覆盖；`:memory:` 或 `STORE=memory` 走进程内 store，重启即丢。
SQLite 文件使用 WAL、`foreign_keys=ON`、`busy_timeout=5000`。

`selectStore()` 不再读取 `DATABASE_URL`；如果环境里还留着它，只记一条
`store.database_url_ignored`，不会把 Postgres 栈带回来。

### 2. 类型映射

SQLite 没有 uuid、timestamptz、jsonb、数组和 boolean。映射固定在
`src/db/sqlite-store.ts` 的行边界：

| 领域类型 | SQLite |
|---|---|
| id（uuid 字符串） | `TEXT PRIMARY KEY`，由 `crypto.randomUUID()` 生成 |
| `Date` | ISO-8601 UTC `TEXT` |
| JSON（tags、工具调用、偏好、checks） | `TEXT`，在 store 内 `JSON.parse/stringify` |
| boolean | `INTEGER 0/1` |
| `bigint` 计数 | `INTEGER` / `count(*)`，读出后 `Number()` |

上层仍然只看到 `src/memory/store.ts` 和 `src/session/store.ts` 的领域类型；
没有列名、snake_case 字段或 JSON 字符串泄漏到 store 之外。

### 3. 事务与并发

单进程 + WAL。需要原子的写序列使用 `BEGIN IMMEDIATE`：

- `appendMessage`：校验会话归属 → 取 `MAX(seq)+1` → 插消息 → 更新会话计数/归档；
- `upsertEvaluationCases`、`saveEvaluationResults`；
- 其他单语句写由 SQLite 自己保证。

这不是一个多写者的数据库方案。这个产品没有多写者；如果以后有，SQLite 的
WAL 仍然允许一个写者和多个读者，但真正的多进程写入需要重新评估。

### 4. 外键与级联

`PRAGMA foreign_keys=ON`，schema 保留 ADR 013 的删除语义：

- `users` 删除时，`conversations`、`messages`、`memories`、`memory_events`、
  `user_preferences`、`message_feedback` 级联删除；
- `agent_runs.user_id` / `conversation_id` `ON DELETE SET NULL`——测量比人活得久；
- `memories.source_message_id`、`superseded_by` `ON DELETE SET NULL`。

Postgres 测试里那条“先写会话、用户不存在”的回归用例被原样保留在
`tests/db/sqlite.test.ts`，因为 `InMemoryStore` 不强制外键，只有真实 schema 能看见它。

### 5. 迁移

`PRAGMA user_version` 是 schema 版本，当前为 1。第一次打开文件时应用 schema；
比当前版本更新的数据库会拒绝启动，而不是被旧代码静默改写。`npm run migrate`
只是初始化并打印路径，不是一个必须有前置步骤的 migration 服务。

已有的 Postgres 数据**不自动迁移**。这是这次切换的明确取舍：数据库当前不可用，
且它是开发数据；需要时再写一次性导出/导入，而不是为了保留它继续背负 Docker。

### 6. 备份

`npm run backup` 使用 `node:sqlite` 的在线 backup API 写到 `backups/`，然后
打开副本做 `PRAGMA integrity_check`。备份是一个被读过、能通过完整性检查的文件，
不是一次 `cp`。

## 备选方案

1. **JSON / JSONL 文件 + 内存索引。** 最像 CLI agent（Claude Code / Codex 的
   transcript），没有数据库。被否决：这个产品有会话列表、消息分页、记忆过滤、
   偏好、反馈、保留期删除和评测结果，全部手写索引与删除逻辑，代码量和出错面都比
   schema 大；而且一次半写会留下一个需要人工修复的 JSON。
2. **PGlite（WASM Postgres）。** 没有服务，保留 SQL/Postgres 语义。被否决：
   仍然带着 Postgres 的 schema 和迁移概念，只是把进程外换成了 WASM；对这个
   单用户应用，收益不抵复杂度。
3. **`better-sqlite3`。** 稳定、成熟，但引入 native 依赖和构建步骤。
   `node:sqlite` 是零依赖，代价是 experimental API 和 Node 版本下限。
4. **继续 Postgres。** 被否决：见背景。

## 后果

- **启动不再依赖 Docker。** `npm install && npm run dev` 就够了；`npm run migrate`
  可选。
- **Node 版本下限变成 22.5**，脚本带 `--experimental-sqlite`。这是 experimental
  API；如果它变得不可接受，替换点是 `src/db/sqlite-store.ts` 一个文件，
  `Store` 接口不变。
- **没有 pgvector。** 当前本来就没用。以后要做 embedding，可以把向量存 BLOB，
  或引入 `sqlite-vec`；那是一个新 ADR，不是恢复 pgvector 的理由。
- **单文件既是优势也是边界。** 备份/迁移/检查都是一个文件；代价是不能把写压力
  分散到多个进程。
- **旧 Postgres 数据有一个一次性迁移，不是自动导入。** `npm run migrate:legacy`
  通过 `docker exec psql` 只导入 `SINGLE_USER_ID` 对应的人，可重复执行；它跳过
  评测遗留用户，因为旧库里 595 个用户中只有这个是真实对话（5 个会话、58 条消息、
  33 条 agent_runs）。旧容器和卷仍然保留，确认不需要后可以删除。会话/记忆的
  “重启后还在”现在是文件级的真实承诺，不再取决于容器是否健康。

## 相关文件

- `src/db/sqlite-schema.ts` — schema 与 `user_version`
- `src/db/sqlite-store.ts` — `Store` 的 SQLite 实现
- `src/db/select.ts` — 默认路径、`STORE=memory`、忽略 `DATABASE_URL`
- `src/db/migrate.ts` — 初始化并打印路径
- `scripts/backup.ts` — 在线备份 + 完整性检查
- `scripts/migrate-legacy-postgres.ts` — 一次性导入旧 Postgres 中 `SINGLE_USER_ID` 的数据
- `tests/db/sqlite.test.ts` — 真实数据库的翻译、外键与级联
- ADR 002 — 被本文取代
