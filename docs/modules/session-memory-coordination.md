# Session 记忆协调模块

## 1. 当前责任

本模块协调每个持久化 Pi session 的记忆生命周期、运行故障和本扩展增强输出授权。它约束来源、MemoryCheckpoint、VerifiedActiveDelta、CurrentTurn 投影与工作上下文。

它不生成派生记忆、不执行 OpenViking IO、不构造 Provider payload，也不解析任务业务语义。跨模块流程见 [`../system/context-enhancement.md`](../system/context-enhancement.md)、[`../system/source-archiving.md`](../system/source-archiving.md) 和 [`../system/source-recall.md`](../system/source-recall.md)。

## 2. 拥有的状态

每个协调实例固定属于一个 Pi session ID 与 session file，并拥有：

- 运行状态：`initializing | ready | faulted | stopping`；
- 当前 OpenViking 运行代际与能力证明；
- 每条当前路线可兼容的 MemoryCheckpoint 身份、来源后缀 watermark 与后台刷新状态；
- 来源归档与完整结果屏障；
- 有界 pending 请求授权和单次请求证明；
- 故障错误码、脱敏原因、发生阶段和恢复入口。

用户配置目标、OpenViking 子进程、来源文件和实际上下文内容由相邻模块拥有；协调模块只保存必要引用、身份和有效性状态。

## 3. 路线身份与不变量

每次操作接收当前路线快照：session ID、session file、实际 leaf，以及从根到 leaf 的规范化 message entry 与 ControlBoundary。协调模块从中派生完整 `SessionRouteSnapshot`、当前 prompt 之前的 `HistoricalRouteKey` 和 prompt 之后的 `CurrentTurnKey`。必须同时满足：

1. 快照身份与协调实例完全一致；
2. entry ID 唯一，父链从根到 leaf 连续；
3. 非空路线的末 entry 等于 leaf；
4. route item 由 MessageSource、ControlBoundary 与仅运行期存在的 OpaqueProviderSegment 组成；后者保持 Pi Provider 基线哈希，不进入来源或检查点；
5. CurrentTurn 实际消息具有稳定顺序和内容哈希；已持久化部分与同版本 MessageSource 精确一致，投影内容必须具有权威 entry 与来源；
6. 来源列出和展开只返回当前快照仍存在的 MessageSource；
7. MessageSource 的 task-content、完成状态、task-content hash 与当前 Pi entry 重新规范化结果一致，authority hash 核对原始 entry；ControlBoundary 不含 summary 文本；
8. MemoryCheckpoint 的 coveredRoutePrefixKey 必须是当前 HistoricalRoute 不跨越 OpaqueProviderSegment 的精确前缀，来源集合属于该前缀，检查点 generation 与当前代际一致；当前代际另有未过期能力证明，检查点的 producing proof 只作来源追溯；
9. VerifiedActiveDelta 是该检查点覆盖 watermark 之后、当前 prompt 之前的有序 MessageSource/ControlBoundary 后缀，全部来源可恢复；
10. 请求授权同时绑定实际 leaf、HistoricalRouteKey、CurrentTurnKey、检查点 identity、delta hash、OpaqueProviderSegment hash 和最终内容哈希。

协调模块拥有后台任务身份：

```text
RefreshTarget = {
  generation,
  routePrefixKey,
  watermark,
  retentionBudgetIdentity
}
```

`retentionBudgetIdentity` 由工作上下文优化返回，协调模块不解析其内部预算语义。只有四项完全相同的 target 可以共享等待和结果；长时记忆只执行该不可拆分目标。

任一条件不成立时拒绝该输入，不用本地缓存或 OpenViking 数据修补 Pi 当前状态。

## 4. 运行状态机

```text
initializing
  → 能力证明与当前来源可用 → ready
  → 任一必要条件失败       → faulted

ready
  → 配置、服务、模型、来源、路线、内容或证明失败 → faulted

faulted
  → 显式重启或重新验证创建新代际 → initializing

任意状态
  → session shutdown → stopping
```

`faulted` 是本扩展锁存状态；后台成功或服务恢复不自动改写结论。只有用户选择重启/重新验证时，本模块才创建新代际并核验当前 branch；其它处理方式不由本模块决定。

后台刷新是 ready 运行状态中的派生任务，不形成独立用户状态，也不等同于路线不可用。每次授权根据兼容检查点、VerifiedActiveDelta、来源与预算计算 `available | refresh-required`：前者直接继续，后者加入唯一必要刷新屏障。刷新失败或等待达到当前 `MemoryRuntimeProfile` 的操作边界时进入 faulted。

## 5. 对外能力

本模块提供：

