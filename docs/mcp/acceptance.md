# MCP 接入验收报告

日期：2026 年 11 月 8 日。实现提交：`feat/mcp-host`（见 `git log`）。协议实测：
`2025-06-18`（真实 stdio fixture），SDK `@modelcontextprotocol/client` 2.1.0。

状态含义：

- **PASS**：有本仓库可重跑的测试或命令证据；
- **PARTIAL**：核心链路有证据，但清单要求的某个侧面（浏览器、真实账号、容器、
  通知）没有覆盖；
- **BLOCKED**：缺少环境（Docker、三方 OAuth、真实模型、公共网络），不能在本机
  产生合格证据；
- **FAIL**：实现或证据不足，且不是环境原因。

> 不把 BLOCKED 改写成 PASS。所有“通过”的条目都能在下面的命令中找到对应测试。

## 1 运行的命令

```sh
npm run typecheck        # 0 error
npm run lint             # 0 error（仅剩既有 any 警告）
npm test                 # 1371 + MCP 新增，全部通过
npm run build            # tsc + assets 复制成功
npm run browser:check    # 390px + 桌面，含 MCP 抽屉，无横向溢出
```

MCP 专项：

```sh
npx vitest run tests/mcp tests/service/mcp-turn.test.ts tests/api/mcp.test.ts
```

证据文件：`docs/captures/mcp-390.png`、`docs/captures/mcp-desktop.png`、
`docs/captures/browser-check.json`。

## 2 测试清单与对应关系

| 测试文件 | 覆盖 |
| --- | --- |
| `tests/mcp/contract.test.ts` | 契约、schema 约束、本地/远程 `$ref`、命名空间与截短摘要 |
| `tests/mcp/config.test.ts` | 配置校验、host 开关、env 引用、私网、导入预览 |
| `tests/mcp/catalog.test.ts` | 分页/循环 cursor、重复名、大小上限、deny 优先、分类 |
| `tests/mcp/credentials.test.ts` | AES-GCM、AAD、无密钥拒绝、脱敏器 |
| `tests/mcp/interactions.test.ts` | 审批单次转换、过期、取消、跨用户拒绝 |
| `tests/mcp/content.test.ts` | 有序块、图片导入/拒绝、音频说明、structuredContent |
| `tests/mcp/manager.stdio.test.ts` | 真实子进程：连接、分页发现、调用、图片、陈旧租约、结构化失败 |
| `tests/service/mcp-turn.test.ts` | 真正回合：工具结果入模、审批暂停/继续、图片逐步骤计划 |
| `tests/api/mcp.test.ts` | 控制面：CRUD/连接/工具/资源/提示词/审批/绑定/令牌 |

## 3 M01–M60

