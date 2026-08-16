# 增强记忆工作上下文系统设计

## 1. 文档角色

本文定义 Pi 集成、Session 记忆协调、长时记忆与工作上下文优化怎样构造增强上下文、维护记忆、保留 Pi Provider 基线，并区分本扩展 hook 结论与宿主/transport 结果。用户行为见 [`../features/context-enhancement-state.md`](../features/context-enhancement-state.md)，OpenViking 边界见 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md)，验证见 [`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md)。

## 2. 设计目标与边界

系统以 Pi session 当前 branch 为事实权威，为本扩展构造来源可恢复、协议合法且有界的增强上下文。内部构造只有 `allow | block`；该结果不等于 Pi 或 Provider transport 的最终事实，后者单独观测。

Pi 继续拥有 Agent 循环、session、工具、tree/branch、扩展调度和 Provider transport。本扩展不修改 Pi 权威 entry，只决定自己返回的 context 和 hook 结论；其它组件之后的行为由各自边界负责。

设计同时处理两个增长方向：

- 当前用户 prompt 之前的跨轮历史；
- 当前 prompt 之后快速增长的 assistant、工具调用与工具结果。

## 3. 运行与路线状态

### 3.1 运行状态

Session 记忆协调维护：

```text
initializing → ready → faulted
      ↑           │
      └───────────┘  仅由显式重启或重新验证进入新代际

任意状态 → stopping
```

- `initializing`：配置、受管 OpenViking 实例和记忆模型能力正在建立；
- `ready`：当前运行代际具有有效能力证明；
- `faulted`：本扩展必要条件失败，不确认新的增强输出；
- `stopping`：session 正在关闭，不接受新工作。

`initializing` 中到达的请求加入当前代际初始化屏障；成功后同一请求继续构造增强上下文。用户取消只移除对应等待者，不锁存服务故障；初始化失败或达到当前运行 profile 的已验证操作边界时 abort 并进入 `faulted`。

`faulted` 保存错误码、脱敏原因、代际、发生位置和可选入口，不替用户选择处理。用户请求重新验证时才创建新代际，且不复用故障代际派生状态。

### 3.2 路线记忆状态

每个运行代际按精确路线身份维护两项正交派生状态：

```text
checkpoint?  已发布、覆盖某个 HistoricalRoute 前缀的 MemoryCheckpoint
refresh?     为确定 route prefix、watermark 与 retentionBudgetIdentity 运行或排队的后台刷新
```

路线身份包含 Pi session ID、session file、当前历史 leaf、规范化 MessageSource/ControlBoundary 顺序与内容哈希，以及 OpenViking 运行代际。检查点只有在其 coveredRoutePrefixKey 是当前 HistoricalRoute 的精确前缀时才兼容；刷新状态不参与任务事实，也不自动使路线不可用。

每次请求即时计算：

- **available**：兼容检查点与其后的 VerifiedActiveDelta 来源完整且能够进入任务模型预算，请求直接继续，后台刷新可以仍在运行；
- **refresh-required**：缺少兼容检查点、旧检查点不适合当前 retentionBudgetIdentity 的历史预算，或 delta 只有被新检查点覆盖后才能进入预算，请求加入完整 RefreshTarget 的唯一刷新屏障；
- **failed**：来源、能力、刷新、assembly、路线身份或预算无法满足，运行状态进入 `faulted`。

这些状态只属于内部协调。后台刷新、等待和队列均保持用户状态“增强记忆”；用户取消只移除自己的等待，不能把健康共享刷新误记为服务故障。

## 4. 请求输入模型

每次 `context` 调用把消息划分为：

```text
HistoricalRoute
  当前用户 prompt 之前的 Pi 权威路线

CurrentTurn
  当前用户 prompt
  + prompt 后的 assistant 文本
  + 已完成工具批次
  + 尚需保留的其它当前回合消息
```

`HistoricalRoute` 由当前 prompt 前的 MessageSource、ControlBoundary 和尚未被增强覆盖的 OpaqueProviderSegment 组成。Session 记忆协调选择与 MessageSource/ControlBoundary 前缀精确兼容、且不跨越 opaque segment 的 `MemoryCheckpoint`，再把覆盖 watermark 后的来源可恢复后缀形成 `VerifiedActiveDelta`；opaque segment 按 Pi Provider 基线原样留在请求中。后台 refresh 只折叠可形成记忆投影的更长前缀，不是每次请求的普遍依赖。

`CurrentTurn` 先保留 Pi Provider 基线，再治理本扩展替换范围。全-text message/ToolBatch 可形成 MessageSource；含 image/unsupported public block 的完整单元形成 OpaqueProviderSegment，不部分归档。thinking/private metadata 按 Pi 结构规则处理且不归档；ControlBoundary 无正文。customType、正文语义和来源黑名单都不决定 Provider 资格。

Pi 集成先验证 context 时刻的完整 `SessionRouteSnapshot`，再以当前 Agent run 的 user prompt 为边界拆分。`HistoricalRouteKey` 绑定 prompt 之前的有序 MessageSource taskContent、完成状态、仍需原样保留的 Pi Provider 内容与 ControlBoundary 身份；`CurrentTurnKey` 绑定该 prompt、后续已持久化 MessageSource、尚未落盘但实际传入的 Provider 基线消息及其顺序。请求证明同时绑定当前 session leaf、两个 key、MemoryCheckpoint identity、VerifiedActiveDelta hash 和最终内容哈希。

同一 user prompt 后的连续工具循环只更新 `CurrentTurnKey`，不提交 Working Memory refresh。Agent settled 后归档完整回合，并可为稳定路线 watermark 安排后台刷新；下一 user prompt 到达时优先组合兼容检查点与实际路线后缀，不因后台任务仍在运行而等待。

首轮请求使用扩展本地合法空检查点与空 VerifiedActiveDelta。它仍绑定已经通过实际能力验证的运行代际，并生成增强证明。

## 5. 工具批次与来源屏障

工作上下文优化按 [`../modules/working-context-optimization.md`](../modules/working-context-optimization.md) 定义的 `ToolBatch` 协议与预算规则，在 Pi Provider 基线内选择 raw 或 projected 表示。Pi 集成提供结构化批次和来源身份；长时记忆负责稳定来源；Session 记忆协调只在请求依赖尚未发布的来源时建立对应屏障。

任何投影省略的内容都必须具有经过完整性核验的稳定来源。批次协议不完整、来源不匹配或当前预算无法无损保留 opaque 内容时，本扩展不确认增强输出；具体解析、投影字段和错误由工作上下文优化模块唯一维护。

## 6. 检查点、来源后缀与后台刷新

`MemoryCheckpoint` 是长时记忆发布的可重建派生结果，绑定运行代际、coveredRoutePrefixKey、覆盖 watermark、来源集合、Working Memory、active history 与 assembly hash。`VerifiedActiveDelta` 是该 watermark 之后、当前 prompt 之前的有序 MessageSource/ControlBoundary 后缀；其内容直接来自 Pi 权威路线并已完成来源屏障，不依赖正在运行的 VLM task。

Session 记忆协调按以下顺序解析历史上下文：

1. 选择 coveredRoutePrefixKey 仍为当前 HistoricalRoute 精确前缀且不跨越 OpaqueProviderSegment 的最近检查点；没有可用检查点时从本地空检查点开始；
2. 对检查点后缀中的 MessageSource/ControlBoundary 执行同版本规范化、路线核验和来源屏障，形成 VerifiedActiveDelta；OpaqueProviderSegment 另按 Pi 基线保留；
3. 让工作上下文优化预计算检查点、delta、opaque segment 和 CurrentTurn 是否能够进入 ProviderPayloadProfile 预算；
4. 若能够进入则立即继续，已存在或新安排的后台刷新不成为等待条件；
5. 若缺少可用检查点、旧检查点在当前历史预算下过大，或 delta 需要被检查点覆盖，则以当前 generation、精确路线前缀、watermark 和 retentionBudgetIdentity 创建或加入必要刷新；刷新完成后重新读取当前 ProviderPayloadProfile 与路线，不沿用旧请求快照；
6. 刷新结果只在 task completed、assembly、来源和完整 RefreshTarget 全部核验后原子发布，当前 watermark 后的新 entry 仍保留为 delta。

后台刷新在 Agent settled、tree/resume 预热和 delta 预算高水位触发。完整 RefreshTarget 相同才共享；尚未启动的线性后继只有 retentionBudgetIdentity 相同才合并到最新 watermark；运行中的目标不改变，新预算请求重新评估，仍需刷新时创建自己的目标。机会性 refresh 返回 `skipped` 时保留既有检查点与 delta，不发布伪检查点或改变运行能力 proof。`refresh-required` 使用与 retentionBudgetIdentity 绑定的显式 retention 边界；若仍返回 skipped，则作为契约/策略错误锁存故障，不以重复提交形成无界循环。

请求取消只移除自己的等待。没有当前路线或消费者需要的未发布任务可以取消；仍服务后台预热或其它等待者的任务继续运行。ready 代际中的 accepted task 失败、Provider/profile 超时、取消或 assembly 错误使能力失效；stopping 清理取消不产生新故障。请求等待不设置比当前 `MemoryRuntimeProfile` 记忆调用更短的任意期限，慢但在支持边界内成功的刷新必须能够发布。

## 7. 工作上下文构造

Pi 集成先以当前任务 Provider、模型与 API 形成版本化 `ProviderPayloadProfile`；其字段和失效条件由 [`../modules/pi-integration.md`](../modules/pi-integration.md) 负责。工作上下文优化按 [`../modules/working-context-optimization.md`](../modules/working-context-optimization.md) 的唯一预算算法，从任务模型窗口扣除输出预留、system prompt、active tool schema、Provider framing 和 transport margin，并采用 profile 约束的保守消息估算。footer 百分比和记忆模型窗口不参与授权。

内容分配严格采用工作上下文优化 §6 的唯一顺序：只依据顺序、结构、大小、预算和来源状态；不分类“否定”“重要”或“影响下一步”。结构必需输入超限时按该模块返回 opaque、refresh 或 context-budget 结果。

最终结果包含：

- 隐藏增强历史消息；
- 有界 CurrentTurn 与必须原样保留的 OpaqueProviderSegment；
- ProviderPayloadProfile 身份；
- session、实际 leaf、HistoricalRouteKey、CurrentTurnKey、MemoryCheckpoint identity、VerifiedActiveDelta hash、OpaqueProviderSegment hash 和运行代际；
- system prompt 与 active tool schema 哈希；
- 上下文消息内容哈希；
- 单次请求 nonce；
- 来源集合与预算统计。

## 8. Provider 请求闸门

### 8.1 `context` 闸门

```text
context
  → 读取当前运行状态
  → 计算 HistoricalRoute 和 CurrentTurn
  → 解析兼容 MemoryCheckpoint 与 VerifiedActiveDelta
  → 仅在历史输入确实无法满足预算时等待必要 checkpoint refresh
  → 等待工具批次来源屏障
  → 构造有界工作上下文
  → 重新核对 session、leaf、路线、检查点、delta、profile 和运行代际
  → 返回增强消息并发布单次请求证明
```

任一步骤失败时，Pi 集成调用 `ctx.abort()` 终止当前 Agent 请求，记录结构化阻断原因并显示故障诊断。扩展异常不能用作控制流；所有可预期错误必须在集成边界转换为确定的阻断结果。

### 8.2 Provider 请求时点自检

本扩展的 `before_provider_request` handler 只核对它在自身执行时实际可见的 payload：

- 当前任务 Provider、模型和 API 与授权证明一致，并具有已验证的 PayloadProofAdapter；
- 归一化后的系统、工具 schema 和有序消息与授权输入一致；
- nonce 存在、未消费且只出现于预期增强消息；
- 重新读取的 runtime snapshot 仍证明同一受管进程代际和同一能力 proof 有效；实际 leaf、HistoricalRouteKey、CurrentTurnKey、MemoryCheckpoint identity、VerifiedActiveDelta hash 与 OpaqueProviderSegment hash 仍为当前值；
- ProviderPayloadProfile 的上下文窗口、输出设置、system/tool 开销和适配版本与实际 payload 一致；
- payload 增强内容哈希与 `context` 决定一致；
- handler payload 未丢失或改变本扩展发布的有序 messages；
- 当前请求没有故障锁存。

核对成功原子消费 nonce 并记 verified；进程/代际失效、能力 proof 变化或 payload/proof 不一致时记 hookRejected，按当前 session 与代际锁存故障、停止自身确认并 abort。constructed 输出未到达 handler 由 runner 记 hookUnobserved。Pi 可继续其它生命周期；最终采用仅由 transport 观测，无法建立则记 unobserved，由用户决定后续。

## 9. Pi compaction 与 tree hook

增强工作上下文持续保持有界，因此任务模型 usage 正常情况下不进入 Pi compaction 阈值。Pi 发出 `session_before_compact` 时，本扩展返回 `{ cancel: true }`，并按 threshold、overflow 或 manual 记录自己的预算结论；handler 不调用外部服务。

对 suite 所选且通过行为探针的 `PiProtocolProfile`，本扩展在选择 summary 的 `session_before_tree` 中返回空扩展 summary，请求宿主按无摘要方式完成目标导航；未选择 summary 时不修改事件。操作后的 leaf 仍由 Pi 定义。

上述返回值只是本扩展通过公开 hook 表达的行为，不构成对 Pi 或其它扩展的要求。实际 Provider 请求或 session entry 证明取消/无摘要结果没有成立时，本扩展记录 `host-behavior-unverified`，不宣称 native compaction/summary 已被抑制，也不自动禁用、重排或修改其它扩展；用户根据宿主与扩展组合诊断决定后续处理。

Session 中已有 compaction/branch summary 只参与本扩展路线身份；其文本不进入本扩展 VLM、来源索引、Working Memory 或增强历史。后续 handler 若重新加入 summary，由 transport 观测记录，而不是被本扩展宣称为已排除。

## 10. 任务上下文用量展示

Pi 的上下文用量来自最近一次任务 Provider usage，并对其后的消息作估算；它反映任务模型输入，不表示记忆模型窗口，也不是下一次增强 payload 的精确预判。增强请求完成后，实际 Provider usage 会校准此前尾部消息估算。

在交互宿主中，本扩展安装 footer adapter，保留模型、usage、费用和 branch，并以 `(增强)` 标识自己负责的上下文构造。它不修改 Pi compaction setting；扩展未加载时不安装 adapter，后续 footer 语义由 Pi 负责。

footer 和状态栏都不参与预算、请求授权或故障恢复。预算事实是 `ProviderPayloadProfile` 与本扩展构造/时点自检结果；显示暂时高估、低估或不可用不能放宽本扩展边界，最终 transport 采用仍由外部观测确定。

## 11. 并发、迟到结果与清理

- 完整 RefreshTarget 相同的调用共享一个任务，兼容检查点在刷新期间保持可读；
- 同一 session 的线性后继按来源顺序写入镜像，未启动刷新只在 retentionBudgetIdentity 相同时合并到最新 watermark；
- 不同 branch 使用隔离镜像，只复用仍为当前路线精确前缀的检查点；
- 迟到结果只进入自己的 generation、route prefix、watermark 和 retentionBudgetIdentity；
- 路线切换不会放宽身份核验，当前请求总是重新计算 delta；
- source、checkpoint、refresh、proof、镜像和清理任务都有明确上限；
- session shutdown 取消运行任务并尽力删除扩展创建的 OpenViking Session；
- 清理错误进入运行观测，不自动重放用户任务。

## 12. 故障与恢复

故障记录必须区分：配置、认证、Launcher 所有权、服务、模型能力、来源、路线、OpenViking 协议、工具批次、预算、Provider 证明和关闭阶段。

恢复流程为：

```text
用户修复配置、凭据、服务或存储条件
  → 执行 /restart-viking，或在扩展更新后重新启动 Pi
  → 创建新运行代际
  → 实际能力探针通过
  → 清除旧代检查点引用、刷新任务与请求证明
  → 从当前 Pi branch 与已核验来源建立本地空检查点和 VerifiedActiveDelta，并安排当前代际第一次后台刷新
  → 状态恢复为“增强记忆”
```

恢复不自动发送用户 prompt，不继续中断前未完成的工具批次。用户根据当前 session 状态重新提交任务。

## 13. 验证与校准

设计成立需要同时证明：

- 必要外部服务可用时，复杂长任务全部有效完成；
- 多个快速、并行和大输出工具批次保持有界并正确推进任务；
- 慢 refresh 期间，兼容 checkpoint+delta 仍可构造 allow；hook/transport 结果分别观测；
- 基线遵循 Pi 转换：全-text 可投影，mixed/image 整单元 opaque，当前 unknown role drop；thinking/private metadata/locator 不进长期记忆；
- ProviderPayloadProfile 约束本扩展预算，footer 只显示任务上下文并以 `(增强)` 标识；
- constructed 输出在 hook 分为 verified/rejected/unobserved；只有 verified 的 transport 才分 adopted/changed/unobserved；
- 本扩展内部必要能力失败时不确认增强输出；abort 返回与 transport 结果分别观测；
- 在声明经过验证的 Pi/扩展组合中，compaction 和 tree summary 结果符合本 handler 的请求；不符合时只形成 `host-behavior-unverified` 兼容性结论；
- tree、fork、clone、resume、reload 后，本扩展只使用 Pi 实际当前路线；
- 扩展未加载时不声明 Pi 的上下文、summary 或 footer 行为。

具体任务、checker、重复次数、blocked 证据和运行入口由 [`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md) 定义。
