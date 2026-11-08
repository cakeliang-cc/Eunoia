# 项目文档

项目技术方案、实施计划、验收报告和项目介绍放在正式文档目录中。`myfree/` 专用于个人学习笔记，不放项目实施或交付材料。

## 文档位置

| 目录 | 内容 |
| --- | --- |
| [plans](./plans/) | 待执行的实施清单、阶段计划与验收要求 |
| [design](./design/) | 项目接口设计、技术方案与预算规则；保留既有设计图片 |
| [research](./research/) | 为项目决策进行的选型研究、实验脚本和结果 |
| [features](./features/) | 项目能力、亮点与对外介绍，区分已实现和规划能力 |
| [adr](./adr/) | 已记录的架构决定 |
| [sandbox](./sandbox/) | 沙箱架构、安全、运维与接口文档 |
| [mcp](./mcp/) | MCP 外部服务配置、认证、故障与验收 |
| myfree | 个人学习资料，不作为正式计划和验收的存放位置 |

根目录已有的历史计划和报告保留原址，新增材料按上表归档。

## 当前执行入口

- [MCP 完整接入清单与验收](./plans/eunoia-MCP接入实施清单.md)（已实施，状态见
  [验收报告](./mcp/acceptance.md)）
- [模型轨迹与前缀缓存实施清单](./plans/eunoia-模型轨迹与前缀缓存实施清单.md)
- [多模态实施计划与验收要求](./plans/eunoia-多模态实施计划与验收.md)
- [多模态一期实际验收报告](./multimodal-acceptance.md)

## 设计和介绍

- [多模态接口设计](./design/eunoia-多模态接口设计.md)
- [图片 Token 与请求预算](./design/eunoia-图片Token与请求预算.md)
- [前缀缓存与模型轨迹亮点介绍](./features/eunoia-前缀缓存与模型轨迹亮点介绍.md)
- [模型轨迹与前缀缓存验收报告](./features/eunoia-模型轨迹与前缀缓存验收报告.md)
- [长任务检查点验收报告](./features/eunoia-长任务检查点验收报告.md)
- [简历项目经历](./features/eunoia-简历项目经历.md)

## 项目研究

- [MCP 使用、配置与故障恢复](./mcp/README.md)
- [MCP 验收报告](./mcp/acceptance.md)
- [MCP 与内置工具用途及 DSH/Codex 对照](./research/mcp/eunoia-MCP与内置工具对照.md)
- [前缀缓存方案对照评估](./research/prefix-cache/eunoia-前缀缓存方案对照评估.md)
- [前缀缓存与主流 Harness 实现对照](./research/prefix-cache/eunoia-前缀缓存与主流Harness实现对照.md)
- [模型轨迹真实与离线实验数据](./research/prefix-cache/experiments/)
