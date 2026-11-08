# Eunoia 图片 Token 与请求预算

> 状态：DSH 实施约束。日期：2026 年 11 月 8 日。
> 配套：[实施计划与验收](../plans/eunoia-多模态实施计划与验收.md)。本文讨论图片输入，不讨论图片生成计费。

## 必须分开的三种数量

| 数量 | 含义 | 不能混淆的地方 |
| --- | --- | --- |
| 存储/上传字节 | 原始文件及私有资源大小 | 相同尺寸不同压缩率可以有不同文件大小 |
| 请求体字节 | Base64、JSON、文字、工具声明等编码后的 HTTP body | Base64 会膨胀传输体，但不是作为普通文本逐字计 Token |
| 模型输入 Token | 文本、图像编码及协议开销占用的输入上下文 | 与像素、模型处理规则和实际发送内容有关 |

禁止 `estimateTokens(JSON.stringify(request))`：它把图片编码当文本。也不能完全忽略图片，或把某个供应商的一张图固定上限当成所有模型通用值。图片 URL、assetId 和 file_id 的字符长度都不能代表视觉 Token。

[DeepSeek 当前指南](https://api-docs.deepseek.com/guides/vision/)给出了当前 Flash 的尺寸处理与每图上限；[用量指南](https://api-docs.deepseek.com/quick_start/token_usage/)明确本地计算是估算，真实用量以响应 usage 为准。旧发布公告中的数字不能覆盖当前指南。

## 模型策略而非全局公式

每条可发送图片的路由需要：输入能力、媒体限制、请求变体策略、图像 Token 策略、文本估算策略、上下文容量和输出预留。策略按 provider/endpoint 配置、modelId、protocol、policyRevision 绑定，未知策略不默认套 DeepSeek 规则。

建议契约如下，具体类型名可与并行预算模块对齐：

```ts
interface ImageCostEstimate {
  readonly estimatedTokens: number;
  readonly upperBoundTokens?: number;
  readonly basis: 'provider-calculator' | 'provider-counter' | 'documented-bound';
  readonly policyRevision: string;
}

interface ImageTokenPolicy {
  estimate(input: {
    width: number;
    height: number;
    detail: string;
    mediaType: string;
  }): ImageCostEstimate;
}
```

`upperBoundTokens` 只用于有明确依据的图片上限；普通启发式安全余量不能假装成数学上界。`provider-calculator` 表示复现本地参考算法，不表示 API 实际 Token 精确相等。没有可靠估算时使用有依据的保守上限并标明 basis；连上限都未知时拒绝该图片路由，不按 0 处理。

文本和消息包装仍有估算误差。不要因为图片项有上界就宣称整个请求存在严格上界。

## 先准备发送版本再计数

```text
原图 → EXIF 方向与格式归一化 → 路由选择请求变体
    → 读取实际编码变体的宽高/字节/摘要
    → 模型专属 Token 策略
    → 完整请求预算与编码字节预检
    → 原样发送已经计数的计划
```

尺寸必须来自实际编码图片，不能使用浏览器声明的原图尺寸，不能按缩略图计数却发送原图。请求准备完成后不允许编码层自行再改变尺寸/detail；发生变化应生成新计划并重算。

缓存请求变体可以减少解码和编码工作，不能把图片在下一次模型请求中的 Token 计为 0。相同图片在一份请求中出现两次，原则上按两次视觉输入计算，除非该协议有可证明的其他语义。同一 assetId 仅在存储层去重，不在模型上下文中自动去重。

Base64 data URL 只在最终编码时产生。其主体不传入文本 tokenizer。文件名、解释文字、角色边界、工具 schema 等实际文本分别计数一次，禁止既按序列化 JSON 又按内容块重复计费。

## DeepSeek Flash 首个策略

当前 DSH 的第一方实现采用 `v41` 图片计算器，包含 14 像素 patch、每轴 3 倍下采样、544×544 总像素下限、1024 Token 的图像编码上限。网格计数包含每行分隔及两个边界 Token；大图需要解出保持比例的可容纳网格，并迭代到稳定状态，不能只算 patch 数后直接截成 1024。[第一方计算器源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/src/image-tokens.ts)

实施时在 DeepSeek 专属模块复现或合规复用该计算器，保留出处与许可证，固定参考 commit 和策略版本。实现前核对实际源码位置，仓库可能重排目录。不要照抄旧 v4 的 384 上限、旧长宽比修正，也不要把 OpenAI 某模型的 tile 算法拿来算 DeepSeek。

首期请求 detail 由 Flash 策略固定为 auto，避免本地 low 变换与服务端 low 二次处理不一致。开放其他 detail 前补齐对应尺寸转换和用量参考。产品可以缩小请求图，但计数必须使用缩小后的真实尺寸。

例如，对传给计数器的请求图片尺寸，当前算法给出：

| 宽 × 高 | 本地计算器应输出 | 说明 |
| --- | --- | --- |
| 544 × 544 | 184 | 方图参考点 |
| 512 × 512 | 184 | 小图会经过计算器的上采样规则 |
| 100 × 100 | 184 | 小文件不代表 Token 接近零 |
| 640 × 480 | 206 | 横图参考点 |
| 480 × 640 | 210 | 每行分隔意味着转置尺寸不一定同价 |
| 800 × 800 | 422 | 不能使用旧算法结果 349 |
| 1024 × 1024 | 652 | 大于简单的单个固定占位值 |

以上是本地算法测试向量，不是在线计费承诺。实际发送前如果策略将原图变成另一组尺寸，应使用新尺寸的预期结果。无需为了让一张 1024×1024 图片匹配该表而禁止合理的变体策略；测试应分别覆盖变体和计数器。

极端长宽比和更大的图应经过完整 solver，不靠一个简化公式处理。一期不接受的原图尺寸可在纯算法测试中单独覆盖，不能据此放宽上传限制。

## 完整请求预算

与另一个 Agent 的预算模块对齐，使用同一公式和唯一输出预留语义：

```text
estimatedInput = 实际发送文本 + 消息/协议开销 + 工具 schema
               + 图片每次出现的估算 + 其他实际保留的输入

effectiveInputLimit = min(产品输入预算,
                          模型上下文容量 - 本次输出预留 - 安全预留)
```

这里“产品输入预算”指完整输入，不再是只含历史的额度。现有 `sessionReplayBudget()` 已减过 prompt reserve，不能把它再次当整包额度，导致系统提示词和预留被扣两次。历史预算是完整额度扣除本次真实固定内容后剩余的子额度。

每次模型步骤都重算：当前历史、原样保留的工具调用/结果、推理记录、当前用户图片和系统说明均纳入，不能只在第一步算图片。没有 usage 的中断步骤记录用量未知，而非 0。

图像上限与模型上下文上限分开。参考计算器可给 point estimate；有依据的 per-image cap 可给保守预算。余量应可配置且有版本，不把经验偏差当成新模型的固定规则。

## 处理接近边界与不确定性

远离容量边界时，用有效策略的估算加安全预留正常放行。接近边界时，优先使用供应商若提供的请求计数接口；没有该能力时，用已知图像上限与当前文本估计构造更保守的保护检查。DeepSeek 当前公开计数资料未提供一个可当作 API 真实视觉 Token 的精确计数接口，不能虚构调用。

预算模块必须区分：

- 点估算及保护检查均满足：允许发送，记录为估计放行。
- 点估算本身已超限：按现有策略压缩旧历史，保护当前用户消息；重算后仍超限返回 `CONTEXT_BUDGET_EXCEEDED`，说明这是估计超限。
- 点估算可容纳，但保守保护检查超限：不能谎报“确定超上下文”。有可用计数器则细化；否则返回 `CONTEXT_BUDGET_UNCERTAIN`，让用户明确选择更少历史、较小请求变体或新会话。原图和草稿保留。
- 模型策略未知：`MODEL_CAPABILITY_UNKNOWN`，区别于容量不足。

这些措施降低误判并让不确定性可解释，但不能保证本地估算与供应商真实分词永远相同。若原始图被压缩或历史图片被摘要，必须生成/标记新的实际输入并重算，不能只在计数器里把原图成本降低。

不得自动删除当前用户图片、重复调用另一个模型或根据一次 context 错误永久调低整个模型的 contextWindow。明确的超限错误与 413 请求体超限、损坏媒体、未知模型、429 必须分开归因。需要重试时由既有回合与幂等机制管理，不能重放已发生的工具副作用。

## HTTP 请求体预算

一期使用内联图片，产品默认最终 JSON body 上限 32 MiB，具体路由限制更低时取更低值；原图在上传时满足 20 MiB 合计限制，也不保证带长文本的请求必然低于 body 上限。

对二进制长度 n，Base64 主体长度为 `4 * ceil(n / 3)`；再加 data URL 前缀、JSON 字段、UTF-8 文本、工具 schema 等开销。规划阶段先估算编码尺寸防止巨大分配；编码阶段对最终 body 的 UTF-8 字节长度再检查一次。body 太大使用 `REQUEST_BODY_TOO_LARGE`，不能报上下文 Token 不够。

Provider Files API 以后能减少重复传输，但不自动减少图片的上下文 Token。将来增加此优化时仍要根据文件背后的请求图片尺寸和策略计算视觉成本，且处理账户、端点、有效期和删除。

## 真实 usage 与观测

每次请求记录 point estimate、保护值、文本/图片估计分项、实际发图次数、变体摘要、策略版本和响应 model。拿到 API usage 后保存实际输入、输出、缓存用量；总输入已包含图片时，不能再把本地图片估计加到总量上。

响应没有分开的 image_tokens 时，标记实际图片分项未知。不能简单用总 usage 减去启发式文本估计，伪造“真实图片 Token”。缓存命中表示计费/处理特性，不能直接从上下文长度扣除。

整轮成本累计每次真实请求的 usage，另存最后请求的上下文压力；两者不是同一个数。usage 缺失的请求需标记，不宣传本轮费用精确可知。长期校准按具体 route 与策略版本进行，先观测，不自动修改能力或算法。

## 预算验收用例

| ID | 测试输入 | 明确预期 |
| --- | --- | --- |
| B01 | 上述 7 个尺寸、非法尺寸及极端长宽比 | 表内本地整数完全一致；0、负数、非有限数、溢出被拒；solver 不死循环 |
| B02 | 两张尺寸相同但压缩率明显不同的图片 | 同一策略下视觉估算相同；传输字节不同 |
| B03 | 原图 3000×2000，变体实际 1500×1000 | 预算和线上编码都使用后者；替换变体摘要使计划失效并重算 |
| B04 | 一图在同一请求出现两次、下一工具步骤再次发送 | 分别按实际出现次数计数；存储去重不降低视觉 Token |
| B05 | Base64 长度数百万的 5 张 800×800 请求图，短文本 | 图片本地合计 2110；文本估算不包含编码主体；不因 JSON 字符数误报数十万 Token |
| B06 | 相同消息切换另一假模型策略 | 图像估算、限制、detail 编码使用新策略；通用 planner 无供应商分支 |
| B07 | 注入固定文本开销和虚构 image policy，阈值前后各 1 Token | 精确断言预算是否容纳；输出/安全/prompt reserve 只扣一次，等于额度可容纳 |
| B08 | 点估算满足，文档上限保护检查不满足 | `CONTEXT_BUDGET_UNCERTAIN`；零模型调用；不写“确定超限”；可恢复草稿 |
| B09 | body 大于 32 MiB，但视觉预算很小 | `REQUEST_BODY_TOO_LARGE`，与 context code 不同；编码前后检查均覆盖 |
| B10 | 已收到 usage 输入 5000、本地图片估计 2110 | 实际总输入记录为 5000，不是 7110；无图像分项则 actualImageTokens 为未知 |
| B11 | 图片上传为小 EXIF 旋转图，后续请求已正确旋转 | 按编码后的方向和尺寸计数；原图引用稳定；不使用浏览器虚假宽高 |
| B12 | unknown 图像策略、缺失 usage、429、context 错误 | unknown 不按 0 放行；用量未知不按 0；429 不关闭视觉能力；context 错误不全局改容量 |

B07 用人工可控的假计数器验证精确阈值；真实模型的文本估算不能拿来要求实际 usage 完全等于本地值。B05 验证的是标准计数器输入尺寸，真实资源链路另由 A 系列验证。

## 来源与版本记录

- [DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/)：当前 Flash 图像输入和限制。
- [DeepSeek Token Usage](https://api-docs.deepseek.com/quick_start/token_usage/)：本地估算与响应 usage 的区别。
- [DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)：协议中的图片内容及完成事件。
- [DSH 图像计算器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/src/image-tokens.ts)：算法、边界和稳定迭代。
- [DSH 请求投影与计数](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/src/request-pricing.ts)：按请求目标尺寸和每次出现计数。

实施交付时记录来源 commit/检索日期、策略修订和固定向量，不只保留可变 master 链接。供应商规则更新只修对应策略及测试，不迁移用户消息结构。
