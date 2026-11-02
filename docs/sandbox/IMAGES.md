# Sandbox 镜像

ADR 017 §3.3 要求维护受信任的 Sandbox Base Image，并使用不可变 digest。本目录
提供参考构建方式；生产镜像应由 operator 自己构建、扫描、签名并推进 digest。

## 参考镜像

`scripts/sandbox-image/Dockerfile` 构建一个通用编码镜像：

- Alpine 基础镜像（**必须按 digest 固定**）；
- Node.js + npm、Python 3 + pip、git、bash、curl、ripgrep；
- uid/gid `1000` 的 `sandbox` 用户，`/workspace` 为唯一工作目录；
- 没有 root 用户启动，没有 package manager 的长期缓存策略。

构建：

```bash
docker pull alpine:3.20
BASE_IMAGE=$(docker image inspect --format '{{index .RepoDigests 0}}' alpine:3.20) \
  ./scripts/sandbox-image/build.sh
```

脚本会输出 `sha256:...` 并做一次非 root smoke test。把它写进
`SANDBOX_IMAGE_DIGEST`。

## 规则

| 规则 | 原因 |
|---|---|
| 只用 `sha256:` digest | tag 会漂移；恢复时不能悄悄换镜像 |
| `--pull=never`（运行时已强制） | 缺镜像时失败，而不是拉一个未验证的新版本 |
| Agent 不能改基础镜像 | 镜像由 operator 构建，Agent 没有 Docker/containerd socket |
| 定期扫描依赖漏洞 | 基础镜像的 CVE 会进入每个 sandbox |
| 记录来源和构建记录 | 出问题时能回答“这个 digest 是谁构建的” |
| 不把 `.env`/SSH key 放进镜像 | 凭据走 Credential Broker，不烤进镜像 |

## 语言运行时

本仓库没有单独的 `Python Tool` / `Node Tool`：`bash` 在镜像内执行任意
命令。因此 Python/Node 是否可用，由镜像决定。参考镜像包含两者；如果只用
`alpine/curl` 做测试镜像，就只能跑 shell/curl。

## 变体建议

```text
sandbox-base:general   # node + python + git（参考 Dockerfile）
sandbox-base:node      # 只装 node/npm，减小攻击面
sandbox-base:python    # 只装 python/pip
sandbox-base:golang    # 只装 go/git
```

每个变体都应该有独立的 digest、独立的扫描记录和独立的 `SANDBOX_IMAGE_DIGEST`。
