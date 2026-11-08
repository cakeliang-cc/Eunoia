# 多模态一期验收报告

- 日期：2026-11-08
- 分支：`feat/multimodal`（基于并行 Agent 的 `feat/turn-integrity` 最新提交）
- 依据：[实施计划](./myfree/Agent/eunoia-多模态实施计划与验收.md)、
  [接口设计](./myfree/Agent/eunoia-多模态接口设计.md)、
  [图片 Token 与请求预算](./myfree/Agent/eunoia-图片Token与请求预算.md)
- 架构决定：[ADR 031](./adr/031-multimodal.md)

## 结论

一期范围（用户文本 + 静态图片输入、助手文本输出）已实现。离线验收矩阵
A01–A26、B01–B12 全部有自动化证据；真实端点 S01–S03 在已有凭据下通过；
390px 与桌面浏览器检查通过并留有截图。

**不是**本期的内容：音频、视频、图片生成、OCR 桥接、自动跨模型路由、视觉能力
Bench。S01–S03 是接线 smoke，不是视觉效果评测。真实 usage 的图片分项无法从
DeepSeek 响应拆分，因此标记 `imageTokensUnknown: true`，没有伪造。

## 交付命令结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS（0 error；`scripts/browser-check.ts` 有 3 个 `any` warning，属于 CDP 边界） |
| `npm test` | PASS：98 个测试文件通过、4 个文件跳过；1325 tests passed、27 skipped |
| `npm run build` | PASS；5 个提示词/Skill 资产复制到 `dist/` |
| `npm run browser:check` | PASS；Chrome headless，390px 无横向溢出 |
| `RUN_SMOKE=1 npx vitest run tests/smoke/live-vision.test.ts` | PASS：3/3（S01–S03） |
| `npm run backup` + `npm run backup:verify` | PASS；临时库 1 个资产、3/3 文件 SHA-256 校验 |
| `npm run cleanup:media` | 已实现；清理过期未绑定/已释放且不在租约中的资源 |

### 真实 smoke 脱敏结果

`docs/captures/live-vision.json`：

- S01：现场生成随机四位数与随机大色块；回复 `数字是 **5390**，背景是**绿色**`。
  `deepseek-flash`，usage `input=2501, output=14, cached=1920`。
- S02：`2, 7` → `2, 7`；交换顺序 → `7, 2`。usage 分别 2654 / 2638 input。
- S03：进程重启后重新生成仍回答 `图里的数字是 **7**，绿色`（不是“没收到图片”）；
  随后切到文本模型 `deepseek-v4-pro`，同一历史图触发 422
  `MODEL_INPUT_UNSUPPORTED`，`details.scope = history`。
- 未记录 Base64、密钥、绝对路径或第三方响应正文。模型为 `deepseek-flash`
  （响应 model 字段未在 SDK 事件中返回，记录为请求路由；usage 为响应值）。

### 浏览器证据

`npm run browser:check` 使用真实 Chrome（CDP，无 Playwright 依赖）启动隔离的
in-memory 服务，拖入真实 PNG、切到可看图模型、发送纯图片消息、打开预览：

- `docs/captures/multimodal-desktop.png`（1280×900）
- `docs/captures/multimodal-390.png`（390×844，2x）
- `docs/captures/multimodal-preview.png`（预览遮罩）
- `docs/captures/browser-check.json`：`readyDrafts=1`、`userImages=1`、
  `previewOpen=true`、`viewport=390`、`scrollWidth=390`、
  `noHorizontalOverflow=true`、`composerInside=true`。

## A 系列

