# 记忆存储调研

这份文档不是 ADR，也不是计划——**它是输入**。它回答的是一个外部问题："别人怎么存
记忆"，为下面两件事提供参照，而不是替它们做决定：

- `CHANGELOG.md` → `Known Issues` 里记着的工作记忆裁剪（compaction，下一步）；
- 记忆层的衰减、晋升与驱逐——目前只有 `status` 列，没有任何执行者。

**证据等级**：每条实质结论都指向一手来源（论文全文、官方文档 Markdown 端点、GitHub
源码），链接可点开自查；凡来源未陈述之处一律写「未验证」，**不做推测**。这不是修辞。
这个领域流传最广的几个数字恰好都是举例值或版本相关值——MemGPT 的 70/100/50 在论文里
写的是 `e.g.`，Generative Agents 的权重在论文与官方仓库里不是同一个——转述时丢掉这层
限定，它们就会变成假事实。

**覆盖面**：**这是调研的一部分，不是全景。** 本文涵盖四个图／学术派系统（Zep /
Graphiti、Cognee、MemoryBank、Generative Agents）。Letta（原 MemGPT）、MemoryOS、
A-MEM，以及 mem0 / LangMem / Memobase 与厂商原生记忆仍在整理中，落地后并入本文件。

---

面向目标：单人 TypeScript 长期陪伴 agent，Postgres + pgvector（无图数据库），四层记忆（working 不持久化 / episodic / semantic / narrative），检索是硬预算的 score-based，模型端点 DeepSeek **无 embeddings 路由**。

---

## 1. Zep / Graphiti

### 一句话定位
面向 agent 的**时序知识图谱记忆层**：Graphiti 是开源引擎（temporally-aware dynamic knowledge graph engine），Zep 是构建其上的托管 memory service。

