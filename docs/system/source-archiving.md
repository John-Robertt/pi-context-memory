# 来源归档系统设计

## 1. 文档角色

本文定义 Pi 集成、Session 记忆协调与长时记忆怎样协作保存 Pi 权威 entry 的本地来源副本。来源进入外部索引和模型召回后的流程由 [`source-recall.md`](source-recall.md) 负责。

## 2. 目标与边界

来源归档把退出模型上下文的信息按 Pi session 和当前活动 branch 的权威路线保存，并能由稳定引用回到 Pi session 条目。归档不得修改模型消息、工具结果、Provider 请求或 Agent 控制流。

本流程只保存来源副本及 Pi 为截断工具结果提供的完整输出，不生成摘要、Working Memory 或向量。归档成功是派生索引的前置条件，但 OpenViking失败不能反向使来源归档失败。

## 3. 数据与控制流

```text
Pi SessionManager 当前活动路线
  → Pi 集成转换为 session、session file、leaf 与原始条目快照
  → Session 记忆协调验证身份和连续父链
  → 长时记忆按 session 保存不可混用的来源副本

当前路线包含带 fullOutputPath 的权威 toolResult entry
  → Session 记忆协调发现完整结果
  → 长时记忆复制完整结果并绑定该 entry
```

`tool_result` 发生时活动 leaf 尚未包含最终 toolResult entry；因此只从 `turn_end` 后的路线快照发现完整结果。失败或重启后可由同一权威 entry 幂等补齐。

## 4. 生效与查询规则

- session ID 是最高隔离键，不同 session 使用独立目录；
- 归档输入只包含 `SessionManager.getBranch()` 当前路线；
- 旧路线副本可以保留，但每次列出或展开必须重新以当前 branch 过滤；
- 来源保存 session ID、session file、entry ID 和原始条目；当前 `SessionManager` 同 ID entry 仍是权威；
- 没有持久化 session file 的临时 session 不归档。

## 5. 失败与降级

归档错误由 Pi 集成记录，不向 Pi 事件处理器抛出。普通生命周期只排队，不等待文件 I/O；完整结果复制受运行配置的有界期限约束，session 退出最多等待归档队列 5 秒。后续生命周期或显式召回会重试当前路线。具体配置见 [`../operations/source-archive.md`](../operations/source-archive.md)。

归档只使用扩展实例内串行队列，不引入独立后台服务、持久化任务队列或 exactly-once 协议。来源归档队列优先于且独立于外部索引队列。

## 6. 验证与证伪

[`../validation/source-archive.md`](../validation/source-archive.md) 覆盖 session 冲突、branch 切换、来源恢复、完整结果、存储错误和复制期限。当前路线可归档、entry ID 可稳定关联工具结果且错误保持显式，是本设计成立的必要条件。
