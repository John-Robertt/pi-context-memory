# 质量与成本观测模块

## 1. 当前责任

本模块定义开发期复杂长任务可靠性、任务质量、增强路径独占和完整 API 成本的验证方法。它运行于开发实验环境，不进入用户扩展运行。

产品成功顺序为：可靠完成 → 事实与路线可信 → 增强独占 → 完整成本优势。压缩率、缓存命中率、召回率和延迟用于解释机制，不替代这些结果。

验证入口由 [`../validation/README.md`](../validation/README.md) 维护，当前交付状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。

### 1.1 证据层级与执行授权

本模块把证据分为：真实本地边界、受控替身边界、真实 Provider/模型纵向链路和真实账单。每个结论必须由与其责任对应的实际层证明；替身结果不能代替真实记忆模型生成、真实任务完成、实际 Provider 采用或最终 billed cost。

suite 启动时记录 `ValidationCoordinates`：任务 Provider/模型/API、记忆 Provider/模型、OpenViking 坐标、凭据引用指纹、thinking、样本数、`maxAttempts` 和停止条件。沿用这些坐标产生的付费调用已属于正常验证授权，不逐次请求用户确认；要修改任务或记忆 Provider/模型时停止并交由用户决定。

## 2. 运行分类

每个实验运行只能归入：

- `completed`：最终任务 checker 通过，运行证据完整；
- `failed`：checker 未通过、任务中断、需要用户介入、证据不完整或出现内部错误；
- `blocked`：独立观测确认必要外部服务不可用；memory-precondition 在 Provider 前阻断，task-provider 在合法增强请求后返回明确外部失败。

`eligible` 表示没有独立外部阻塞证据的运行：

```text
eligibleRuns = completed + failed
completionReliability = completed / eligibleRuns
```

声明支持的验证范围内，`completionReliability` 必须为 `100%`。无法独立归因的失败属于 `failed`。

内部等待、快速输出、大结果、队列拥堵、竞态、操作超时、预算错误和实现缺陷不构成 blocked 依据。

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

每个 fixture 形成可由测试或结构化检查确定验证的仓库产物。任务 checker 在 Agent settled 后以独立进程检查最终工作区、公开任务产物、Pi 权威 session 与来源断言；它不读取扩展内部状态，也不以模型自报、日志或 token 指标决定成功。协议 checker 分别判断 manifest 要求的压力覆盖、增强独占、故障归因和成本完整性；要求的覆盖未发生时，attempt 因证据不完整记为 failed。

## 4. 可靠性实验

增强路径在固定 fixture、任务模型、记忆模型、thinking、工具边界和输入条件下重复运行；每个 fixture 的 `eligibleTarget` 至少为 10。每次 eligible 运行必须同时满足：

- 最终任务 checker 通过；
- 无用户手工重试、记忆整理或目标重述；
- 无内部死锁、无界等待或悬挂任务；
- 工具调用与结果没有丢失、错序或协议破坏；
- 当前目标、硬约束、有效事实和必要证据保持连续；
- branch、session 和迟到结果没有污染；
- 每个已发送任务 Provider 请求具有合法增强证明；
- Pi compaction 和 tree summary 模型请求为零，tree 不新建 `branch_summary` entry；
- 已有 summary 文本没有进入 VLM 或任务 payload；
- 所有失败、重试和后台任务具有确定归因。

fixture、checker、`eligibleTarget`、`maxAttempts`、模型、环境、期限、输入顺序和停止规则在 suite 开始前进入带哈希的 run manifest。blocked 不占 eligible 名额；样本不足为 inconclusive；失败和停止原因不能由补跑成功替换。

## 5. 外部阻塞证据

blocked 必须由扩展之外的观测证明，例如：

- 受管 OpenViking 子进程已退出或连接被明确拒绝；
- 任务模型或记忆模型 Provider 返回经独立采集的认证、配额、网络或服务不可用事实；
- 必要凭据在运行环境中不存在；
- 用户主动取消或终止必要服务。

独立证据必须覆盖故障时间和运行所需操作的区间。仅有扩展超时、空结果、内部错误码或“服务可能不可用”的推断不能形成 blocked。

