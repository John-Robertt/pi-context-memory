# 系统设计文档

## 目录角色

本目录保存多个架构模块协同实现当前目标能力所需的战术设计，类别和生命周期服从 [`DOCUMENTION.md`](../../DOCUMENTION.md)。实现与证据状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。

## 当前设计

| 文档 | 当前责任 |
| --- | --- |
| [`source-archiving.md`](source-archiving.md) | 定义 Pi 权威来源进入本地归档并形成工作上下文恢复屏障的流程 |
| [`source-recall.md`](source-recall.md) | 定义当前路线来源进入 OpenViking 索引、召回、权威展开和统一故障状态的流程 |
| [`memory-model-runtime.md`](memory-model-runtime.md) | 定义用户配置、项目启动器所有权、实际模型能力证明和运行代际 |
| [`context-enhancement.md`](context-enhancement.md) | 定义增强记忆请求闸门、ToolBatch、自动压缩接管、路线协调和故障恢复 |

系统设计只分配 [`ARCHITECTURE.md`](../../ARCHITECTURE.md) 已定义的责任，不在局部文档改变模块所有权。
