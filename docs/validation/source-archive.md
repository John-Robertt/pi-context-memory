# 来源归档与恢复屏障验证

## 1. 验证责任

本文定义来源归档的 session 隔离、当前 branch 约束、来源恢复、完整结果保存、ToolBatch 投影屏障、存储错误和期限行为。稳定结果保存于 [`../../validation/evidence/source-archive.json`](../../validation/evidence/source-archive.json)。

## 2. 核心不变量

验证必须证明：

- 不同 session 的来源不可互查或混用；
- branch 切换后，离开路线的 entry 不进入当前列表、屏障或展开；
- MessageSource 与当前 Pi entry 经同版本规范化后的 task-content、完成状态、task-content hash 和 authority hash 精确一致；
- 全-text custom 按 user 语义形成来源；含 image/unsupported public block 的 mixed message/ToolBatch 整体 opaque，不部分归档；当前未知 role 按 Pi drop；thinking/private metadata、excluded bash 和扩展私有内容不进来源；
- compaction/branch summary 只形成无文本 ControlBoundary，summary 与 retainedTail 污染哨兵不进入来源；
- 截断工具结果的完整输出具有稳定副本和完整性证明；
- ToolBatch 只有在全部必要来源可恢复后才能投影；
- 不可写目录、复制失败、损坏 blob、哈希错误和期限结束形成明确失败；
- 来源失败不污染已经发布的有效数据；
- 无法确认 session file、entry ID、父链或内容指纹的数据被拒绝；
- 来源失败使本扩展拒绝确认依赖该来源的增强输出；Pi session 和其它扩展不被修改。

## 3. 场景与判定

### 3.1 Session 隔离与来源恢复

使用 Pi `SessionManager` 创建两个持久化 session，并写入冲突事实。分别归档和查询当前路线。

通过条件：查询只返回目标 session 的 MessageSource；每条来源的 session ID、session file、entry ID、taskContent、完成状态和哈希与当前 Pi entry 按公开转换重新投影的结果一致；权威展开不暴露 thinking、私有 metadata、locator 或 OpaqueProviderSegment。

### 3.2 Branch 切换

在同一 session 形成共同前缀和路线 A，归档后回到共同点并形成路线 B，再次归档、建立屏障和查询。

通过条件：存储可以保留路线 A 副本，但当前列表、屏障和展开只接受共同前缀与路线 B；路线 A 的 entry 不能满足路线 B 请求。

### 3.3 Provider 基线、记忆投影与 Summary 边界

加入全-text/mixed/image user/custom、各 stopReason assistant、完整 ToolBatch、孤立 toolResult、重复或缺失 tool-call ID、不完整调用、普通/excluded bash、thinking、details/usage、当前 unknown role、未来 Pi 可见 block 和已有 summary entry；分别设哨兵。

通过条件：基线与 Pi 转换/探针一致；全-text 任意 customType 形成 user-role MessageSource，mixed/image 整单元 opaque，孤立结果、重复/缺失调用 ID 和不完整批次不得发布 MessageSource，当前 unknown role drop；assistant text 保存 completion。thinking/private metadata、excluded bash、opaque 和本机 locator 不进来源或 Provider 表示；opaque 单元若携带 locator 但无法发布稳定 `fullOutputRef`，请求屏障必须拒绝。opaque 预算内原样保留，不能投影时只返回本扩展诊断；ControlBoundary 无 summary 正文，废弃 branch 不回灌。

### 3.4 完整工具结果

以权威 toolResult 和 BashExecutionMessage 的受控 `fullOutputPath` 验证大结果归档，并注入损坏 blob、元数据发布失败、输入持续增长和复制期限结束。

通过条件：`Pi entry → FullOutputCandidate → content-addressed blob → 唯一 source record/fullOutputRef` 链路成立；Pi 文本中的同路径提示被替换为稳定引用，来源记录不持久化 candidate 或原始路径；source record 只在 blob 完整写入后发布，不存在第二份 entry metadata；读取和每次请求来源屏障都复核字节数与 SHA-256，损坏或缺失 blob 不得放行；删除原临时文件并创建新的协调实例后，仍可按当前 branch 和 fullOutputRef 恢复完整结果。

### 3.5 ToolBatch 来源屏障

构造多 sibling 工具批次，混合普通/截断/error/负向哨兵；在 entry 持久化前后请求 raw/projected，验证负向文本只靠固定 head/tail 与来源恢复而非语义分类。

通过条件：普通、未截断且预算内的 raw 批次保持 Pi Provider 基线；含 FullOutputCandidate 的 raw 批次先等待 blob/fullOutputRef，增强 payload 只出现稳定展开标记。批次完整前不发布历史 MessageSource；不完整 HistoricalRoute 只使本扩展报告 `tool-protocol` 并拒绝确认增强输出。projected 等待全部权威 entry 与来源；失败时不产生部分投影或来源。

### 3.6 存储与身份失败

使用不可写目录、错误 session、损坏父链、同 ID 不同内容和未持久化 session 验证拒绝语义。

通过条件：失败明确返回且不改变已发布内容、Pi session 或其它扩展；未持久化 session 不创建增强来源；本扩展不确认依赖这些输入的增强输出。

### 3.7 修复与重建

修复存储条件后，以当前 Pi branch 创建新运行代际并重新提交来源。

通过条件：稳定 entry ID 幂等补齐；旧 branch/错误内容不进入新代际；用户重提后本扩展可重新确认来源与增强输出。

## 4. 并发与期限

验证同一内容并发归档收敛、异内容冲突拒绝、普通后台路线折叠、当前请求屏障优先、复制取消、shutdown 有界等待和重启补齐。

期限结束表示来源故障，本扩展不继续投影或确认依赖它的输出；测试分别记录等待、block/abort 与 Provider transport 增量。

## 5. 执行与 evidence

```bash
node scripts/validate-source-archive.mjs
node scripts/validate-context-enhancement.mjs
node scripts/check-validation-evidence.mjs
```

`source-archive` runner 证明本地数据和协调边界；`context-enhancement` runner 分别证明来源屏障后的本扩展 allow/block 与 transport 结果。临时文件位于 `.artifacts/`。

runner 和 evidence 必须与当前验证规格一致。有效范围由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
