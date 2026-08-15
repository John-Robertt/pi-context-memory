# 模块设计文档

## 1. 目录角色

本目录保存 [`ARCHITECTURE.md`](../../ARCHITECTURE.md) 所定义模块的当前内部设计。模块文档把架构责任转化为可实现、可验证的战术设计；实现与证据状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。

## 2. 模块与文档位置

| 模块 | 架构锚点 | 稳定文档位置 | 当前设计责任 |
| --- | --- | --- | --- |
| Pi 集成 | [`ARCHITECTURE.md` §6.1](../../ARCHITECTURE.md#61-pi-集成模块) | [`pi-integration.md`](pi-integration.md) | Pi 生命周期、请求闸门、压缩所有权、命令和状态 |
| Session 记忆协调 | [`ARCHITECTURE.md` §6.2](../../ARCHITECTURE.md#62-session-记忆协调模块) | [`session-memory-coordination.md`](session-memory-coordination.md) | 运行状态、精确路线、来源屏障和请求授权 |
| 长时记忆 | [`ARCHITECTURE.md` §6.3](../../ARCHITECTURE.md#63-长时记忆模块) | [`long-term-memory.md`](long-term-memory.md) | 来源、完整结果、OpenViking Session、配置和模型能力证明 |
| 工作上下文优化 | [`ARCHITECTURE.md` §6.4](../../ARCHITECTURE.md#64-工作上下文优化模块) | [`working-context-optimization.md`](working-context-optimization.md) | 跨轮历史、ToolBatch、预算、投影和增强证明 |
| 召回与来源追溯 | [`ARCHITECTURE.md` §6.5](../../ARCHITECTURE.md#65-召回与来源追溯模块) | [`recall-and-provenance.md`](recall-and-provenance.md) | OpenViking 候选、当前路线过滤、权威展开和故障集成 |
| 质量与成本观测 | [`ARCHITECTURE.md` §6.6](../../ARCHITECTURE.md#66-质量与成本观测模块) | [`quality-and-cost-observation.md`](quality-and-cost-observation.md) | 复杂长任务可靠性、质量、增强独占和完整成本 |

扩展内模块不必对应独立包、进程或服务。稳定边界用于保持责任和依赖方向清晰，不为尚无独立消费者的实现细节新增模块。

## 3. 维护规则

模块文档直接描述当前目标设计、数据、不变量、接口、错误和验证边界。跨模块流程进入 `docs/system/`，独立共享契约进入 `docs/contracts/`，验证进入 `docs/validation/`，已实现运行行为进入 `docs/operations/`。

实现成立后用运行结果校准设计；责任消失或被其它结构完整承担时，删除对应设计和引用。