| ID | 结果 | 证据（测试名/命令） |
| --- | --- | --- |
| A01 | PASS | `tests/db/media.test.ts` “A01 — version 8 database upgrades and restarts idempotently”：v8 文件升级、连开两次、消息 count/seq/内容不变、turn 行保留、`content_parts`/media 表存在、`user_version=9`；未知内容版本被拒绝。 |
| A02 | PASS | 同文件 “A02 — ordered blocks …” 对 InMemory/SQLite 参数化：两文两图交错顺序一致、投影只由 text 块派生、重复图片保留两个引用位置。 |
| A03 | PASS | `tests/api/media.test.ts` 上传/预览/删除；`tests/media/decode.test.ts` JPEG/PNG/WebP 实际尺寸；无沙箱依赖。 |
| A04 | PASS | `tests/media/decode.test.ts` 伪 MIME、损坏字节、SVG、GIF、APNG 标记全部 415；`tests/media/service.test.ts` 失败后媒体目录为空。 |
| A05 | PASS | `tests/media/decode.test.ts`：10 MiB 上限前拒绝、单边/像素上限、**恰好 40,000,000 像素通过、+1 拒绝**、8192 单边边界、解码 gate 峰值 ≤2。 |
| A06 | PASS | `parseUserContent` 6 张图返回 400；`MediaService.assertMessageImages` 超过 5 张/20 MiB 拒绝；前端从 `/api/media/capabilities` 取同一组限制。 |
| A07 | PASS | `tests/api/media.test.ts` “refuses another user…”：B 读/删 A 的图均 404，B 发 A 的 asset 也 404；`tests/media/service.test.ts` 另会话 resolve 404，无元数据泄漏。 |
| A08 | PASS | `tests/media/service.test.ts` “replay reads the bound bytes…”，改名/改写工作区同名文件后仍读 immutable 原图；digest 篡改被检测。 |
| A09 | PASS | `tests/api/media.test.ts` 文本模型收图 422 `MODEL_INPUT_UNSUPPORTED`、`scope=current`、0 次模型调用、消息为 0、无 running turn；`tests/agent/request-plan.test.ts` 对应纯函数用例。 |
| A10 | PASS | 计划层 “supported route with no registered token policy” 与 API “no token policy” 均 422 `MODEL_CAPABILITY_UNKNOWN`，0 次调用。 |
| A11 | PASS | `tests/agent/vision-encoding.test.ts` 用 SDK adapter 捕获 `input_image` 并 decode 出 640×480 / 120×90，顺序为文本-图-文本-图；假路由同样 decode。 |
| A12 | PASS | API “sends an image-only message”：`content` 只有 image，`message` 投影为 `''`，历史/回放仍能读到图，没有伪造用户文字。 |
| A13 | PASS | API 重新生成后仍加载同一 asset 的 request variant；继续轮次也携带历史图；模型切到文本路由后重新生成在 rewind 前 422，旧回复条数不变；S03 真实端点重启后重新生成回答 7。 |
| A14 | PASS | API “refuses text after switching to a text model when history has an image”：422 `scope=history`，模型调用仍为 1 次（新增文本轮零调用）。 |
| A15 | PASS | `tests/agent/request-plan.test.ts` “allows a text route once the image is behind the summary boundary”：摘要后无 image block，允许文本模型，`imageTokens=0` 但原图未删除；`tests/session/summary.test.ts` 验证摘要输入以 `[图片附件 …]` 明确标记来源 id，而不是伪造描述。 |
| A16 | PASS | `tests/service/usage.test.ts` 模拟拒图/429/401/5xx：均结束 failed、保留输入与 bound 资产、不自动重试、不改能力；错误消息各自保留。 |
| A17 | PASS | API “a 422 retry after switching models can succeed with the same id”；web “reuses the same request id and body when a failed send is retried”：重试 requestId 与 body 一致，草稿在失败时保留。 |
| A18 | PASS | web “clears the staged image when the person opens another conversation”：切换后媒体条隐藏；客户端对上传中的请求 `AbortController.abort()`，迟到响应还有 `conversationId` 比对 + 服务端 DELETE 清理路径。选择的是“取消请求”，不是把迟到图塞进 B。 |
| A19 | PASS | API “idempotency”：同 requestId 不同内容 409 `request_conflict`；完全相同的重试 `replayed=true`，模型调用仍 1 次；路由固定在 turn 上。 |
| A20 | PASS | API 已绑定图 DELETE 409；会话删除后媒体行消失；`tests/media/service.test.ts` 活租约/被引用资源不被清理，释放后清理；`tests/db/media.test.ts` 消息删除释放引用。 |
| A21 | PASS | API 上传 `<img onerror=…>.png`：JSON 原样返回为字符串、预览 `Content-Disposition` 编码、路径型 assetId 404，响应与日志无路径/Base64。 |
| A22 | PASS | API “offline second route”：同一规范消息只替换 profile/策略/适配器，走 `fake-tiles/1`、`fake-tile-v1` 公式；DB 中仍是同一份 content/blocks。 |
| A23 | PASS | `tests/agent/vision-encoding.test.ts` 两步工具循环：第二次请求仍带两张图；预算按出现次数重新计，存储去重不降为 0。 |
| A24 | PASS | 下方 B01–B12 全部通过。 |
| A25 | PASS | `npm test`：1325 passed；原上传/文本/停止/权限/恢复/SSE 结束契约全部保留；schema 版本测试更新为 9。 |
| A26 | PASS | `npm run browser:check`：选择、拖入、移除/重试、预览、发送、模型切换、390px 无溢出；截图见上。 |

## B 系列

