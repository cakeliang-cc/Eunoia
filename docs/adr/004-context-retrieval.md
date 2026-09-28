# ADR 004 — 上下文检索：带评分的预算，embedding 推迟

## 背景

spec §6 禁止每轮检索所有记忆，也禁止把 "vector -> text" 作为唯一的机制。
spec §7 禁止每轮都写记忆。

侦察发现唯一可用的模型端点**没有 embeddings 路由**（`/v1/embeddings`、
`/embeddings`、`/v1/embed` 均返回 HTTP 404）。spec 的检索评分包含一个
"semantic relevance" 项，而 §13 会为 `memory_relevance` 打分——因此这是一个
真实的缺口，不是细节。

## 决定

**由两部分构成的决定。**

**1. 检索是带评分、带预算的选择，不是全量抓取。**

```
candidate set (SQL-filtered by user_id, type, expiry)
        ↓
score = w_i·importance + w_r·recency + w_t·typePrior + w_s·similarity
        ↓
take top-K under an explicit context token budget
        ↓
render compactly (one line per memory, with date + type + confidence)
```

权重与 K 集中在一个 config 模块里，而不是散落在代码各处。

**2. embedding 与 `similarity` 项是被推迟，而不是被去掉。**

Phase 2 交付的评分中 `w_s = 0`，使用 importance + recency + type prior + 词法
重叠。`embedding` 列与 `vector` 扩展在**第一个 migration** 中就创建，这样以后
启用 similarity 是回填，而不是 migration。评分函数把 similarity 作为注入的
输入，因此开启它是一次配置变更加一个回填任务。

## 备选方案

1. **现在就上本地 ONNX embedding**（`all-MiniLM-L6-v2`，384 维，离线）。推迟，
   而非否决——用户选择了评分优先。它仍然是既定的后续工作：推理时不需要 API
   key，也不需要网络。
2. **外部 embedding API。** 暂时否决：环境中不存在这样的凭据，而且它会在每一轮
   的热路径上引入网络依赖。
3. **永久只用词法检索。** 已否决——对于被改述的记忆（"我很讨厌被催促" 对
   "别给我压力"），它无法满足 §13 的 `memory_relevance` 维度，而这正是
   similarity 的用途所在。
4. **抓取所有记忆，让模型来过滤。** 已否决——§6 与反模式 2 明确禁止。

## 理由

推迟 similarity 项是风险最低、最易回滚的路径：它完全解锁 Phase 2，逆转起来不花
任何代价，并保持 schema 向前兼容。对那一列什么都不做，会让它日后变成一次真正
的 migration；而立即上本地 ONNX，则会在它所服务的检索逻辑尚未被验证之前就引入
一个依赖。

## 后果

- **已知局限，记录在 CHANGELOG：** 在 embedding 落地之前，对被改述记忆的检索
  质量是下降的。Phase 2 的 eval 用例不得在 `memory_relevance` 上过度声称。
- 上下文预算是硬上限，在测试中断言——如果检索曾经为一个用户返回了所有记忆，
  测试必须失败。
- `MemoryRetrieval` 无需数据库即可单元测试，因为评分是纯的。
- 向量维度（384）必须在第一个 migration 中固定，尽管它还没被用到，因为日后修改
  一个 `vector(N)` 列就是一次 migration。选 384 是为了匹配既定的模型
  `all-MiniLM-L6-v2`。
