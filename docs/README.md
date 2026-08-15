# 项目文档入口

## 1. 目录角色

`docs/` 保存产品与架构战略之下的当前功能、系统、模块、契约、验证、运行和开发状态。文档类别、权威关系和生命周期由 [`DOCUMENTION.md`](../DOCUMENTION.md) 定义；本文只维护当前地图。

上层权威来源：

- [`PRODUCT.md`](../PRODUCT.md)：产品目标、范围、优先级和价值评价；
- [`ARCHITECTURE.md`](../ARCHITECTURE.md)：系统战略、模块职责和协作关系；
- [`DOCUMENTION.md`](../DOCUMENTION.md)：文档架构与治理；
- [`DEVELOPMENT.md`](DEVELOPMENT.md)：当前实现、有效证据、主导约束和唯一下一入口。

设计文档描述当前目标设计；运行文档只描述已经实现并可操作的行为。两者之间的实现差距只由 `DEVELOPMENT.md` 维护。

## 2. 稳定归属空间

```text
docs/
├── README.md
├── DEVELOPMENT.md
├── features/      # 用户或任务模型可观察的目标功能规格
├── system/        # 跨模块系统设计
├── modules/       # 单个架构模块内部设计
├── contracts/     # 独立演进的共享契约
├── validation/    # 验证规格与当前 evidence 入口
└── operations/    # 已实现行为的配置、运行和故障处理
```

目录树表示稳定归属，不要求为没有当前责任的内容预建文档。

## 3. 当前文档

| 文档 | 当前责任 |
| --- | --- |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | 当前可运行状态、有效证据、主导约束和唯一下一入口 |
| [`features/README.md`](features/README.md) | 功能规格索引 |
| [`features/session-recall.md`](features/session-recall.md) | 当前 session/branch 来源召回和数据面故障行为 |
| [`features/context-enhancement-state.md`](features/context-enhancement-state.md) | 增强记忆独占上下文与自动压缩、current turn、状态和恢复 |
| [`features/memory-model-configuration.md`](features/memory-model-configuration.md) | 用户记忆模型配置、实际能力状态与受管重启 |
| [`system/README.md`](system/README.md) | 跨模块系统设计索引 |
| [`system/source-archiving.md`](system/source-archiving.md) | Pi 权威来源归档和工作上下文恢复屏障 |
| [`system/source-recall.md`](system/source-recall.md) | OpenViking 来源索引、当前路线召回与统一故障状态 |
| [`system/memory-model-runtime.md`](system/memory-model-runtime.md) | 配置编译、进程所有权、模型能力证明与运行代际 |
| [`system/context-enhancement.md`](system/context-enhancement.md) | 请求闸门、ToolBatch、自动压缩接管、路线和恢复 |
| [`modules/README.md`](modules/README.md) | 架构模块与内部设计映射 |
| [`modules/pi-integration.md`](modules/pi-integration.md) | Pi 生命周期、请求闸门、压缩所有权、命令和状态 |
| [`modules/session-memory-coordination.md`](modules/session-memory-coordination.md) | 运行状态、精确路线、来源屏障和请求授权 |
| [`modules/long-term-memory.md`](modules/long-term-memory.md) | 来源、完整结果、OpenViking Session、配置和能力证明 |
| [`modules/working-context-optimization.md`](modules/working-context-optimization.md) | 跨轮历史、ToolBatch、预算、投影和增强证明 |
| [`modules/recall-and-provenance.md`](modules/recall-and-provenance.md) | 候选排序、当前路线过滤、权威展开和故障集成 |
| [`modules/quality-and-cost-observation.md`](modules/quality-and-cost-observation.md) | 复杂长任务可靠性、质量、增强独占和完整成本 |
| [`contracts/README.md`](contracts/README.md) | 共享契约索引 |
| [`contracts/openviking-adapter.md`](contracts/openviking-adapter.md) | OpenViking 来源、Session、模型能力、配置和故障契约 |
| [`validation/README.md`](validation/README.md) | 验证顺序、执行入口、可靠性和成本方法 |
| [`validation/source-archive.md`](validation/source-archive.md) | 来源隔离、恢复、完整结果和投影屏障验证 |
| [`validation/source-recall.md`](validation/source-recall.md) | 来源索引、召回、权威展开和故障阻断验证 |
| [`validation/context-enhancement-state.md`](validation/context-enhancement-state.md) | 复杂长任务可靠性、current turn、增强独占和恢复验证 |
| [`validation/memory-model-runtime.md`](validation/memory-model-runtime.md) | 配置、运行所有权、实际能力证明和请求阻断验证 |
| [`operations/README.md`](operations/README.md) | 当前已实现运行与维护文档索引 |
| [`operations/source-archive.md`](operations/source-archive.md) | 当前本地来源归档配置、诊断与清理 |
| [`operations/session-recall.md`](operations/session-recall.md) | 当前 OpenViking、记忆模型、召回和上下文运行方法 |

## 4. 按问题导航

| 当前问题 | 入口 |
| --- | --- |
| 产品为什么存在、什么结果有价值 | [`PRODUCT.md`](../PRODUCT.md) |
| 系统责任、增强独占与故障边界 | [`ARCHITECTURE.md`](../ARCHITECTURE.md) |
| 文档应建在哪里 | [`DOCUMENTION.md`](../DOCUMENTION.md) |
| 当前实现到哪里、证据是否有效、下一步是什么 | [`DEVELOPMENT.md`](DEVELOPMENT.md) |
| 用户会观察到哪些增强状态和行为 | [`features/context-enhancement-state.md`](features/context-enhancement-state.md) |
| 大工具输出和自动压缩怎样处理 | [`system/context-enhancement.md`](system/context-enhancement.md) |
| 怎样配置并验证记忆模型 | [`features/memory-model-configuration.md`](features/memory-model-configuration.md) |
| OpenViking 能力怎样形成请求条件 | [`contracts/openviking-adapter.md`](contracts/openviking-adapter.md) |
| 怎样证明复杂长任务可靠完成 | [`validation/context-enhancement-state.md`](validation/context-enhancement-state.md) |
| 当前已实现行为怎样运行 | [`operations/README.md`](operations/README.md) |

## 5. 维护要求

- 新事实先确定唯一权威类别、当前消费者和验证路径；
- 已有文档能够承担责任时原地更新；
- 设计、实现和 evidence 的差距只在 `DEVELOPMENT.md` 维护；
- 运行文档只在行为实现并验证后更新；
- 移动、合并或删除文档时同步更新全部索引和引用；
- 文档直接描述当前目标或当前实现，不保存方案演变过程。
