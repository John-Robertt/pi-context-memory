# 模块设计文档

## 1. 目录角色

本目录保存 [`ARCHITECTURE.md`](../../ARCHITECTURE.md) 所定义模块的当前内部设计。模块文档把既定架构责任转化为可实现、可验证的战术设计，但不改变模块定位、所有权或依赖方向。文档类别与生命周期服从 [`DOCUMENTION.md`](../../DOCUMENTION.md)。

## 2. 模块与文档位置

| 模块 | 架构锚点 | 稳定文档位置 | 当前状态 |
| --- | --- | --- | --- |
| Pi 集成 | [`ARCHITECTURE.md` §6.1](../../ARCHITECTURE.md#61-pi-集成模块) | [`pi-integration.md`](pi-integration.md) | 归档、显式召回、记忆模型命令与 Pi 原生状态已验证 |
| Session 记忆协调 | [`ARCHITECTURE.md` §6.2](../../ARCHITECTURE.md#62-session-记忆协调模块) | [`session-memory-coordination.md`](session-memory-coordination.md) | 当前 session/branch 与来源确认已验证 |
| 长时记忆 | [`ARCHITECTURE.md` §6.3](../../ARCHITECTURE.md#63-长时记忆模块) | [`long-term-memory.md`](long-term-memory.md) | 本地来源、完整结果、用户 JSONC 与 VLM 配置编译已验证 |
| 工作上下文优化 | [`ARCHITECTURE.md` §6.4](../../ARCHITECTURE.md#64-工作上下文优化模块) | `working-context-optimization.md` | 未进入当前实现 |
| 召回与来源追溯 | [`ARCHITECTURE.md` §6.5](../../ARCHITECTURE.md#65-召回与来源追溯模块) | [`recall-and-provenance.md`](recall-and-provenance.md) | OpenViking候选排序与权威展开已验证 |
| 质量与成本观测 | [`ARCHITECTURE.md` §6.6](../../ARCHITECTURE.md#66-质量与成本观测模块) | [`quality-and-cost-observation.md`](quality-and-cost-observation.md) | 开发验证边界已建立，不进入扩展运行 |

稳定位置用于未来开发找到权威归属。扩展内模块不必对应独立包、进程或服务；质量与成本观测是独立开发验证责任。

## 3. 创建与维护

模块进入当前交付范围时，主文档应明确当前目标、拥有的数据和不变量、对外能力、正常与降级流程以及验证边界。运行证据形成后直接校准为当前事实，不保留候选方案或实现历史。

默认一个架构模块维护一份主文档。跨模块流程进入 `docs/system/`，独立共享契约进入 `docs/contracts/`，验证进入 `docs/validation/`，已可用运行行为进入 `docs/operations/`。
