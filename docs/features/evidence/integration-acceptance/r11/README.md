# R11 开发面板、来源卡片与范围撤销：证据

分支：`fix/integration-acceptance`（worktree `<repo>/.worktrees/integration-acceptance`）。
本目录只保存本次 R11 前端与浏览器验收证据；统一报告与 manifest 由主线汇总。

## 交付位置

| 内容 | 文件 |
| --- | --- |
| 开发面板（作业 / 预览 / 改动与撤销） | `web/dev-panel.js`，`web/index.html` 的 `#dev-drawer`、`#dev-open` |
| 面板样式、来源卡片、390px 布局 | `web/team.css` |
| 来源卡片渲染（真实标题/URL、费用未知、日期未知） | `web/app.js` 的 `addSourceCards` |
| 作业/来源事件的真实数据投影 | `src/agent/events.ts` `ToolSourceEvent`；`src/agent/loop.ts` `sourcesForEvent` |
| 文件级撤销范围（主线实现，本项复用） | `src/sandbox/workspace-change-service.ts` `planUndo` / `undo({paths})`；`src/api/server.ts` `POST .../undo/preflight` |
| 单元回归 | `tests/web/dev-panel.test.ts`（含范围撤销与来源事件契约） |
| 真实浏览器断言 | `scripts/dev-panel-check.ts` |
| 浏览器断言日志 | `dev-panel-check.json` |
| 截图 | `390-*.png`、`1280-*.png` |

## 命令与结果

```bash
# 单元回归（14 项）
NODE_OPTIONS='--experimental-sqlite --disable-warning=ExperimentalWarning' \
  npx vitest run tests/web/dev-panel.test.ts
# 结果：14 passed

# 全量 web 回归（115 项）
NODE_OPTIONS='--experimental-sqlite --disable-warning=ExperimentalWarning' \
  npx vitest run tests/web
# 结果：115 passed（dev-panel 14 项包含在内）

# 受影响的后端回归
NODE_OPTIONS='--experimental-sqlite --disable-warning=ExperimentalWarning' \
  npx vitest run tests/agent/loop.test.ts tests/service/workspace-undo.test.ts tests/api/workspace-undo.test.ts
# 结果：32 passed

# 真实 Chrome/CDP 浏览器断言（1280 与 390 各跑一遍完整场景）
node --experimental-strip-types scripts/dev-panel-check.ts
# 结果：62/62 assertions passed

# 类型检查
npm run typecheck
# 本项涉及的文件无错误；运行当时仓库内另有
# tests/semantic/lsp-provider.test.ts 与 scripts/vision-diagnostic.ts 的
# 其他整改项类型错误（非本项文件），因此该命令整体未通过，详见下方“未覆盖/阻塞”。

# 静态检查（本项文件）
npx eslint web/app.js web/dev-panel.js tests/web/dev-panel.test.ts tests/web/harness.ts scripts/dev-panel-check.ts
# 结果：0 errors，3 个 scripts/dev-panel-check.ts 的 any 警告（CDP 返回值）
```

浏览器脚本不依赖 `playwright`：`@playwright/mcp` 只是 devDependency，直接 import 它的
传递依赖 `playwright-core` 不是稳定契约；因此沿用仓库已有的 Chrome + CDP 方案，不修改
`package.json`。脚本启动一个本地 fixture HTTP 服务（记录每个请求的方法、URL、JSON body
和 `x-eunoia-token`），把 `web/` 原样提供给真实 Chrome。fixture 不是生产服务，但页面、
脚本和事件格式都是真实的；它证明按钮实际发出的请求与面板实际渲染的 DOM。

## 断言覆盖（`dev-panel-check.json`，62 项，1280/390 各 31）

- 面板打开/关闭，`role=dialog`、`aria-modal`、`aria-labelledby`；
- 作业列表：归属、成员、状态、退出码、日志游标；
- 读日志：请求带 `conversationId` 与当前 `cursor`，文本与推进后的游标出现在 DOM；
- 停止作业：`POST /api/processes/:id/stop`，body `{conversationId}`，带 `x-eunoia-token`；
- 预览列表：只有 `ready` 的租约渲染 `<a target=_blank rel="noopener noreferrer">`；
  `failed`/`expired` 行没有任何 `<a>`，并显示“地址不可用：原因”；
- 启动预览：body 精确包含 `conversationId/command/port/cwd/ready_timeout_ms` 与 token；
  201 就绪后出现新链接；409 未就绪显示 detail 且无链接（单元测试覆盖 409）；
- 预览日志：复用 `/api/processes/:id/logs`；停止预览发送 `{conversationId}`；
- 来源卡片：真实标题与 `https://nodejs.org/en`，`rel=noopener noreferrer`，
  `费用未知`、`日期未知`，有 `publishedAt` 时显示真实日期；空标题/`javascript:` 被丢弃；
- 改动：`修改`/`新增`、before/after 字节与摘要；预检显示冲突清单；
- 部分撤销：只选 `src/a.ts` 且后续轮次仍引用它时，预检拒绝并显示原因与可行范围，
  点击撤销**不发出任何写请求**；改选 `src/new.ts` 后预检通过，撤销 body 只含
  `paths:["src/new.ts"]`，并显示“实际已应用”集合；
- 键盘：打开后焦点在关闭按钮，Tab 进入面板、Shift+Tab 回到关闭按钮，Escape 关闭并把焦点
  还给 `#dev-open`；
- 布局：`document.documentElement.scrollWidth <= innerWidth + 1`，
  `body.scrollWidth <= width + 1`，抽屉完整落在视口内。

截图：

- `390-jobs.png` / `1280-jobs.png`
- `390-previews.png` / `1280-previews.png`（可见 failed/expired 没有链接）
- `390-sources.png` / `1280-sources.png`
- `390-changes-blocked.png` / `1280-changes-blocked.png`（部分撤销被拒绝与原因）
- `390-changes-applied.png` / `1280-changes-applied.png`（实际已应用集合）
- `390-panel.png` / `1280-panel.png`

## 未覆盖 / 已知边界

1. **浏览器证据使用本地 fixture**：它验证客户端契约与 DOM，不验证真实容器作业/预览网关。
   真实沙箱、端口探测与租约路由需要 `R04/R05` 的容器环境；本脚本不声称已跑通真实预览。
2. **`moved`**：`WorkspaceChangeKind` 只有 `added/modified/deleted`，一个重命名在变更集里
   表现为删+增。开发面板对 `moved/renamed` 有渲染分支，但后端不会产生这种记录；git 级别的
   重命名仍由既有“工作区 → 改动”标签以 `path ← from` 展示，面板文案明确说明这一点。
3. **before/after 内容**：变更集保存 before 内容与前后摘要/字节；after 内容不重复保存，
   面板展示 before 内容展开、before/after 字节与摘要。逐行 diff 仍由工作区 git diff 提供。
4. **来源费用**：当前 web 工具不返回价格，卡片按需求显示“费用未知”；只有后端真的给出
   `costUsd` 时才显示费用。日期同理，缺失时显示“日期未知”，不会用今天代替。
5. **类型检查**：本项文件通过；`npm run typecheck` 当时仍被其他整改项的
   `tests/semantic/lsp-provider.test.ts`、`scripts/vision-diagnostic.ts` 阻断（不在本项可改范围）。
