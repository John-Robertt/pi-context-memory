# 质量与成本观测模块

## 1. 当前责任

本模块定义开发期复杂长任务可靠性、任务质量、增强采用与责任边界、宿主兼容性和完整 API 成本的验证方法。它运行于开发实验环境，不进入用户扩展运行。

产品成功顺序为：可靠完成 → 事实与路线可信 → 增强采用结论准确 → 完整成本优势。压缩率、缓存命中率、召回率和延迟用于解释机制，不替代这些结果。

验证入口由 [`../validation/README.md`](../validation/README.md) 维护，当前交付状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。

### 1.1 证据层级与执行授权

本模块把证据分为：真实本地边界、受控替身边界、真实 Provider/模型纵向链路和真实账单。每个结论必须由与其责任对应的实际层证明；替身结果不能代替真实记忆模型生成、真实任务完成、实际 Provider 采用或最终 billed cost。

suite 启动时记录 `ValidationCoordinates`：任务/记忆 Provider、模型与 API、Pi/OpenViking、extensionCompositionFingerprint 与 handler 顺序、MemoryRuntimeProfile/adapter、凭据指纹、task thinking、样本和停止条件。坐标不变时按既有授权执行付费验证；Provider/模型变化交由用户决定。扩展组合变化要求重新观测兼容性，但不授权本扩展调整其它组件。

## 2. 运行分类

运行分类、blocked 证据、eligible 和可靠性公式统一引用 [`../validation/README.md`](../validation/README.md) §5。本模块只采集 checker、外部服务、block/abort、transport 与失败归因；内部等待、输出规模、队列、竞态、操作超时、预算和实现缺陷不能作为 blocked 依据。

## 3. 复杂长任务设计

真实 suite 至少包含工具输出压力、路线与事实更新、长时间连续任务三个 fixture；各 fixture 具有不同主要压力，并共同覆盖：

- 多轮调查、修改、验证和修正；
- 目标、硬约束和事实更新；
- 冲突 branch 与路线恢复；
- 多个并行或连续工具调用；
- 快速返回的大工具结果、错误和否定证据；
- 多次增强上下文换代；
- 早期来源召回和权威展开；
- 长时间运行和后台 Working Memory 更新；
- 接近任务模型上下文预算的 current turn；
- 最终可确定验证的任务产物。

每个 fixture 形成可确定验证的仓库产物。任务 checker 不读取扩展内部状态；协议 checker 分别判断 Provider 基线/记忆投影、hook 时点证明、transport 采用、宿主兼容性、故障归因和成本完整性，不能把本扩展时点日志提升为最终 Provider 事实。

## 4. 可靠性实验

增强路径在固定 fixture、任务模型、记忆模型、thinking、工具边界和输入条件下重复运行；每个 fixture 的 `eligibleTarget` 取自 [`../../validation/suite.json`](../../validation/suite.json) 的当前政策。每次 eligible 运行必须同时满足：

- 最终任务 checker 通过；
- 无用户手工重试、记忆整理或目标重述；
- 无内部死锁、无界等待或悬挂任务；后台 refresh pending 时可兼容检查点与 VerifiedActiveDelta 继续推进，只有必要 refresh 建立等待；
- 工具调用与结果没有丢失、错序或协议破坏；
- 当前目标、硬约束、有效事实和必要证据保持连续；
- branch、session 和迟到结果没有污染；
- constructed 输出完整分区 hook verified/rejected/unobserved；只有 verified 再分 transport 结果，且无虚假采用声明；
- Provider 基线未丢失 Pi 可见 foreign/opaque 单元，记忆投影未吸收 private metadata/locator；
- manifest 声明的 compaction/tree 宿主兼容性与实际请求/entry 一致，不一致时只形成该组合的兼容性失败；
- 已有 summary 文本没有进入本扩展 VLM、来源或增强历史；
- 所有失败、重试和后台任务具有确定归因。

fixture、checker、`eligibleTarget`、`maxAttempts`、模型、环境、期限、输入顺序和停止规则在 suite 开始前进入带哈希的 run manifest。blocked 不占 eligible 名额；样本不足为 inconclusive；失败和停止原因不能由补跑成功替换。

## 5. 外部阻塞证据

blocked 必须由扩展之外的观测证明，例如：

- 受管 OpenViking 子进程已退出或连接被明确拒绝；
- 任务模型或记忆模型 Provider 返回经独立采集的认证、配额、网络或服务不可用事实；
- 必要凭据在运行环境中不存在；
- 用户主动取消或终止必要服务。

