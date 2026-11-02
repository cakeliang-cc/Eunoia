# Permission Modes 与权限生命周期

> 需求与目标状态见 [ADR 020](../adr/020.md)。本文描述**已经实现的代码**、
> 它实际提供的保证、以及和 ADR 字面要求不一致的地方。实现集中在
> `src/sandbox/permissions/`，入口是 `PermissionManager.evaluate()`。

## 1. 一句话模型

```text
工具调用
   |
   v
Sandbox Gateway
   |
   v
PermissionManager.evaluate()
   |
   +-- deny  ----------------> 不创建 Execution，工具报 forbidden
   +-- approval_required ----> 不创建 Execution，工具报 approval_required
   +-- allow ----------------> Sandbox Controller -> Runtime
```

权限层只回答“这次能不能做”。它不执行命令、不创建容器、不改 OCI 配置。
真正的隔离仍由 Runtime 的 mount / namespace / capability 基线承担。

## 2. 四种模式

| 模式 | 默认行为 | 扩展方式 |
|---|---|---|
| `read-only` | 只读工作区；`/workspace` 以只读 bind mount 编译 | 拒绝写入；拒绝一切权限扩展 |
| `auto` | 授权范围内的读、写、命令直接执行 | 需要审批的操作先过 auto-review；风险超限才找人 |
| `on-request` | 授权范围内的操作直接执行 | 超出范围时创建 Request，等人工审批 |
| `restricted` | 只允许显式白名单（工具、读/写路径、网络） | auto-review 永远不能扩大；只有 Human Approval 或改 Policy 可以 |

部署默认模式由写入/命令开关推导：

```text
WORKSPACE_WRITES + WORKSPACE_COMMANDS 都开 → auto
只开一个                                  → on-request
都关                                      → read-only
```

也可以用 `SANDBOX_PERMISSION_MODE` 显式指定。

### 2.1 read-only 的强制点

`read-only` 不是靠解析命令名实现的。`narrowPolicyForMode()` 把
`filesystem.write` 清空，`compileRuntimeConfig()` 看见没有可写前缀就给
`/workspace` 加 `readonly`。因此：

- `write_file` / `edit_file` 在 Permission Manager 被 DENY；
- `run_command` 可以在只读挂载里运行，但写 `/workspace` 会被内核拒绝；
- `/tmp` 仍是 tmpfs，命令可以写临时文件；
- 网络仍受 `SANDBOX_NETWORK_MODE` 限制。

### 2.2 restricted 的强制点

`restricted` 把结构策略收窄到 `SANDBOX_RESTRICTED_*` 白名单：

- 读/写路径取**交集**（`/workspace` ∩ `/workspace/tests` = `/workspace/tests`）；
- `run_command` 不在 `SANDBOX_RESTRICTED_TOOLS` 时，`process.allowShell=false`；
- 网络模式、域名、端口取交集；
- 工具名不在白名单时直接进入人工审批（auto-review 被禁止）。

注意：restricted 的**子路径**限制由 Permission Manager 和宿主侧文件 guard 执行，
不是 bind mount 的能力。mount 只能表达“整个 workspace 可写/只读”。这是记录在
§12 的偏差。

## 3. 判定顺序

```text
1. 解析有效策略（deployment ∩ session ∩ task ∩ sandbox）
2. structural policy: system deny / workspace / network / shell
3. permission rules: deny  > approval_required > allow
4. 有效 Grant（action + resource + task + principal + policy version）
5. 模式分支
6. auto-review 或 human approval
7. fail closed
```

关键性质：

1. `System deny`（`/etc/shadow`、`/proc/sys`、docker/containerd socket、
   metadata、宿主机提权命令）在 grant 之前判定，任何审批都提升不了。
2. Grant 只能提升**可扩展**的拒绝：
   - `process.exec` 在 `WORKSPACE_COMMANDS` 关闭时可被 grant 提升；
   - restricted 的工作区内子路径/工具白名单可被**人工** grant 提升；
   - 工作区外的路径、新网络域名不可被 grant 提升——运行时无法在容器存活期间
     获得新 mount 或改出口代理，批准它等于撒谎。这类请求会被记录并 DENY，
     提示需要修改部署策略。
