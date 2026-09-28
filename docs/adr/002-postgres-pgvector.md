# ADR 002 — Docker 中的 PostgreSQL + pgvector

## 背景

spec §5 默认选用 PostgreSQL + pgvector，并禁止在第一版引入独立的向量数据库。

侦察发现本机只有 `libpq` **客户端**（17.6）：`postgres` 服务端二进制并不存在，
也没有数据目录。Docker CLI 已安装，但侦察时 daemon 未在运行。

记忆是应用数据——它需要关系完整性、`user_id` 作用域、type/source/confidence
列、更新时间戳与过期时间——而不只是向量相似度。spec §5 明确指出，仅靠
`vector -> text` 是错误的模型。

## 决定

在 Docker 中运行带 `pgvector` 扩展的 PostgreSQL，使用官方
`pgvector/pgvector:pg17` 镜像。固定镜像 tag。schema 由提交进仓库的版本化 SQL
migration 定义。

工具链通过 `MemoryStore` 接口与它通信，因此检索与写入策略的代码从不直接依赖
驱动。

## 备选方案

1. **Homebrew 安装（`postgresql@17` + `pgvector`）。** 已否决。它会安装一个常驻
   的后台服务并改动宿主机系统；更难重置到已知状态，也更难复现。Docker 是一次性
   的，这契合一个会频繁迭代 schema 的项目。
2. **嵌入式/进程内存储（SQLite、内存）。** 因用户的决定而否决，并且它偏离
   spec §5。它还会把真正的集成风险推迟，而不是消除。
3. **独立向量数据库（Pinecone/Qdrant/Chroma）。** 已否决——spec §0 与 §5 明确
   禁止在 MVP 中使用，而且在本项目这个规模上，它只会把应用数据拆到两个存储里，
   毫无收益。

## 理由

Docker 给出一个精确、固定、可复现的 Postgres+pgvector，一条命令即可拆除，因此
Phase 2 的 schema 工作可以反复迭代而不在宿主机上留下残留。pgvector 是与关系型
记忆行位于同一个数据库里的扩展，这正是 §5 所要求的：`embedding` 列与
`confidence`、`source`、`importance` 位于同一行。

## 后果

- **阻塞项，需要用户操作：** 必须让 Docker daemon 运行起来，才能提供数据库。
  `docker ps` 目前连接失败。
- 连接串来自 `DATABASE_URL`；没有任何地方硬编码凭据。
- migration 必须能在全新容器上运行且幂等，因此重置就是
  `docker compose down -v && docker compose up -d` 加上 `npm run migrate`。
- `embedding` 列**从第一个 migration 起**就创建为 nullable 且类型为 `vector`，
  尽管 embedding 被推迟（见 ADR 004）。这样以后加 embedding 是回填，而不是
  schema migration。
- schema 变更需要新的 migration 文件；不允许修改已应用的 migration。
