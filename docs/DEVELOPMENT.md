# 当前开发入口

## 1. 文档角色

本文连接 [`PRODUCT.md`](../PRODUCT.md)、[`ARCHITECTURE.md`](../ARCHITECTURE.md) 与当前实践，只维护可运行状态、有效证据、当前主导约束、交付边界和唯一下一执行入口。

## 2. 当前目标设计

扩展启用期间，增强记忆独占任务模型工作上下文与自动压缩。每个任务模型请求必须具有当前 OpenViking 运行代际、实际记忆模型能力、精确 Pi 路线、可恢复来源和最终增强 payload 证明；条件不成立时在 Provider 前阻断。

内部路线准备不形成用户状态。状态栏只展示“增强记忆 · 初始化中”“增强记忆”和“增强记忆 · 故障”。用户需要 Pi 原生行为时退出当前实例、禁用扩展并重新启动。

产品第一验收门槛是真实复杂长任务可靠完成：声明范围内没有独立外部阻塞证据的运行必须全部通过任务 checker。快速、并行和大输出工具结果、内部等待、队列和上下文换代均属于系统责任。

每个核心节点必须具有与其责任匹配的实际运行证据；协议替身只能补充故障和边界覆盖。验证沿用 manifest 中当前任务与记忆 Provider/模型时，必要付费调用已获正常流程授权，不再逐次询问用户；只有改变任务或记忆 Provider/模型时才暂停并请求决定。

## 3. 当前可运行实现

当前实现坐标为 Pi `0.84.2` 与项目私有 OpenViking `0.4.13`。以下能力可以运行：

- 持久化 Pi session 当前 branch 的本地来源归档；
- `fullOutputPath` 完整工具结果的内容寻址副本；
- OpenViking `vectors_only` 来源索引；
- `recall_session(search|read_source)` 当前路线过滤和 Pi 权威展开；
- 用户记忆模型 JSONC、配置编译、项目启动器所有权和受管重启；
- OpenViking Session append、commit、task polling 和 context assembly；
- 当前 prompt 之前历史的有界增强消息。

当前自动上下文实现仍允许未准备、超时、服务或模型失败的请求使用原始 Pi messages；当前回合工具结果保持原始形态，overflow 使用 Pi compaction，`session_before_tree` 也尚未抑制 Pi 原生 summary；用户状态仍包含准备和原生路径语义。当前实现因此不满足目标设计的增强独占、自动压缩接管、tree summary 隔离和复杂长任务可靠性。

## 4. 当前证据边界

以下 evidence 仍能证明各自的局部实现事实：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：现有本地来源隔离、恢复和完整结果；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：现有来源索引、当前路线过滤和权威展开；
- [`validation/evidence/memory-model-runtime.json`](../validation/evidence/memory-model-runtime.json)：现有配置转换、进程所有权和重启行为；
- [`validation/evidence/context-enhancement.json`](../validation/evidence/context-enhancement.json)：现有异步准备、路线身份、Provider payload 和 Pi 生命周期行为；
- [`validation/evidence/context-quality.json`](../validation/evidence/context-quality.json)：预置 session、禁用工具、单 prompt、单次原生/增强的固定答案样本；fixture 含有与当前产品目标不一致的要求，不能作为复杂长任务验收。

这些 evidence 尚未证明：

- 实际记忆模型能力是任务请求前置条件；
- 声明支持的任务与记忆 Provider/模型/API 组合均具有对应 actual 证据；
- 失败请求在 Provider 前被阻断；
- 全部已发送任务请求具有增强证明；
- current turn 多工具与大输出保持有界；
- Pi compaction/tree summary 摘要请求和新 `branch_summary` entry 均为零，已有 summary 文本不污染 VLM；
- 三类真实复杂长任务分别达到至少 10 个 eligible 且全部完成；
- 完整 API 成本优势。

