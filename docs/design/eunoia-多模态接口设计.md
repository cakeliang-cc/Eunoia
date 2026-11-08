# Eunoia 多模态消息与模型接口设计

> 状态：设计提案，尚未实现。日期：2026 年 11 月 8 日。
> 首期范围：文本与图片输入，文本输出。音频、视频和媒体生成后续分别扩展。

执行入口为 [实施计划与验收](../plans/eunoia-多模态实施计划与验收.md)，图片计数以 [图片 Token 与请求预算](eunoia-图片Token与请求预算.md)为准。本文保留接口探索背景；模型能力三态、首期 detail 策略、资源/API 和错误处理采用执行文档的具体约定。

多模态接入要贯通消息内容、资源存储、历史回放、能力检查和模型协议转换。Eunoia 可以保留现有 Agent 循环的职责，将结构化内容沿消息链路传递，在模型适配层完成媒体解析与协议转换。

## 当前实现的具体边界

| 位置 | 当前实现 | 多模态需要补充的部分 |
| --- | --- | --- |
| `src/api/server.ts` | 原始字节上传到会话工作区，聊天请求携带附件路径 | 受控媒体资源 ID，与消息绑定 |
| `src/session/types.ts` | `Message.content` 是字符串 | 持久化有顺序的内容块 |
| `src/agent/infp-agent.ts` | 当前消息与历史均以文本传递 | 保留用户消息中的图片块 |
| `src/agent/model-port.ts` | `LoopInputItem` 的消息内容是字符串 | 增加供应商无关的多模态内容 |
| `src/agent/model-turn.ts` | 用户内容映射成 `input_text` | 将图片块转换成 SDK 图片输入 |
| `src/models/types.ts` | 能力信息包括工具和流式支持 | 声明输入模态、输出模态及限制 |
| `src/tools/types.ts` | 工具结果为字符串 | 后续支持截图等媒体结果 |

[ADR 026](../adr/026-message-actions-and-uploads.md)明确说明，附件当前不随消息入库，图片也不会送作视觉输入。仅修改上传界面或更换模型，不能打通这些环节。

本机安装的 Agents SDK 在 `agents-core/dist/types/protocol.d.ts` 中已有 `input_image`，其 `image` 接受字符串或文件引用。项目自己的适配层尚未传递这类内容。

## 先确认具体模型与协议的能力

