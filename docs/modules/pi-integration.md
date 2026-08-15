# Pi 集成模块

## 1. 当前责任

本模块是系统与 Pi 的唯一集成边界。它观察 Pi 生命周期，通过 `pi-session-protocol.ts` 将版本化 session entry 和消息形态规范化为下游稳定输入，注册用户命令与召回工具，并在 Pi 提供的 hook 中构造增强上下文、请求摘要抑制并核验本扩展自己的请求证明。它不拥有 Pi 的 Provider transport、其它扩展或扩展执行顺序。

来源、OpenViking Session 和记忆模型能力由长时记忆模块拥有；运行与路线决定由 Session 记忆协调拥有；有界消息构造由工作上下文优化拥有；排序与来源展开由召回模块拥有；OpenViking 子进程由项目启动器拥有。

实现入口位于 [`.pi/extensions/pi-context-memory/index.ts`](../../.pi/extensions/pi-context-memory/index.ts)。跨模块流程见 [`../system/context-enhancement.md`](../system/context-enhancement.md)、[`../system/memory-model-runtime.md`](../system/memory-model-runtime.md)、[`../system/source-archiving.md`](../system/source-archiving.md) 和 [`../system/source-recall.md`](../system/source-recall.md)。

## 2. 输入与规范化边界

模块从 Pi 读取：

- session ID 与持久化 session file；
- 当前 leaf 和从根到 leaf 的 branch entry；
- `context` 中的实际 Agent messages；
- 当前 system prompt 与 active tool schema；
- tool call、tool result 和 assistant 消息生命周期；
- compaction、tree、fork、clone、resume、reload 和 shutdown 事件；
- 本扩展的 `before_provider_request` handler 被调用时可见的当前 Provider payload；
- 当前模型、上下文窗口和取消信号。

`pi-session-protocol.ts` 只解释 Pi 的结构与传递语义，不判断自然语言内容“是否重要”或“是否为事实”。它发布两个正交结果：

- **Provider 基线**：当前 Pi 版本会交给任务模型的消息表示；优先复用 Pi 导出的 `convertToLlm`，只有完整输出定位和 summary 等版本差异使用行为探针固定；
- **记忆投影**：本扩展有结构证据可以归档、索引和重建的 `MessageSource`，以及只表达路线边界的 `ControlBoundary`。

判断只依据 Pi/entry 结构判别字段、明示元数据、消息所有者和协议关系；正文关键词、模型语义、customType 与来源黑名单都不参与。版本化投影表是“能否重建长期记忆”的能力表，不是“是否允许进入 Provider”的 allowlist：未有投影只降低本扩展的记忆/压缩能力，Pi 可见内容仍 opaque 保留。

```text
MessageSource = {
  id, parentId, role,
  taskContent, completion,
  taskContentHash, authorityHash
}

ControlBoundary = {
  type: "compaction" | "branch-summary",
  id, parentId,
  firstKeptEntryId? | fromId?
}
```

`MessageSource.role` 使用 Pi Provider 基线的 `user | assistant | toolResult`；bash/custom text 转换后为 user。原 entry type/ID/parent 由来源引用与 authority hash 保留，customType 不写成任务语义。

当前 suite 所选 `PiProtocolProfile` 的已验证基线：user/assistant/toolResult 原样保留；非 excluded bash 转 user；任意 customType 的公开 content 转 user 且 details 丢弃；compaction/branch summary 转派生 user 文本；未知 role 被该 profile 的 `convertToLlm` 丢弃，因此不属于 Provider 基线，也不形成 opaque。版本升级只有在同一行为探针重新通过后才能继续使用该 profile。扩展自有 proof/诊断按所有者识别，不作为会话来源。

记忆投影只接收整个 Provider-view message/ToolBatch 的可重建 task text。含 image 或其它无任务投影的公开 block 时，整条 message/完整批次的 `convertToLlm` 输出成为 OpaqueProviderSegment，不能同时拆出 MessageSource。Pi 结构明示的 thinking/usage/private details 不属于 taskContent：raw 按 Pi 保留，projected 按固定协议规则省略，不读取正文。summary entry 只形成无文本 ControlBoundary。

Pi 适配器发现结构化 `fullOutputPath` 时，只用该结构化值和当前版本确定生成的文本片段做精确配对，把匹配路径替换为基于 entry ID 的稳定“完整输出可展开”标记，并把原路径作为瞬时 `FullOutputCandidate` 交给长时记忆复制。这里的文本处理是对已知 locator 的精确脱敏，不解析正文语义。candidate 不参与 task-content hash，不持久化，也不进入 OpenViking、recall、增强 Provider payload 或日志；长时记忆完成 blob 发布后，只保存稳定 `fullOutputRef { blobId, sha256, size }`。

