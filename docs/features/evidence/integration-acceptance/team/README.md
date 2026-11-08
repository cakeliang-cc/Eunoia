# Team 抽屉全流程：真实 Chrome/CDP 浏览器证据

分支：`fix/integration-acceptance`（worktree `<repo>/.worktrees/integration-acceptance`）。
本目录只保存本项 Team 抽屉的浏览器验收证据；统一报告与 manifest 由主线汇总。

## 交付位置

| 内容 | 文件 |
| --- | --- |
| 真实浏览器断言脚本（fixture HTTP 服务 + CDP） | `scripts/team-browser-check.ts` |
| 断言日志（含每个请求的方法/URL/JSON body/headers） | `team-browser-check.json` |
| 截图（1280 与 390，各 6 张） | `1280-*.png`、`390-*.png` |
| 本说明 | `README.md` |

脚本没有修改 `package.json`、`src/`、`web/` 或现有测试。浏览器方案沿用
`scripts/dev-panel-check.ts`：不依赖 Playwright，只使用 Node 内置 WebSocket 与本机
Chrome（headless=new）的 CDP 端点。

## 命令与结果

```bash
node --experimental-strip-types scripts/team-browser-check.ts
# team browser check: 96/96 assertions passed
# 1280 与 390 各 48 项；失败即抛错并以非零码退出
```

```bash
npx tsc --noEmit
# 通过（脚本加入 scripts/**/*.ts 的类型检查范围）
```

脚本会创建临时 `HOME` 与 Chrome `--user-data-dir`，并带 `--no-sandbox`；运行结束后
删除，不写入用户 Chrome profile，也不依赖网络。

## 这是什么、不是什么

- **真实的部分**：`web/index.html`、`web/app.js`、`web/team.js`、`web/team.css` 原样由
  本地 HTTP 服务提供；真实 Chrome 解析、布局、执行 `team.js`；断言读取真实 DOM，并检查
  真实 `fetch` 发出的方法、URL、JSON body 与 `x-eunoia-token`。
- **fixture 的部分**：`/api/teams` 由脚本内的确定性快照应答，**不是生产服务**。它只
  用来证明“哪个按钮发出哪个请求、请求体是什么、响应如何渲染”。它不证明生产环境的数据
  持久化、权限、SSE 时序或并发行为；这些仍由服务端测试覆盖。

## Fixture 数据

- 团队：`mode=team`、`configRevision=1`、`maxMembers=4`、模型
  `deepseek-flash`、预算 `maxRequests=24 / 400000 input / 32000 output`；
- 一次运行 `run_team_fixture_0001`（`running`，停止后 `cancelled`）；
- 两名成员：`主成员`（root，depth 1，bind）+ `写手`（worker，depth 2，copy），共 2 名；
  这与“members tab renders two members”的断言一致（root + 1 个成员）；
- 两个任务：必需 `task_required_0001`（`submitted`，rev 7）与可选
  `task_optional_0002`（`submitted`，rev 4）；两个任务都待验收，分别用来验证
  accept 与 reject；
- 两条消息、8 条初始事件、1 个 artifact、1 个带冲突的集成候选；
- 两个 pending approval：主 approval 是 `action=shell.exec / generation=3 / 主成员`；
  第二个只为验证 reject 请求形状（任务要求的是“one pending approval”，主 approval
  满足该字段组合）；
- 1 个 pending MCP interaction（`approval`，`issues.update`）；
- SSE fixture 事件在主连接建立后由 `/__fixture/release-sse` 触发，序号按当前事件游标
  动态生成（本次为 12），用于稳定复现“事件 → 重连”而不用 sleep 猜时序。

## 断言覆盖（`team-browser-check.json`，96 项，1280/390 各 48）

- 打开：`#team-open` 打开抽屉，`role=dialog`、`aria-modal=true`；配置 meta 渲染
  模式/成员上限/模型/请求上限/输入输出预算；
- 模式开关：点击 `#team-mode` 发送 `POST /api/teams/config`，body 带
  `conversationId`、`expectedRevision`、`config.mode`、`enabled` 与 token；响应后
  标签在 `开启`/`关闭` 切换、meta 显示 `仅委派`；第二次点击使用新 revision；
- 发起运行：`POST /api/teams/runs`，body 精确包含 `conversationId`、`message`、
  UUID `requestId`，带 token；DOM 显示当前运行；
- 成员：渲染两名成员的稳定 ID（`mem_root_…` / `mem_writer_…`），姓名/角色/深度/模型/
  上下文/工作区；写手的“发送跟进”`POST /api/teams/members/:id/followup`，
  body `{runId, message}` + token；
- 任务：必需/可选徽标与 `rev 7`/`rev 4`（CAS 版本显示在卡片上）；`查看提交`
  读取 `GET /api/teams/tasks/:id` 并显示 attempts/submission/testEvidence；
  `通过`/`拒绝` 分别 `POST /api/teams/tasks/:id/review`，body 的
  `expectedRevision` 精确为 7/4，`decision=accepted/rejected`，带理由与 token；
- 消息：meta 显示稳定成员 ID（`主成员（mem_root_000…）`、`写手（mem_writer_0…）`）
  与状态；`@写手 …` 通过 `POST /api/teams/runs/:id/messages` 发送
  `{recipientId, clientMessageId(UUID), body}` + token，刷新后消息出现在列表；
