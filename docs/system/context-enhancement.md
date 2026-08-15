# 增强记忆工作上下文系统设计

## 1. 文档角色

本文定义 Pi 集成、Session 记忆协调、长时记忆与工作上下文优化模块怎样协作，在扩展启用期间独占任务模型工作上下文与自动压缩。用户可观察行为见 [`../features/context-enhancement-state.md`](../features/context-enhancement-state.md)，OpenViking 边界见 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md)，证明方法见 [`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md)。

## 2. 设计目标与边界

系统以 Pi session 当前 branch 为事实权威，为每个任务模型请求构造来源可恢复、协议合法且有界的增强上下文。扩展启用期间不存在请求级路径选择：满足增强条件的请求发送，不满足条件的请求在 Provider 前终止。

Pi 继续拥有 Agent 循环、session 历史、工具执行、tree 和 branch 语义。系统不修改或删除 Pi 权威 entry，只控制任务模型实际收到的消息。

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
- `faulted`：必要条件失败，新的任务模型请求被阻断；
- `stopping`：session 正在关闭，不接受新工作。

`initializing` 中到达的请求加入当前代际初始化屏障；成功后同一请求继续构造增强上下文。用户取消只移除对应等待者，不锁存服务故障；初始化失败或请求操作期限结束时 abort 并进入 `faulted`。

`faulted` 保存稳定错误码、脱敏原因、运行代际、发生位置和恢复入口。恢复创建新代际，不复用故障代际的 pending、ready 或请求证明。

### 3.2 路线状态

每个运行代际内，路线按完整身份维护：

```text
absent → preparing → ready
           │     └→ failed
           └→ absent  最后一个等待者取消且结果未发布
```

路线身份包含：

- Pi session ID；
- session file；
- 当前历史 leaf；
- 有序 message entry 与 ControlBoundary ID；
- message 完整内容指纹和无 summary 文本的 ControlBoundary 身份；
- OpenViking 运行代际。

路线状态属于内部协调数据。`preparing` 期间用户状态保持“增强记忆”；只有路线失败或操作期限结束才使运行状态进入 `faulted`。

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

`HistoricalRoute` 由 OpenViking Working Memory 和来源核验的 active history 构成稳定增强历史；目标、约束和有效决定由这两类来源的连续性保持，不建立独立语义锚点状态。`CurrentTurn` 由工作上下文优化直接治理，不等待慢速 Working Memory 提取后才处理大工具结果。

Pi 集成先验证 context 时刻的完整 `SessionRouteSnapshot`，把 compaction/branch summary 归一化为无文本 ControlBoundary，再以当前 Agent run 的 user prompt 为边界拆分。`HistoricalRouteKey` 绑定 prompt 之前的有序 message 内容与 ControlBoundary 身份；`CurrentTurnKey` 绑定该 prompt、后续已持久化 message entry、尚未落盘但实际传入的消息及其顺序。请求证明同时绑定当前 session leaf、两个 key 和最终内容哈希。

同一 user prompt 后的连续工具循环只更新 `CurrentTurnKey`，不为每个工具结果重做历史 Working Memory。Agent settled 后可以为完整回合预备下一条 HistoricalRoute；下一 user prompt 到达时只复用与实际前缀精确一致的结果。

首轮请求具有合法空 `HistoricalRoute`。它仍绑定已经通过实际能力验证的运行代际，并生成增强证明。

## 5. 工具批次与来源屏障

### 5.1 原子批次

一个包含工具调用的 assistant 消息与其全部对应 tool result 构成 `ToolBatch`。批次只有在调用 ID 完整匹配、每个调用具有一个最终结果且顺序可解释时才可进入上下文构造。

批次处理只有两种合法结果：

- **raw**：保留整个批次的原消息对象和顺序；
- **projected**：移除整个协议批次，以一个隐藏增强投影表示其任务语义和来源。

系统不保留孤立 tool call 或 tool result，也不在批次内部按字符截断协议消息。

### 5.2 投影内容

工具批次投影由本地确定性算法生成，不调用模型，至少包含：

- 批次顺序、工具名称和调用 ID；
- assistant 文本与允许 thinking block 的类型、大小、哈希和有界 head/tail；
- 参数规范化表示的大小、哈希与有界 head/tail；
- 成功、错误、取消和截断状态；
- 已支持结果 block 的类型、大小、哈希与有界 head/tail；
- 错误、否定文本和完成状态的保留区域；
- Pi entry ID、完整输出路径、来源内容哈希或展开入口；
- 原始与投影大小、省略范围和恢复方式。

图片、未知 content block、缺失调用结果或无法建立来源的内容不静默投影，而是返回明确失败。

### 5.3 来源屏障

工作上下文准备在用投影替代原始大结果前，等待长时记忆确认对应 Pi entry 和完整结果具有可恢复来源。来源写入、完整性校验或身份核验失败时，不发送缺失必要信息的任务模型请求。

## 6. 历史路线准备

Session 记忆协调为精确 `HistoricalRoute` 调用幂等的 `ensureReady`：

1. 已有精确 ready 结果时直接复用；
2. 已有相同 pending 时加入同一任务；
3. 路线尚未准备时创建准备任务；
4. 线性后继复用同一 OpenViking Session 并追加增量；
5. 分叉、session replacement 或有效前缀变化使用隔离 Session；
6. 来源核验的 active history 和 Working Memory 按 OpenViking 契约组装；
7. 结果只发布给创建它的运行代际和完整路线身份。

操作期限用于限定等待和形成诊断，不用于选择另一条任务路径。期限结束、任务失败或结果不可信时，路线进入 `failed`，运行状态锁存故障。

accepted Working Memory task 完成并通过最终 assembly 核验前，路线保持 `preparing`，依赖该路线的请求继续等待；`skipped` 只在契约确认无需提取时使用既有 Working Memory 与来源核验 active history 形成 ready。单个请求取消不取消仍有消费者的共享任务。ready 运行中的后端失败、取消、超时或 assembly 失败使当前代际进入能力故障；stopping 期间的清理取消不创建新故障。

## 7. 工作上下文构造

工作上下文优化按以下顺序分配预算：

1. 当前用户 prompt；
2. 保持 Provider 合法所需的 CurrentTurn 结构；
3. 当前回合中影响下一步的错误、否定结果和证据；
4. 当前有效且有界的完整 Working Memory；
5. 来源核验的近期 active history；
6. 已进入当前请求的召回结果和补充背景。

预算选择以任务可靠完成和事实可信为约束。内容无法在保持这些约束及工具协议的前提下进入模型窗口时，构造返回失败。

最终结果包含：

- 隐藏增强历史消息；
- 有界 CurrentTurn 消息；
- ProviderPayloadProfile 身份；
- session、实际 leaf、HistoricalRouteKey、CurrentTurnKey 和运行代际；
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
  → ensureReady 精确历史路线
  → 等待工具批次来源屏障
  → 构造有界工作上下文
  → 重新核对 session、leaf、路线和运行代际
  → 返回增强消息并发布单次请求证明
```

任一步骤失败时，Pi 集成调用 `ctx.abort()` 终止当前 Agent 请求，记录结构化阻断原因并显示故障诊断。扩展异常不能用作控制流；所有可预期错误必须在集成边界转换为确定的阻断结果。

### 8.2 最终 Provider 闸门

`before_provider_request` 以当前单次请求证明核对最终序列化 payload：

- 当前任务 Provider、模型和 API 与授权证明一致，并具有已验证的 PayloadProofAdapter；
- 归一化后的系统、工具 schema 和有序消息与授权输入一致；
- nonce 存在、未消费且只出现于预期增强消息；
- 运行代际、实际 leaf、HistoricalRouteKey 和 CurrentTurnKey 仍为当前值；
- payload 增强内容哈希与 `context` 决定一致；
- 没有其它扩展删除或替换必要增强内容；
- 当前请求没有故障锁存。

核对成功时原子消费 nonce；重复、迟到或并发复用同一证明的 payload 被阻断。核对失败时在网络请求发出前 abort。Provider payload 是增强实际采用的最终事实，`context` 返回值本身不构成成功证明。

## 9. Pi compaction 与 tree summary 抑制

增强工作上下文持续保持有界，因此任务模型 usage 正常情况下不进入 Pi compaction 阈值。Pi 发出 `session_before_compact` 时，Pi 集成在增强模式下取消该 compaction：

- threshold 表示增强预算控制没有成立；
- overflow 表示增强 payload 超出模型边界；
- manual 表示用户调用了不属于增强运行路径的压缩入口。

这些事件不触发 Pi 摘要模型。threshold 和 overflow 锁存工作上下文故障；manual 返回增强记忆已自动管理上下文的明确提示。

`session_before_tree` 不等待记忆、不生成摘要。Pi `0.84.2` 适配器在用户选择 summary 时返回空的扩展 summary，使宿主跳过原生 summarizer、继续目标导航且不建立 `branch_summary` entry；未选择 summary 时直接保持无摘要导航。若宿主版本尚未验证这一抑制契约，则取消带 summary 的 tree 操作，也不允许原生模型请求。操作后的 leaf 重新定义唯一有效路线。

Session 中已有 compaction 或 branch summary entry 只参与路线身份和边界解释；其 summary 文本从 VLM 输入、来源索引、Working Memory 与任务模型上下文中排除。

## 10. 并发、迟到结果与清理

- 同一精确路线共享一个准备任务；
- 同一 session 的线性后继按来源顺序串行写入镜像；
- 不同 branch 使用独立镜像；
- 迟到结果只进入自己的代际与路线缓存；
- 路线切换不会放宽身份核验；
- pending、ready、镜像和清理任务都有明确上限；
- session shutdown 取消运行任务并尽力删除扩展创建的 OpenViking Session；
- 清理错误进入运行观测，不自动重放用户任务。

## 11. 故障与恢复

故障记录必须区分：配置、认证、Launcher 所有权、服务、模型能力、来源、路线、OpenViking 协议、工具批次、预算、Provider 证明和关闭阶段。

恢复流程为：

```text
用户修复配置、凭据、服务或存储条件
  → 执行 /restart-viking，或在扩展更新后重新启动 Pi
  → 创建新运行代际
  → 实际能力探针通过
  → 清除旧代路线与请求证明
  → 从当前 Pi branch 重建来源和工作上下文
  → 状态恢复为“增强记忆”
```

恢复不自动发送用户 prompt，不继续中断前未完成的工具批次。用户根据当前 session 状态重新提交任务。

## 12. 验证与校准

设计成立需要同时证明：

- 必要外部服务可用时，复杂长任务全部有效完成；
- 多个快速、并行和大输出工具批次保持有界并正确推进任务；
- 慢于内部准备预期的路线最终增强发送或明确阻断，不产生其它路径请求；
- 每个已发送 Provider payload 都具有当前增强证明；
- 各类必要能力失败时 Provider 请求数不增加；
- Pi compaction 和 tree summary 的模型请求均为零，tree 不新建 `branch_summary` entry；
- tree、fork、clone、resume、reload 和已有 compaction session 只采用当前路线；
- 禁用扩展并重新启动后 Pi 原生行为独立可用。

具体任务、checker、重复次数、blocked 证据和运行入口由 [`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md) 定义。
