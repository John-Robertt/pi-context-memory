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
- Pi 集成在 manual/threshold/overflow `session_before_compact` 返回 `{ cancel: true }`，在用户选择 summary 的 `session_before_tree` 返回空 summary；实际 entry 与本 handler 请求不一致时只记录 `host-behavior-unverified`，不修改其它 handler；
- 交互 TUI 安装独立 `pi-footer-adapter.ts`，从 Pi 公开 session usage、`getContextUsage()` 与 footer data 显示模型、累计 usage、费用、Git branch 和 `(增强)`，shutdown 时恢复宿主 footer；显示与授权、预算和 compaction 配置隔离；
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
- [`validation/evidence/context-enhancement.json`](../validation/evidence/context-enhancement.json)：`allow | refresh-required | block`、checkpoint+delta、RefreshTarget 并发/预算/迟到隔离、Provider proof、hook/transport 分账、CurrentTurn raw/projected、来源故障与新代恢复；真实 Pi 基准组合中 manual/threshold/overflow 均由本 handler 取消且无 compaction entry，tree 空 summary 无请求/entry，后续受控 handler 恢复 native summary 时形成 `host-behavior-unverified`；真实交互 TUI 完成 footer 安装、任务响应刷新和卸载；权威 fixture 中的三类污染哨兵按记忆投影、受控 OpenViking append 与 assembly 分阶段保持隔离；

[`validation/evidence/context-quality.json`](../validation/evidence/context-quality.json) 是通过的 actual paired diagnostic：真实受管 OpenViking 和当前记忆模型完成必要 refresh、MemoryCheckpoint 发布与后台刷新并行；当前实际任务 Provider/模型采用 hook-verified 增强请求，native/enhanced 返回相同 checker-valid 答案，增强任务输入显著更小。增强 arm 同时在真实 Pi 中证明 manual compaction 取消、tree 空 summary 无请求/entry，且 compaction/branch/retained-tail 污染哨兵未进入任务 Provider payload。该结果只证明当前单一 fixture，不证明复杂长任务可靠性或完整账单成本优势。

现有 evidence 尚未证明：

- 三类真实复杂长任务分别达到 suite policy 的 `eligibleTarget` 且全部完成；
- 包含能力探针、Working Memory、召回、重试和恢复的完整 API 账单成本优势。

统一 checker 同时核对 schema、实现、验证规格、suite 和运行坐标；当前五份 evidence 均应为 `input-current`。受控替身只证明本地控制流与故障边界；actual paired diagnostic 只证明其单一 fixture，不替代复杂长任务或完整账单。

## 5. 当前主导约束

当前主导约束是 **宿主兼容性、污染隔离和增强 footer 的纵向前置条件已经闭合，但复杂长任务仍只有单一配对诊断，尚未形成三类可重复 fixture、独立 checker 和达到 `eligibleTarget` 的实际可靠性证据**。

当前实际样本已经同时覆盖受管 OpenViking、当前任务/记忆 Provider、增强采用、任务质量、manual compaction 取消、tree 无摘要和污染隔离；真实交互 TUI 也闭合 footer 显示。它不能替代多轮工具压力、路线/事实更新和长时间连续任务中的重复运行，内部竞态或路线错误仍可能只在长任务中出现。

复杂长任务可靠性是成本实验的前置条件；完整成本继续后置。

## 6. 当前交付边界

**目标**：以 suite 固定坐标建立并执行三类真实复杂长任务验证，使每类达到 `eligibleTarget`，最终 checker、增强采用、路线/来源和宿主责任边界均可独立复核。

**需要完成**：

- 为 `tool-output-pressure`、`route-and-fact-update` 与 `continuous-long-task` 分别建立版本化初始仓库、用户 turn/操作序列、最终产物和独立 checker；
- resolved run manifest 固定当前 Provider/模型、扩展组合、工具、权限、节奏、期限、`eligibleTarget`、`maxAttempts` 和停止规则；
- 每个 attempt 使用隔离工作区、Pi session、OpenViking 运行代际和证据目录，完整保留 completed/failed/blocked 分类；
- checker 只读取最终工作区、公开产物、Pi 权威 session 和测试结果，协议 checker 独立核对采用、路线、来源、ToolBatch、summary 污染与宿主边界；
- 首个 failed 立即停止对应可靠性结论，不以补跑成功替换失败。

**完成条件**：三类 fixture 各自达到 suite 的 `eligibleTarget`，所有 eligible attempt 的最终 checker 与协议 checker 均通过，`completionReliability == 100%`，且 run manifest、attempt 清单、停止原因和原始 artifact 索引完整。

完整账单成本实验不进入本次交付；可靠性与一般质量成立后重新识别成本归集约束。

## 7. 唯一下一执行入口

1. 以 [`validation/context-enhancement-state.md`](validation/context-enhancement-state.md) §4–5、§7–8 为契约，先完成 `tool-output-pressure` 的版本化 fixture、独立 checker、resolved run manifest 和单次 actual eligible 纵向运行；该模板通过后复用同一运行边界扩展另外两类并执行 suite 计数。
