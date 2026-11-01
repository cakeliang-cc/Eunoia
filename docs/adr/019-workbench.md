# 019 — 可见的工作区（Workbench）

## 状态

已实现。前端在 `web/index.html`，服务在 `src/workspace-ui/`。

## 背景

编码工具已经能读写一个工作目录，但页面上没有地方看见它。模型说“我改好了”，
人能看到的只有一句摘要；文件树、实际 diff、以及“这一轮到底动了哪些文件”都在
页面之外。这个项目的对话界面是为陪伴设计的，但一个会碰代码的 agent 需要一块
可以检查它的地方。

## 决定

在对话右侧加一个 **workbench**，三个视图：

- **文件**：逐层列出目录，点开文件做只读预览，带行号；
- **改动**：读 git 工作树状态，列出改动文件，点开看 unified diff；本次对话里
  `write_file` / `edit_file` 成功写过的路径也会单独列出；
- **终端**：一条一条执行用户输入的命令，流式显示 stdout/stderr 和退出码。

工作区根目录默认来自 `WORKSPACE_ROOT`；也可以在界面里选择，选择结果持久化到
`data/workspace-ui.json`。选择器从 `$HOME` 开始；设置 `WORKSPACE_BROWSE_ROOTS`
可以把它限制在一个或多个目录里。

### 它不是 agent 的第二个执行入口

workbench 的读文件和 git 检查在服务进程里做，不经过 agent 的 Sandbox Gateway。
这是一条有意画出的边界：

- agent 的文件/命令工具仍然只走 `src/tools/` → Sandbox Gateway；
- workbench 只读文件、只读 git，终端是**用户自己**敲的命令，不是模型发起的工具
  调用；
- 因此 workbench 不能替模型执行命令，也不能绕过工具策略。

终端默认只在服务绑定 loopback 时开启；`HOST=0.0.0.0` 时默认关闭，需要显式
`WORKSPACE_TERMINAL=1`。它不是 PTY，也不保留 shell 状态：每条命令独立运行，
`cd` 不会延续到下一条。需要真正的交互式终端时再引入 PTY，而不是把这里慢慢
长成一个半成品 shell。

### 路径和凭据

文件列表和预览复用 `src/tools/workspace.ts` 的 `Workspace`：词法包含、`realpath`
检查、忽略目录、凭据文件规则都在那一处，workbench 不复制一份。额外加了两条
workbench 自己的检查：

- 列目录前对真实路径再查一次，避免 workspace 内的 symlink 把目录指到外面；
- 浏览器的目录选择器只返回目录名，不返回文件内容；`WORKSPACE_BROWSE_ROOTS`
  在浏览和“切换根目录”两处都生效。

写入不在第一版里。预览是只读的，终端可以产生改动，但改文件仍由 agent 的工具
或用户自己的编辑器完成。

### 和 agent 根目录的关系

workbench 的根目录和 agent 的 sandbox bind 根目录默认是同一个
`WORKSPACE_ROOT`。如果人在界面里换了目录，footer 会显示 agent 实际使用的目录；
两者不同时，workbench 不会假装它们相同。把界面选择同步到 sandbox 的任务生命周期
是另一件事，不在这一版里假装完成。

## 后果

- 人第一次能看见工作区，而不是只相信一句“改好了”。
- 多了一个本机 HTTP 面：`/api/workspace/*`。它有同源检查，修改类请求（切换根
  目录、终端）要求 `X-Workspace-UI: 1`，所以普通 HTML 表单不能直接触发。
- 这是一个单用户、loopback 优先的工具。没有登录之前，不要把带终端的实例暴露到
  网络上。
- 终端输出有字节上限和超时；超时会杀掉整个进程组，避免子进程留在后台。
- git 检查是只读的：不刷新 index、不加锁、不调用外部 diff 驱动；没有 git 或
  不是仓库时，改动视图退化为“本次对话工具写过的文件”。
