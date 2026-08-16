# 当前开发入口

## 1. 文档角色

本文连接 [`PRODUCT.md`](../PRODUCT.md)、[`ARCHITECTURE.md`](../ARCHITECTURE.md) 与当前实践，只维护可运行状态、有效证据、当前主导约束、交付边界和唯一下一执行入口。

## 2. 当前路线

当前功能、系统和模块设计分别由 [`features/`](features/README.md)、[`system/`](system/README.md) 与 [`modules/`](modules/README.md) 维护；验证政策和运行方式由 [`validation/`](validation/README.md) 与 [`operations/`](operations/README.md) 维护。本文只报告这些设计与当前实践之间的状态、证据和执行入口。

## 3. 当前可运行实现

当前验证坐标由 [`../validation/suite.json`](../validation/suite.json) 选择 Pi protocol profile 与任务/记忆模型，由 [`../pyproject.toml`](../pyproject.toml) 和 `uv.lock` 锁定项目私有 OpenViking。以下能力可以运行：

- `config/toolchain.json`、`.python-version` 与依赖锁形成项目内安装链，uv bootstrap 先校验摘要且不创建用户级 Python 入口；
- `validation/suite.json` 是 Pi profile、任务/记忆模型和验证政策的机器入口，runner 实际观测版本；
- `config/openviking-adapter-contract.json` 统一配置桥、TypeScript 校验和适配器 runner 的受审查字段/凭据/schema 契约；
- 扩展与启动器从同一 OpenViking 基础配置解析 endpoint；stable evidence 绑定当前实现、验证规格、suite 和工具链；
- 持久化 Pi session 当前 branch 的本地来源归档；
- `toolResult.details.fullOutputPath` 与 `BashExecutionMessage.fullOutputPath` 经权威 entry 提取、locator 脱敏后的内容寻址副本；
- OpenViking `vectors_only` 来源索引；
- `recall_session(search|read_source)` 当前路线过滤、Pi 权威 taskContent 展开，以及同来源 `fullOutputRef` 的完整性核验和有界正文读取；
- 用户记忆模型 JSONC、预检凭据解析、无凭据值的运行配置、固定内部子进程环境、child 输出实时脱敏、项目启动器所有权和受管重启；版本化 `MemoryRuntimeProfile` 显式约束模型请求与客户端策略，Launcher 在 service readiness 后完成隔离生产 Session 探针并发布进程代际绑定的能力证明，扩展逐项核对证明后才建立工作上下文代际；
- OpenViking Session append、commit、task polling 和 context assembly 只由长时记忆执行，并在 task completed、目标、来源与 assembly 核验后原子发布不可变 `MemoryCheckpoint`；
- Session 记忆协调按 generation、精确路线前缀、watermark 与 `retentionBudgetIdentity` 管理不可拆 `RefreshTarget`，选择兼容 checkpoint 并从 Pi 权威来源形成 `VerifiedActiveDelta`；相同目标共享，未启动的同预算线性后继收敛，运行目标、分支、预算和迟到结果保持隔离；
- 工作上下文优化不执行 OpenViking IO，只消费已核验 checkpoint+delta；可用组合立即构造，delta 超过当前预算时返回唯一 `checkpoint-refresh-required`，必要 refresh 完成后重算路线与 Provider profile；
- Provider 基线与记忆投影双边界：`pi-session-protocol.ts` 复用 Pi 的 `buildContextEntries`/`sessionEntryToContextMessages`/`convertToLlm` 建立基线，并从结构证据产生 `MessageSource`、`ControlBoundary` 与 `OpaqueProviderSegment`；
- 当前任务 Provider、模型、API、base URL/compat、payload adapter、context window、输出上限、system prompt 和 active tools 形成版本化 `ProviderPayloadProfile`；同一 profile 同时约束增强历史与 CurrentTurn，进入授权证明，并在 hook 对实际 wire 的唯一 system/developer instruction、tools 和输出字段重新核对；
- 当前 user prompt 后的 assistant/tool messages 按 Provider 基线解析为不可拆 `ToolBatch`；call/result ID 在全回合唯一，event taskContent/完成状态与 Pi 权威来源一致时才可 projected；预算内批次保持 raw，超预算时按最旧批次优先形成保持调用/结果协议外壳的确定性 projected 批次，opaque、协议不完整或来源不匹配内容 fail-closed；
- 来源归档与召回索引以 `MessageSource` 的完整 taskContent、完成状态与两个哈希为准；OpenViking append 对单条派生索引投影限为 32 KiB、单批 JSON 限为 256 KiB，省略时显式保留原始字节数、taskContentHash 和权威来源展开入口，不冒充原文；`fullOutputRef` 在 blob 完整写入后原子发布进同一来源记录，每次请求来源屏障都重验 blob 大小与 SHA-256；权威 entry 明示 locator 的请求在 allow 前完成该来源屏障并精确脱敏，opaque 单元无法发布稳定引用时 fail-closed；
- 归档格式身份不匹配时丢弃该 session 归档目录并从当前 branch 重建，不存在读取其它格式的路径。