- 审批：卡片显示 `待审批：shell.exec`（action）、成员、`代次：3`、执行 activation、资源、
  风险、策略、请求摘要与理由；
  `批准本次`/`拒绝` 分别 `POST /api/teams/runs/:id/approvals/:approvalId`，
  body `{decision, reason}` + token，处理后卡片消失；
- MCP：卡片显示 payload；`接受` `POST /api/teams/runs/:id/mcp-interactions/:id`，
  body `{action:'accept', response:{}}` + token；
- 集成：artifact 渲染候选哈希/文件/testEvidence；集成候选显示
  `冲突：src/shared.ts`；`解决冲突` 通过 `GET /api/teams/integrations/:id/conflicts`
  展示源文件/候选/另一方；`保留源文件` `POST .../conflicts`，body
  `{path, resolution:'source'}` + token；`重新验证` `POST .../verify`；随后
  `发布到源目录`（stub 确认框）`POST .../publish`，body `{memberId}` + token；
- SSE：初始连接从快照游标 `after=8` 订阅；fixture 推送事件后触发一次 snapshot 刷新，
  重连请求从新游标 `after=12` 继续；期间写请求数不变、不新建 run、成员卡片仍为 2；
- 停止：`停止整队`（stub 确认框）`POST /api/teams/runs/:id/stop`，body
  `{reason:'用户停止整队'}` + token，并到达 `cancelled`；
- 键盘：打开后焦点在 `#team-close`；Escape 关闭并把焦点还给 `#team-open`；
- 布局（1280/390）：`document.documentElement.scrollWidth <= innerWidth + 1`，
  `body.scrollWidth <= width + 1`，抽屉完整落在视口内，面板内容不横向滚动；
  1280 抽屉宽 480，390 抽屉宽 390（全宽）。

每个场景最后统一检查：所有 Team 写请求都带 `x-eunoia-token` 且
`content-type: application/json`；config/start 都使用 localStorage 里的
`df_conversation`。

## 契约差异与未覆盖（重要）

1. **本证据依赖工作树里一个并发修复。** 运行本次证据时，`web/team.js` 的 `el()` 已被
   另一项改动修复为能 append 元素参数（`git status` 显示 `M web/team.js`，不是本脚本改的）。
   因此 approval/MCP/artifact/integration 卡片标题本次正常渲染，断言也覆盖标题。如果把
   `web/team.js` 回退到修复前，三条标题断言会失败并暴露 `[object HTMLSpanElement]`。
2. **模式开关是 POST，不是 PUT/PATCH。** 本仓库的 Team API 只有
   `POST /api/teams/config`（CAS：`expectedRevision`），`web/team.js` 也使用 POST。
   脚本断言真实请求，不伪造不存在的 PUT/PATCH 路由。
3. **没有人工“领取/提交”按钮。** 本版本的 `web/team.js` 在任务页暴露
   `查看提交`（读 attempts/submission）与 `通过`/`拒绝`（review，带 CAS）；没有
   `领取`（claim）或 `提交`（submit）控件，因为 claim/submit 是模型侧工具
   （`team_task_claim`/`team_task_submit`），不是这个抽屉的人工操作。脚本覆盖了真实存在
   的提交证据读取与 review；如果验收要求人工 claim/submit，需要另开产品改动。
4. **运行控制按钮的 `[hidden]` 被 CSS 覆盖。** 停止后 `team-pause/team-resume/
   team-stop` 的 `hidden` 都是 true，但 `.soft-button{display:inline-flex}` 覆盖了
   UA 的 `[hidden]{display:none}`，所以三个按钮仍可见（截图 390/1280-panel）。
   这是非阻塞观察，已写入 JSON 的 `findings`；本脚本没有修改 `web/`。
5. **`@` 只是消息正文。** 抽屉没有结构化 mention/自动补全；脚本验证了
   `recipientId` 选择与包含 `@写手` 的 `body` 都正确发送。
6. **fixture 的两个 approval。** 主 approval 完全满足“member/action/generation”；
   第二个只用于覆盖 reject 请求。生产数据的 approval 数量不受此约束。
7. **SSE 是确定性 fixture。** 事件序号和重连时机由脚本控制，不覆盖生产网络抖动、
   Last-Event-ID 与事件裁剪；服务端 SSE 游标另有单测覆盖。
8. **Chrome 环境。** 需要本机
   `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。脚本用临时
   HOME/profile 与 `--no-sandbox` 规避 EPERM/缓存问题；未安装任何依赖。
9. **未提交。** 改动仅为新增脚本、证据目录与本 README。

## 截图索引

| 文件 | 内容 |
| --- | --- |
| `1280-members.png` / `390-members.png` | 打开后的配置、发起运行、成员 |
| `1280-tasks.png` / `390-tasks.png` | 必需/可选任务、CAS revision、review |
| `1280-messages.png` / `390-messages.png` | 稳定成员 ID 与 @ 消息 |
| `1280-approvals.png` / `390-approvals.png` | 审批（generation/资源）与 MCP 卡片 |
| `1280-integration.png` / `390-integration.png` | artifact、冲突、两侧内容与操作 |
| `1280-panel.png` / `390-panel.png` | 停止后的抽屉布局与视口适配 |

`team-browser-check.json` 保存了全部 96 条断言、两个场景的完整请求列表、fixture 摘要、
`findings` 与失败时的 `pageProbe`（DOM 文本/当前 tab），便于复核。