`node scripts/check-validation-evidence.mjs` 只能确认现有 evidence 与现有实现输入一致；现有受控替身或固定答案证据不能替代各核心节点的实际纵向验证，也不能满足新验证规格。

## 5. 当前主导约束

当前主导约束是**任务模型请求没有单一、可执行的增强授权边界**。

运行 readiness、路线准备、上下文构造和 Provider payload 目前由多个布尔状态及隐式空值表达；失败结果可以返回原始消息，扩展异常也不能阻止 Pi 继续请求。只要该边界未改为 `allow(enhancedContext, proof) | block(fault)`，服务故障、快速请求和后续 ToolBatch 设计都无法形成可靠保证。

成本归属不是当前执行入口。可靠完成、事实可信和增强独占成立前，不进入成本优势实现。

## 6. 当前交付边界

**目标**：建立扩展启用期间的增强请求硬闸门，使实际记忆模型能力、精确路线和最终 payload 证明成为任务 Provider 请求的必要条件。

**需要完成**：

- Session 记忆协调拥有 `initializing | ready | faulted | stopping` 运行状态；
- 长时记忆通过隔离 OpenViking Session 执行实际模型能力探针，发布并续租有界代际证明；
- 请求授权只返回 `allow` 或 `block`，不返回原始 Pi messages；
- `context` 在 initializing 时加入能力屏障，在 ready 时创建或加入精确路线准备，并在失败时使用 `ctx.abort()`；
- `before_provider_request` 通过 PayloadProofAdapter 核对 system prompt、tool schema、消息、nonce、代际与路线身份；
- `session_before_compact` 在增强运行期间确定性取消 Pi compaction；
- `session_before_tree` 抑制原生与扩展 summary，导航不建立 `branch_summary` entry；
- 用户状态收敛为初始化、增强记忆和故障；
- 本地 runner 实际证明初始化、配置、服务、能力、路线和 payload 失败时 Provider 接收数不增加；
- 慢但成功的路线准备最终只发送增强 payload；
- 禁用扩展并重新启动后 Pi 原生行为独立可用。

**完成条件**：

```text
sentTaskRequests == enhancedVerifiedRequests
unverifiedSentTaskRequests == 0
blockedRequestsProviderDelta == 0
nativeCompactionRequests == 0
nativeBranchSummaryRequests == 0
createdBranchSummaryEntries == 0
summaryContaminationHits == 0
```

同时，故障诊断准确、当前 Pi session 不变、显式恢复创建新代际且不自动重放 prompt。

## 7. 唯一下一执行入口

1. 在 Session 记忆协调中定义运行状态、故障数据和 `allow | block` 请求授权结果；
2. 在 OpenViking 适配与长时记忆中实现能力探针、代际租约和续租，并立即用当前实际记忆 Provider/模型闭合探针、accepted task、assembly 和租约证据；
3. 将 Pi `context`、受支持 Provider 的 PayloadProofAdapter 与 `before_provider_request` 接入授权结果：用隔离传输证明 block 后零增量，并用当前实际任务 Provider/模型证明 allow payload 被采用；
4. 接管 `session_before_compact`、抑制 `session_before_tree` summary，并用真实 Pi session 验证零摘要请求、零新 entry 和污染隔离；
5. 重写 `validate-memory-model-runtime.mjs` 与 `validate-context-enhancement.mjs`，使 stable evidence 区分 controlled/actual，绑定 `ValidationCoordinates`、响应 ID、usage、fixture、checker、实现和规格哈希；
6. 重新调查 CurrentTurn 持久化时序，实现 ToolBatch 纵向交付，并以真实 Pi 工具、大输出来源和当前任务 Provider/模型证明 raw/projected 后续行动；
7. 以三个真实任务 manifest 和独立 checker 替换当前固定答案 fixture，完成每类至少 10 个 eligible 运行；前述门槛全部成立后，再以相同 Provider/模型执行原生/增强成对完整账单实验。