自动上下文请求内部只产生 `allow(enhancedContext, proof)`、`refresh-required` 或 `block(fault)`；`refresh-required` 由 Session 协调转换为唯一必要刷新并重算，最终对 Pi 只返回 allow 或 block，block 调用 `ctx.abort()` 且不携带原始 Pi messages。constructed 输出通过一次性 nonce、运行代际、能力 proof ID、完整 request route fingerprint、HistoricalRoute、MemoryCheckpoint、VerifiedActiveDelta、retention budget、完整增强内容哈希和 `openai-completions-payload-v1` 有序消息哈希，在本扩展 `before_provider_request` 时点重新读取 runtime、完整当前路线、检查点、delta 与 Provider profile 后分为 verified/rejected；其中任一身份或 payload 变化均拒绝。未到达则记 unobserved，记录型 Provider 独立分类 transport。未知公开 block、不完整、孤立、重复或错配 ToolBatch 和含不可投影内容的完整批次形成 opaque，当前授权无法无损表示时直接 block。机会性后台刷新失败保留旧 checkpoint+delta，不锁存；必要工作上下文和来源归档故障锁存当前运行代际，同代际不自动恢复，显式新代际才重新验证；用户状态仅为初始化中、增强记忆和故障。

## 4. 当前证据边界

以下 evidence 绑定当前实现与验证规格，`node scripts/check-validation-evidence.mjs` 报告为 `input-current`：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：Provider 基线、完整 ToolBatch、孤立/重复/不完整/opaque 与 summary 边界、来源隔离、branch 过滤、toolResult/Bash locator 脱敏、完整输出原子发布与有界恢复、复制超时单一错误出口和归档格式重建；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：来源索引、当前路线过滤、taskContent 展开和权威核对；
- [`validation/evidence/memory-model-runtime.json`](../validation/evidence/memory-model-runtime.json)：配置与凭据隔离、显式 `MemoryRuntimeProfile` 映射、进程所有权和三态诊断；当前 suite 记忆坐标在真实受管 OpenViking 上完成隔离 Session append、commit、task 终态、来源核验 assembly 与清理，实际 task/usage 绑定 profile、Provider、模型、配置、launch ID 和 child PID；进程退出撤销能力，显式重启以新子进程和 proof 恢复；
- [`validation/evidence/context-enhancement.json`](../validation/evidence/context-enhancement.json)：`allow | refresh-required | block`、checkpoint+delta 直接构造、完全相同 RefreshTarget 共享、同预算线性收敛、慢 accepted refresh 并行、必要等待、机会性刷新失败保留授权、skipped 保留旧 checkpoint+delta、budget shrink、取消、超时、分支/代际/迟到结果隔离、完整 request route 时点拒绝、原子发布和 OpenViking append 字节上限；同时覆盖 opaque 历史阻断、Provider proof、hook/transport 分账、必要来源故障锁存与新代际恢复、overflow 重试及 Pi tree/session/compaction 生命周期，并以隔离本地实际 Pi 回合验证 raw/projected CurrentTurn、来源恢复和最终 Provider 输入有界。

[`validation/evidence/context-quality.json`](../validation/evidence/context-quality.json) 是通过的 actual paired diagnostic：真实受管 OpenViking 和当前记忆模型完成必要 refresh 等待、MemoryCheckpoint 原子发布，以及兼容 checkpoint+delta 在下一次后台 accepted refresh 完成前继续授权；实际 OpenRouter 任务模型采用 hook-verified 增强请求并返回与 native arm 相同的 checker-valid 答案，增强 arm 任务输入显著小于 native arm，记忆模型用量另行归集。该结果证明当前样本的检查点机制、采用、质量和任务输入收缩，不证明完整账单成本优势或复杂长任务可靠性。