3. 模式只能收紧结构策略；`read-only` 下不存在 approval 分支。
4. 每次实际执行前重新判定；Gateway 在启动进程前还会再验证一次
   （`PermissionManager.revalidate()`）。

## 4. 作用域、优先级与 Policy Version

```text
System deny
  > organization policy (部署配置)
  > project policy
  > session policy (permission_policies, scope=session)
  > task policy    (permission_policies, scope=task)
  > sandbox policy (permission_policies, scope=sandbox)
  > execution grant
```

- 子作用域可以自由收紧。`autoReview` / `approval` / `restricted` 三层按交集解析：
  子作用域不能加回部署已经删掉的风险等级、工具或路径（见 §13 的“陈旧策略”一行）。
- 子作用域要放宽模式，必须落在 `SANDBOX_PERMISSION_ALLOWED_MODES` 里；否则解析器
  忽略它并回退到父级。切换入口是可信控制面：CLI，或本机页面通过 loopback +
  per-process token 的 HTTP 端点（ADR 022）。Agent 没有 API。
- 过期的作用域策略被整体忽略，回退到父级。
- 每一层都有数值 `version`；有效版本是：

```text
ppv1:<deployment-hash>.s<sessionVersion>.t<taskVersion>.b<sandboxVersion>
```

`deployment-hash` 覆盖模式、auto-review/approval 配置、restricted 白名单和结构
策略。任何一处变化都会改变版本字符串，从而让旧 Grant 在重校验时失效
（ADR 020 §12.3）。

## 5. Request / Approval / Grant 状态机

```text
CREATED → EVALUATING
                |
                +-- allow ----------------→ （不建 Request，直接执行）
                +-- deny -----------------→ DENIED
                +-- approval_required ----→ PENDING
                                              |
                          +-------------------+-------------------+
                          v                   v                   v
                      APPROVED             DENIED             EXPIRED / CANCELLED
                          |
                          v
                     GRANT_CREATED → REVALIDATING → EXECUTING
                          |
                          +-- 重校验失败 → DENIED
```

- 一个 (principal, action, resource, policy version) 只有一个**打开的** Request；
  重复的工具调用复用同一个 Request，不会产生第二个审批。
- 人工决策是 compare-and-set：`PENDING → APPROVED` 只有一个赢家；重复 approve
  返回已有 Grant，不创建第二个。
- 一次性（`once`）Grant 在执行授权点被消费；下一次调用必须重新申请。
- 任务销毁时，未完成的 Request 变 `CANCELLED`，Grant 全部撤销。

## 6. Auto-review

默认实现是确定性的（`DeterministicAutoReviewer`），不调用模型：

| 操作 | 风险 |
|---|---|
| workspace 读 / 列目录 | low |
| workspace 写 | low |
| 命令 | medium；`curl`、`npm install`、`git push`、`chmod` 等 high |
| 网络 | medium；私网/loopback/metadata/IP literal critical |
| 宿主机路径、docker socket、提权命令 | critical + forbidden |

批准条件（全部满足）：

1. 不是 forbidden；
2. 不可信文本里没有指令式内容；
3. 模式不是 `restricted`；
4. 风险在 `SANDBOX_AUTO_APPROVE_RISK` 内；
5. 风险不在 `SANDBOX_REQUIRE_HUMAN_RISK` 内；
6. TTL 不超过 `SANDBOX_AUTO_REVIEW_TTL_MS`。

否则 `escalate` 到人工。Auto-review **只能**在 `auto` 模式运行；`on-request`
按名字就是“问人”。

### 6.1 不可信输入

Agent 的 reason、命令文本、metadata、文件/网页/MCP 内容全部放在
`AutoReviewRequest.untrusted`。默认评估器只做关键字扫描；命中
`ignore previous instructions`、`system:`、`approve this request immediately`
之类的内容时 **escalate**，不会批准。自定义 reviewer 的返回值还会再被
`AutoReviewService` 用同一套限制校验一遍，所以一个被注入的模型不能直接把
critical 请求变成 approved。

## 7. Human Approval

