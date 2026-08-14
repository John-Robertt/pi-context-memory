# 项目文档入口

## 1. 目录角色

`docs/` 保存产品与架构战略之下的当前功能、设计、契约、验证、运行和开发状态文档。文档体系的类别、权威关系和生命周期由 [`DOCUMENTION.md`](../DOCUMENTION.md) 定义；本文只维护当前地图。

上层权威来源：

- [`PRODUCT.md`](../PRODUCT.md)：产品目标、范围、优先级和价值评价；
- [`ARCHITECTURE.md`](../ARCHITECTURE.md)：系统战略、模块职责和协作关系；
- [`DOCUMENTION.md`](../DOCUMENTION.md)：文档架构与治理；
- [`DEVELOPMENT.md`](DEVELOPMENT.md)：当前状态、证据、主导约束和下一入口。

## 2. 稳定归属空间

```text
docs/
├── README.md
├── DEVELOPMENT.md
├── features/      # 用户或任务模型可观察的功能规格
├── system/        # 跨模块系统设计
├── modules/       # 单个架构模块的内部设计
├── contracts/     # 需要独立演进和验证的共享契约
├── validation/    # 验证规格与当前有效证据索引
└── operations/    # 已可用行为的配置、运行与故障处理
```

目录树表示稳定归属，不表示尚无当前责任的文档应提前创建。

## 3. 当前文档

| 文档                                                                                 | 当前责任                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| [`DEVELOPMENT.md`](DEVELOPMENT.md)                                                   | 当前可运行状态、证据、主导约束和唯一下一入口     |
| [`features/README.md`](features/README.md)                                           | 功能规格索引                                     |
| [`features/session-recall.md`](features/session-recall.md)                           | 当前 session/branch 内的显式来源召回行为         |
| [`features/context-enhancement-state.md`](features/context-enhancement-state.md)     | 自动上下文增强与 Pi 回退、原生压缩和状态标识     |
| [`features/memory-model-configuration.md`](features/memory-model-configuration.md)   | 用户级记忆模型 JSONC 与 OpenViking 快速重启       |
| [`system/README.md`](system/README.md)                                               | 跨模块系统设计索引                               |
| [`system/source-archiving.md`](system/source-archiving.md)                           | Pi 权威路线进入本地来源归档的流程                |
| [`system/source-recall.md`](system/source-recall.md)                                 | 本地来源进入 OpenViking派生索引并受控召回的流程  |
| [`system/memory-model-runtime.md`](system/memory-model-runtime.md)                   | 用户 JSONC、配置编译与托管 OpenViking 重启流程   |
| [`system/context-enhancement.md`](system/context-enhancement.md)                    | 当前路线进入 Working Memory 与有界模型上下文的流程 |
| [`modules/README.md`](modules/README.md)                                             | 架构模块与内部设计映射                           |
| [`modules/pi-integration.md`](modules/pi-integration.md)                             | Pi 生命周期、归档、索引与工具集成边界            |
| [`modules/session-memory-coordination.md`](modules/session-memory-coordination.md)   | session、当前 branch 与来源有效性协调            |
| [`modules/long-term-memory.md`](modules/long-term-memory.md)                         | 来源副本、完整结果、记忆模型配置与 Session Working Memory |
| [`modules/working-context-optimization.md`](modules/working-context-optimization.md) | 有界增强历史构造与当前 Pi turn 保留              |
| [`modules/recall-and-provenance.md`](modules/recall-and-provenance.md)               | OpenViking候选排序、当前路线过滤与来源展开       |
| [`modules/quality-and-cost-observation.md`](modules/quality-and-cost-observation.md) | 独立于扩展运行的开发期任务质量与 API 成本验证    |
| [`validation/README.md`](validation/README.md)                                       | 验证规格与证据入口索引                           |
| [`validation/source-archive.md`](validation/source-archive.md)                       | 来源归档隔离、恢复、完整结果与存储边界验证       |
| [`validation/source-recall.md`](validation/source-recall.md)                         | OpenViking索引、显式召回、权威展开与错误语义验证 |
| [`validation/context-enhancement-state.md`](validation/context-enhancement-state.md) | 有界采用、路线隔离、当前 turn 与 Pi 降级验证     |
| [`validation/memory-model-runtime.md`](validation/memory-model-runtime.md)           | 记忆模型配置、OpenViking重启与降级验证           |
| [`operations/README.md`](operations/README.md)                                       | 当前可用行为的运行与维护索引                     |
| [`operations/source-archive.md`](operations/source-archive.md)                       | 本地来源归档配置、诊断与清理                     |
| [`operations/session-recall.md`](operations/session-recall.md)                       | OpenViking、记忆模型、来源召回与自动有界上下文运行 |

当前没有需要独立演进的共享契约文档。

## 4. 按问题导航

| 当前问题                         | 入口                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| 产品为什么存在、什么结果有价值   | [`PRODUCT.md`](../PRODUCT.md)                                  |
| 系统责任与依赖方向               | [`ARCHITECTURE.md`](../ARCHITECTURE.md)                        |
| 文档应建在哪里                   | [`DOCUMENTION.md`](../DOCUMENTION.md)                          |
| 项目现在做到哪里、下一步是什么   | [`DEVELOPMENT.md`](DEVELOPMENT.md)                             |
| 任务模型怎样召回早期来源         | [`features/session-recall.md`](features/session-recall.md)     |
| 上下文增强怎样兼容 Pi 回退并展示状态 | [`features/context-enhancement-state.md`](features/context-enhancement-state.md) |
| 怎样配置记忆模型并重启 OpenViking | [`features/memory-model-configuration.md`](features/memory-model-configuration.md) |
| 来源归档怎样运行                 | [`operations/source-archive.md`](operations/source-archive.md) |
| 安装项目依赖、启动并使用来源召回 | [`operations/session-recall.md`](operations/session-recall.md) |

## 5. 维护要求

- 新文档先确定权威类别、当前消费者和验证路径；
- 已有文档能够承担责任时原地更新，不建立竞争版本；
- 移动、拆分、合并或删除时同步更新本页和子目录索引；
- 本页只提供到唯一权威来源的最短路径，不复制具体设计。
