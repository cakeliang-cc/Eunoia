# ADR 015 — 技能：按需加载的流程，不是工具，也不是 Agent

## 背景

工具系统（ADR 014）解决的是“Agent 能做什么动作”：读文件、搜索、改文件、跑命令。
它不解决“这类任务应该按什么顺序做”：改完代码要跑哪些检查、发版前要比较什么、
文档过时了从哪开始查。这些知识目前散在提示词、README 和人的记忆里。

把它们全部写进系统提示词会让每一轮都为一个可能用不到的流程付费，也会让提示词
随着仓库增长而腐烂。为每个流程加一个工具，则会让工具列表变成一份 RPG 技能表，
模型挑错工具的概率随数量上升。让每个技能变成一个子 Agent，会直接违反 ADR 001。

## 决定

采用 Agent Skills 的 `SKILL.md` 格式，做**项目内 + 内置**的技能层。

### 1. 技能是流程，不是工具

一个技能是一个目录：

```text
skill-name/
├── SKILL.md        # YAML frontmatter + Markdown 正文
├── references/     # 按需读取
├── scripts/        # 按需执行
└── assets/         # 模板、图片等
```

frontmatter 的两个核心字段是 `name` 和 `description`。它们不是简介，而是**路由
元数据**：description 同时回答“做什么”和“什么时候用”。

技能不增加工具。它需要的动作仍然由现有工具完成；技能只是告诉模型该在什么时候、
以什么顺序调用它们。技能也不能扩大权限——见下面第 4 点。

### 2. 三层渐进披露

| 层 | 内容 | 何时进入上下文 |
|---|---|---|
| 1 | `name` + `description` | 每轮，作为技能索引 |
| 2 | `SKILL.md` 正文 | 模型调用 `load_skill` 时 |
| 3 | `references/`、`scripts/`、`assets/` | 正文明确要求时，用 `read_file` / `run_command` |

索引只放在运行时上下文的 `# 可用技能` 块里，不写进稳定提示词。技能正文作为
`load_skill` 的**工具结果**进入下一轮模型输入——复用循环已有的“工具结果回喂”，
不引入第二套上下文机制。

### 3. 发现位置与优先级

只支持落在 `WORKSPACE_ROOT` 里的项目技能，以及随服务发布的内置技能：

```text
<WORKSPACE_ROOT>/.eunoia/skills/      # 项目自己的约定，优先级最高
<WORKSPACE_ROOT>/.agents/skills/      # 兼容 Codex / Claude 的约定
src/skills/builtin/                   # 随服务发布，构建时复制进 dist/
```

同名技能的优先级按上面的顺序；被覆盖的那个会写进 `server.skill_diagnostic`，
而不是静默消失。非法技能、symlink 技能目录、缺失 `SKILL.md` 也都是诊断，不是
静默跳过：一个永远不会加载的技能，必须能回答“为什么”。

第一版不支持 `~/.eunoia/skills` 全局技能。原因是模型只能用 `read_file` 读
工作目录内的 `references/`；全局技能在工作目录外，列出来的参考资料会是一个
读不到的路径。要么加 `read_skill_file`，要么把技能复制进项目——那是另一层设计。

### 4. `allowed-tools` 是声明，不是授权

frontmatter 可以写 `allowed-tools`，Claude Code 用它预批准工具。这里**不这样做**：

- 进程策略（`WORKSPACE_WRITES` / `WORKSPACE_COMMANDS`）仍然是唯一的授权来源；
- `load_skill` 只报告“这个技能需要什么、当前哪些不可用”；
- 技能需要 `run_command` 但命令没开时，模型必须停下来告诉用户，不能绕过；
- `load_skill` 永远不执行脚本，只读 `SKILL.md`。

这样技能不会成为权限提升的入口。Claude 的 `Read` / `Bash` / `Grep` 等工具名会
被映射到本项目的 `read_file` / `run_command` / `grep`，这只是兼容层，不是授权层。

### 5. 脚本按需运行，不自动执行

`load_skill` 列出 `scripts/` 的路径，并明确说“不会自动执行”。模型需要时用
`run_command` 跑；命令权限没开就报告没开。脚本内容不读进上下文——能跑就跑，
跑失败再调试。这是 OpenAI 在 Agents SDK 仓库里用的分工：模型负责解释和比较，
脚本负责确定性的机械步骤。

### 6. 一个 `load_skill` 工具，而不是每个技能一个工具

工具列表保持稳定：记忆工具 + 编码工具 + `load_skill`。技能数量增长只改变索引
文本，不改变 schema 数量，也不改变模型需要在几十个工具名里做选择的局面。

## 备选方案

1. **把每个技能做成一个工具。** 被否决：工具是动作，技能是流程；而且工具列表
   随技能数量增长，选择成本会变成主要成本。
2. **把全部 `SKILL.md` 塞进系统提示词。** 被否决：每一轮都为所有技能付费，
   也失去了“只在需要时加载”的缓存优势。
3. **用向量检索选技能。** 现在被推迟，不是被否定。技能少于 30 个时，description
   加模型判断够了；检索需要嵌入、索引和一套新的失败模式，等数量证明需要再说。
4. **每个技能一个子 Agent。** 被否决：ADR 001 是一个 Agent。
5. **让技能自动执行脚本。** 被否决：脚本是代码，必须继续走命令权限。
6. **全局技能目录。** 推迟，理由见第 3 点。

## 后果

- **项目技能需要重启服务才会被发现。** 发现发生在启动时，不每轮扫盘；这和
  `WORKSPACE_ROOT` 一样是进程级配置。
- **索引有成本。** 每个技能约 100 token 的索引；超过 30 个只列前 30 个并提示。
  如果测量显示这笔开销显著，下一步是把索引移进稳定提示词并纳入版本哈希，而不是
  继续增加技能。
- **技能正文是受信任的本地内容。** 它和代码一样，来自用户自己的仓库；从不受信任
  的仓库加载技能，等同于从那个仓库执行文档级指令，应该先审查。
- **没有显式 `/skill` 调用。** 第一版靠 description 路由；显式调用、`/api/skills`
  之外的管理 UI、以及技能级 eval 都是后续工作。
- **内置技能是自包含的。** 它们不依赖 `references/`，因为 `load_skill` 不能保证
  内置目录在 `WORKSPACE_ROOT` 内；项目技能可以自由使用资源目录。
- **观测是日志级的。** `load_skill` 记下 name、source、hash 和缺失工具；`agent_runs`
  仍只记工具名，不单独建技能表。要按技能统计成功率，需要下一个 migration。

## 相关文件

- `src/skills/parse.ts` — frontmatter、校验、Claude 工具别名映射
- `src/skills/registry.ts` — 发现、优先级、索引、加载、诊断
- `src/skills/builtin/` — `code-change-verification`、`release-review`、`docs-sync`
- `src/tools/skill.ts` — `load_skill`
- `src/agent/runtime-context.ts` — `# 可用技能` 块
- `src/service/chat.ts` — 组装技能工具与索引
- `src/api/server.ts` — 启动时发现技能、`/api/skills`、`/health`
- `tests/skills/`、`tests/tools/skill.test.ts`
