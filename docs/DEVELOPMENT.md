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
- OpenViking Session append、commit、task polling 和 context assembly；
- 当前 prompt 之前历史的有界增强消息；
- Provider 基线与记忆投影双边界：`pi-session-protocol.ts` 复用 Pi 的 `buildContextEntries`/`sessionEntryToContextMessages`/`convertToLlm` 建立基线，并从结构证据产生 `MessageSource`、`ControlBoundary` 与 `OpaqueProviderSegment`；
- 当前任务 Provider、模型、API、base URL/compat、payload adapter、context window、输出上限、system prompt 和 active tools 形成版本化 `ProviderPayloadProfile`；同一 profile 同时约束增强历史与 CurrentTurn，进入授权证明，并在 hook 对实际 wire 的唯一 system/developer instruction、tools 和输出字段重新核对；
- 当前 user prompt 后的 assistant/tool messages 按 Provider 基线解析为不可拆 `ToolBatch`；call/result ID 在全回合唯一，event taskContent/完成状态与 Pi 权威来源一致时才可 projected；预算内批次保持 raw，超预算时按最旧批次优先形成保持调用/结果协议外壳的确定性 projected 批次，opaque、协议不完整或来源不匹配内容 fail-closed；
- 来源归档、召回索引与 OpenViking append 全部以 `MessageSource` 的 taskContent、完成状态与两个哈希为准；`fullOutputRef` 在 blob 完整写入后原子发布进同一来源记录，每次请求来源屏障都重验 blob 大小与 SHA-256；权威 entry 明示 locator 的请求在 allow 前完成该来源屏障并精确脱敏，opaque 单元无法发布稳定引用时 fail-closed；
- 归档格式身份不匹配时丢弃该 session 归档目录并从当前 branch 重建，不存在读取其它格式的路径。

自动上下文请求只产生 `allow(enhancedContext, proof)` 或 `block(fault)`；block 调用 `ctx.abort()`，不携带原始 Pi messages。constructed 输出通过一次性 nonce、构造时能力 proof ID、完整增强内容哈希和 `openai-completions-payload-v1` 的有序消息哈希在本扩展 `before_provider_request` 时点分为 verified/rejected；handler 重新读取 runtime snapshot，受管进程代际失效或能力 proof ID 变化即拒绝。Provider、模型、API、消息删除或重排同样使证明拒绝；未到达则记 unobserved，记录型 Provider 独立分类 transport。未知公开 block、不完整、孤立、重复或错配 ToolBatch 和含不可投影内容的完整批次形成 opaque，当前授权无法无损表示时直接 block。必要工作上下文和来源归档故障锁存当前运行代际，同代际不自动恢复，显式新代际才重新验证；用户状态仅为初始化中、增强记忆和故障。

## 4. 当前证据边界

以下 evidence 绑定当前实现与验证规格，`node scripts/check-validation-evidence.mjs` 报告为 `input-current`：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：Provider 基线、完整 ToolBatch、孤立/重复/不完整/opaque 与 summary 边界、来源隔离、branch 过滤、toolResult/Bash locator 脱敏、完整输出原子发布与有界恢复、复制超时单一错误出口和归档格式重建；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：来源索引、当前路线过滤、taskContent 展开和权威核对；
- [`validation/evidence/memory-model-runtime.json`](../validation/evidence/memory-model-runtime.json)：配置与凭据隔离、显式 `MemoryRuntimeProfile` 映射、进程所有权和三态诊断；当前 suite 记忆坐标在真实受管 OpenViking 上完成隔离 Session append、commit、task 终态、来源核验 assembly 与清理，实际 task/usage 绑定 profile、Provider、模型、配置、launch ID 和 child PID；进程退出撤销能力，显式重启以新子进程和 proof 恢复；
- [`validation/evidence/context-enhancement.json`](../validation/evidence/context-enhancement.json)：`allow | block`、opaque 历史阻断、block 后扩展停止、完整增强内容与有序 Provider 消息 proof 变更拒绝、wire ProviderPayloadProfile 变更拒绝、hook outcome 分账、记录型 Provider transport 观测、backend/archive 故障同代际锁存与新代际恢复、overflow 重试及 Pi tree/session/compaction 生命周期；隔离的本地实际 Pi 回合覆盖 raw 与 projected 多工具协议、200,000 字节结果、错误、fullOutputPath、来源恢复、前置 handler 内容/profile 改写阻断和最终 Provider 输入有界。

