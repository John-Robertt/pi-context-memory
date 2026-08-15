# 当前开发入口

## 1. 文档角色

本文连接 [`PRODUCT.md`](../PRODUCT.md)、[`ARCHITECTURE.md`](../ARCHITECTURE.md) 与当前实践，只维护可运行状态、有效证据、当前主导约束、交付边界和唯一下一执行入口。

## 2. 当前目标设计

扩展只负责自己的上下文、记忆生命周期和 hook 事实。constructed 输出绑定代际、能力、路线与来源；到达 `before_provider_request` 时只能发布 verified 或 rejected，未到达则记 unobserved。最终 Provider 采用由 transport 观测。

后台记忆刷新、必要等待和队列不形成用户状态。状态栏只展示“增强记忆 · 初始化中”“增强记忆”和“增强记忆 · 故障”。诊断不自动修改 Pi、其它扩展、加载顺序或 Provider/模型；处理方式由用户决定。

Pi 集成先建立 Provider 基线，再按结构/元数据/所有者/协议关系投影；不读正文，不维护 customType allowlist/blacklist。全-text 单元可形成来源；含 image/unsupported public block 的完整 message/ToolBatch opaque 保留；当前未知 role 按 Pi drop；thinking/private metadata 不进长期记忆。

跨轮历史由兼容 MemoryCheckpoint、来源可恢复 VerifiedActiveDelta 和未被检查点覆盖的 OpaqueProviderSegment 组成。后台 refresh 不自动阻塞请求，只有结构化历史无法形成可信有界输入时才等待必要刷新；opaque 内容必须原样保留，预算不足时报告本扩展表示能力边界。

用户配置仍只选择记忆 Provider/模型、凭据和必要连接字段。运行配置匹配带 actual 证据的内部 MemoryRuntimeProfile；任务上下文预算只使用 ProviderPayloadProfile，Pi footer 在交互模式以 `(增强)` 标识任务模型用量而不参与授权。

产品第一验收门槛是真实复杂长任务可靠完成：声明范围内没有独立外部阻塞证据的运行必须全部通过任务 checker。快速、并行和大输出工具结果、内部等待、队列和上下文换代均属于系统责任。

每个核心节点必须具有与其责任匹配的实际运行证据；协议替身只能补充故障和边界覆盖。验证沿用 manifest 中当前任务与记忆 Provider/模型时，必要付费调用已获正常流程授权，不再逐次询问用户；只有改变任务或记忆 Provider/模型时才暂停并请求决定。

## 3. 当前可运行实现

当前验证坐标由 [`../validation/suite.json`](../validation/suite.json) 选择 Pi protocol profile 与任务/记忆模型，由 [`../pyproject.toml`](../pyproject.toml) 和 `uv.lock` 锁定项目私有 OpenViking。以下能力可以运行：

- `config/toolchain.json`、`.python-version` 与依赖锁形成项目内安装链，uv bootstrap 先校验摘要且不创建用户级 Python 入口；
- `validation/suite.json` 是 Pi profile、任务/记忆模型和验证政策的机器入口，runner 实际观测版本；
- `config/openviking-adapter-contract.json` 统一配置桥、TypeScript 校验和适配器 runner 的受审查字段/凭据/schema 契约；
- 扩展与启动器从同一 OpenViking 基础配置解析 endpoint；stable evidence 绑定实现、验证规格、suite 和工具链后，上一代 evidence 已正确失效；
- 持久化 Pi session 当前 branch 的本地来源归档；
- `toolResult.details.fullOutputPath` 与 `BashExecutionMessage.fullOutputPath` 经权威 entry 提取、locator 脱敏后的内容寻址副本；
- OpenViking `vectors_only` 来源索引；
- `recall_session(search|read_source)` 当前路线过滤、Pi 权威 taskContent 展开，以及同来源 `fullOutputRef` 的完整性核验和有界正文读取；
- 用户记忆模型 JSONC、配置编译、项目启动器所有权和受管重启；
- OpenViking Session append、commit、task polling 和 context assembly；
- 当前 prompt 之前历史的有界增强消息；
- Provider 基线与记忆投影双边界：`pi-session-protocol.ts` 复用 Pi 的 `buildContextEntries`/`sessionEntryToContextMessages`/`convertToLlm` 建立基线，并从结构证据产生 `MessageSource`、`ControlBoundary` 与 `OpaqueProviderSegment`；
- 当前任务 Provider、模型、API、base URL/compat、payload adapter、context window、输出上限、system prompt 和 active tools 形成版本化 `ProviderPayloadProfile`；同一 profile 同时约束增强历史与 CurrentTurn，进入授权证明，并在 hook 对实际 wire system/tools/output 字段重新核对；
- 当前 user prompt 后的 assistant/tool messages 按 Provider 基线解析为不可拆 `ToolBatch`；call/result ID 在全回合唯一，event taskContent/完成状态与 Pi 权威来源一致时才可 projected；预算内批次保持 raw，超预算时按最旧批次优先形成保持调用/结果协议外壳的确定性 projected 批次，opaque、协议不完整或来源不匹配内容 fail-closed；
- 来源归档、召回索引与 OpenViking append 全部以 `MessageSource` 的 taskContent、完成状态与两个哈希为准；`fullOutputRef` 在 blob 完整写入后原子发布进同一来源记录，每次请求来源屏障都重验 blob 大小与 SHA-256；权威 entry 明示 locator 的请求在 allow 前完成该来源屏障并精确脱敏，opaque 单元无法发布稳定引用时 fail-closed；
- 归档格式身份不匹配时丢弃该 session 归档目录并从当前 branch 重建，不存在读取其它格式的路径。