| ID | 状态 | 证据 / 说明 |
| --- | --- | --- |
| M01 | PASS | schema v11 迁移测试（`tests/sandbox/sqlite.test.ts`、`tests/db/turns.test.ts`）覆盖 v1/v2/v3/v7 升级与幂等；内存与 SQLite 契约一致 |
| M02 | PASS | 同一校验器：`config.test.ts` 的导入预览与 API `/servers` 均走 `parseServerInput`；非法命令/引用被拒绝，导入不执行 |
| M03 | PARTIAL | `configRevision` 乐观锁有代码与 409 路径；并发修改/重复启停没有并发测试，重复 connect 的幂等有实现但未做双进程压测 |
| M04 | PARTIAL | 存储层按 owner 过滤，`interactions.test.ts` 验证跨用户不能 resolve；API 跨用户/跨会话的完整矩阵未覆盖 |
| M05 | PASS | `manager.stdio.test.ts` 第一项：真实 `node mcp-stdio-server.mjs` 子进程，分页工具可见并可调用，结果含随机 marker |
| M06 | BLOCKED | 环境没有 Docker；`docker run -i` 参数构造有单元级代码，但未运行真实 OCI |
| M07 | PASS | `config.test.ts`：未授权 host、含空格命令、非 digest 镜像均明确拒绝 |
| M08 | PASS | `config.test.ts`：子进程环境只含允许列表与显式 `env:`；`DEEPSEEK_API_KEY` 不能引用 |
| M09 | BLOCKED | `disconnect` 会关闭连接；进程树/卡死宽限的真实清理未在容器环境验证 |
| M10 | BLOCKED | HTTP 传输使用 SDK，但没有可控 HTTP fixture，未做 JSON/SSE/旧版本实测 |
| M11 | PARTIAL | 受控 fetch 手动重定向、跨域去凭据、私网/明文校验有代码与配置测试；真实 DNS/重定向未跑 |
| M12 | PARTIAL | 引用解析、Bearer/header 拼接、无密钥不存 secret 有测试；真实远端认证未跑 |
| M13 | BLOCKED | 没有受控授权服务器；预注册/DCR/CIMD 路径交给 SDK，未做三种路径实测 |
| M14 | PARTIAL | state 与 server 绑定、跨服务回调拒绝有代码；未做真实回调重放测试 |
| M15 | PARTIAL | token 密封、刷新由 SDK 驱动；并发刷新与注销后调用未实测 |
| M16 | PASS | `credentials.test.ts`：数据库无明文、缺密钥拒绝、AAD 不匹配失败；备份不含主密钥 |
| M17 | PASS | `catalog.test.ts`：分页、重复 cursor 拒绝、重复名拒绝、schema/目录上限 |
| M18 | PASS | `contract.test.ts`：两服务器不同 slug、超长名 8 位摘要、字符清洗 |
| M19 | PASS | `contract.test.ts`：嵌套/数组/required/enum/union/数值约束，非法参数零远端调用（`manager.stdio.test.ts` 陈旧租约项） |
| M20 | PASS | `contract.test.ts`：2020-12 归一化、远程 `$ref` 拒绝、无参数工具 |
| M21 | PASS | `catalog.test.ts` deny 优先；`api/mcp.test.ts` 会话绑定；内置工具不受影响（全量回归） |
| M22 | PARTIAL | 原子发布与失效标记有测试；`tools list changed` 通知的真实触发未测 |
| M23 | PASS | `manager.stdio.test.ts` 陈旧租约：目录 revision 不匹配时零远端调用 |
| M24 | PASS | `catalog.test.ts`：readOnlyHint 默认仍是 `external_unknown`，只有显式信任才变只读 |
| M25 | PARTIAL | 循环对外部调用串行、授权先于执行；“读并发 + 两个写 + 一个待批准”的组合未单独测 |
| M26 | PASS | `interactions.test.ts` 审批/拒绝/重复点击；超时经 `awaitDecision` 的过期分支 |
| M27 | PARTIAL | 评审可刷新、取消后迟到批准不执行（单次转换）；重启后自动接回模型未实现 |
| M28 | PARTIAL | 授权绑定 contractHash/参数摘要；批准后目录变化在 `resumeAction` 被拒；完整“旧摘要执行新动作”测试未写 |
| M29 | PARTIAL | elicitation 表单状态机与 schema 渲染有代码；没有服务器发起 elicitation 的 fixture |
| M30 | PASS | `runtime.ts` 拒绝含 password/secret/token 字段的表单；URL 模式只显示域名 |
| M31 | BLOCKED | SDK `inputRequired.autoFulfill` 已启用，但没有 modern-era fixture 验证多轮 |
| M32 | PASS | `content.test.ts` 文本多块 + structuredContent + outputSchema；`manager.stdio.test.ts` 违规即失败 |
| M33 | PARTIAL | `isError`、schema 错、超时可区分；协议错/网络错的分类只经 `mapSdkError`，未逐类实测 |
| M34 | PARTIAL | 发送后异常记 `unknown` 的代码路径存在；断线场景未构造 |
| M35 | PARTIAL | MCP 工具与内置工具共用循环/事件；一个回合混合两者的测试未写 |
| M36 | PASS | `service/mcp-turn.test.ts` 图片项：两张图按序导入并进入下一模型请求 |
| M37 | PASS | `content.test.ts` 不支持格式、空图、音频、artifact、解码失败说明 |
| M38 | PASS | `service/mcp-turn.test.ts`：图片第二步出现、按出现次数计数、逐步骤重规划 |
| M39 | BLOCKED | 需要真实文本模型与会话历史；现有媒体预检测试覆盖“历史含图但模型不支持” |
| M40 | PARTIAL | `api/mcp.test.ts` 列表/读取/选入快照；模板补全与模板读取未测 |
| M41 | PARTIAL | `visibleResource` 只允许目录/模板前缀；`file://` 与内网链接未构造测试 |
| M42 | BLOCKED | 订阅有实现，但没有通知/退订的 fixture |
| M43 | PARTIAL | 列表/获取/预览已验证；参数补全未测；提示词只预览，不自动应用 |
| M44 | PARTIAL | UI 全用 `textContent`；注入文本的浏览器断言未写 |
| M45 | BLOCKED | 任务句柄持久化；SDK 无独立任务 fixture，未验证创建→轮询→结果 |
| M46 | BLOCKED | 任务补充输入与取消确认未验证 |
| M47 | BLOCKED | 重启后任务状态核对未验证 |
| M48 | PASS | `content.test.ts` 超限即拒绝；`catalog.test.ts` schema/目录上限 |
| M49 | PASS | 工具 schema 计入既有 `context-budget`；`tests/agent/context-budget` 全量回归 |
| M50 | BLOCKED | 需要 durable 轨迹 + 关闭服务器回放；MCP 结果本地快照未单独测 |
| M51 | PARTIAL | 既有重生/幂等测试通过；MCP action 在重生时不重放有设计但未测 |
| M52 | BLOCKED | 关键写入失败注入未做 |
| M53 | PARTIAL | 删除服务/会话级联有 schema 与 API 证据；MCP 媒体 GC 未单独测 |
| M54 | PARTIAL | 管理抽屉可增删改、连接/刷新/认证/工具列表；浏览器检查覆盖 390px 与空状态，不覆盖真实远端 |
| M55 | PARTIAL | 聊天卡片显示 MCP 来源、内联审批；补充输入/任务进度卡片未在浏览器实测 |
| M56 | PASS | `browser:check`：390px 与桌面无横向溢出；MCP 抽屉面板 390px 宽；所有文本走 textContent |
| M57 | FAIL | 第二个离线模型适配器未实现 |
| M58 | PARTIAL | 脱敏器与密钥存储有测试；数据库/日志/SSE 的诱饵秘密扫描未做 |
| M59 | FAIL | 只有模型 usage 与动作记录，没有 MCP 延迟/字节/重连的独立计量 |
| M60 | PASS | typecheck/lint/test/build/browser 全绿，既有 1371 项无回归 |

