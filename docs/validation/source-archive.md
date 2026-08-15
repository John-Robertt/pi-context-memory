# 来源归档与恢复屏障验证

## 1. 验证责任

本文定义来源归档的 session 隔离、当前 branch 约束、来源恢复、完整结果保存、ToolBatch 投影屏障、存储错误和期限行为。稳定结果保存于 [`../../validation/evidence/source-archive.json`](../../validation/evidence/source-archive.json)。

## 2. 核心不变量

验证必须证明：

- 不同 session 的来源不可互查或混用；
- branch 切换后，离开路线的 entry 不进入当前列表、屏障或展开；
- message 来源副本与 Pi 当前路线中的权威 message entry 精确一致；
- compaction/branch summary 只形成无文本 ControlBoundary，summary 与 retainedTail 污染哨兵不进入来源；
- 截断工具结果的完整输出具有稳定副本和完整性证明；
- ToolBatch 只有在全部必要来源可恢复后才能投影；
- 不可写目录、复制失败、损坏 blob、哈希错误和期限结束形成明确失败；
- 来源失败不污染已经发布的有效数据；
- 无法确认 session file、entry ID、父链或内容指纹的数据被拒绝；
- 依赖失败来源的任务模型请求不进入 Provider。

## 3. 场景与判定

### 3.1 Session 隔离与来源恢复

使用 Pi `SessionManager` 创建两个持久化 session，并写入冲突事实。分别归档和查询当前路线。

通过条件：查询只返回目标 session 的 message 来源；每条来源的 session ID、session file、entry ID、内容和哈希与对应 Pi message entry 一致；权威展开与 `SessionManager.getEntry()` 中的 message 一致。

### 3.2 Branch 切换

在同一 session 形成共同前缀和路线 A，归档后回到共同点并形成路线 B，再次归档、建立屏障和查询。

通过条件：存储可以保留路线 A 副本，但当前列表、屏障和展开只接受共同前缀与路线 B；路线 A 的 entry 不能满足路线 B 请求。

### 3.3 Summary 控制边界

在当前路线放入已有 compaction 和 branch summary entry，并把唯一污染哨兵分别写入 summary、retainedTail、details 和 usage 可序列化字段。

通过条件：归档仅保存 type、ID、parent 和 `firstKeptEntryId | fromId`；所有污染哨兵均未出现在来源文件、列表、展开或 OpenViking 索引输入中；compaction 前的当前 parent 链 message 仍可按自身 entry 恢复，`fromId` 废弃 branch 不进入当前来源。

### 3.4 完整工具结果

以权威 toolResult 和受控 `fullOutputPath` 验证大结果归档，并注入损坏 blob、元数据发布失败、输入持续增长和复制期限结束。

通过条件：`Pi toolResult entry → fullOutputPath → content-addressed blob → metadata` 链路成立；元数据只在 blob 完整写入后发布；读取字节数与 SHA-256 一致；新的协调实例能够按当前 branch 补齐。

### 3.5 ToolBatch 来源屏障

构造包含多个 sibling 工具结果的批次，其中混合普通输出、截断输出、错误和否定结果；分别在权威 entry 持久化前后请求 raw 与 projected 工作上下文。

通过条件：预算内 raw 批次可以依据实际 CurrentTurn 发送；投影必须等待全部消息核对到 Pi entry 且来源 ready 后一次性允许；任一 authority/source pending 时继续等待，失败或期限结束时 Provider 接收数不增加；不会产生部分批次投影。

### 3.6 存储与身份失败

使用不可写目录、错误 session、损坏父链、同 ID 不同内容和未持久化 session 验证拒绝语义。

通过条件：失败明确返回且不改变已发布内容；未持久化 session 不创建增强来源；依赖这些输入的请求被阻断。

### 3.7 修复与重建

修复存储条件后，以当前 Pi branch 创建新运行代际并重新提交来源。

通过条件：稳定 entry ID 幂等补齐缺失数据；旧 branch 和错误内容不进入新代际；用户重新提交任务后增强请求可以通过来源屏障。

## 4. 并发与期限

验证同一内容并发归档收敛、异内容冲突拒绝、普通后台路线折叠、当前请求屏障优先、复制取消、shutdown 有界等待和重启补齐。

期限结束表示来源故障，不允许投影或任务 Provider 请求继续。测试记录等待时长、队列身份和 Provider 接收增量。

## 5. 执行与 evidence

```bash
node scripts/validate-source-archive.mjs
node scripts/validate-context-enhancement.mjs
node scripts/check-validation-evidence.mjs
```

`source-archive` runner 证明本地数据和协调边界；`context-enhancement` runner 实际证明来源屏障与 Provider 请求闸门。临时文件位于 `.artifacts/`，稳定 evidence 保存脱敏检查和实现绑定。

runner 和 evidence 必须与当前验证规格一致。有效范围由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