独立证据必须覆盖故障时间和运行所需操作的区间。仅有扩展超时、空结果、内部错误码或“服务可能不可用”的推断不能形成 blocked。

memory-precondition 只有在本扩展 block 且 transport 独立观测到对应 Provider 增量为零时才能按该类归因；task-provider blocked 需要合法请求后的独立失败响应。观测不成立时不能由扩展日志推断 blocked。

外部错误经同一运行内重试恢复时，运行仍按最终 checker 归类，全部重试计入成本；只有外部条件使运行无法继续时才是 blocked。

## 6. 增强采用与责任边界观测

每个任务模型请求记录可关联的：

- run ID 和 request ID；
- 任务 Provider、模型和 API；
- session、完整 request route fingerprint、HistoricalRouteKey、MemoryCheckpoint、VerifiedActiveDelta 和运行代际；
- system prompt、tool schema、消息、ProviderPayloadProfile 与适配版本哈希；
- `context` 授权决定；
- constructed identity、hook verified/rejected/unobserved 与 handler 顺序；
- Provider 实际接收时刻；
- 阻断错误码。

只有 hook verified 才进一步分类 transport adopted/changed/unobserved；rejected/unobserved 也保存实际 transport 结果但不称增强采用。本扩展不控制后续 handler，用户根据诊断决定处理。

通过条件与指标定义统一引用 [`../validation/README.md`](../validation/README.md) §6；本模块只采集重算这些指标所需的 handler、transport、Provider 基线、记忆投影、跨组件修改、block 和 summary 污染事实。

manifest 可以额外要求 `changedAfterHook == 0`、`transportUnobserved == 0`、native summary 请求与新 entry 为零，从而证明某个明确 Pi/扩展组合的兼容性。该要求不扩大本扩展运行时权力，也不把其它组合判为非法。

观测不保存完整 payload 或凭据。

## 7. 任务质量与基线

Pi 原生 arm 只作为独立开发基线，用于比较任务质量和成本；它不进入增强扩展的运行状态机。

原生与增强 arm 共享：

- 相同任务和最终 checker；
- 相同任务模型、Provider 和 thinking；
- 相同工具能力、初始仓库和权限；
- 相同输入和停止条件；
- 相同 pair ID、预先平衡的 arm 顺序、固定缓存条件和重复次数。

增强 arm 首先满足可靠性、增强采用证据和责任边界门槛，再比较结果质量。任一 arm 未有效完成的样本不进入成本优势结论，但增强 arm 的失败继续计入可靠性。

## 8. 完整成本

完整成本包括：

- 任务模型请求；
- 记忆模型初始或显式恢复能力探针；
- Working Memory 生成、合并和提取；
- 召回相关模型请求；
- 重试和故障处理请求；
- 被测组合实际产生并由该 arm 归属的 compaction/tree summary 请求；
- 其它由增强系统触发的 API 请求。

每个 generation 必须关联唯一 run、arm、责任和 Provider 最终账单。两个 arm 都有效完成任务、增强采用结论准确且费用归属完整后，才比较完整 billed cost。manifest 坐标不变时直接执行付费验证；只有 Provider/模型变化交由用户决定。

## 9. 证伪条件

以下任一结果推翻对应产品结论：

- 任一 eligible 增强运行未通过最终 checker；
- 失败依赖内部推断被标记为 blocked；
- 任一核心节点只有替身证据却被标记为完成；
- suite 中途改变 Provider/模型，或在坐标未变时把重复授权作为验证前置条件；
- 大工具输出、快速调用、后台刷新或必要等待导致任务中断；
- constructed 输出未完整分区，或把 hook rejected/unobserved、transport changed/unobserved 宣称为采用；
- 本扩展 block 后仍由自身代码继续构造或确认同一增强处理；
- Provider 基线丢失 Pi 可见 foreign/opaque 单元，或记忆投影吸收 private metadata/locator/extension-private 内容；
- 本扩展尝试禁用、重排或修改其它扩展、加载顺序或 Pi 配置；
- manifest 声明宿主 summary 抑制兼容但实际请求/entry 不符合；
- 已有 summary 文本进入本扩展 VLM、来源索引或增强历史；
- 当前路线采用了冲突 branch 或迟到结果；
- 任务输入、模型、工具、权限或 checker 在两个 arm 间不一致；
- 任一 API generation 缺少唯一归属或最终账单；
- 成本结论只由 token、压缩率或缓存指标支持。

证据推翻设计时，先回到最早缺少运行观测的责任边界，再校准系统和验证文档。