现有 evidence 尚未证明：

- `(增强)` footer 语义成立；
- compaction/tree handler 返回、实际宿主结果和兼容性结论由真实 Pi 组合分别证明，已有 summary 文本不污染本扩展记忆；
- 三类真实复杂长任务分别达到 suite policy 的 `eligibleTarget` 且全部完成；
- 包含能力探针、Working Memory、召回、重试和恢复的完整 API 账单成本优势。

统一 checker 同时核对 schema、实现、验证规格、suite 和运行坐标；当前五份 evidence 均应为 `input-current`。受控替身只证明本地控制流与故障边界；actual paired diagnostic 只证明其单一 fixture，不替代复杂长任务或完整账单。

## 5. 当前主导约束

当前主导约束是 **本扩展已能独立维持有界增强上下文，但 compaction/tree 的实际宿主结果与 summary 污染隔离，以及 `(增强)` footer 对任务 Provider 用量、费用和 branch 的显示语义，尚未在同一真实 Pi 组合中闭合**。

MemoryCheckpoint、VerifiedActiveDelta、RefreshTarget、当前回合投影、运行代际和 Provider hook 时点证明已经分别通过受控链路与真实受管 OpenViking；实际配对样本也证明当前增强上下文被任务 Provider 采用并保持答案质量。复杂长任务会反复经历 compaction、tree、fork、clone、resume 和 reload；若宿主或后续扩展仍生成或重新注入 summary，本扩展不能把自己的 handler 返回误报为宿主结果，也不能让 summary 文本进入来源、记忆模型或增强历史。

宿主上下文换代兼容性与 footer 采用共同构成开始三类真实复杂长任务可靠性计数前的交互宿主纵向前置条件：前者保证路线与事实可信，后者保证用户看到的增强身份、任务用量和 branch 状态可核对；完整成本继续后置。

## 6. 当前交付边界

**目标**：在 suite 固定的真实 Pi/扩展组合和当前任务 Provider/模型上，同时闭合 compaction/tree 的实际宿主结果、summary 污染隔离与 `(增强)` footer 采用；各结论可独立复核，且不越权控制宿主或其它扩展。

**需要完成**：

- 真实 Pi 分别触发 manual、threshold、overflow compaction，以及选择/不选择 summary 的 tree 导航；
- 单独记录本 handler 的 `{ cancel: true }`/空 summary 返回、后续 handler 顺序、实际 summary Provider 请求数和新 entry；
- 在既有 compaction/branch summary 与 retained tail 中放入污染哨兵，证明其文本不进入来源归档、OpenViking append/assembly、召回索引或本扩展增强 Provider payload；
- tree 往返、fork、clone、resume 和 reload 后只采用实际当前 leaf，兼容性结论只绑定被测组合；
- 宿主结果与 handler 返回不一致时形成 `host-behavior-unverified` 诊断，不修改 Pi、其它扩展或加载顺序；
- 在交互宿主中观测 footer adapter 的安装、刷新与卸载：保留模型、最近任务 Provider usage、尾部估算、费用和实际 branch，以 `(增强)` 标识本扩展构造；显示不参与预算或授权，不修改持久化 compaction setting，扩展未加载时不声明 footer 行为。

**完成条件**：每种 compaction/tree 事件都能从 handler、transport 和 Pi session entry 三方独立重算，summary 污染计数为零且当前路线任务结果正确；footer 的模型、usage/尾部估算、费用、branch 与 `(增强)` 标识能从实际任务响应和宿主状态复核，安装或显示变化不改变授权、compaction 配置或无扩展基线；所有结论只绑定被测组合。

三类复杂任务可靠性和完整成本实验不进入本次交付；宿主兼容性与 footer 闭环后重新识别下一主导约束。

## 7. 唯一下一执行入口

1. 以 [`system/context-enhancement.md`](system/context-enhancement.md) §9–10 和 [`validation/context-enhancement-state.md`](validation/context-enhancement-state.md) §6–8 为边界，在同一真实 Pi 与当前任务 Provider 组合中建立 compaction/tree handler、summary transport/session、污染哨兵和 footer adapter 的配对观测；同时复核 footer 的模型、usage/尾部估算、费用、branch、`(增强)` 标识及其不参与授权/compaction 的边界，再决定是否进入复杂长任务 suite。
