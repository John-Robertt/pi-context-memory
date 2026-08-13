# 来源归档验证

## 1. 文档角色

本文定义来源归档的 session 隔离、当前 branch 约束、来源恢复、完整结果保存、存储错误和复制期限的证明方法。精确结果由 [`../../validation/evidence/source-archive.json`](../../validation/evidence/source-archive.json) 保存。

## 2. 预期变化与证伪条件

启用扩展后应新增本地来源归档。日常 runner 使用隔离配置并验证 Provider 请求数为零；以下任一结果证伪当前本地交付：

- 不同 session 的相同或冲突内容可通过另一 session 查询取得；
- branch 切换后，离开路线的 entry 仍被当前查询采用；
- 归档记录不能关联并展开到 Pi 当前路线中的原始 entry；
- 截断工具结果的完整输出没有稳定副本或完整性不一致；
- 归档目录不可写时，协调层没有显式失败或破坏已发布来源；
- 无法确认 session file、entry ID 或连续父链的数据仍被接受。

## 3. 场景与判定

### Session 隔离与来源恢复

使用 Pi `SessionManager` 创建两个持久化 session，在两者中写入冲突事实。归档到同一根目录后，分别通过协调实例查询当前路线。

通过条件：查询只返回目标 session 的条目；每条来源引用的 session ID、session file 和 entry ID 与对应 Pi 条目一致；展开结果与 `SessionManager.getEntry()` 一致。

### Branch 切换

在同一 session 形成共同前缀和路线 A，归档后将 Pi leaf 移回共同点并形成路线 B，再次归档和查询。

通过条件：历史存储可保留路线 A 副本，但当前查询只返回共同前缀和路线 B；尝试展开路线 A 的 entry 被拒绝。

### 完整工具结果

以 `SessionManager` 权威 toolResult 和受控 `fullOutputPath` 验证大结果归档，并以协调层故障场景验证损坏 blob、元数据发布失败和无界输入复制超时。

通过条件：真实 `toolResult 权威 entry → fullOutputPath → blob` 链路成立，并能由新的协调实例在重启语义下补齐；完整输出按内容寻址保存并由元数据原子发布；读取字节和 SHA-256 一致；损坏、发布失败和超时不会返回错误内容。

### 存储失败与未持久化 session

以不可写或无效存储输入验证错误传播，并确认没有权威 session file 的 session 不产生归档。

通过条件：存储错误显式返回且不污染已发布内容；未落盘 session 不创建来源；后续新的协调实例仍能从完整副本恢复当前路线。
## 4. 执行与证据

```bash
node scripts/validate-source-archive.mjs
```

runner 执行本地存储与协调场景。未持久化 session 探针使用隔离的 Pi 配置目录和只指向回环拒绝端点的本地验证模型，并以 `noProviderRequests` 检查请求数为零。所有临时文件位于仓库 `.artifacts/source-archive/`；完整通过后原子替换与当前实现绑定的稳定 evidence。

## 5. 当前限制

本验证覆盖来源归档的本地数据与协调边界。Provider 生命周期、摘要质量、语义召回、跨机器恢复和完整成本由各自的纵向交付验证；完整成本实验遵循 [`README.md`](README.md) 的同任务成对设计。
