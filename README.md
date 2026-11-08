# Eunoia

![Eunoia](docs/cover.png)

你好，我是 Eunoia。

期待与你相遇。

## 快速开始

```bash
npm install
cp .env.example .env       # 填 DEEPSEEK_API_KEY
npm run dev                # http://127.0.0.1:8787
```

需要 Node **>= 22.9**（类型擦除运行源码、`--env-file-if-exists` 和 `node:sqlite`）。
数据库是一个文件，默认 `data/eunoia.sqlite`，不需要 Docker 或 Postgres。Node 版本也写在
`.nvmrc` 里，`nvm use` 即可。

## 多模态（图片输入）

- 输入框可以选择、粘贴、拖入 JPEG / PNG / WebP，最多 5 张、单张 10 MB、合计
  20 MB；只发图片不写字也可以。SVG、GIF/动态 WebP、多页图、PDF、音视频不是视觉
  输入，会明确返回 415。
- 默认模型 `deepseek-v4-pro` 是纯文本路由；要发图片，请用输入框右侧的模型选择器
  切到 **DeepSeek Flash（可看图）**。图片是私有不可变资源，历史、重新生成和重启后
  都引用同一张原图；重新生成失败会保留旧回复。
- 图片 Token 与 HTTP body 预算分开计算，按实际发送的请求变体计；详见
  [ADR 031](docs/adr/031-multimodal.md) 与
  [验收矩阵](docs/multimodal-acceptance.md)。
- 备份：`npm run backup` 会同时复制数据库、媒体文件和 SHA-256 清单；
  `npm run backup:verify -- <backup-directory>` 校验恢复前的文件。过期草稿用
  `npm run cleanup:media` 清理。

## 文档

- [为什么做 Eunoia](docs/story.md)
- [ADR](docs/adr/)
- [当前环境](CURRENT_STACK.md)
- [变更记录](CHANGELOG.md)
