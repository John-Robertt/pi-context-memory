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
- 来源归档、召回索引与 OpenViking append 全部以 `MessageSource` 的 taskContent、完成状态与两个哈希为准；`fullOutputRef` 在 blob 完整写入后原子发布进同一来源记录，每次请求来源屏障都重验 blob 大小与 SHA-256；权威 entry 明示 locator 的请求在 allow 前完成该来源屏障并精确脱敏，opaque 单元无法发布稳定引用时 fail-closed；
- 归档格式身份不匹配时丢弃该 session 归档目录并从当前 branch 重建，不存在读取其它格式的路径。

自动上下文请求只产生 `allow(enhancedContext, proof)` 或 `block(fault)`；block 调用 `ctx.abort()`，不携带原始 Pi messages。constructed 输出通过一次性 nonce、完整增强内容哈希和 `openai-completions-payload-v1` 的有序消息哈希在本扩展 `before_provider_request` 时点分为 verified/rejected，Provider、模型、API、消息删除或重排均使证明拒绝；未到达则记 unobserved，记录型 Provider 独立分类 transport。未知公开 block、不完整、孤立、重复或错配 ToolBatch 和含不可投影内容的完整批次形成 opaque，当前授权无法无损表示时直接 block。必要工作上下文和来源归档故障锁存当前运行代际，同代际不自动恢复，显式新代际才重新验证；用户状态仅为初始化中、增强记忆和故障。

## 4. 当前证据边界

以下 evidence 已按当前实现与验证规格重新生成，`node scripts/check-validation-evidence.mjs` 报告为 `input-current`：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：Provider 基线、完整 ToolBatch、孤立/重复/不完整/opaque 与 summary 边界、来源隔离、branch 过滤、toolResult/Bash locator 脱敏、完整输出原子发布与有界恢复、复制超时单一错误出口和归档格式重建；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：来源索引、当前路线过滤、taskContent 展开和权威核对；
- [`validation/evidence/memory-model-runtime.json`](../validation/evidence/memory-model-runtime.json)：配置转换、进程所有权、三态词汇、配置与运行实例分离和重启行为；
- [`validation/evidence/context-enhancement.json`](../validation/evidence/context-enhancement.json)：`allow | block`、opaque 历史阻断、block 后扩展停止、完整增强内容与有序 Provider 消息 proof 变更拒绝、hook outcome 分账、记录型 Provider transport 观测、backend/archive 故障同代际锁存与新代际恢复、overflow 重试及 Pi tree/session/compaction 生命周期。

[`validation/evidence/context-quality.json`](../validation/evidence/context-quality.json) 仍为 stale：其预置 session、禁用工具、单 prompt、单次固定答案 fixture 不符合真实复杂长任务目标，不构成当前产品结论。

现有 evidence 尚未证明：

- 声明支持的实际记忆 Provider/模型/API 组合完成能力探针、Working Memory 和请求授权纵向链路；
- current turn 多工具与大输出在 ProviderPayloadProfile 预算内保持协议完整、来源可恢复且输入有界；
- 慢速后台 refresh 与任务并行，只有必要 refresh 形成等待；RefreshTarget、MemoryCheckpoint 与 VerifiedActiveDelta 在预算、branch 和迟到结果下保持隔离；
- ProviderPayloadProfile 预算与 `(增强)` footer 语义成立；
- compaction/tree handler 返回、实际宿主结果和兼容性结论由真实 Pi 组合分别证明，已有 summary 文本不污染本扩展记忆；
- 三类真实复杂长任务分别达到 suite policy 的 `eligibleTarget` 且全部完成；
- 完整 API 成本优势。

统一 checker 同时核对 schema、实现、验证规格、suite 和运行坐标；当前预期结果是上述四份 evidence 为 `input-current`，仅 `context-quality` 为 stale。受控替身只证明本地控制流与故障边界，不替代实际记忆能力、真实任务质量或账单。

## 5. 当前主导约束

当前主导约束是 **current turn 尚未进入统一 Provider 预算**。

请求授权、hook 时点和 transport 观测已经分开并通过本地实际 Pi 生命周期验证；当前限制转移到 `buildEnhancedContext`：它把当前 prompt 后的 assistant/tool messages 原样拼入增强输入。以一个 200,000 字节工具结果实际调用该函数，输入为 200,260 字节，构造结果为 200,576 字节，证明现实现不会治理单回合大输出。该缺口直接限制工具输出压力任务，且比 checkpoint、footer、summary 或成本实验更早决定复杂长任务能否继续。

当前行动必须先让 ProviderPayloadProfile、ToolBatch 原子性、raw/projected 选择和来源屏障形成最小纵向闭环；成本归属仍不是当前执行入口。

## 6. 当前交付边界

**目标**：让当前 prompt 后的 assistant/tool 消息与跨轮增强历史共同服从一个 ProviderPayloadProfile，在保持 Pi Provider 协议、完整 ToolBatch 和可恢复来源的前提下形成有界请求。

**需要完成**：

- Pi 集成从当前任务模型/API、context window、输出设置、system prompt、active tools、framing 和 transport margin 发布版本化 ProviderPayloadProfile；
- 工作上下文优化把 assistant tool calls 与全部对应结果组织为不可拆 ToolBatch，只依据结构、顺序、大小、状态和来源选择 raw 或 projected；
- 预算内且无待发布完整输出的批次保持 Pi Provider 基线；需要 projected 的批次保留调用/结果配对、状态、固定 head/tail、哈希和稳定来源入口；
- `fullOutputPath` 在 fullOutputRef 原子发布前不能获得 allow；含 image/unsupported public block 的单元原样 opaque，预算无法容纳时返回 `opaque-content-unrepresentable`；
- 授权证明绑定 ProviderPayloadProfile、CurrentTurnKey、最终有序消息和内容哈希，hook 只核对本扩展时点，transport 继续独立观测；
- runner 实际驱动 Pi 多工具、快速返回、大输出、错误、截断/fullOutputPath、raw/projected 与来源屏障失败分支，并证明输入有界、协议完整和 block 后停止。

**完成条件**：本地实际 Pi + 记录型 Provider 的 current-turn 控制流指标全部通过；原始和 projected 批次均实际发生，投影省略内容可从当前 session 来源恢复，超预算或来源未就绪只产生本扩展 block，不引入其它请求路径。

MemoryCheckpoint/VerifiedActiveDelta、慢 refresh、footer、summary 宿主兼容性、真实复杂任务和成本实验不进入本次交付；current turn 闭环成立后重新调查下一主导约束。

## 7. 唯一下一执行入口

1. 以 `ProviderPayloadProfile` 和不可拆 `ToolBatch` 为最小数据边界，实现 current turn 的 raw/projected 预算治理与来源屏障；先让一个包含并行调用、200,000 字节结果、错误结果和 fullOutputPath 的真实 Pi 回合在记录型 Provider 中保持有界且协议完整，再覆盖 opaque 超预算与来源失败的 block。只完成本节 current-turn 纵向闭环，不并行推进 checkpoint/refresh、footer、summary、真实复杂任务或成本实验。