[`validation/evidence/context-quality.json`](../validation/evidence/context-quality.json) 是通过的 actual paired diagnostic：真实受管 OpenViking 完成能力探针与 Working Memory，增强请求在本扩展 hook verified，并由实际 OpenRouter 任务模型返回与 native arm 相同的 checker-valid 答案；增强 arm 的任务输入显著小于 native arm，记忆模型用量另行归集。该结果只证明本样本的采用、质量和任务输入收缩，精确用量以 evidence 为准，不证明完整账单成本优势或复杂长任务可靠性。

现有 evidence 尚未证明：

- 慢速后台 refresh 与任务并行，只有必要 refresh 形成等待；RefreshTarget、MemoryCheckpoint 与 VerifiedActiveDelta 在预算、branch 和迟到结果下保持隔离；
- `(增强)` footer 语义成立；
- compaction/tree handler 返回、实际宿主结果和兼容性结论由真实 Pi 组合分别证明，已有 summary 文本不污染本扩展记忆；
- 三类真实复杂长任务分别达到 suite policy 的 `eligibleTarget` 且全部完成；
- 包含能力探针、Working Memory、召回、重试和恢复的完整 API 账单成本优势。

统一 checker 同时核对 schema、实现、验证规格、suite 和运行坐标；当前五份 evidence 均应为 `input-current`。受控替身只证明本地控制流与故障边界；actual paired diagnostic 只证明其单一 fixture，不替代复杂长任务或完整账单。

## 5. 当前主导约束

当前主导约束是 **跨轮历史仍由 route mirror 的即时 active context 与后台 commit 隐式协调，尚未形成可按路线前缀、预算和运行代际验证的 MemoryCheckpoint、VerifiedActiveDelta 与 RefreshTarget**。

真实初始/重启记忆能力、进程撤销、Provider 时点重验、当前回合协议、增强 hook 和单样本任务质量已经闭合；能力 proof 与受管进程代际共同生效。现有 `OpenVikingSessionMemory` 能按 route prefix 复用 Session、在固定 pending-token 阈值触发 commit，并在任务 pending 或超时时保留来源可核验 active history；这些行为足以支撑当前短 fixture，但不能表达“哪个已完成 Working Memory 覆盖到哪个历史 watermark、其生成预算是什么、后续来源后缀是否完整、迟到结果属于哪个 branch/代际”。

这个缺口直接限制复杂长任务：历史增长、路线切换或任务预算缩小时，系统无法用一个稳定数据结构判断已发布记忆是否仍可采用、是否只需附加 delta、是否必须等待 refresh，因而也无法对后台并行、必要等待和成本归属形成可证伪结论。footer 和完整成本不是当前入口。

## 6. 当前交付边界

**目标**：以最小的 `MemoryCheckpoint + VerifiedActiveDelta + RefreshTarget` 数据边界显式表达跨轮历史覆盖关系，使已发布的兼容检查点可立即参与请求，只有当前请求确实依赖刷新结果时才等待。

**需要完成**：

- Session 记忆协调拥有 RefreshTarget 身份与等待决策；长时记忆拥有检查点内容，工作上下文优化只消费已核验 checkpoint 与 delta；
- checkpoint 绑定 session、精确 HistoricalRoute 前缀/watermark、运行代际、retentionBudgetIdentity、来源集合和 assembly hash；
- checkpoint 之后到当前 prompt 之前的来源形成 VerifiedActiveDelta，不能跨 opaque、branch 或代际；
- 完全相同 RefreshTarget 共享；尚未启动的线性后继可按相同预算收敛，运行中目标不可换绑，迟到结果不能覆盖新路线；
- commit accepted 只有 task completed 且最终 assembly/来源/预算核验成功才原子发布 checkpoint；skipped 保留旧 checkpoint 与 delta，不伪造完成；
- 先用受控时钟/故障覆盖并发、超时、取消、budget shrink 和迟到结果，再用真实受管 OpenViking 证明一条长路线的后台刷新、请求并行与必要等待。

**完成条件**：已有兼容 checkpoint 时慢 refresh 不阻断任务；没有可用 checkpoint 且 delta 无法在当前预算内可信表示时只等待对应共享 refresh；branch、代际、预算或来源不匹配的结果永不进入请求；缓存、pending 和清理均有固定上限。

footer、宿主 summary 兼容性、三类复杂任务和完整成本实验不进入本次交付；checkpoint 纵向闭环后重新识别下一主导约束。

## 7. 唯一下一执行入口

1. 以 [`modules/session-memory-coordination.md`](modules/session-memory-coordination.md) 的 RefreshTarget 和 [`modules/long-term-memory.md`](modules/long-term-memory.md) 的 MemoryCheckpoint 为数据边界，为“已发布的兼容 checkpoint + 当前来源 delta + 后台 accepted refresh”建立最小受控纵向链路；验证请求不等待、refresh 完成后原子晋升、branch 或预算不匹配的结果不得晋升，再接入真实受管 OpenViking。