- 验证并归档当前路线；
- 计算完整路线身份；
- `awaitGenerationReady`：让初始化期间的请求等待当前代际能力屏障；
- `scheduleCheckpointRefresh`：在稳定 agent settlement、路线预热或后缀高水位为完整 RefreshTarget 安排可合并后台刷新；
- `resolveHistoricalContext`：选择兼容 MemoryCheckpoint、形成 VerifiedActiveDelta，并在必要时按当前 retentionBudgetIdentity 创建或加入 checkpoint 刷新屏障；
- `awaitAuthorityEntry`：把需要投影的实际 CurrentTurn 消息核对到已持久化 Pi entry；
- `ensureSourceBarrier`：确认被投影内容具有可恢复来源；
- `authorizeRequest`：组合运行、路线、来源和上下文构造结果，返回允许或阻断；
- `verifyRequestProof`：在本扩展 Provider handler 时点原子复核并消费单次请求证明；
- `latchFault`：原子锁存首个当前代际故障和后续相关证据；
- `beginGeneration`：显式恢复时清理旧代派生状态并进入初始化；
- 当前路线来源列表和权威展开；
- 有界的后台索引、准备、取消与 shutdown 协调。

请求授权结果只有：

```text
allow { enhancedContext, requestProof }
block { faultCode, diagnostic }
```

不存在返回原始 Pi messages 的授权结果。

## 6. 并发与期限

- 同一运行代际共享一个能力初始化或续租任务；
- 同一 session 的来源写入保持 entry 顺序；
- generation、精确 route prefix、watermark 与 retentionBudgetIdentity 全部相同才共享 checkpoint refresh；
- 后台刷新运行期间，已发布的兼容检查点继续可读，新 entry 留在 VerifiedActiveDelta；
- 尚未启动的线性后继刷新只在 retentionBudgetIdentity 相同时合并到最新 watermark；已运行任务不改变目标，ProviderPayloadProfile/预算变化后的请求重新评估；
- 分叉路线只复用仍是当前路线精确前缀的检查点，并拥有独立刷新；
- 已运行任务保留自己的完整 RefreshTarget，迟到结果不能进入其它路线或预算身份；
- source、checkpoint、refresh、proof、索引和清理状态都有固定上限；
- 请求等待只绑定必要刷新，不设置比当前 profile 记忆调用更短的任意超时；达到已验证操作边界形成明确失败，不选择另一条路径；
- 调用取消只移除对应等待者；后台仍需要的刷新继续运行，无当前路线或消费者需要且尚未发布的任务可以取消，不改变已发布检查点或锁存伪故障。

## 7. 故障语义

故障按责任分类：

- `configuration`：用户配置、schema、连接字段或凭据；
- `runtime`：Launcher、子进程、readiness 或运行代际；
- `capability`：记忆模型实际能力；
- `source`：归档、完整输出、哈希、身份或恢复；
- `route`：session、leaf、父链、指纹、迟到结果或期限；
- `protocol`：OpenViking 响应未知、矛盾或缺失；
- `context`：工具批次、预算、内容形态或来源投影；
- `provider-proof`：本扩展 handler 时点的 payload 与授权决定不一致；
- `shutdown`：关闭和资源清理。

故障记录不包含凭据或完整 payload。当前代际已经锁存故障后，后续请求直接返回同一主故障，并可追加不改变主归因的观测。

## 8. 恢复与 session 生命周期

用户请求重启或能力重新验证且验证成功后，Pi 集成调用 `beginGeneration`：

1. 取消旧代 pending；
2. 清除旧代 ready 和请求证明；
3. 保留 Pi 权威 session 与已核验本地来源；
4. 绑定新 OpenViking 代际和能力证明；
5. 重新验证当前 branch；
6. 为新代际建立本地合法空检查点，从当前 Pi branch 的已核验来源形成 VerifiedActiveDelta，并安排当前代际第一次刷新；旧代非空检查点不重新绑定；
7. 只有运行能力和当前检查点/后缀成立时，才返回本扩展 `allow(enhancedContext, proof)`。

session replacement、fork、clone、resume 和 reload 创建与新 session 身份绑定的协调实例。shutdown 进入 stopping，拒绝新授权并有界等待必要来源写入。

## 9. 验证边界

验证必须覆盖：

- 跨 session、损坏父链、相同 entry ID 不同内容和错误 leaf 拒绝；
- 后台刷新与必要等待对用户状态不可见；
- 慢刷新期间兼容检查点与 VerifiedActiveDelta 继续授权，只有后缀超预算或缺少兼容检查点时等待；
- RefreshTarget 共享、同预算线性合并、ProviderPayloadProfile 变化、取消、profile 期限、分支替代和迟到结果保持隔离；
- 来源屏障失败只返回本扩展 block；
- 当前代际必要故障锁存并停止确认后续增强输出；
- 用户选择重新验证时创建新代际且不复用旧结果；
- allow 输出具有唯一 proof；block/abort 与 transport 实际结果分别记录；
- 并行工具与快速路线变化不产生无界队列；
- shutdown 不泄漏任务或污染替换 session。