| ID | 结果 | 证据 |
| --- | --- | --- |
| B01 | PASS | `tests/provider/image-tokens.test.ts` 7 个向量完全一致（544/512/100/640×480/480×640/800/1024），非法尺寸/溢出拒绝，极端长宽比收敛。 |
| B02 | PASS | `tests/media/service.test.ts` 同尺寸不同压缩：文件字节不同，策略计数相同。 |
| B03 | PASS | `tests/agent/request-plan.test.ts` 3000×2000 原图 / 1500×1000 变体，只有变体被计数，不等于原图计数；变体摘要进入 plan。 |
| B04 | PASS | 同图两次出现计 2×422；存储 `images.size=1`，`occurrences=2`。 |
| B05 | PASS | 5 张 800×800：`imageTokens=2110`，textTokens <100，requestBodyBytes >6,000,000，未把 Base64 当文本 Token。 |
| B06 | PASS | `fake-tile-v1` 公式 `ceil(w*h/4096)+48` 与 DeepSeek 不同；planner 无供应商分支，只按 profile/policy。 |
| B07 | PASS | 固定开销 5000，恰好等于 limit 时通过、limit−1 时 `CONTEXT_BUDGET_EXCEEDED`；输出/安全/prompt reserve 只扣一次。 |
| B08 | PASS | 落在 point estimate 与 upper bound 之间时 `CONTEXT_BUDGET_UNCERTAIN`（422），未宣称确定超限；零模型调用由 API 预检覆盖。 |
| B09 | PASS | 5 张 6 MB 变体 → `REQUEST_BODY_TOO_LARGE`（413），与 `CONTEXT_BUDGET_*` 区分；API 用 2 KB body 上限复验。 |
| B10 | PASS | `tests/service/usage.test.ts` 响应 input=5000 时 turn usage 记录 5000（不是 7110），图片分项 `imageTokensUnknown=true`；无 usage 时为 null 而非 0。 |
| B11 | PASS | `tests/media/decode.test.ts` EXIF orientation=6：300×200 → 200×300，变体方向与尺寸按编码结果；原图引用稳定。 |
| B12 | PASS | unknown 策略不按 0（A10/B06）；缺失 usage 为 null（B10 测试）；429 不改视觉能力（A16）；context 错误只作用本轮，不全局改 contextWindow（预算 preflight 仅拒绝本次）。 |

## S 系列（真实端点）

| ID | 结果 | 证据 |
| --- | --- | --- |
| S01 | PASS | 现场生成随机四位数 + 大色块，回复同时识别数字与颜色；`docs/captures/live-vision.json` 记录脱敏 model/usage。 |
| S02 | PASS | 两张现场数字图顺序 `2,7` → `2,7`，交换 → `7,2`；每对使用独立会话避免历史干扰。 |
| S03 | PASS | 重启后重新生成仍识别图中 7（首轮修复了“重新生成漏图”缺陷并加了断言）；切文本路由后同一历史图 422 `scope=history`。 |

## 与并行 Agent 的衔接

- 基线包含其 `d89a0fe`（每次模型请求前的上下文预算）及更早的
  requestId、turn admission、finish reason、恢复和 usage 入口。
- 本次复用了 `ContextBudget`/`fitContext`：扩展 `estimateItemTokens` 接受
  `PreparedMediaPlan`，图片按出现次数计入；没有另建一套预算。
- 扩展了 `TurnRecord`/`turn_requests` 的 `usage`，没有改动其 finish reason、
  admission 或恢复状态机。
- `runTurn` 在保留其事件/落库路径的前提下加入“入场前媒体预检”和
  “重新生成前资源预检”；S03 修复只影响 regenerate 的结构化内容传递。
- 未修改或被覆盖的文件：并行 Agent 的 `docs/adr/030`、执行历史/恢复/准入实现。
- 共享差异：schema v9（其 v8 之上增量）、`Store` 增加 `MediaAssetStore`、
  `ModelProfile` 增加 `capabilities`、`Message` 增加 nullable `contentParts`、
  事件增加可选 `usage`/`code`/`details`——均为向后兼容的可选/可空扩展。

## 已知限制与后续

- 默认模型是文本路由，发图需选择 Flash；这是能力事实，不是 bug。
- 预览使用请求变体（长边 ≤2048）；原图保留但当前没有“看原图细节”入口。
- 没有任何 OCR/描述降级；不支持图的路由不会被静默改写。
- 真实 usage 没有图片分项；长期校准按 route/policy revision 另行观测。
- 动画检测依赖 libvips 元数据 + 容器标记；WebP 动画的现场样本未纳入 smoke。
- 音频、视频、图片生成、实时语音和视觉 Bench 不在本期。