来源：[Zep 论文 arXiv:2501.13956](https://arxiv.org/abs/2501.13956)、[ar5iv HTML](https://ar5iv.labs.arxiv.org/html/2501.13956)、[graphiti repo](https://github.com/getzep/graphiti)

### 存储模型

论文把图定义为 𝒢=(𝒩,ℰ,φ)，含三个层级子图：

* **Episode Subgraph 𝒢ₑ**：episodic nodes（episodes）存 raw input（message / text / JSON）
* **Semantic Entity Subgraph 𝒢ₛ**：entity nodes（从 episode 抽取并做 entity resolution）+ entity edges（实体间关系）
* **Community Subgraph 𝒢_c**：community nodes（强连通实体的聚类 + 高层摘要）+ community edges

**节点字段**（[`graphiti_core/nodes.py`](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/nodes.py)）：
* `Node` 基类：`uuid`、`name`、`group_id`（graph 分区）、`labels`、`created_at`
* `EpisodicNode`：`source`（`EpisodeType` = `message` / `json` / `text` / `fact_triple`）、`source_description`、`content`（注释即 *"raw episode data"*）、`valid_at`（*"datetime of when the original document was created"*）、`entity_edges: list[str]`、`episode_metadata: dict | None`
* `EntityNode`：`name_embedding: list[float] | None`、`summary`（*"regional summary of surrounding edges"*）、`attributes: dict`
* `CommunityNode`：`name_embedding`、`summary`（*"region summary of member nodes"*）
* `SagaNode`：`summary`、`first_episode_uuid`、`last_episode_uuid`、`last_summarized_at`、`last_summarized_episode_valid_at`

**边字段**（[`graphiti_core/edges.py`](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/edges.py)）：
* `EpisodicEdge` = `MENTIONS`：`(Episodic)-[:MENTIONS]->(Entity)`
* `EntityEdge` = `RELATES_TO`：`name`（关系名）、`fact`（事实文本）、`fact_embedding`、`episodes: list[str]`（引用该边的 episode id 列表）、`expired_at`、`valid_at`、`invalid_at`、`reference_time`、`attributes`，加上基类的 `source_node_uuid` / `target_node_uuid` / `created_at` / `group_id`
* `CommunityEdge` = `HAS_MEMBER`：`(Community)-[:HAS_MEMBER]->(Entity)`
* `HasEpisodeEdge` = `HAS_EPISODE`、`NextEpisodeEdge` = `NEXT_EPISODE`（episode 时序链）

**bi-temporal 四时间戳**（论文 2.2.3）：`t'created` / `t'expired ∈ T'` 是**事务时间**（系统何时创建/失效），`t_valid` / `t_invalid ∈ T` 是**事件时间**（事实何时为真）。这四者存在 edge 上。

### 存什么 / 不存什么
**保留原始逐字内容，且是 source of truth**。论文原文：*"Episodes serve as a non-lossy data store from which semantic entities and relations are extracted."* 并且 *"Episodes and their derived semantic edges maintain bidirectional indices ... semantic artifacts can be traced to their sources for citation or quotation, while episodes can quickly retrieve their relevant entities and facts."*

同时存：抽取的 entity（name + summary + attributes）、entity edge（fact + embedding）、community summary、Saga summary。

注意 episode 本身**没有 embedding 字段**——`EpisodeSearchMethod` 只有 `bm25`（[search_config.py](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/search/search_config.py)），即原始 episode 只走全文检索。

### 写入路径
论文 2.2 与附录 prompt 给出的实际 pipeline：

1. 摄入 episode（message/text/json），带 reference timestamp `t_ref`
2. **Entity extraction**：用当前 message + 最近 `n=4` 条消息（两个完整对话轮）作上下文做 NER；speaker 自动作为实体；随后用 reflexion 式 reflection 降低幻觉并提高覆盖率；同时抽 entity summary
3. **Entity candidate recall**：把 entity name embed 到 **1024 维**向量空间 → cosine 相似度搜索已有实体节点；**并行**对已有 entity name 和 summary 做 full-text 搜索取额外候选
4. **Entity resolution**：候选节点 + episode context 一起给 LLM 用 entity resolution prompt 判断；判定重复则生成更新的 name 和 summary（prompt：`is_duplicate: true/false`、返回已有 uuid、给"most complete full name"）
5. **Fact extraction**：在给定 entity 列表上抽 fact，`relation_type` 用全大写（`LOVES`、`IS_FRIENDS_WITH`、`WORKS_FOR`）；同一 fact 可在不同实体对间重复出现 → 论文称以 hyper-edge 方式建模多实体 fact
6. **Fact embedding + edge dedup**：与 entity resolution 类似的 dedup 流程；**hybrid search 被约束在相同 entity pair 之间已存在的边**——既防止不同实体间的相似边被错误合并，也大幅降低 dedup 计算复杂度
7. **Temporal extraction**：用 `t_ref` 解析绝对与相对时间，填 `valid_at` / `invalid_at`（ISO 8601）。prompt 明确：*"If the fact is written in the present tense, use the Reference Timestamp for the valid_at date"*、无时间信息则留 null、只按年份给出时用该年 1 月 1 日 00:00:00
8. **Edge invalidation（矛盾处理）**：LLM 把新边与语义相关的已有边对比找矛盾；发现**时序重叠的矛盾**时，把受影响旧边的 `t_invalid` 设为**失效新边的 `t_valid`**；*"Following the transactional timeline T', Graphiti consistently prioritizes new information."* 旧边**不删除**，只是被 invalidate
9. 用**预定义 Cypher 查询**写入，而非 LLM 生成 DB 查询（论文：确保 schema 一致、减少幻觉）
10. **Community 构建**：用 **label propagation**（而非 GraphRAG 的 Leiden）；动态扩展 = label propagation 的单步递归——新 entity 节点归入其邻居**多数派**所在社区并更新社区摘要；社区 summary 用迭代 map-reduce 式摘要；社区名含关键术语并 embed 以支持 cosine 检索；动态扩展会逐渐偏离全量结果，因此仍需周期性 refresh

### 检索路径
论文形式化 `f(α) = χ(ρ(φ(α))) = β`：**Search → Reranker → Constructor**。

**φ Search 方法**（三个 object type 的搜索字段不同）：
* edges 搜 `fact`；entities 搜 `name`；communities 搜 `community name`
* `EdgeSearchMethod` / `NodeSearchMethod` = `cosine_similarity` | `bm25` | `breadth_first_search`；`CommunitySearchMethod` = `cosine_similarity` | `bm25`；`EpisodeSearchMethod` = `bm25`（仅此一项）
* cosine 与 BM25 走 Neo4j 的 Lucene 实现
* **BFS**：从种子节点做 n-hop 扩展取额外节点与边，`bfs_max_depth` 默认 `MAX_SEARCH_DEPTH = 3`；可接受节点作参数，因此"用最近 episode 作 BFS 种子"是文档化用法

**ρ Reranker**：
* `EdgeReranker` / `NodeReranker` = `rrf` | `node_distance` | `episode_mentions` | `mmr` | `cross_encoder`
* `CommunityReranker` = `rrf` | `mmr` | `cross_encoder`；`EpisodeReranker` = `rrf` | `cross_encoder`

**实际融合公式**（[`search_utils.py`](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/search/search_utils.py)）：

* **RRF**：`scores[uuid] += 1 / (i + rank_const)`，`rank_const` 默认 **1**（即 1/1, 1/2, 1/3 …，**不是 60**）。排序后按 `min_score` 过滤。
* **node_distance_reranker**：只查 1-hop `RELATES_TO` 邻居，邻居 `score = 1`，center 自身 `score = 0.1`，其余 `= +inf`；按 score **升序**排；返回 `1/score` 作分数。即它实际是**一条边距离的二值信号**，而非多跳距离衰减。
* **episode_mentions_reranker**：先用 RRF 预排序，再 `MATCH (episode:Episodic)-[:MENTIONS]->(n:Entity) RETURN count(*) AS score`，按 mention count **降序**；完全没有 MENTIONS 的节点 score 记 0（排最后）。
* **MMR**：候选 embedding 先 L2 normalize，`mmr = mmr_lambda * dot(query, cand) + (mmr_lambda - 1) * max_sim`，其中 `max_sim` 是该候选与其它候选的最大 cosine；`DEFAULT_MMR_LAMBDA = 0.5`，但 recipes 里显式设 `mmr_lambda=1`。
* 其它常量：`DEFAULT_MIN_SCORE = 0.6`（cosine 相似搜索阈值）、`DEFAULT_SEARCH_LIMIT = 10`、`RELEVANT_SCHEMA_LIMIT = 10`、`MAX_QUERY_LENGTH = 128`。

**文档化的 search recipes**（[`search_config_recipes.py`](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/search/search_config_recipes.py)）：
* `COMBINED_HYBRID_SEARCH_RRF`：edge / node / community 均 `[bm25, cosine_similarity]` + `rrf`；episode `[bm25]` + `rrf`
* `COMBINED_HYBRID_SEARCH_MMR`：同上但 reranker = `mmr`，`mmr_lambda=1`（episode 仍 `rrf`）
* `COMBINED_HYBRID_SEARCH_CROSS_ENCODER`：edge / node 用 `[bm25, cosine_similarity, bfs]` + `cross_encoder`；community 用 `[bm25, cosine_similarity]` + `cross_encoder`
* `EDGE_HYBRID_SEARCH_RRF` / `_MMR` / `_NODE_DISTANCE` / `_EPISODE_MENTIONS` / `_CROSS_ENCODER`（后者 `limit=10`）
* `NODE_HYBRID_SEARCH_RRF` / `_MMR` / `_NODE_DISTANCE` / `_EPISODE_MENTIONS` / `_CROSS_ENCODER`（后者 `limit=10`）
* `COMMUNITY_HYBRID_SEARCH_RRF` / `_MMR` / `_CROSS_ENCODER`（cross-encoder 版 `limit=3`）

**高层 API**（[Zep 文档 Searching the Graph](https://help.getzep.com/v2/graphiti/working-with-data/searching)）：`graphiti.search(query)` = 语义相似 + BM25，用 RRF 重排；`graphiti.search(query, center_node_uuid=focal_node_uuid)` 在此基础上再加 node distance reranking。

**χ Constructor**：edge → 返回 `fact` + `t_valid` + `t_invalid`；entity → `name` + `summary`；community → `summary`。上下文模板含 `FACT (Date range: from - to)`。

论文实验用 top-20 edges + entity nodes，模型：BGE-m3 做 **embedding 与 reranking**，gpt-4o-mini-2024-07-18 做图构建，gpt-4o-mini / gpt-4o 做回答生成。

### 巩固 / 衰减 / 遗忘
* **巩固**：community summarization（label propagation 聚类 + map-reduce 迭代摘要 + 社区名 embedding），Saga 节点做 episode 序列的增量摘要（`last_summarized_at` 作水位线）。
* **遗忘**：只有 **temporal edge invalidation**（`invalid_at` / `expired_at`），旧边保留在图中不删除（non-lossy）。
* **没有 Ebbinghaus 式衰减曲线，也没有 TTL**：论文未提出任何基于时间或访问次数的衰减/遗忘机制，Graphiti 源码中亦未见 TTL 或 retention-decay 字段（**未验证**存在此类机制）。

### 工作记忆 vs 长期记忆
* **长期记忆** = user-level knowledge graph。Zep 文档明确：*"The knowledge graph does not separate the data from different sessions, but integrates the data together to create a unified picture of the user."*（[Zep Sessions 文档](https://help.getzep.com/v2/sessions)）
* **工作记忆** = session（一段对话）本身的消息序列。`memory.get` 不返回该 session 专属记忆，而是 *"whatever user-level memory is most relevant to that session, based on the session's most recent messages"*。
* **Zep v3 的 6 种 context type**（[context-types](https://help.getzep.com/v3/context-types)）：`Facts`、`Entities`、`Episodes`、`Thread summaries`、`Observations`、`User summary`；默认 Context Block 可全部包含，且 *"Smart Context Assembly selects available context that is relevant to the four most recent messages"*。可用 context template 选择 `%{user_summary}`、`%{edges}`、`%{entities}`、`%{episodes}`、`%{observations}`、`%{thread_summaries}`。

### embedding 依赖
**写入硬依赖 embedding，且硬依赖 LLM（每写一条消息调用很多次）**。
* embedding 必需：entity `name_embedding`（1024-d）、edge `fact_embedding`、community `name_embedding`；论文的 entity resolution 明确以 cosine 候选召回为前提。
* LLM 必需：entity extraction、entity resolution、fact extraction、fact dedup、temporal extraction、edge invalidation、community summarization —— 论文用 gpt-4o-mini 做图构建。
* 检索侧可以不靠 cosine（episode 只有 BM25），但写入侧不行。

### 可直接借鉴（TS + Postgres + pgvector，无 embedding）
| 借鉴点 | 可行性 |
| --- | --- |
| bi-temporal 四时间戳（`valid_at` / `invalid_at` / `created_at` / `expired_at`）做成普通列 | **现在就能做** |
| 新事实矛盾时把旧事实 `invalid_at` 设为新事实 `valid_at`（不删除，保留历史） | **现在就能做**（LLM 判矛盾或纯时间戳规则覆盖） |
| 原始 episode 逐字保留作 source of truth + edge→episode 双向索引（`episodes: uuid[]`）用于引用溯源 | **现在就能做** |
| RRF 融合 `1/(rank+1)`（`rank_const=1`）：多个排名 CTE 求和 | **现在就能做**（不需要 embedding；BM25 用 `ts_rank` 也能给出排名） |
| BM25 全文检索 | **现在就能做**（Postgres `tsvector` + `ts_rank_cd`，或 ParadeDB/pg_search） |
| BFS / n-hop 扩展（`bfs_max_depth=3`） | **现在就能做**——用 `WITH RECURSIVE` 在 edges 表上做，无需图数据库 |
| `episode_mentions` reranker（mention count 排序） | **现在就能做**（纯 `count(*)`） |
| `node_distance` 以 focal node 为中心的思路 | **现在就能做**，且用递归 CTE 算真实 hop 距离会比 Graphiti 自己的 1-hop 实现更好 |
| Saga / thread summary（`summary` + `first/last_episode_uuid` + `last_summarized_at` 增量水位线） | **现在就能做**，非常贴合 narrative 层 |
| community 检测（迭代 label propagation） | **现在就能做**（纯 SQL 多轮 UPDATE）；但 community **摘要**需要 LLM（仍不需要 embedding） |
| MMR 去冗余 | **需要 embedding** |
| cross-encoder reranker | **不适用**（需额外 rerank 模型） |

---

## 2. Cognee

### 一句话定位
开源的 **AI memory platform / memory engine**（topoteretes/cognee）：把文档、代码、会话变成自托管知识图谱，供 agent 跨 session 复用；v1.0 起**整个记忆层可跑在单个 Postgres 实例上**。

来源：[cognee README](https://github.com/topoteretes/cognee)、[Architecture](https://docs.cognee.ai/core-concepts/architecture)、[Data Flows](https://docs.cognee.ai/core-concepts/data-flows)、[DataPoints](https://docs.cognee.ai/core-concepts/building-blocks/datapoints)、[Recall](https://docs.cognee.ai/core-concepts/main-operations/recall)、[Sessions and Caching](https://docs.cognee.ai/core-concepts/sessions-and-caching)、[Forget](https://docs.cognee.ai/core-concepts/main-operations/forget)、[Cognify](https://docs.cognee.ai/core-concepts/main-operations/legacy-operations/cognify)

### 存储模型
**三种互补存储**，同一 DataPoint 的 `id` 在三种存储中共享，用来互相 join：

1. **Relational store**：documents、chunks、provenance（来源与链接关系）
2. **Vector store**：chunks 与 DataPoints 的 embedding
3. **Graph store**：entities 与 relationships

**DataPoint**（Pydantic 模型，最小知识单元）字段：
```
id: UUID
created_at: int          # ms epoch
updated_at: int
version: int = 1
topological_rank: Optional[int] = 0   # 依赖层级；被引用的 Entity 排名低于依赖它的 TextSummary
valid_to: int | None = None           # bi-temporal 被取代时刻（ms epoch）；None = 仍然有效
metadata: MetaData
type: str = "DataPoint"
ontology_uri: str | None = None
belongs_to_set: Optional[List["DataPoint"]] = None
```
`MetaData`（TypedDict，四个键）：`index_fields: list[str]`（必填，决定哪些字段被 embed）、`type`、`identity_fields`（去重键）、`transparent: bool`。

内置 DataPoint 类型：`Document`（`index_fields=["name"]`）、`DocumentChunk`（`["text"]`）、`TextSummary` / `CodeSummary` / `GlobalContextSummary`（`["text"]`）、`Entity` / `EntityType`（`["name"]`）、`Edge`。

**索引粒度**：每个 indexed field 生成**独立的 vector collection**，命名 `Class_field`（如 `Person_name`）；多 index field 时会按字段深拷贝 DataPoint、各存一份 embedding。向量命中后用共享 `id` 回图存储取全部属性。

**抽取出的图元素字段**（cognify 文档）：
* Node：`id`（模型给的 chunk-local handle，仅用于连边）、`name`、`type`（如 `Person` / `Organization`）、`description`
* Edge：`source_node_id`、`target_node_id`、`relationship_name`（如 `works_at`、`produces`）

**节点 identity**：由 `name` 派生（小写、空格→下划线、去撇号），因此同名跨 chunk / 跨文档 / 跨多次 cognify 复用同一 `Entity` 节点。显式 `id` 优先。

**去重**：`Dedup()` 注解或 `identity_fields` → 生成确定性 **UUID5**：`uuid5(NAMESPACE_OID, "ClassName:value1|value2|...")`（值小写、空格规范化为 `_`），`add_data_points` 因此 upsert 到同一节点。可用 `Product.id_for(sku)` 预计算。

**Session（短期）关系表**：
* `session_records`：`session_id` (PK)、`user_id` (PK)、`dataset_id`、`status`（`running` / `completed` / `failed`）、`started_at`、`last_activity_at`、`ended_at`、`tokens_in`、`tokens_out`、`cost_usd`、`error_count`、`last_model`
* `session_model_usage`：`(session_id, user_id, model)` PK、`tokens_in`、`tokens_out`、`cost_usd`、`updated_at`
* cache 条目 `SessionQAEntry`：`time`、`qa_id`、`question`、`context`、`answer`、`feedback_text`、`feedback_score`(1–5)、`used_graph_element_ids: {node_ids, edge_ids}`、`memify_metadata`

### 存什么 / 不存什么
* **存原文**：`Document` + `DocumentChunk` 存原文切片，provenance 在 relational store。原文是 source of truth —— `forget(memory_only=True)` 明确保留 raw files 以便 re-cognify。
* **存派生**：`Entity` / `Edge`（LLM 抽取）、每个 chunk 一个 `TextSummary`、`GlobalContextSummary`；可选 `Triplet` DataPoint（`embed_triplets=True` 时把 `<subject text> -› <predicate> -› <object text>` 当文本 embed，不额外建图节点）。
* **会话记忆**：只存 Q&A 条目（question / context / answer），**raw 且不抽取、不 chunk、不 embedding**。
* **不存**：`metadata["transparent"]=True` 的容器类**永不入库**（只当结构，子 DataPoint 提升为顶层节点）；非 DataPoint 字段会被丢弃；类里未声明的字段传进去会被静默丢弃。

### 写入路径
**永久记忆**（`remember(data)` 无 `session_id` ⇒ Add + Cognify + Improve）。cognify pipeline 六个有序 task + 两个 opt-in（[Cognify 文档](https://docs.cognee.ai/core-concepts/main-operations/legacy-operations/cognify)）：

1. **Classify documents** — 把 raw `Data` 行包成 `Document`，附 metadata / node sets
2. **Check permissions** — 校验 dataset 写权限
3. **Extract chunks** — chunker 切成 `DocumentChunk`，更新 token count
4. **Extract graph** — LLM 抽 entities 与 relationships，*"Deduplicates nodes and edges, commits to the graph DB"*
5. **Summarize text** — 每 chunk 生成 `TextSummary`（`summary_method="llm"` 默认）
6. **Add data points** — embed 并写入 vector store + graph
7. *（opt-in，`PROVENANCE_TRACKING=true`）* **Record provenance** — append-only `provenance_entries` 表，每条带 SHA-256 checksum 链到上一条，`verify_chain()` 可检测删除/重排/单字段篡改
8. *（opt-in，`CONTRADICTION_DETECTION=true`）* **Detect contradictions** — 收拢本次涉及实体 1-hop 的事实（跳过 `contains`、`made_from` 这类结构边），LLM 判断哪些成对冲突，写 `contradicts` 边，携带 `first_fact`、`second_fact`、`reason`、`confidence`；阈值 `CONTRADICTION_CONFIDENCE_THRESHOLD` 默认 `0.5`，`CONTRADICTION_MAX_FACTS` 默认 `500`。**非破坏性 fail-safe：只加边，不 invalidate 旧事实，吞掉自身错误**

成本：默认 **2 LLM calls/chunk**（抽取 + 摘要）；`summary_method="from_extraction"` 用抽取结果拼摘要可降到 1。`chunk_size = min(embedding_token_limit, llm_max_tokens / 2)`，`EMBEDDING_MAX_COMPLETION_TOKENS` 默认上限 `4096`。

**两层增量/去重**：Layer 1 = `add()` 按 content hash 在 dataset 内去重（内容变了就是新记录）；Layer 2 = `cognify()` 检查记录的 `pipeline_status`，`cognify_pipeline` 已是 `COMPLETED` 则整条跳过（无 LLM、无 re-embed、无图写）。两个 skip flag 是 `incremental_loading=True` + `data_cache=True`，默认都开。

**会话记忆**（`remember(data, session_id=...)`）：raw 直写 cache，**无 chunk、无抽取、无 embedding、near-instant、无 LLM**。默认 `self_improvement=True` 时后台跑 Improve：把 gated guidance 蒸馏成 lesson documents（`session.distill_session`，拒绝已知/无依据/不持久的 lesson），打 `session_learnings` 标签，再经 `add()` + `cognify()` 写入 dataset。

### 检索路径
**`SearchType` 枚举**（[`SearchType.py`](https://raw.githubusercontent.com/topoteretes/cognee/main/cognee/modules/search/types/SearchType.py)）：`SUMMARIES`、`CHUNKS`、`RAG_COMPLETION`、`HYBRID_COMPLETION`、`TRIPLET_COMPLETION`、`GRAPH_COMPLETION`、`GRAPH_COMPLETION_DECOMPOSITION`、`GRAPH_SUMMARY_COMPLETION`、`CYPHER`、`NATURAL_LANGUAGE`、`GRAPH_COMPLETION_COT`、`GRAPH_COMPLETION_CONTEXT_EXTENSION`、`FEELING_LUCKY`、`TEMPORAL`、`CODING_RULES`、`CHUNKS_LEXICAL`、`AGENTIC_COMPLETION`、`CODE`、`GRAPH_REPORT`、`SKILLS`

**`recall()` 流程**：
1. **查 session scope** — 有 `session_id` 且无 `datasets` / `query_type` 时先直查 session cache；session 搜索是**关键字匹配** `question`、`context`、`answer`
2. **选策略** — `query_type` 优先；**无可用 LLM 时一律解析为 `CHUNKS`**（纯 vector search over chunks，因为没人能写 completion）；`auto_route=True` 走**两条正则规则**的顺序 router（`quoted_phrase` → `CHUNKS_LEXICAL`；`coding_rules_intent` → `CODING_RULES`），否则 `HYBRID_COMPLETION`；路由类型被拒或返回空 → **重试一次 `HYBRID_COMPLETION`**（仅限 router 自己选的类型）
3. **graph retrieval** — `HYBRID_COMPLETION` 在**一次 LLM 调用**里同时检索 document chunks、summaries、entity neighbourhood；`HybridRetriever` 渲染 `{chunks, entities, facts}` 三键（`chunk_summaries` 键被接受但不渲染）

**无 reranker / RRF / MMR** —— Cognee 的融合完全在 retriever 内部完成，文档未给出跨路打分的显式公式（**未验证**有 RRF/MMR/权重公式）。可调参数：`top_k` 默认 `15`、`wide_search_top_k`（扩大初始候选）、`triplet_distance_penalty`、`feedback_influence`（用已存反馈权重影响排名）。

结果带 `source` 标记：`"graph"` / `"session"` / `"trace"` / `"session_context"`。`score` 字段在 `CHUNKS` 下是 **vector store 原始距离（越小越好）**；`CHUNKS_LEXICAL` 下 `score` 为 `None`（BM25 排名但不填该字段）。

会话历史窗口：**固定最近 10 条 Q&A entry，不可配置**；且构建 prompt 时内部用 `include_context=False`（只重放过去的问题与答案，不带旧 context）。

### 巩固 / 衰减 / 遗忘
* **没有衰减曲线**（无 Ebbinghaus、无 retention 权重）。
* **遗忘 = 显式删除 `forget()`**：
  * `data_id + dataset`：删该 item + **按污染链**删除 session cache 轮次（turn → 引用它的 feedback → 由该 feedback 蒸馏的 session-context lesson → 消费该 lesson 的后续 turn）
  * `dataset`：删 relational + graph + vector + `pipeline_status`，并删该 dataset 归属的全部 session；再对无 dataset 归属的 session 做定向清理
  * `everything=True`：删该用户可删的一切 + 整体 prune cache
  * `memory_only=True`：只删 graph + vector，保留 raw files 与 relational 记录，重置 `pipeline_status` 以便 re-cognify
  * `forget()` **不调用 LLM / embedding、不耗 token、不重算图**，只是从三种存储里删
* **TTL 只在 session cache 层**：`SESSION_TTL_SECONDS` 默认 `604800`（7 天），从 session 的**最后一次写入**起算的**滑动 TTL**（每次写都往后推）；设为 `0` 则永不过期。SQL backend 上**惰性重戳**：只有记录的过期时间落后当前目标超过 TTL 的 5% 才重写 ⇒ 实际过期落在 `0.95 × TTL` 到 `1.0 × TTL` 之间（7 天默认下最多提前约 8.4 小时）。Redis backend 保持精确 `EXPIRE`。session 还会计时 `SESSION_ABANDON_AFTER_SECONDS`（默认 1800s，读时计算 `abandoned` 状态，无需后台 sweeper）。
* **巩固**：`improve()` / memify 在已有图上加派生的检索结构（triplet index、dataset 级 bucket / root summaries、global context index），以及 session distillation。
* **矛盾保留**：`contradicts` 边而非覆盖 —— 与 Zep 的 invalidate 相反。

### 工作记忆 vs 长期记忆
Cognee 把这个二分做成了**显式的两套写入路径**（[Sessions and Caching](https://docs.cognee.ai/core-concepts/sessions-and-caching)）：

| | Session cache（短期） | Permanent memory（知识图谱） |
| --- | --- | --- |
| 写入 | `remember(data, session_id=...)` | `remember(data)`（无 `session_id`） |
| 行为 | raw 直写 cache 为 Q&A entry；**无 chunking、无 entity extraction、无 embeddings** | 完整 Add + Cognify pipeline：chunking、entity/relationship extraction、embeddings，再 Improve |
| 延迟/成本 | near-instant，无 LLM 调用 | 重；LLM 与 embedding 调用随输入规模增长 |
| 作用域 | `(user_id, session_id)` | named dataset，跨所有 session 共享 |
| 寿命 | 约 `SESSION_TTL_SECONDS`（默认 7 天）后过期，且被底层数据删除牵连 | 持久，直到 `forget` |
| 适合 | 对话轮次、scratch context、最近交互 | 文档、事实、之后要以图查询的东西 |

读时汇合：`recall(query, session_id=...)` 先查 session cache，miss 才落到 permanent graph，结果带 `_source` 标记。

### embedding 依赖
* **embedding 是架构级必需**：vector store 是三支柱之一，`add_data_points` 一定会 embed indexed fields；cognify 第 6 步明确 "embed nodes and summaries"。
* **LLM 对写入不是绝对必需**：`GRAPH_EXTRACTOR=gliner_demo` / `cognify(extractor="gliner_demo")` 用本地 **GLiNER** 填充抽取与摘要两步，*"making no LLM call for either"*，但*"step 6 still embeds what it writes"*。README：无 LLM key 时用本地 GLiNER 抽取 + 本地 embedding 模型；*"Text ingestion, retrieval, and session storage work without an LLM. LLM-dependent improvement stages skip automatically."*
* 结论：Cognee **硬依赖 embeddings**（可用本地小模型），LLM 在抽取/摘要/补全上可被 GLiNER 或无 LLM 模式替代。

### 可直接借鉴（TS + Postgres + pgvector，无 embedding）
| 借鉴点 | 可行性 |
| --- | --- |
| **单 Postgres 承载整个记忆层**（relational + PGVector + graph state，自建表与 schema） | **现在就能做**。README：*"Since cognee 1.0 you can run the entire memory layer on a single Postgres instance."* 但注意 **README 明确警告："Using Postgres as a graph store is currently released as a demo feature."** |
| DataPoint `id` 跨三存储共享（一张 nodes 表 + 一张 embeddings 表用同 id） | **现在就能做** |
| `Dedup()` / `identity_fields` → 确定性 UUID5 做实体归一 | **现在就能做**，且这是**无 embedding 场景下替代向量相似度去重的正解**：纯计算、可复现、可 upsert |
| name-derived node identity（小写/下划线归一） | **现在就能做**，零成本实体归一的基线 |
| `valid_to` 作 bi-temporal 被取代标记（旧节点保留而非删除） | **现在就能做** |
| `contradicts` 边（`first_fact`、`second_fact`、`reason`、`confidence`）——**非破坏性**，保留矛盾双方 | **现在就能做**（LLM 判断 + 加边）；对陪伴 agent 比 Graphiti 的 invalidate 更合适：既修订又不丢失用户曾经的说法 |
| `metadata.index_fields` 只 embed 选定字段 + 每字段独立 collection `Class_field` | **需要 embedding**（但"只 embed 少数关键字段"的取舍现在就能定） |
| session cache 的滑动 TTL + `0=永不过期` + 惰性重戳（5% slack 抑制写放大） | **现在就能做**，直接对应 working memory 与 episodic 的预算/过期策略 |
| 两层增量：content hash 去重 + `pipeline_status` 跳过已完成项 | **现在就能做** |
| `SessionQAEntry` 结构（`question`/`context`/`answer` + `used_graph_element_ids{node_ids, edge_ids}`） | **现在就能做**；`used_graph_element_ids` 就是「这条回答基于哪些记忆条目」的归因字段 |
| 删除时沿 provenance 链传播污染（turn → feedback → lesson → 后续 turn） | **现在就能做**（narrative/semantic 层被删时清理派生记忆） |
| 两级读（先 session 后 graph）+ `source` 标记 | **现在就能做** |
| 每 chunk 一个 `TextSummary` + `GlobalContextSummary` | **现在就能做**（纯 LLM，不需要 embedding），对应 semantic / narrative 层 |
| 抽取器可换成小模型（GLiNER）以去掉 LLM 依赖 | **不适用**（目标是 DeepSeek 单端点）；但"抽取器可插拔"的设计思路值得保留 |

---

## 3. MemoryBank

### 一句话定位
为 LLM 补上长期记忆的机制（memory storage + retrieval + updating），以 **Ebbinghaus 遗忘曲线**驱动记忆更新与用户画像，落地为 AI 伴侣 chatbot **SiliconFriend**。

来源：[arXiv:2305.10250](https://arxiv.org/abs/2305.10250)、[ar5iv HTML](https://ar5iv.labs.arxiv.org/html/2305.10250)、[AAAI PDF](https://ojs.aaai.org/index.php/AAAI/article/download/29946/31654)、[MemoryBank-SiliconFriend repo](https://github.com/zhongwanjun/MemoryBank-SiliconFriend)

### 存储模型
Memory storage 是"仓库"，存三类东西（论文 2.1）：

1. **In-Depth Memory Storage**：多轮对话按时间顺序、**每条带时间戳**的详细记录。原文：*"recording multi-turn conversations in a detailed, chronological fashion. Each piece of dialogue is stored with timestamps, creating an ordered narrative of past interactions. This detailed record not only aids in precise memory retrieval but also facilitates the memory updating process afterwards"*
2. **Hierarchical Event Summary**：把冗长对话压缩成 **daily event summary**，再合成 **global summary**，形成层级记忆结构
3. **Dynamic Personality Understanding**：**daily personality insights** → 聚合为 **global user portrait**（多层级用户人格理解）

**检索单位**：`memory piece m` = *"every turn of conversations and event summaries"*，预编码为 `h_m`，整库 `M = {h_m^0, h_m^1, ...}`。

**字段/schema：论文未给出显式字段名或表结构**（**未验证**）。论文只描述为「对话轮次 + 时间戳」、「daily/global event summary」、「daily/global personality insights」这些语义单元。

论文给出的摘要 prompt 原文：
* 事件摘要：*"Summarize the events and key information in the content [dialog/events]"*
* 每日人格：*"Based on the following dialogue, please summarize the user's personality traits and emotions.[dialog]"*
* 全局人格：*"The following are the user's exhibited personality traits and emotions throughout multiple days. Please provide a highly concise and general summary of the user's personality[daily Personalities]"*

### 存什么 / 不存什么
* **原始对话逐字保留**，带时间戳，作为精确检索与后续 memory updating 的索引基础 —— 论文明确它是 detailed record / detailed index。
* 另存派生的 daily + global **event summary** 与 daily + global **personality** 画像。
* **不存什么 / 是否物理删除：「未验证」**。论文只说遗忘是 *"forget it with a lower probability"*，没有说明被"遗忘"的记忆是否从 storage 中物理删除，也没有给出采样概率或阈值公式。

### 写入路径
论文描述的步骤有限：

1. 用户与 SiliconFriend 的对话被 **logged 进 memory storage**：*"the dialogues between SiliconFriend and users are logged and updated in the memory storage"*；每次对话轮次带时间戳入库
2. **事件摘要**：以「之前的 daily conversations 或 daily events」为输入，用 LLM 生成 daily event summary，再合成 global summary
3. **人格画像**：以「daily conversations 或 personality analysis」为输入，用 LLM 生成 daily personality insights，再聚合为 global user portrait
4. **memory updating**：Ebbinghaus 机制更新 memory storage（见下节）

**是否 dedup、是否有 silence threshold / 会话间隔触发摘要、是否在写入前先检索：论文未描述（未验证）**。论文只以「daily」为单位描述摘要与画像。

### 检索路径
* **dual-tower dense retrieval**，类似 Dense Passage Retrieval：编码器 `E(·)` 把每个 memory piece `m` 预编码为 `h_m`，把当前对话上下文 `c` 编码为 `h_c`；`h_c` 作为 query 在 `M` 中检索最相关记忆。原文：*"we adopt a dual-tower dense retrieval model similar to Dense Passage Retrieval"*
* 向量用 **FAISS** 索引以高效检索
* **没有 score fusion、没有 reranker、没有 BM25、没有图检索** —— 论文仅描述纯向量最近邻（**未验证**存在其它排序机制）
* 编码器 `E(·)` 可替换为任何合适模型
* 实现：用 **LangChain** 做 memory retrieval，支持开源 embedding + FAISS；英文用 **MiniLM**，中文用 **Text2vec**
* 检索后组装进 prompt 的信息：*"relevant memory, global user portrait, and global event summary"* —— 三段式

评估：10 天对话 × 15 个虚拟用户，194 个探测问题（97 英 / 97 中）；指标含 Memory Retrieval Accuracy、Response Correctness、Contextual Coherence、Model Ranking Score。英文下 SiliconFriend ChatGPT 检索准确率 0.763、中文 0.711。

### 巩固 / 衰减 / 遗忘
**Ebbinghaus 遗忘曲线（论文原文）**：

```
R = e^(-t/S)
```

* `R` = memory retention，即「还能保留的信息比例」
* `t` = 自学习该信息起**流逝的时间**
* `e ≈ 2.71828`
* `S` = **memory strength**，随学习深度与重复次数变化

**实际更新方程（论文原文，注意它给的是离散规则而非指数增长式）**：

> *"To simply memory updating process, we model `S` as a discrete value and initialize it with **1** upon its first mention in a conversation. When a memory item is recalled during conversations, it will persist longer in memory. We **increase `S` by 1** and **reset `t` to 0**, hence forget it with a lower probability."*

即：
* 首次提及：`S = 1`，`t` 从此刻起算
* 每次被 recall：`S ← S + 1`，`t ← 0`

**重要澄清**：论文**没有**给出 `S_new = S_old · e^(A·t)` 之类的指数强化形式；只有上述离散 `+1` 与 `t` 重置。（论文被引述时常见的指数式属「未验证」。）

论文自述：*"It is important to note that this is an exploratory and highly simplified memory updating model."*

论文明确只模拟 Ebbinghaus 的三条原则：**Rate of Forgetting**、**Time and Memory Decay**（曲线前陡后缓）、**Spacing Effect**（重学比初学容易，定期复习可重置遗忘曲线使其更平缓）；明确**不**模拟 *overlearning* 与 *meaningful material effect*。

**没有 TTL、没有硬删除描述**；"forget with a lower probability" 的具体概率/采样方式**未验证**；论文也未把 `R` 定义为检索排序权重（**未验证** `R` 是否参与排序）。

### 工作记忆 vs 长期记忆
* 论文**没有**独立的 working memory 模块或容量定义（**未验证**）。
* 长期记忆 = memory storage（对话记录 + event summaries + user portrait）。
* 隐含的工作记忆 = 当前会话上下文 `c`（被编码成 `h_c` 作为检索 query），以及最终 prompt 中的 recent / global 部分。

### embedding 依赖
* **检索硬依赖 embedding**（dual-tower + FAISS 最近邻）—— 必需。
* **写入**：对话 logging 本身不需要 LLM；但摘要与画像生成需要 LLM；且该 memory piece 要被检索就需要被编码为 `h_m`，即需要 embedding。
* 具体模型：论文说 encoder 可互换；实现里英文 MiniLM、中文 Text2vec；摘要与模拟对话用 ChatGPT；开源版用 ChatGLM / BELLE + LoRA（rank `r = 16`，3 epochs，A100）。

### 可直接借鉴（TS + Postgres + pgvector，无 embedding）
| 借鉴点 | 可行性 |
| --- | --- |
| **离散记忆强度：`S` 初始 1，每次 recall `S += 1`，并把 `t` 重置为 0** | **现在就能做**。纯 SQL 两列：`strength int default 1`、`last_recalled_at timestamptz`；检索命中时 `UPDATE ... SET strength = strength + 1, last_recalled_at = now()`。**这是最适合无 embedding 场景的"复习/强化"机制** —— 不需要向量，只需要"这条记忆被用到了"这一事实 |
| **`R = e^(-t/S)` 作保留率** 并入 score-based 检索公式 | **现在就能做**：`exp(-extract(epoch from now() - last_recalled_at) / 86400 / strength)`。可替代或补充 Generative Agents 的 recency 项，且 `S` 让"被反复使用的旧记忆"不掉队 |
| **daily event summary → global summary 的层级摘要** | **现在就能做**（纯 LLM），直接对应 episodic → narrative 两层 |
| **daily personality insights → global user portrait** | **现在就能做**（纯 LLM），对应 semantic / narrative 层的"人物画像"多层级更新 |
| **检索后组装 prompt 的三段式：relevant memory + global user portrait + global event summary** | **现在就能做**，是 token budget 分配的现成模板 |
| **"recall 即强化" 天然产生 spacing effect** | **现在就能做**（同上，纯 UPDATE） |
| dual-tower + FAISS 向量检索 | **需要 embedding** |
| 论文未提供的"遗忘概率"采样公式 | **需要自己做**（论文无可照搬公式） |

---

## 4. Generative Agents（Park et al. 2023）

### 一句话定位
LLM 驱动的可信人类行为模拟架构：**memory stream**（自然语言经验全记录）+ 三因子检索 + reflection + planning。

来源：[arXiv:2304.03442](https://arxiv.org/abs/2304.03442)、[ar5iv HTML](https://ar5iv.labs.arxiv.org/html/2304.03442)、[官方 repo](https://github.com/joonspk-research/generative_agents)、[`associative_memory.py`](https://raw.githubusercontent.com/joonspk-research/generative_agents/main/reverie/backend_server/persona/memory_structures/associative_memory.py)、[`retrieve.py`](https://raw.githubusercontent.com/joonspk-research/generative_agents/main/reverie/backend_server/persona/cognitive_modules/retrieve.py)

### 存储模型
**论文**：memory stream 是 *"a list of memory objects, where each object contains a natural language description, a creation timestamp, and a most recent access timestamp"*。基本元素是 **observation**（agent 直接感知到的事件）。架构中一切都是自然语言描述。论文另外明确：*"Our current implementation utilizes the gpt3.5-turbo version of ChatGPT."*

**官方代码 `ConceptNode` 的实际字段**（`associative_memory.py`，注释写明 *"this class is the Memory Stream module in the generative agents paper"*）：

```
node_id            # "node_1", "node_2", ...
node_count         # 全局计数
type_count         # 该 type 内计数
type               # "thought" / "event" / "chat"
depth              # event/chat = 0；thought = 1 + max(filling 中节点的 depth) → reflection tree 深度
created            # datetime
expiration         # datetime | None（save 时总是写 None）
last_accessed      # 初始 = created
subject / predicate / object   # s, p, o 三元组
description        # 自然语言描述
embedding_key      # 指向 embeddings dict 的键
poignancy          # importance 分数（LLM 打的 1–10 整数）
keywords           # keyword 集合（用于倒排）
filling            # reflection 的证据指针 / chat 的对话行
```

`AssociativeMemory` 的容器结构：
* `id_to_node`：`node_id → ConceptNode`
* 三个**按时间倒序**的序列（`add_*` 用 `[0:0]` 前插）：`seq_event`、`seq_thought`、`seq_chat`
* 关键字倒排：`kw_to_event`、`kw_to_thought`、`kw_to_chat`（`dict[str, list[ConceptNode]]`）
* 关键字频次：`kw_strength_event`、`kw_strength_thought`
* `embeddings`：`dict[embedding_key, vector]`

**reflection 树**：论文 *"agents generate trees of reflections: the leaf nodes of the tree represent the base observations, and the non-leaf nodes represent thoughts that become more abstract and higher-level the higher up the tree they are."* 代码里以 `depth = 1 + max(filling 的 depth)` 实现。

**planning**：plan 条目含 location、starting time、duration（论文：*"for 180 minutes from 9am, February 12th, 2023, at Oak Hill College Dorm: Klaus Mueller's room, read and take notes for research paper"*），并且 *"Like reflections, plans are stored in the memory stream and are included in the retrieval process."* 计划自顶向下递归分解：日计划 → 小时级 → 5–15 分钟级。

### 检索分数公式（最关键）
**三个分量**（论文 4.1）：

1. **Recency**：*"we treat recency as an exponential decay function over the number of sandbox game hours since the memory was last retrieved. Our decay factor is **0.995**."*
   代码 `extract_recency`：把 nodes 按 `last_accessed` 升序（最旧在前）排序后，`recency_vals = [recency_decay ** i for i in range(1, len(nodes)+1)]`，即**越靠后（越近）指数越大**。注意实现是**用排序位置 `i` 近似"小时差"**，而不是精确小时数。
2. **Importance**：`node.poignancy`，1–10 的整数，**在记忆创建时**由 LLM 打分。论文给出的逐字 prompt：
   > *On the scale of 1 to 10, where 1 is purely mundane (e.g., brushing teeth, making bed) and 10 is extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the following piece of memory.*
   > *Memory: buying groceries at The Willows Market and Pharmacy*
   > *Rating: \<fill in\>*

   论文举例：*"cleaning up the room"* 返回 2，*"asking your crush out on a date"* 返回 8。*"The importance score is generated at the time the memory object is created."*
3. **Relevance**：memory 描述向量与 query 向量的 **cosine similarity**。代码 `extract_relevance`：`focal_embedding = get_embedding(focal_pt)`，`cos_sim(node_embedding, focal_embedding)`（`cos_sim(a,b) = dot(a,b)/(norm(a)*norm(b))`）。

**归一化**：三者**各自 min-max 缩放到 [0,1]**。代码 `normalize_dict_floats(d, 0, 1)`：
```
min_val = min(d.values()); max_val = max(d.values()); range_val = max_val - min_val
if range_val == 0:  d[key] = (target_max - target_min) / 2          # → 0.5
else:               d[key] = (val - min_val) * (target_max - target_min) / range_val + target_min
```
关键含义：**归一化是在候选集内部做的**，所以绝对分跨查询不可比。

**组合公式**（论文原文）：
```
score = α_recency · recency + α_importance · importance + α_relevance · relevance
```
> *"To calculate the final retrieval score, we normalize the recency, relevance, and importance scores to the range of [0,1] using min-max scaling. The retrieval function scores all memories as a weighted combination of the three elements ... In our implementation, all αs are set to 1."*

**⚠️ 论文与仓库代码不一致（必须注意）**：论文说 α 全为 1，但 `retrieve.py` 的 `new_retrieve` 里实际是：
```python
# Note to self: test out different weights. [1, 1, 1] tends to work
# decently, but in the future, these weights should likely be learned,
# perhaps through an RL-like process.
# gw = [1, 1, 1]
# gw = [1, 2, 1]
gw = [0.5, 3, 2]
master_out[key] = (persona.scratch.recency_w * recency_out[key] * gw[0]
                 + persona.scratch.relevance_w * relevance_out[key] * gw[1]
                 + persona.scratch.importance_w * importance_out[key] * gw[2])
```
即 **`gw` 的顺序是 `[recency, relevance, importance]`，main 分支实为 `[0.5, 3, 2]`**，再各乘 `scratch.recency_w / relevance_w / importance_w`。引用时应说明是论文版本（全 1）还是仓库版本（`[0.5, 3, 2]`）。

**取 top-k 与检索即刷新**：`new_retrieve(persona, focal_points, n_count=30)`，`top_highest_x_values(master_out, n_count)`；命中后 `n.last_accessed = persona.scratch.curr_time` —— **这就是 recency 的更新机制：检索即强化**。

其它实现细节：
* 候选集来自 `seq_event + seq_thought`，并过滤 `if "idle" not in i.embedding_key`（排除 idle 事件）
* `retrieve()` docstring 提到 perceived 事件受 `att_bandwidth` 与 `retention` 两个超参控制，但**该文件与其加载路径中未见其默认值**，论文也未给出 → **未验证**
* 另有一条**不依赖 embedding 的召回通道**：`retrieve_relevant_events(s, p, o)` / `retrieve_relevant_thoughts(s, p, o)` 直接用 `kw_to_event` / `kw_to_thought` 做关键字倒排命中

### 巩固 / 衰减 / 遗忘
* **没有遗忘**：memory stream 不做删除，也没有让权重随时间衰减的机制。recency 只是连续衰减项，而每次被检索就刷新 `last_accessed`（等价于强化）。`expiration` 字段存在于代码但 save 时恒为 `None`，论文未描述其语义 → **未验证**。**没有 TTL**。
* **reflection = 巩固**。触发条件（论文）：*"we generate reflections when the sum of the importance scores for the latest events perceived by the agents exceeds a threshold (**150** in our implementation). In practice, our agents reflected roughly two or three times a day."*
* reflection 流程（论文原文步骤）：
  1. 取最近 **100** 条记录，prompt：*"Given only the information above, what are 3 most salient high-level questions we can answer about the subjects in the statements?"*
  2. 用生成的问题作 retrieval query，收集相关记忆（**包括其它 reflection**）
  3. prompt：*"What 5 high-level insights can you infer from the above statements? (example format: insight (because of 1, 5, 3))"*
  4. 解析并把 statement 作为 reflection 存回 memory stream，**附被引用记忆对象的指针**（即 `filling`）→ 形成 reflection tree

### 工作记忆 vs 长期记忆
* 论文**没有独立的 working memory 模块**。memory stream 就是长期记忆；"工作集"是检索返回的 top-k（默认 30）+ 最近的 observation。
* prompt 里包含：recent observations（受 `att_bandwidth` / `retention` 控制）+ retrieved memories（events / thoughts，按 focal point）+ reflections + plans。
* 检索按 focal point 分别进行，`retrieve()` 为每个事件返回 `curr_event` / `events` / `thoughts` 三部分。
* **容量约束是显式的**：论文 *"The top-ranked memories that fit within the language model's context window are included in the prompt."*

### embedding 依赖
* **写入：既需要 LLM 也需要 embedding**。每条 observation 变成 memory node 需要 (a) LLM 抽出 description / keywords 并打 `poignancy`（importance）；(b) 一次 embedding 产生向量（`embedding_key` → vector）。
* **检索：relevance 需要 embedding**；recency 和 importance 不需要。
* 论文说 relevance 用 *"the language model to generate an embedding vector of the text description of each memory"*；代码调用 `get_embedding`（来自 `persona/prompt_template/gpt_structure.py`）。**论文未指名具体 embedding 模型 → 未验证**（常被引述的 `text-embedding-ada-002` 在论文中未验证）。
* **无 embedding 的降级路径**：`kw_to_event` / `kw_to_thought` 关键字倒排可独立工作，可作为 relevance 的替代。

### 可直接借鉴（TS + Postgres + pgvector，无 embedding）
**这是四个系统里对"无 embedding 的 score-based 检索"最有用的一节。**

| 借鉴点 | 可行性 |
| --- | --- |
| **三因子加权 + 候选集内 min-max 归一化 + 硬 top-k 预算** | **现在就能做**。把 recency 用时间差现算、importance 用 LLM 打分、relevance 换成 BM25 / 关键字命中率；min-max 与加权求和是纯计算。**关键教训：min-max 在候选集内归一 ⇒ 绝对分不可跨查询比较，这正是"score-based + hard budget"的正确形态** |
| **`recency = decay^i` 用排序位置代替精确时间差** | **现在就能做**（按 `last_accessed` 排序后取 rank 的指数，比精确小时差更便宜，且天然 scale-free） |
| **importance 1–10 在写入时由 LLM 打分，附逐字 prompt** | **现在就能做**（DeepSeek 可打分）；每条写入多一次极小的 LLM 调用，可批量/缓存 |
| **检索时刷新 `last_accessed`（检索即强化）** | **现在就能做**，纯 `UPDATE`；天然产生 spacing effect，和 MemoryBank 的 `S += 1` 是同构的 |
| **reflection 触发 = importance 累计阈值 150** | **现在就能做**（纯 SQL `SUM(importance) since last reflection`），阈值可调 |
| **reflection 两步 prompt：先问 3 个 salient questions 当检索 query，再抽 5 条 insights 并附 evidence 指针** | **现在就能做**（纯 LLM），这是 narrative 层生成的现成配方 |
| **reflection 存回同一 memory stream，带 `depth` 与 `filling`（证据指针）** | **现在就能做**（同一张表 + `depth` / `parent_ids` 列）；narrative 层不必是独立表 |
| **关键字倒排通道（`kw_to_event` / `kw_to_thought` + `kw_strength`）** | **现在就能做**，而且这是**无 embedding 时 relevance 的替代方案**：Postgres `tsvector` + GIN，或一张 `memory_keywords` 表 + count |
| **plan 也写进 memory stream 并参与检索** | **现在就能做** |
| **每个 focal point 分别检索，返回 curr_event / events / thoughts 三组** | **现在就能做**（对应四层记忆的并行召回 + 分层装填） |
| **`att_bandwidth` / `retention` 的"最近 N 条强制进入上下文"** | **现在就能做**，这正是 hard budget 的做法（具体默认值 **未验证**） |
| **权重放进可调常量表并 A/B**（论文 α=1 vs 代码 `gw=[0.5,3,2]`） | **现在就能做**，且是必要教训：权重不该硬编码 |
| cosine relevance、MMR 去冗余 | **需要 embedding** |

---

## 跨系统小结（对目标的直接结论）

1. **无 embedding 仍然可用的检索骨架**：Generative Agents 的 `min-max 归一 + 加权求和 + 硬 top-k` 是唯一一个**不依赖向量也能成立**的完整检索公式；把 `relevance` 换成 BM25 / 关键字命中率（其 `kw_to_*` 倒排通道 + Graphiti 的 BM25 + Cognee 的 `CHUNKS_LEXICAL` 都印证这条路径），recency 用 rank-based decay 或 MemoryBank 的 `e^(-t/S)`，importance 用 LLM 写入时打分。
2. **无 embedding 的实体归一**：Cognee 的确定性 UUID5（`Dedup()` / `identity_fields`）+ name-derived identity 是零成本方案；Graphiti 的 cosine 实体解析在无 embedding 时无法照搬。
3. **无图数据库的图结构**：Graphiti 的 3 层子图与边语义（`RELATES_TO` / `MENTIONS` / `HAS_MEMBER`）可以直接落成 Postgres 两张表（nodes / edges）+ 递归 CTE 做 BFS（`bfs_max_depth=3`）；`episode_mentions` 与 `node_distance` reranker 都是纯 SQL count / hop 距离；**RRF 的 `1/(rank+1)` 是最便宜的跨路融合**。
4. **时间与遗忘**：Zep 的 bi-temporal 四时间戳（`valid_at` / `invalid_at` / `created_at` / `expired_at`）+ 矛盾时"新事实时间戳覆盖旧事实 `invalid_at`"是纯列语义；Cognee 的 `contradicts` 边（非破坏性、带 reason + confidence）更贴合陪伴场景；MemoryBank 的 `S += 1` 与 Generative Agents 的 `last_accessed` 刷新是同一种"检索即强化"，都用一行 `UPDATE` 实现。**四个系统都没有任何 TTL 式的长期记忆过期** —— 只有 Cognee 对 session cache 有 7 天滑动 TTL。
5. **分层与巩固**：Graphiti 的 Saga（`summary` + `last_summarized_at` 水位线）适合做**增量 episode 摘要**；MemoryBank 的 daily→global 双层摘要与 daily→global 人格画像；Generative Agents 的 importance 阈值触发 reflection + 写回同一 store 带 evidence 指针。这三者可组合成 narrative 层的三档巩固，全部只需要 LLM，不需要 embedding。