自动上下文请求只产生 `allow(enhancedContext, proof)` 或 `block(fault)`；block 调用 `ctx.abort()`，不携带原始 Pi messages。constructed 输出通过一次性 nonce、完整增强内容哈希和 `openai-completions-payload-v1` 的有序消息哈希在本扩展 `before_provider_request` 时点分为 verified/rejected，Provider、模型、API、消息删除或重排均使证明拒绝；未到达则记 unobserved，记录型 Provider 独立分类 transport。未知公开 block、不完整、孤立、重复或错配 ToolBatch 和含不可投影内容的完整批次形成 opaque，当前授权无法无损表示时直接 block。必要工作上下文和来源归档故障锁存当前运行代际，同代际不自动恢复，显式新代际才重新验证；用户状态仅为初始化中、增强记忆和故障。

## 4. 当前证据边界

以下 evidence 已按当前实现与验证规格重新生成，`node scripts/check-validation-evidence.mjs` 报告为 `input-current`：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：Provider 基线、完整 ToolBatch、孤立/重复/不完整/opaque 与 summary 边界、来源隔离、branch 过滤、toolResult/Bash locator 脱敏、完整输出原子发布与有界恢复、复制超时单一错误出口和归档格式重建；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：来源索引、当前路线过滤、taskContent 展开和权威核对；
- [`validation/evidence/memory-model-runtime.json`](../validation/evidence/memory-model-runtime.json)：配置转换、进程所有权、三态词汇、配置与运行实例分离和重启行为；
- [`validation/evidence/context-enhancement.json`](../validation/evidence/context-enhancement.json)：`allow | block`、opaque 历史阻断、block 后扩展停止、完整增强内容与有序 Provider 消息 proof 变更拒绝、wire ProviderPayloadProfile 变更拒绝、hook outcome 分账、记录型 Provider transport 观测、backend/archive 故障同代际锁存与新代际恢复、overflow 重试及 Pi tree/session/compaction 生命周期；隔离的本地实际 Pi 回合覆盖 raw 与 projected 多工具协议、200,000 字节结果、错误、fullOutputPath、来源恢复、前置 handler 内容/profile 改写阻断和最终 Provider 输入有界。

[`validation/evidence/context-quality.json`](../validation/evidence/context-quality.json) 仍为 stale：其预置 session、禁用工具、单 prompt、单次固定答案 fixture 不符合真实复杂长任务目标，不构成当前产品结论。

现有 evidence 尚未证明：