```text
npm run sandbox -- approvals --task <id>
npm run sandbox -- approve-request --approval <id> --by alice \
  [--scope once|task|session] [--minutes 10]
npm run sandbox -- deny-request --approval <id> --by alice
```

- 审批对象是具体的 Request，不是“让 Agent 继续”。
- 审批者不能是 `agent:*` / `model:*` / `system:*`，也不能是发起请求的 principal。
- scope 只能比申请更窄，不能更宽；请求单文件时不能批成整个 workspace。
- Grant 带 action、resource scope、task/session/sandbox、principal、policy version、
  TTL、来源和批准人。
- `once` 由下一个授权动作消费；`task` / `session` 受 TTL 和任务生命周期约束。
- 长期 Grant 不提供；需要时由控制面修改 Policy。
- 审批通过后，工具的下一次调用才会通过；当前回合不会阻塞等待。

## 8. Gateway 集成与模式切换

- 命令、读文件、写文件、列目录、glob、grep 全部先调用 Permission Manager。
- `execute()` 在 `controller.execute()` 之前再次 `revalidate()`：Grant 被撤销、
  TTL 到期、Policy Version 变化都会让 Execution 以 `FAILED` 结束（命令没有提交），
  不会把旧授权用到新策略上。
- 模式切换（CLI 或本机 UI）会：
  1. 写新 Policy Version；
  2. 写 `permission.mode.changed` / `permission.policy.changed` 审计；
  3. 把受影响的活动 sandbox 标记 `INTERRUPTED`；
  4. 把旧版本 Grant 标记 `expired`；
  5. 下一次执行时 Controller 比较 `config_digest`，销毁旧容器并按新策略重建。

`config_digest` 是 `RuntimeSandboxConfig` 的规范化哈希（mount 可写性、资源、网络、
环境、mask）。没有它，一个从 auto 切到 read-only 的任务会继续跑在可写 mount 的
旧容器里——这正是 ADR 020 §12.2 要求避免的。

### 8.1 本机控制面（ADR 022）

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/permissions?conversationId=` | 有效模式、scope 链、auto-review 配置、待审批列表 |
| `POST` | `/api/permissions/mode` | `{conversationId, mode, minutes?, remember?}` |
| `POST` | `/api/permissions/approvals/:id/approve` | `{scope?, ttlSeconds?, reason?}` |
| `POST` | `/api/permissions/approvals/:id/deny` | `{reason?}` |

约束：

- 写端点只接受 `mode`，不接受 `autoReview` / `approval` / `restricted` 覆盖；风险等级
  和人工审批线是部署决策，不能由请求放宽。
- 审批按 `approvalRequestId` 定位，但仍校验该审批属于当前用户的会话：知道 id
  不等于获得批准权。
- 写端点要求 `Content-Type: application/json` 和 `X-Eunoia-Token`；token 由服务端
  每个进程生成一次并注入 `index.html` 的 `<meta name="eunoia-token">`，所以别的源
  读不到它（同源策略），DNS rebinding 也猜不到。
- 只接受 loopback 来源；`HOST=0.0.0.0` 时这些路由直接 403，不跟随部署放宽。
- 批准/拒绝后的工具调用**不会**自动重试，这和 CLI 的语义一致：下一次调用才会通过。

## 9. 持久化（schema v4）

| 表 | 内容 |
|---|---|
| `permission_policies` | 作用域策略，含 mode、version、rules、restricted、expires_at |
| `permission_requests` | 请求、请求键、风险、decision/grant/approval 关联、TTL |
| `permission_approval_requests` | 人工审批队列，`PENDING/APPROVED/DENIED/EXPIRED/CANCELLED` |
| `permission_decisions` | append-only 决策记录（decision id、effect、layer、policy version） |
| `sandbox_approvals` | Grant（新增 source/status/scope/request/used_at 等列） |
| `executions` | 新增 `decision_id`、`permission_mode`、`permission_policy_version` |
| `sandboxes` | 新增 `config_digest` |

`PRAGMA user_version` 从 3 升到 4。迁移逐列检查，支持从 1/2/3 升级，也可从一次
中途失败的迁移继续。

## 10. Recovery 与 Fail Closed

`PermissionRecovery.recoverAll()`（启动时和 `npm run sandbox -- recover` 调用）：

- 过期 Request / Approval 标记 `EXPIRED`；
- `PENDING` 永远不会在恢复时变成 `APPROVED`；
- `APPROVED` 但没有 Grant → Request `DENIED`（fail closed）；
- 有 Grant 但 Request 没来得及更新 → 补 `GRANT_CREATED`，这是唯一允许的“恢复写入”；
- 旧 policy version 的 Grant → `expired`；
- 已过期/已撤销的 Grant 不恢复。

以下情况一律 DENY，审计记录 `layer=fail_closed`：

- Permission Manager 抛错（store 不可用、策略读不出来）；
- Policy Version 在执行前变化；
- Grant 在决策后失效；
- 请求上下文缺字段；
- 无匹配规则。

## 11. 配置

见 `.env.example` 的 permission 段。摘要：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SANDBOX_PERMISSION_MODE` | 由开关推导 | 部署默认模式 |
| `SANDBOX_PERMISSION_ALLOWED_MODES` | 全部四种 | 控制面允许切换的上限 |
| `SANDBOX_AUTO_REVIEW` | auto 模式开 | 总开关 |
| `SANDBOX_AUTO_APPROVE_RISK` | `low,medium` | 可自动批准的风险 |
| `SANDBOX_REQUIRE_HUMAN_RISK` | `high,critical` | 必须找人的风险 |
| `SANDBOX_AUTO_REVIEW_TTL_MS` | 10 分钟 | 自动 Grant 上限 |
| `SANDBOX_APPROVAL_TTL_MS` | 15 分钟 | 人工 Grant 上限 |
| `SANDBOX_PERMISSION_REQUEST_TTL_MS` | 30 分钟 | PENDING 请求寿命 |
| `SANDBOX_OPERATOR_ID` | `operator` | 审计中的默认操作员 |
| `SANDBOX_RESTRICTED_*` | 读 `/workspace`，写空 | restricted 白名单 |