截至上述日期，DeepSeek 当前 [Vision 指南](https://api-docs.deepseek.com/guides/vision/)说明 `deepseek-flash` 接受图片与文本，并支持 Responses 图片内容块。旧的视觉实验模型名已经退役并转由最新 Flash 服务，不能仅依据旧发布公告配置模型。

这意味着可以优先验证现有 Flash 路由。`deepseek-v4-pro` 等其他模型应分别核实；不能因为属于同一供应商就自动标记为支持图像。官方能力声明也不能替代本项目 SDK 与端点的实际连通检查。

以下类型均为本项目的拟议接口，并非供应商 SDK 的现有类型。

## 消息使用有顺序的内容块

```ts
type AssetId = string;

type InputPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly assetId: AssetId;
      readonly detail?: 'auto' | 'low' | 'high';
    };

interface UserMessageContent {
  readonly parts: readonly InputPart[];
}
```

例如，“第一张是设计稿，第二张是实现，请找区别”应保存为交错排列的文字和两张图片。顺序参与含义，不能在持久化或适配时把文字、图片分别收集后重排。

首期用户消息允许文本与图片；系统指令、助手文本和 reasoning 继续保留各自的类型和角色约束。不要把所有角色的 `content` 都不加区分地改成任意媒体数组。

持久化以带版本的结构化内容为事实来源，纯文本字段作为 UI、搜索和旧接口需要的派生投影。迁移旧消息时，将原字符串转换为单个文本块，明确一种转换规则，避免两份内容独立更新。

## 媒体资源独立保存

```ts
interface ImageAsset {
  readonly id: AssetId;
  readonly ownerId: string;
  readonly conversationId: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

interface MediaStore {
  putImage(
    scope: { userId: string; conversationId: string },
    bytes: Uint8Array,
  ): Promise<ImageAsset>;

  readImage(
    scope: { userId: string; conversationId: string },
    assetId: AssetId,
    signal?: AbortSignal,
  ): Promise<{ asset: ImageAsset; bytes: Uint8Array }>;
}
```

消息只保存 `assetId` 等引用，原始字节保存到私有媒体存储。资源 ID 是不透明标识，不接受用户用它直接指定宿主文件路径。`putImage` 负责校验实际格式和图像尺寸；`readImage` 负责归属与可访问范围检查。

原图作为不可变资源保存。工作区中的文件可以继续存在，但应当是副本或导出，不宜让一条历史消息随着工作区同名文件被修改而改变含义。初版可以复用已有上传入口，在上传后生成私有不可变资源，并返回资源 ID。

Base64 仅在需要的模型请求转换阶段生成，不作为聊天文本落库，也不进入普通请求日志。前端预览应走带权限检查的资源读取入口。

上传成功与消息发送成功分开处理：消息保存时绑定媒体引用，未被消息使用的上传资源可按期限清理。删除或过期的图片需要显示明确状态；重新生成时若必须的原图不可用，应报告资源缺失，不能静默改成纯文本请求。

## 模型能力使用显式声明

```ts
type Modality = 'text' | 'image' | 'audio' | 'video';

interface ModelCapabilities {
  readonly inputModalities: readonly Modality[];
  readonly outputModalities: readonly Modality[];
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  readonly imageInput?: {
    readonly mediaTypes: readonly string[];
    readonly maxCount: number;
    readonly maxBytesPerImage: number;
  };
}
```

能力声明放入模型配置，由实际模型和所用协议共同决定。供应商支持某种内容，不代表某个具体模型、适配器和端点组合都已支持。

发送前检查输入模态、图像格式和数量，再检查适配器是否能编码这些内容。模型不能接收图片时，应明确提示选择兼容模型。若后续增加 OCR 或图像描述降级，应把派生文本及来源标记清楚；它不等同于原生视觉理解，也不应被静默替换。

`audio`、`video` 出现在能力词汇中只表示未来可扩展。首期不接受这些输入，也不在模型配置中宣称支持。

## 模型适配层完成协议转换

```text
上传图片 → 私有媒体资源 → 用户消息中的 image 块
                                      ↓
历史回放保留内容块 → 检查模型与适配器能力
                                      ↓
按资源 ID 解析媒体 → 转换为 SDK 输入 → 发起模型请求
```

内部消息不直接保存某个供应商的 `image_url`、Base64 或远程文件 ID。适配层根据实际协议，将 `assetId` 转换成内联数据或该供应商可用的文件引用。

当前 SDK 的 `input_image.image` 与 Responses HTTP 请求中的 `input_image.image_url` 是不同层级的字段。本项目使用 SDK 时应构造 SDK 类型，再由其编码为协议请求，避免把 HTTP 示例直接拷入 SDK 输入。

[OpenAI 图片输入说明](https://developers.openai.com/api/docs/guides/images-vision)与 [DeepSeek Responses 图片说明](https://api-docs.deepseek.com/guides/vision/#using-images-with-the-responses-api)提供了协议层参考。供应商文件 ID 的复用如果后续实现，应按供应商、账户及资源版本记录映射，不能当作通用资源 ID。

## 图片输入与图片输出分开设计

第一版只要求模型读取图片并返回文本，因此无需同时建设图片生成、实时语音和视频流协议。

工具截图是另一个图片来源。后续可让工具结果携带文本与图片资源块，经能力检查转换为模型可消费的工具结果；保留工具调用 ID 和来源角色。若协议不支持工具图片结果，应明确拒绝或采用声明过的转换方式，不把工具图片伪装成用户上传。

音频后续需要采样率、声道、时长和转写来源；视频需要时间轴或带时间戳的帧。可以沿用资源 ID 与内容块的分层方式，再定义各自的块结构。原生音频理解、语音转文字、语音合成和实时对话也需要分别声明能力。

## 历史与预算接口的衔接

重新打开会话或重新生成时，应从消息中恢复相同的媒体引用。下一轮提到“刚才那张图”时，由上下文选择策略决定重送哪张原图，而不是重新信任浏览器传来的历史内容。

图片有模型相关的处理成本，预算不能按 Base64 字符数计算。接口需要向统一预算模块提供图片数量、尺寸、detail 和模型相关估算；预算不足时，显式选择降低细节、减少历史图片或停止请求。降低细节如需改变图片，应生成新的派生资源并保留与原图的关系。

摘要可以保存图片相关结论和来源资源 ID，但文字描述不能保证替代全部视觉细节。即使历史已压缩，也应保留重新获取原图的路径。此处定义多模态模块应提供的信息，具体循环与预算实现由相应模块承接。

## 建议的首期接入顺序

1. 定义文本与图片内容块，以及模型输入能力声明。
2. 在现有上传入口增加私有资源记录，持久化消息与图片引用。
3. 让当前消息、历史回放和模型端口保留这些内容块。
4. 在现有 SDK 适配层接通图片输入，优先核实 Flash 路由。
5. 前端显示图片预览和不兼容模型提示，并更新原有“图片不会作为视觉输入”的提示逻辑。

实现后的功能验收可以保持很小：一条带图提问真正到达模型；刷新或重新生成仍使用原图；不支持图像的路由明确报错；不可读取其他用户资源；旧文本消息正常回放。这些是接口接通检查，不涉及建设大型沙箱或 Bench 评测系统。

## 与已有工作的连接

会话执行与恢复模块需要保存版本化内容块及媒体引用；预算模块需要接收媒体成本信息；模型结束状态继续沿现有事件契约处理。这里的设计稿给出这些数据边界，不规定它们的并发、恢复或预算算法。

媒体读取与格式检查是确定性代码能力，可以先通过普通端口与适配器实现。无需为了首期图片输入先建设完整插件加载系统。