其它扩展 custom 仍按 Pi 基线处理：全 text 可形成 MessageSource；含 image/unsupported public block 的整条 message 或完整 ToolBatch 成为请求内存中的 `OpaqueProviderSegment { reason: "unsupported-content", entryIds, providerMessages, providerViewHash }`；孤立结果、重复调用 ID、缺失结果或错配形成 `reason: "tool-protocol"`，不得发布部分 MessageSource。providerMessages 只能是 `convertToLlm`/版本探针确认的有序输出，不含 raw entry/details；它原样保留，但不持久化、不进 OpenViking/log/stable evidence，也不能被 checkpoint 覆盖。预算要求替换却无法保持该有序 Provider view 时才报告 `opaque-content-unrepresentable`，不要求 foreign allowlist 或组件变更。

`HistoricalRouteKey` 和 `CurrentTurnKey` 绑定 Pi Provider 基线中实际保留的有序消息、完成状态、协议关系及无文本 control 身份。记忆投影可以替代已经由 MessageSource/检查点覆盖的历史内容，但不得静默删除未被覆盖的 Pi Provider 内容。compaction 前仍在当前 parent 链上的原始 message entry 按自身身份读取；branch summary 的 `fromId` 只用于边界身份，不展开废弃 branch。

临时 session 没有可恢复来源，不能形成跨重启增强记忆。本扩展保持初始化/故障并说明该边界；是否继续临时 session、切换持久化 session 或禁用扩展由用户决定。

## 3. 对外能力

本模块提供：

- Pi 生命周期到 Session 记忆协调的稳定事件输入；
- `context` 阶段的增强请求闸门；
- 为工作上下文优化提供 ProviderPayloadProfile；
- `before_provider_request` 阶段对本扩展增强证明的时点核验；
- `session_before_compact` 中请求取消 Pi compaction；
- `session_before_tree` 中请求无摘要导航；
- `recall_session(search|read_source)`；
- `/memory-model` 和 `/restart-viking`；
- “增强记忆 · 初始化中”“增强记忆”和“增强记忆 · 故障”状态；
- 脱敏的请求、阻断、来源、运行代际和生命周期观测。

## 4. 请求闸门

### 4.1 `context`

每次任务模型调用前：

1. 读取当前 session、branch 和实际 messages；
2. `initializing` 时加入当前代际能力屏障；
3. 请求 Session 记忆协调授权当前请求；
4. 取得与当前路线前缀兼容的检查点和来源可恢复后缀；只有该组合无法满足内容或预算时，才等待必要刷新；
5. 等待 projected 批次及任何含 FullOutputCandidate 的 CurrentTurn 内容所需来源屏障；
6. 重新核对 session、leaf、路线、检查点前缀和运行代际；
7. 成功时返回工作上下文优化构造的增强消息；
8. 失败时调用 `ctx.abort()`，保存阻断原因并按责任更新运行状态。

扩展抛错不是阻断机制。最外层 handler 捕获所有可预期错误，并把它们转换为确定的授权失败；返回原始 Pi messages 不是合法结果。

### 4.2 Provider 请求时点自检

`before_provider_request` 使用与当前任务 Provider API 匹配的 `PayloadProofAdapter`，把本 handler 被调用时可见的 payload 归一化为模型、系统、工具 schema 与有序消息表示，并核对本扩展此前发布的增强证明。需要绑定的完整字段由 [`../system/context-enhancement.md`](../system/context-enhancement.md) §8.2 唯一定义。

核验成功只证明 handler 时点一致并记 verified；失败记 hookRejected、锁存到当前 session 与运行代际、停止自身确认并 abort，只有显式新代际可以重新授权。后续 handler 仍由 Pi 按顺序调用，本扩展不要求其停止、重排或注册 allowlist。

未到达本 handler 的 constructed 输出由 runner 记 hookUnobserved。transport 只由职责外观测分类；本扩展不从自身日志推断，也不自动修改其它组件。

### 4.3 Provider payload profile

Pi 集成为当前任务 Provider、模型、API、base URL/compat 与唯一 PayloadProofAdapter 发布版本化 `ProviderPayloadProfile`，统一描述模型上下文窗口、可请求输出上限、system prompt 与 tool schema 的规范化大小、协议 framing、传输余量和估算器身份。该 profile 只提供边界事实，不选择保留哪些任务内容；预算分配由工作上下文优化负责。`before_provider_request` 对实际可见的 wire system/tools/output 字段重建相同 adapter 事实，不能一致时拒绝证明。

profile 从当前 Pi 模型和本 handler 可见的实际请求接口推导，不读取 footer 百分比，也不由用户记忆模型配置决定。`model_select`、system prompt、active tools、Provider API 或适配版本变化使旧 profile 与预算缓存失效；Provider 请求时点自检核对可见 payload 与 profile 一致，transport 最终采用另由外部观测确定。

## 5. Pi compaction 与 tree hook

`session_before_compact` handler 在扩展运行期间返回 `{ cancel: true }`，表达本扩展不需要 Pi compaction：

- threshold 和 overflow 记录为本扩展工作上下文预算未成立；
- manual 提示增强记忆已经管理上下文；
- handler 不调用外部服务。

`session_before_tree` 同样只表达本扩展的处理意见。对 suite 所选且已经通过真实行为探针的 `PiProtocolProfile`，用户选择 summary 时，本 handler 提示“增强记忆按无摘要导航处理本次操作”并返回 `{ summary: { summary: "" } }`；未选择 summary 时不返回修改。`pi-session-protocol.ts` 发布 `treeSummarySuppressionVerified` 作为本扩展对当前宿主行为的观测结论。

