# 工作上下文优化模块

## 1. 当前责任

本模块构造任务模型实际工作上下文，负责扩展启用期间的自动压缩、跨轮历史预算和当前回合工具结果治理。

它接收 Session 记忆协调确认有效的路线、长时记忆提供的 Working Memory 与来源、以及 Pi 集成规范化的实际 current turn。它不判断当前 branch、不维护 OpenViking Session、不修改 Pi 历史，也不拥有 Provider、UI 或进程生命周期。

跨模块流程见 [`../system/context-enhancement.md`](../system/context-enhancement.md)，验证见 [`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md)。实现入口为 [`.pi/extensions/pi-context-memory/working-context-optimization.ts`](../../.pi/extensions/pi-context-memory/working-context-optimization.ts)。

## 2. 输入与输出

输入包含：

- 当前运行代际和完整路线身份；
- 与当前 HistoricalRoute 前缀兼容的 `MemoryCheckpoint`；
- checkpoint 覆盖 watermark 之后、当前 prompt 之前的 `VerifiedActiveDelta`；
- 当前 user prompt；
- Pi Provider 基线中的 prompt 后 assistant、ToolBatch、bash、custom、召回内容，以及尚未被检查点覆盖的 OpaqueProviderSegment；
- 每项来源的可恢复证明；
- 当前 system prompt、active tool schema 及其规范化哈希；
- Pi 集成提供的 `TaskContextBudget`（任务 Provider、模型和 API 身份，模型上下文窗口、输出预留、system/tool 固定开销、framing/transport 余量与估算版本）；
- 长时记忆提供的检查点 retention 输入边界与预算版本。

输出包含：

- 隐藏增强历史消息；
- 有界 current turn 与原样保留的 OpaqueProviderSegment；
- 运行代际与路线身份；
- 最终内容哈希和请求 nonce；
- 使用的来源 entry ID；
- 原始、保留、投影和省略预算统计。

无法构造可信结果时返回结构化失败，不返回空值或原始 Pi messages。

## 3. 上下文结构

任务模型输入按稳定顺序构造：

```text
EnhancedHistory
  当前 MemoryCheckpoint 的有界派生记忆
  + VerifiedActiveDelta
  + 按 Pi Provider 基线原样保留的 OpaqueProviderSegment
  + 已采用召回结果

CurrentTurn
  当前 user prompt
  + assistant 文本
  + raw ToolBatch 或 projected ToolBatch
  + 其它允许的当前回合消息
```

`EnhancedHistory` 是一个或多个隐藏 custom message。MemoryCheckpoint 只能用于其 coveredRoutePrefixKey 仍为当前路线精确前缀的请求；VerifiedActiveDelta 按 Pi 顺序补入该前缀之后、当前 prompt 之前的来源内容。两者的组合是历史输入，后台 refresh 状态本身不进入上下文。`CurrentTurn` 保持任务推进顺序，但不要求所有工具输出原样保留。

首轮允许空历史，但仍生成包含运行代际、空路线和来源边界的合法增强消息。

## 4. ToolBatch 解析

一个 `ToolBatch` 包含：

- 一个带一个或多个 tool call 的 assistant 消息；
- 这些调用对应的全部最终 tool result；
- Pi Provider 基线中的完整 assistant 消息、tool call 与完成状态；MessageSource 另标识可进入记忆投影的公开 taskContent。

解析必须验证：

1. tool call ID 唯一；
2. 每个调用有且只有一个最终结果；
3. 结果属于同一 assistant 批次；
4. sibling 结果的完成顺序不改变 assistant 源顺序；
5. raw 批次保持 Pi Provider 基线；只有 projected 批次要求全部被替换 block 具有已验证表示；
6. 批次来源与当前 session、branch 和路线一致。

验证失败返回 `tool-protocol` 错误。

## 5. 工具批次投影

### 5.1 保留策略

保留策略只依据来源顺序、大小、预算和协议状态，不另行推测工具内容价值：

1. 计算完整 CurrentTurn、最小合法增强历史与预留项后的总量；
2. 预算内的完整批次保持 raw；
3. 超预算时按最旧批次优先，把仍为 raw 且投影能够缩小输入的完整批次逐个替换为 projected；
4. 每次替换后重新计算，并把剩余空间分配给有界增强历史；
5. 全部可投影批次使用最小合法投影后仍超限时返回 `context-budget`。

近期批次预算允许时保持 raw：复制 Pi Provider 基线，只规范化已验证 locator。assistant thinking、其它扩展公开 custom content 和未来版本新增的 Pi 可见 opaque block 都按基线保留；projected 只能替换本扩展具有结构化表示的完整单元。

### 5.2 投影不变量

投影以完整批次为单位，只缩减 tool result 与 assistant 的说明正文；结构化 tool call 必须逐项保留 Pi Provider 基线中的工具名称、调用 ID 和原始 arguments，使 active tool schema 仍可验证。投影由本地确定性算法生成，不调用任务模型或记忆模型。表示必须包含：

- 批次顺序、工具名称、调用 ID 和原始 arguments；
- assistant task-content、完成状态、大小、哈希和有界 head/tail；
- 每个结果的成功、错误、取消和截断状态；
- 已支持 content block 的类型、大小、哈希与固定上限 head/tail；
- 稳定 fullOutputRef、Pi entry ID、来源内容哈希或 `recall_session` 展开入口；不得包含 FullOutputCandidate 或本机路径；
- 原始与投影大小、省略范围和恢复方式。

含 image/unsupported public block 的 message/ToolBatch 在 raw 中整体保持 Pi 基线；需要 projected 却无法保持完整单元时返回 `opaque-content-unrepresentable`。

### 5.3 来源前置条件

projected ToolBatch 只能引用长时记忆已确认可恢复的来源；任何含 FullOutputCandidate 的 raw ToolBatch、bash 或其它 CurrentTurn 内容也必须先取得稳定 fullOutputRef，因为 Pi 本机路径已从任务内容移除。工作上下文构造不自行写文件或调用 OpenViking；它向 Session 记忆协调返回所需来源集合，由协调模块完成屏障后重新构造或继续。普通、未截断且预算内的 raw 内容不要求来源屏障。

来源绑定同时核对全回合唯一的 call/result ID，以及 event message 的规范化 taskContent、完成状态和 Pi 权威 `MessageSource` 哈希。前置 context handler 改变正文或状态后，批次可以在预算内 raw 保留，但不能引用修改前的来源形成 projected；必须投影时返回来源错误。

## 6. 预算与选择顺序

预算只由 `TaskContextBudget` 与本次规范化输入计算：

```text
fixedTokenUpperBound = maxOutputTokens
                     + stableJsonUtf8Bytes(systemPrompt)
                     + stableJsonUtf8Bytes(activeTools)
                     + framingReserve
                     + transportMargin
messageTokenBudget = contextWindowTokens - fixedTokenUpperBound
```

任务 Provider、模型和 API 只参与预算身份，不参与名称准入或 wire 解析。有效 UTF-8 JSON 的每个 token 至少承载一个字节，因此稳定 JSON 字节数本身就是协议无关的 token 保守上界；system、tools 和消息序列均按该上界计算，另保留 framing/transport 余量，不再重复乘以安全系数。结构必需输入超过 `messageTokenBudget` 时失败。任务模型没有发布正整数窗口/输出上限、固定开销已经耗尽窗口或消息结果超限时返回预算失败。Pi footer 百分比、记忆模型窗口和最终 transport token 计数不参与授权计算。

模块同时从会改变 checkpoint retention/output 边界的预算事实生成 `retentionBudgetIdentity`：长时记忆 retention 输入边界、预算版本、任务模型 context window/output reserve、system/tool 规范化成本、framing/transport margin 和 estimator 版本。它不包含本次 CurrentTurn、system/tool 正文哈希或其它与历史空间无关字段；相同 identity 表示可共享同一检查点生成边界，不表示最终构造证明相同。

模块按以下优先级选择内容：

1. 当前 user prompt；
2. 保持 Provider 合法所需的 CurrentTurn 结构；
3. 不能被检查点覆盖的 OpaqueProviderSegment；
4. 当前 MemoryCheckpoint 中在剩余消息预算内的派生记忆；
5. VerifiedActiveDelta；
6. 已采用召回结果和补充背景。

选择只依据顺序、结构、大小、预算和来源状态；相同输入得到相同哈希。前五类是结构必需，召回/背景只用剩余预算。opaque 超限返回 `opaque-content-unrepresentable`。旧 checkpoint/delta 需折叠时返回精确 `checkpoint-refresh-required`；当前预算身份的最小合法 checkpoint 后结构必需输入仍超限，才返回 `context-budget`，同一目标不重复刷新。

## 7. 增强证明

每个成功输出生成一次性证明，至少绑定：

- 运行代际；
- 完整 request route fingerprint 与 HistoricalRoute fingerprint，其中路线身份包含当前 session；
- MemoryCheckpoint identity、VerifiedActiveDelta hash、retentionBudgetIdentity 与 OpenViking Session ID；
- 最终增强字符串内容哈希和一次性 nonce；
- `TaskContextBudget` 身份，间接绑定任务 Provider、模型、API、system、tools、窗口、输出预留和估算版本。

nonce 随隐藏增强字符串进入 Pi Provider 基线，其余证明只保留在扩展内存中。Pi 集成可在自己的 `before_provider_request` handler 时点观察该字符串并重新计算扩展自有身份；这不解释任务 API wire，也不声明控制后续扩展或 Provider transport。

## 8. 错误语义

模块返回稳定分类：

- `empty-input`：缺少合法 current prompt 或增强边界；
- `tool-protocol`：调用与结果不完整或错配；
- `opaque-content-unrepresentable`：Pi Provider 基线中的不透明内容必须被替换才能进入预算，但本扩展无法保持其语义；
- `source-required`：投影需要尚未完成的来源屏障；
- `source-unrecoverable`：投影省略的完整结构单元没有可恢复来源；
- `checkpoint-refresh-required`：已发布检查点超过当前 retentionBudgetIdentity 的历史预算，或来源后缀需要纳入新检查点；交由协调器建立唯一必要刷新屏障；
- `context-budget`：结构必需输入在刷新后仍超出模型窗口；
- `memory-malformed`：MemoryCheckpoint、VerifiedActiveDelta 或来源绑定不符合适配契约；
- `route-mismatch`：输入与路线身份不一致。

错误不生成部分增强消息。Session 记忆协调负责把必要失败锁存为运行故障。

## 9. 验证边界

验证必须覆盖：

- 首轮空历史增强消息；
- 兼容 MemoryCheckpoint 与 VerifiedActiveDelta 形成多轮有界历史，后台刷新状态不改变相同输入；
- 单批和多批并行工具调用；
- thinking、excluded bash、assistant stop reason、其它扩展 custom message 和未来版本新增的 Pi 可见 opaque block 先遵循 Pi Provider 基线；记忆投影不读取私有 metadata；
- 快速连续产生的最大边界工具输出；
- raw/projected 批次的 Provider 协议合法性；
- isError/cancelled/truncated/stopReason 等结构状态、固定 head/tail 和负向哨兵的来源恢复；不引入正文分类器；
- 相同输入的确定性内容与哈希；
- `TaskContextBudget` 对 system prompt、tool schema、framing、传输余量和输出上限的共同预算；任务 API 名称、footer 与记忆模型窗口不影响准入；
- 任务历史预算缩小时，过大的旧检查点触发当前 retentionBudgetIdentity 刷新；该身份的最小合法检查点仍超限时终局失败且不重复刷新；
- 不透明内容预算内原样保留，只有必须替换却无法表示时返回本扩展能力诊断；来源失败和预算不足保持独立错误；
- 本扩展 handler 时点对构造字符串、运行代际、路线、检查点、delta 和任务预算的观察与构造结果一致，异常只诊断；
- 复杂长任务 checker 能依据投影继续正确行动。

当前实现与设计之间的状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
