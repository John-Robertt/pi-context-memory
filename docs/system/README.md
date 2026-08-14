# 系统设计文档

## 目录角色

本目录保存多个架构模块协同实现当前能力所需的战术设计，类别和生命周期服从 [`DOCUMENTION.md`](../../DOCUMENTION.md)。

## 当前设计

| 文档 | 当前责任 |
| --- | --- |
| [`source-archiving.md`](source-archiving.md) | 定义 Pi 会话事实经协调边界进入本地来源归档的跨模块流程 |
| [`source-recall.md`](source-recall.md) | 定义经当前 Pi 路线核对的本地来源副本进入 OpenViking 派生索引并受控召回与展开的流程 |
| [`memory-model-runtime.md`](memory-model-runtime.md) | 定义用户 JSONC、配置编译、项目启动器所有权与 OpenViking 重启流程 |

系统设计只分配既有架构责任，不重新划分模块所有权。当前运行结论由对应验证规格和证据证明。
