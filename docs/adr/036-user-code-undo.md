# ADR 036：用户可操作的按轮撤销

日期：2026 年 11 月 8 日。状态：已实现。

## 1 背景

工作区已经有检查点（ADR 017/028），但它的用途是**恢复执行**：把已知状态重新放回去，
让 Agent 从一个确定的位置继续。用户需要的却是另一种操作：

> Agent 这一轮改错了。把这轮新增、修改和删除的文件退回去，但不要覆盖我后来手动改的
> 内容。

两者不能共用一套语义。恢复可以覆盖“未知的后来状态”，因为它的目标是回到受控快照；
撤销必须**拒绝**覆盖后来状态，因为那可能是用户真实的工作。

已有 `WorkspaceManager.restoreCheckpoint()` 明确保留快照之后新增的文件——这是正确的恢复
语义，但直接当撤销用会漏掉“本轮新增”的文件，也会覆盖用户后来的编辑。

## 2 决定一：变更集是“这一轮的文件事实”

新增 schema v12：

- `workspace_changesets`：每轮一行，保存 turnId、workspaceId、前后 manifest 摘要、
  文件计数、可选 checkpointId、状态（available/undone/partial）；
- `workspace_changeset_files`：每个文件一行，保存 added/modified/deleted、前后
  SHA-256、字节数、修改前文本（write/edit 日志）、恢复来源（journal/checkpoint/none）
  和是否已恢复。

`UNIQUE(conversation_id, turn_id)` 让重试的同一回合落在同一变更集上，而不是叠加第二份。

变更集不复制整个工作区：它只保存“修改前文本”（文件工具写入/编辑过的文件，≤512 KiB）
和一个 checkpoint 引用（命令改过的文件）。

## 3 决定二：三种事实的组合

| 事实 | 回答的问题 | 采集时机 |
| --- | --- | --- |
| manifest diff | 这一轮到底改了哪些文件（包括命令改的） | 第一次写/命令之前取基线，回合结束取结束态 |
| write journal | 被文件工具覆盖前，原来是什么字节 | `writeFile`/`editFile` 真正落盘之前 |
| checkpoint | 命令可能改了任意文件，修改前树是什么 | 本轮第一条命令之前，只建一次 |

基线是**惰性**的：`arm()` 只登记回合；第一次 `beforeWrite`/`beforeCommand` 才抓 manifest。
纯对话/只读回合因此不付出整仓哈希的代价，而基线仍然早于任何修改。

diff 用内容摘要而不是 mtime：同样的字节重写不算修改，同样大小的编辑不会被误判为没变。

## 4 决定三：撤销只覆盖“仍是本轮结束状态”的文件

对每个文件：

1. 读当前 SHA；与 `after_sha` 比较；
2. 不相等 → 冲突，不写；
3. 相等：
   - added → 删除文件；
   - modified/deleted → 用 journal 文本或 checkpoint 内容恢复；
4. 恢复前再校验保存内容的摘要等于 `before_sha`，否则拒绝（不信任半截数据）。

`force=true` 是显式覆盖，仍然逐文件报告原因。操作按文件粒度记录 `restored`，所以
冲突后重试只处理剩余文件；全部完成才标记 `undone`，否则 `partial`。

删除只删文件，不清空目录；不碰 ignored/敏感文件；路径仍走 workspace 路径守卫。

## 5 决定四：外部 MCP 操作不在承诺范围内

MCP 工具可能写远端 Issue、数据库或第三方文件。它们没有通用逆操作。宿主不提供
“撤销本轮外部调用”，也不把本地文件撤销描述成能回滚远端副作用。审批记录可以告诉你
做了什么，但补偿必须由具体服务/人来决定。

## 6 决定五：API 与界面

- `GET /api/conversations/:id/changes`：变更集列表；`?turnId=` 查单轮。
- `GET /api/conversations/:id/changes/:changesetId`：逐文件明细。
- `POST /api/conversations/:id/changes/:changesetId/undo` `{force?}`：执行撤销。
- 回合结束事件带 `workspaceChanges`（仅计数与 id）；聊天消息工具栏出现“撤销本轮”。
  两次点击确认，冲突逐条显示，并提供显式的“强制撤销其余文件”。

## 7 后果

**收益**：用户第一次可以把“这一轮”作为一个可撤销单位；后续手动修改被保护；命令
造成的改动也有恢复路径；操作可审计、可重试、幂等。

**代价与边界**：

- 命令路径依赖 checkpoint；checkpoint 被清理后只能报告“无法恢复”，不能编造内容；
- 超过 5000 文件的变更集不提供撤销（宁可不提供，也不提供半份）；
- 二进制文件不进入 write journal；命令产生的二进制只能靠 checkpoint；
- 撤销的是工作区文件，不是模型历史、不是外部服务、不是 Git 提交。它不创建 commit，
  也不替代版本控制。