Pi 升级、其它 handler 或实际 entry/请求观测使取消或无摘要结果无法证明时，本扩展记录 `host-behavior-unverified`，不宣称 Pi 已取消 compaction 或 summary，也不要求 Pi 或其它扩展改变、禁用或重排。用户根据诊断决定是否继续当前组合；无论宿主最终行为如何，已有 compaction/branch summary 仍只按下一段的来源边界处理。

Pi session 中已有 compaction/branch summary 的身份和分支关系仍用于本扩展路线解释；summary 文本不进入本扩展长时记忆、召回、增强历史或时点证明。compaction 前仍在当前 parent 链上的 message 按自身身份读取，branch summary 的废弃 `fromId` 路线不回灌；Pi 或后续扩展如何处理原 entry 不由本模块控制。

## 6. 状态与诊断

用户状态只由运行生命周期驱动：

- `initializing` → “增强记忆 · 初始化中”；
- `ready` → “增强记忆”；
- `faulted` → “增强记忆 · 故障”。

后台刷新、必要等待、队列长度和 OpenViking task 不改变 ready 状态展示。故障诊断通过通知、`/memory-model` 和脱敏观测提供具体原因。

交互模式使用宿主版本适配器保留 Pi footer 的模型、累计 usage、费用与 branch 信息，并把任务模型上下文用量标识为 `已用比例/窗口 (增强)`；该数值沿用 Pi 对最近任务 Provider usage 与尾部消息估算的语义，不表示记忆模型用量。扩展不修改 Pi 的持久化 compaction setting。非交互模式不安装 footer，只输出同语义观测。

footer 是观测而非授权输入。上下文构造只使用 `ProviderPayloadProfile`；显示失败或响应返回前的估算偏差不能放宽预算、触发回退或改变运行代际。配置文件变化只刷新目标配置诊断，不改变当前 ready 运行代际；重启和能力重新验证由显式命令触发。

## 7. 来源与召回集成

模块在 session、turn、tree、compaction 和 shutdown 生命周期提交当前权威路线归档。当前回合需要投影大工具结果时，授权流程等待对应来源屏障。

`recall_session` 每次执行都重新取得当前 branch：

- `search` 在当前路线来源中使用 OpenViking 排序；
- `read_source` 重新规范化当前 Pi 权威 entry，只展开经核对的 task-content 或长时记忆来源记录中 fullOutputRef 指向的同身份完整结果切片，不暴露 FullOutputCandidate 或本机路径；
- 结果进入当前回合后仍受工作上下文预算约束。

召回错误以工具错误返回；若错误表明必要记忆数据面已经失效，Session 记忆协调同时锁存运行故障。

## 8. 生命周期与关闭

```text
session_start
  → 建立协调实例并进入初始化
  → 检查受管代际和能力证明
  → 从当前 branch 恢复来源与增强上下文

message_end / tool_result / turn_end
  → 只提交当时已经最终化且通过 disposition 的来源；中间 turn_end 不安排 checkpoint refresh

agent_settled
  → 以完整用户回合后的当前路线安排后台检查点刷新

model_select
  → 清除 pending 请求证明和预算缓存，重新计算 retentionBudgetIdentity；旧 refresh 只有完整 identity 仍一致时才可共享
  → 核对新模型 API 的 PayloadProofAdapter

context / before_provider_request
  → 授权、应用并核验增强请求

session_tree / session replacement / reload
  → 以操作后的 session 和 leaf 重建

session_shutdown
  → 停止接受请求
  → 有界等待必要来源写入
  → 取消运行任务并清理扩展资源
```

关闭不自动发送消息或继续中断任务。清理结果进入观测。

## 9. 验证边界

本模块必须证明：

- 每个 constructed 输出在 hook 分入 verified/rejected/unobserved；只有 verified 再按 transport adopted/changed/unobserved 分类；
- 声明支持的任务 Provider/模型/API 具有实际响应证据，本扩展不把 controlled adapter 或自身日志提升为最终采用；
- 本扩展内部配置、服务、模型、来源、路线、预算和时点 proof 失败时，不确认增强输出；
- Provider 基线与 Pi 转换一致；Pi 可见 foreign/opaque 单元不丢失，thinking/private metadata/locator 不进长期记忆；
- 多工具和大输出 current turn 保持 Provider 协议合法；中间 `turn_end` 不触发 checkpoint refresh，`agent_settled` 才形成完整用户回合刷新边界；
- compaction/tree handler 返回与实际宿主请求/entry 结果分别记录，不一致时只发布兼容性诊断；
- 已有 compaction/branch summary 文本不进入本扩展来源、OpenViking 或增强历史；
- tree、fork、clone、resume 和 reload 后，本扩展只从操作后的当前路线构造记忆；
- 后台刷新和必要等待不进入用户状态；交互 footer 保留 Pi 原有观测并以 `(增强)` 标识任务上下文用量，显示值不参与授权；
- 用户若禁用扩展并重启，后续 Pi 行为不再由本模块声明。

当前实现与设计之间的交付状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