## 12. 与 ADR 020 的偏差（明确列出）

| ADR 020 的要求 | 实现 | 原因 |
|---|---|---|
| Auto-review 可以是模型/服务 | 默认确定性评估器；可注入自定义 reviewer，但结果被二次校验 | 单机产品没有审批模型端点；确定性更容易审计，且防 prompt injection 不依赖模型自觉 |
| 超出范围时“暂停执行”并恢复 | 当前工具调用直接返回 `approval_required`（带 request/approval id）；批准后由下一次调用通过 | 聊天传输是单向 SSE，回合中无法弹窗等待；ADR 018 §4 已记录同一限制 |
| 网络/新域名扩展可以审批 | 记录 Request 后 DENY，要求改部署策略 + 重启代理 | 容器网络和 egress proxy 在启动时固定；运行中加域名无法由应用单方面兑现 |
| 工作区外路径扩展可以审批 | DENY（system/task 层） | bind mount 只有 `/workspace`；批准后仍无法访问 |
| Organization / Project 分层 | `organization`/`project` 是部署配置和 ID；可持久化的只有 session/task/sandbox | 单用户单租户产品，没有组织表 |
| Approval UI | CLI + 本机页面（`/api/permissions/*`，见 §8.1、ADR 022） | 没有 HTTP 认证层（ADR 009），所以端点只开 loopback、只收 JSON、并要求 per-process token；远程审批仍然不做 |
| 运行中权限收紧会终止执行 | 标记 sandbox `INTERRUPTED` 并让下次执行重建；已经在 `controller.execute()` 中的命令不会被强杀 | 与 ADR 018 的 timeout/interrupt 语义一致；强杀需要额外的信号通道 |

## 13. 威胁模型