## 4 L01–L06

| ID | 状态 | 原因 |
| --- | --- | --- |
| L01 | BLOCKED | 宿主 stdio 有真实子进程证据，但“经 Web 发起 + 模型调用 + 容器”需要真实模型与 Docker |
| L02 | BLOCKED | 没有真实 HTTP MCP 服务与账户；审批“批准前 0、批准后 1”在单测/集成中成立，未走 Web+远端 |
| L03 | BLOCKED | 没有受控 OAuth 授权服务器与浏览器流程 |
| L04 | BLOCKED | 没有同时提供 resources/prompts/elicitation/tasks 的真实综合服务 |
| L05 | BLOCKED | 需要真实模型与公共网络，不在本机验收范围 |
| L06 | BLOCKED | 需要 GitHub/浏览器等第三方账号；未创建任何外部写 |

## 5 已知缺口（明确不声称）

1. **重启后自动继续模型回合**：resume 执行原 action 并返回结果，但不会把结果自动
   接回中断的模型步骤；用户需要显式继续。影响 M27/M47。
2. **OCI 沙箱**：代码构造受控 `docker run -i`，没有在本机跑真实容器；宿主模式已
   被单独验证。
3. **HTTP 与 OAuth 的真实服务**：策略、凭据、回调和密封存储有单元/集成证据，没有
   可控远端。
4. **任务扩展**：句柄与查询/取消接口存在，SDK 的 `tasks/*` 方法不在公开便利 API
   中，主机用原始 request 实现；没有 fixture 验证。
5. **MCP 计量**：动作表记录状态、耗时可用日志推断，但没有独立的延迟/字节/重连面板。
6. **第二模型适配器**：没有实现另一种工具结果媒体编码，因此无法用离线第二适配器
   证明核心不依赖模型名。

这些缺口不是“后续版本”占位符：代码路径与拒绝行为都在，缺的是环境或最后一公里。