memory-precondition 阻塞要求协调器在任务 Provider 前 block 且 Provider 增量为零；task-provider 阻塞可以发生在合法增强请求发送之后，但失败响应必须独立采集。两者都不计入 completionReliability 分母。

外部错误经同一运行内重试恢复时，运行仍按最终 checker 归类，全部重试计入成本；只有外部条件使运行无法继续时才是 blocked。

## 6. 增强独占观测

每个任务模型请求记录可关联的：

- run ID 和 request ID；
- 任务 Provider、模型和 API；
- session、实际 leaf、HistoricalRouteKey、CurrentTurnKey 和运行代际；
- system prompt、tool schema、消息与适配版本哈希；
- `context` 授权决定；
- 最终 Provider payload 增强证明；
- Provider 实际接收时刻；
- 阻断错误码。

任务 Provider 采用由扩展之外的传输观测证明：本地接收端核对请求和 payload 哈希，真实 Provider 运行关联最终 HTTP 发送哈希与响应 ID、状态及 usage。扩展日志只用于对账。

通过条件为：

```text
sentTaskRequests == enhancedVerifiedRequests
unverifiedSentTaskRequests == 0
blockedRequestsProviderDelta == 0
nativeSummaryRequests == 0
createdBranchSummaryEntries == 0
summaryContaminationHits == 0
```

`createdBranchSummaryEntries` 统计运行开始后的增量；`summaryContaminationHits` 覆盖来源、OpenViking 请求/assembly 和任务 Provider payload。

`blockedRequestsProviderDelta` 只覆盖协调器已 block 的任务请求；task-provider 在合法增强发送后的外部失败仍计入 sentTaskRequests。

观测不保存完整 payload 或凭据。

## 7. 任务质量与基线

Pi 原生 arm 只作为独立开发基线，用于比较任务质量和成本；它不进入增强扩展的运行状态机。

原生与增强 arm 共享：

- 相同任务和最终 checker；
- 相同任务模型、Provider 和 thinking；
- 相同工具能力、初始仓库和权限；
- 相同输入和停止条件；
- 相同 pair ID、预先平衡的 arm 顺序、固定缓存条件和重复次数。

增强 arm 首先满足自己的可靠性和独占门槛，再比较结果质量。任一 arm 未有效完成的样本不进入成本优势结论，但增强 arm 的失败继续计入可靠性。

## 8. 完整成本

完整成本包括：

- 任务模型请求；
- 记忆模型初始化与续租能力探针；
- Working Memory 生成、合并和提取；
- 召回相关模型请求；
- 重试和故障处理请求；
- 异常 tree summary 请求（通过门槛要求为零）；
- 其它由增强系统触发的 API 请求。

每个 generation 必须关联唯一 run、arm、责任和 Provider 最终账单。两个 arm 都有效完成任务、增强可靠性与独占成立且费用归属完整后，才比较成功任务的完整 billed cost。运行沿用 manifest 已固定的任务与记忆 Provider/模型时直接执行付费验证；仅 Provider/模型变更需要用户决定，外部失败不能触发未经授权的切换。

## 9. 证伪条件

以下任一结果推翻对应产品结论：

- 任一 eligible 增强运行未通过最终 checker；
- 失败依赖内部推断被标记为 blocked；
- 任一核心节点只有替身证据却被标记为完成；
- suite 中途改变 Provider/模型，或在坐标未变时把重复授权作为验证前置条件；
- 大工具输出、快速调用或路线准备导致任务中断；
- 任一已发送任务请求缺少增强证明；
- block 后 Provider 仍收到任务请求；
- Pi 产生独立 compaction/tree summary 模型请求或 tree 新建 `branch_summary` entry；
- 已有 summary 文本进入 VLM、来源索引或任务 payload；
- 当前路线采用了冲突 branch 或迟到结果；
- 任务输入、模型、工具、权限或 checker 在两个 arm 间不一致；
- 任一 API generation 缺少唯一归属或最终账单；
- 成本结论只由 token、压缩率或缓存指标支持。

证据推翻设计时，先回到最早缺少运行观测的责任边界，再校准系统和验证文档。