- 声明支持的实际记忆 Provider/模型/API 组合完成能力探针、Working Memory 和请求授权纵向链路；
- 慢速后台 refresh 与任务并行，只有必要 refresh 形成等待；RefreshTarget、MemoryCheckpoint 与 VerifiedActiveDelta 在预算、branch 和迟到结果下保持隔离；
- `(增强)` footer 语义成立；任务 ProviderPayloadProfile 的真实 API 适配仍需对应实际 Provider 证据；
- compaction/tree handler 返回、实际宿主结果和兼容性结论由真实 Pi 组合分别证明，已有 summary 文本不污染本扩展记忆；
- 三类真实复杂长任务分别达到 suite policy 的 `eligibleTarget` 且全部完成；
- 完整 API 成本优势。

统一 checker 同时核对 schema、实现、验证规格、suite 和运行坐标；当前预期结果是上述四份 evidence 为 `input-current`，仅 `context-quality` 为 stale。受控替身只证明本地控制流与故障边界，不替代实际记忆能力、真实任务质量或账单。

## 5. 当前主导约束

当前主导约束是 **运行时只凭启动器 service readiness 建立工作上下文代际，尚未证明实际记忆 Provider/模型具备生产所需能力**。

CurrentTurn 已进入统一 ProviderPayloadProfile 预算，并由本地实际 Pi 回合证明 raw/projected 多工具协议、200,000 字节结果、来源恢复和 transport 采用。当前 `runtimeWorkingContextGeneration` 仍只检查启动器 `ready`、child PID 与 active Provider/model，再以 launch ID 和 PID 建立代际；这些事实不能区分“OpenViking 服务可连接”与“配置的记忆模型能够完成受约束的 Working Memory、任务轮询和来源核验 assembly”。受控 runtime evidence 也只证明配置和进程边界，不能把该组合纳入 actual 支持范围。

这个缺口位于所有 checkpoint、慢 refresh、复杂长任务和成本结论之前：没有绑定进程、配置、MemoryRuntimeProfile 与真实响应的能力证明，请求授权可能建立在不可用或不符合 profile 的记忆运行时上。当前行动必须先建立实际能力探针和有界租约；成本归属仍不是当前执行入口。

## 6. 当前交付边界

**目标**：只有当前受管 OpenViking 子进程上的实际记忆 Provider/模型完成生产同协议能力探针后，才发布可供工作上下文使用的运行代际。

**需要完成**：

- 为 suite 已选定的精确记忆 Provider、模型和 API 定义内部版本化 `MemoryRuntimeProfile`，把每个运行字段映射到最终请求或客户端策略，不允许用户任意透传或备用 Provider/model；
- 启动按“预检—受管进程 ready—隔离 Session 能力探针—发布能力证明”完成；探针使用生产 Session append/commit/task polling/context assembly 契约并核对来源；
- 能力证明绑定 launch ID、child PID、配置指纹、Provider、模型、API、MemoryRuntimeProfile、adapter、探针版本、真实响应/usage 和 `validUntil`；只有当前有效证明才能形成工作上下文代际；
- accepted 业务 refresh 完整成功可以续租；进入 renewal lead 后共享后台续租，过期或失败准确锁存故障，不以 health/model 对象存在代替能力；
- runner 在真实受管 OpenViking 上证明 profile 字段实际生效、没有 fallback、成功/失败/过期/显式新代际恢复边界，并保存 actual artifact。

**完成条件**：当前 suite 记忆坐标在真实受管 OpenViking 上完成能力探针并发布可追溯租约；工作上下文代际只接受匹配且未过期的证明，配置、进程、profile、Provider/model/API 或探针版本变化均使旧证明失效；失败不 fallback，显式新代际可恢复。

MemoryCheckpoint/VerifiedActiveDelta 的增量策略、慢 refresh 并行、footer、summary 宿主兼容性、真实复杂任务和成本实验不进入本次交付；能力门成立后重新调查下一主导约束。

## 7. 唯一下一执行入口

1. 以 [`system/memory-model-runtime.md`](system/memory-model-runtime.md) 的 `MemoryRuntimeProfile` 和能力证明为唯一数据边界，先让 suite 当前记忆 Provider/模型/API 在真实受管 OpenViking 隔离 Session 中完成 append、commit、task polling、来源核验 assembly 和租约发布；再让扩展只凭匹配的当前能力证明建立工作上下文代际，并覆盖失败、过期、配置/进程变化与显式新代际恢复。只完成实际能力门纵向闭环，不并行推进 checkpoint/refresh、footer、summary、复杂任务或成本实验。