| 威胁 | 控制 | 测试 |
|---|---|---|
| Agent 伪造 permission mode | `request.permissionMode` 只是提示；模式由 store + 部署配置解析 | `permission-policy.test.ts` |
| Agent 伪造 grant id | Grant 必须匹配 task、principal、action、resource、policy version、TTL；`grantId` 不是授权凭证 | `permission-flow.test.ts` 跨 task/过期 |
| Agent 伪造 approval result | 审批只能由 CLI 的 `--by` 或本机 UI 的 operator 身份写入；`agent:*` 被拒 | `permission-flow.test.ts` |
| 审批重复提交 / 重放 | Approval CAS；重复 approve 返回已有 Grant；`once` 消费 | `permission-flow.test.ts` |
| Grant 跨 task / session / workspace 重用 | Grant 绑定 task/session/sandbox；查询按 task/session 过滤 | `permission-flow.test.ts` |
| Grant 在策略变更后继续有效 | 复合 policy version + revalidate + recovery sweep | `permission-flow.test.ts` |
| Auto-review 覆盖 system deny | system deny 在 grant/auto-review 之前返回 | `policy.test.ts`、`permission-policy.test.ts` |
| Auto-review Prompt Injection | 不可信文本单独成字段，指令式内容 escalate；自定义 reviewer 二次校验 | `permission-policy.test.ts` |
| restricted 被 auto-review 扩大 | reviewer 与 service 双重拒绝 restricted | `permission-policy.test.ts` |
| 权限层不可用时降级执行 | `evaluate()` 捕获异常返回 `deny/fail_closed` | `permission-flow.test.ts` |
| 旧容器绕过新挂载策略 | `config_digest` 不匹配即销毁重建 | `permission-flow.test.ts` |
| 工具绕过 Permission Manager | 唯一执行入口是 Gateway；`sandbox-boundaries.test.ts` 机械检查 | 架构测试 |
| 恢复时把 PENDING 当 APPROVED | 状态机无此边；recovery 只允许 EXPIRED/DENIED | `permission-flow.test.ts` |
| 跨站页面伪造模式切换 / 审批（CSRF） | 写端点要求 JSON content-type + per-process token；token 在服务端注入页面，跨源读不到 | `tests/api/permissions.test.ts` |
| DNS rebinding 打到 loopback | token 不是可猜的值（每进程随机），且写端点只对 loopback socket 开放 | `tests/api/permissions.test.ts` |
| 陈旧 scope 策略在部署收紧后继续生效 | scope 层的 `autoReview` / `approval` / `restricted` 与父层取交集，不能加回被移除的等级、工具或路径 | `permission-policy.test.ts` |
| 本机 UI 放宽自动审核 | 端点不接受 `autoReview` / `approval` 覆盖，只有 `mode` | `tests/api/permissions.test.ts` |

## 14. 测试证据

| 文件 | 覆盖 |
|---|---|
| `tests/sandbox/permission-policy.test.ts` | 模式解析、优先级、过期作用域、规则、restricted 收窄、scope 收紧不变量、auto-review 风险/注入/自定义 reviewer |
| `tests/sandbox/permission-flow.test.ts` | 四种模式、请求→审批→Grant、一次性 Grant、Grant 过期、模式切换重建、跨 task、审批身份、fail closed、recovery |
| `tests/sandbox/permission-manager.test.ts` | 伪造 mode 提示无效、重复评估只开一个请求、Grant 按字段校验、once 消费、撤销立即生效 |
| `tests/sandbox/policy.test.ts` | system deny 不可提升、路径规范化、网络白名单 |
| `tests/sandbox/sqlite.test.ts` | schema v4、1/2/3 → 4 迁移、Grant/决策持久化 |
| `tests/architecture/sandbox-boundaries.test.ts` | 工具不能直接执行、不能绕过 Gateway |

## 15. 验收对照（ADR 020 §16.4）

- [x] 四种 Permission Mode
- [x] 所有 Tool Execution 经过 Permission Manager
- [x] Auto-review 不能覆盖 System Deny
- [x] Human Approval 有身份检查与审计
- [x] Grant 有明确 Scope 和 TTL
- [x] Policy Version 能让旧授权失效
- [x] Recovery 不恢复无效权限
- [x] 关键权限状态持久化
- [x] 运行时权限撤销可生效（下一次授权前重校验）
- [x] 测试全绿
- [x] 不存在普通 Host Execution 作为降级路径
- [x] 安全测试覆盖绕过路径

未满足的部分是“暂停后原地恢复”和“运行中新增网络域名”，原因与替代行为见 §12。
