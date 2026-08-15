# 来源归档系统设计

## 1. 文档角色

本文定义 Pi 集成、Session 记忆协调与长时记忆怎样协作保存 Pi 权威 entry 的本地来源副本，并为工作上下文投影提供来源可恢复屏障。来源进入 OpenViking 索引和召回后的流程由 [`source-recall.md`](source-recall.md) 负责。

## 2. 目标与边界

来源归档按 Pi session 和当前 branch 保存可核验事实副本，使退出任务模型输入的历史和大工具结果能够稳定回到 Pi entry 或完整输出。

归档不生成摘要、Working Memory 或向量。Pi session 历史始终是事实权威；来源副本承担恢复、投影和索引重建责任。

普通生命周期可以异步归档不影响当前请求的内容。工作上下文准备需要用投影替代原始内容时，必须等待对应来源屏障完成。

## 3. 数据与控制流

```text
Pi SessionManager 当前 branch
  → Pi 集成转换为 session、session file、leaf、权威 message SourceRecord 与无 summary 文本的 ControlBoundary
  → Session 记忆协调验证身份、父链和完整内容指纹
  → 长时记忆按 session 幂等保存来源副本
  → 精确读回并核对内容哈希

当前路线包含带 fullOutputPath 的权威 toolResult entry
  → Session 记忆协调发现完整结果
  → 长时记忆流式复制到内容寻址 blob
  → 核对字节与 SHA-256
  → 原子发布 entry 元数据

工作上下文需要投影 ToolBatch
  → Session 记忆协调列出该批次必要来源
  → 等待全部来源和完整结果屏障
  → 成功后允许工作上下文使用来源引用
```

`tool_result` 事件发生时权威 entry 可能尚未进入当前 leaf。Pi 集成以实际 CurrentTurn 消息保持 raw 批次；需要投影时调用 `awaitAuthorityEntry`，等待消息持久化生命周期提供与 tool call ID、内容和顺序一致的 Pi entry，再建立来源屏障。

实际消息尚未持久化不妨碍预算内 raw 发送；它不能满足 projected 批次的来源条件。权威 entry 在操作期限内仍不可观察时，当前请求进入来源故障且 Provider 增量为零。

## 4. 生效与查询规则

- session ID 是最高隔离键，不同 session 使用独立目录；
- 归档输入只包含当前 `SessionManager.getBranch()`；
- 历史路线副本可以保留，每次列出、屏障和展开都以当前 branch 过滤；
- message 来源保存 session ID、session file、entry ID、原始 message entry 和内容哈希；compaction/branch summary 只保存无文本 ControlBoundary，其 summary、retainedTail、details 和 usage 不复制到来源；
- 当前 `SessionManager` 同 ID entry 仍是权威；
- 没有持久化 session file 的输入不形成增强来源；
- 来源屏障只对创建它的 session、branch 和路线身份有效；
- 已发布来源只有通过精确读回和完整性核验后才可使用。

## 5. 并发与期限

同一 session 的写入保持 entry 顺序；同一 entry 和内容的并发提交共享幂等结果；同 ID 不同内容立即拒绝。

普通后台归档可以折叠尚未开始的旧路线。来源屏障优先完成当前请求需要的 entry，不被外部索引队列阻塞。

文件复制和关闭等待具有有界期限。期限用于形成明确来源故障，不允许在来源未确认时继续投影或发送任务模型请求。

实现使用扩展实例内队列和原子文件操作，不引入独立持久化任务系统或 exactly-once 协议。

## 6. 故障与恢复

来源创建、序列化、复制、发布、读回、身份或哈希错误返回稳定错误。普通后台错误进入 Session 记忆协调；当前或后续请求依赖该来源时锁存增强故障。

已经发布且核验通过的其它来源保持有效。用户修复存储条件并重新验证增强运行后，当前 branch 按稳定 entry ID 补齐来源。

来源故障不修改 Pi session，不删除已发布数据，也不以空来源表示成功。

## 7. 验证与证伪

[`../validation/source-archive.md`](../validation/source-archive.md) 必须证明：

- session 和 branch 隔离；
- Pi message entry 与来源副本精确一致；
- compaction/branch summary 只归档 ControlBoundary，污染哨兵不进入来源内容；
- 完整输出复制、原子发布和哈希核验；
- ToolBatch 投影前来源屏障；
- 并发、期限、关闭和重启补齐；
- 来源失败使依赖请求在 Provider 前被阻断；
- 修复后从当前 branch 重建且不污染已发布来源。
