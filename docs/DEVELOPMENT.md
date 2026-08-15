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
- `fullOutputPath` 完整工具结果的内容寻址副本；
- OpenViking `vectors_only` 来源索引；
- `recall_session(search|read_source)` 当前路线过滤和 Pi 权威展开；
- 用户记忆模型 JSONC、配置编译、项目启动器所有权和受管重启；
- OpenViking Session append、commit、task polling 和 context assembly；
- 当前 prompt 之前历史的有界增强消息。

当前自动上下文实现仍允许未准备、超时、服务或模型失败时返回原始 Pi messages；尚未建立 Provider 基线/记忆投影双边界，也没有区分本扩展 hook 时点证明与 transport 最终采用。当前回合工具结果、overflow、compaction 和 tree summary 仍沿用现有实现，因此不满足新的责任边界、复杂长任务可靠性和可验证性目标。

## 4. 当前证据边界

以下文件保留上一实现坐标的局部运行结果；新增的规格/suite 绑定已使 checker 正确报告它们为 stale，因此它们只能作为重新验证前的调查基线，不能作为当前稳定结论：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：现有本地来源隔离、恢复和完整结果；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：现有来源索引、当前路线过滤和权威展开；
- [`validation/evidence/memory-model-runtime.json`](../validation/evidence/memory-model-runtime.json)：现有配置转换、进程所有权和重启行为；
- [`validation/evidence/context-enhancement.json`](../validation/evidence/context-enhancement.json)：现有异步准备、路线身份、Provider payload 和 Pi 生命周期行为；
- [`validation/evidence/context-quality.json`](../validation/evidence/context-quality.json)：预置 session、禁用工具、单 prompt、单次原生/增强的固定答案样本；fixture 含有与当前产品目标不一致的要求，不能作为复杂长任务验收。

这些 evidence 尚未证明：

- 本扩展只在实际记忆能力成立时确认增强输出；
- 声明支持的任务与记忆 Provider/模型/API 组合均具有对应 actual 证据；
- 本扩展内部失败能够停止自己的增强输出并形成准确诊断；
- hook verified/rejected/unobserved 与 transport 结果分别证明，不以本扩展日志替代最终事实；
- current turn 多工具与大输出保持有界；
- Provider 基线与 Pi 一致：全-text foreign custom 可投影，mixed/image 整单元 opaque，当前 unknown role drop；thinking/private metadata 不进长期记忆，fullOutputRef 可恢复；
- 慢速后台 refresh 与任务并行，只有必要 refresh 形成等待；RefreshTarget 绑定 generation、路线前缀、watermark 与 retentionBudgetIdentity，检查点/后缀在预算变化、branch 与迟到结果下保持隔离；
- MemoryRuntimeProfile 字段由实际记忆请求采用，ProviderPayloadProfile 预算与 `(增强)` footer 语义成立；
- compaction/tree hook 返回值、实际宿主结果和兼容性结论被分别证明，已有 summary 文本不污染本扩展记忆；
- 三类真实复杂长任务分别达到 suite policy 的 `eligibleTarget` 且全部完成；
- 完整 API 成本优势。

`node scripts/check-validation-evidence.mjs` 现在同时核对 schema、实现、对应验证规格、suite 和运行坐标；在目标实现与 runner 重写并重新生成 evidence 前，它应报告 stale。旧受控替身或固定答案结果不能替代各核心节点的实际纵向验证。

## 5. 当前主导约束

当前主导约束是**当前实现与旧设计都没有把本扩展可证明的事实和宿主最终事实分开**。

现有实现会在增强未准备时返回原始消息，也没有区分 Provider 基线、记忆投影、本扩展 handler 时点与 transport 最终采用。下一实现必须让内部增强构造采用明确 `allow | block`，同时让其它扩展内容和最终采用遵循 Pi 权威边界，只发布准确的时点与外部观测结论。

成本归属不是当前执行入口。可靠完成、事实可信和增强采用证据成立前，不进入成本优势实现。

## 6. 当前交付边界

**目标**：建立本扩展职责内可执行的增强构造边界，并把 Provider 基线、hook 时点证明、transport 最终采用和宿主 compaction/tree 结果分别观测，不越权合并为一个“最终闸门”。

**需要完成**：

- Session 记忆协调拥有 `initializing | ready | faulted | stopping` 运行状态；
- 长时记忆把用户目标匹配到实际验证的 MemoryRuntimeProfile，通过隔离 Session 建立并提前续租有界代际证明；
- 请求授权只返回 `allow` 或 `block`，不返回原始 Pi messages；
- Pi 集成复用 `convertToLlm` 建立 Provider 基线，从结构证据产生 MessageSource、ControlBoundary 与 OpaqueProviderSegment；text/image/foreign custom 不按正文或黑名单猜测；
- 长时记忆发布绑定路线前缀的 MemoryCheckpoint，Session 记忆协调形成 VerifiedActiveDelta，并仅为缺少可信有界历史的请求等待必要 refresh；
- 工作上下文优化使用 ProviderPayloadProfile 统一预算历史、CurrentTurn、system、tools、输出和传输余量；Pi 集成以 `(增强)` footer 展示任务上下文用量；
- `context` 在 initializing 时加入能力屏障，在 ready 时执行授权，并在失败时使用 `ctx.abort()`；
- `before_provider_request` 将 constructed 输出分为 verified/rejected，未到达记 unobserved；不声称控制后续 transport；
- `session_before_compact` 和 `session_before_tree` 只返回本扩展处理意见，并把 handler 返回、实际请求/entry 结果与兼容性结论分别记录；
- 用户状态收敛为初始化、增强记忆和故障；
- 本地 runner 证明 block 后本扩展未继续构造/确认，并独立观测 transport；
- 慢 refresh 不影响兼容检查点+后缀构造；必要 refresh 后重新构造并分别记录 hook/transport 结果；
- 诊断只说明本扩展责任阶段和宿主兼容性事实，不自动禁用、重排或修改其它组件。

**完成条件**：[`validation/README.md`](validation/README.md) §6 的责任边界指标全部成立，且本节目标的实际运行 evidence 可复核。

特定验证 manifest 可以要求 transport 最终采用增强 payload、compaction 取消和无摘要 tree 实际成立；这些是该 Pi/扩展组合的兼容性证据，不是本扩展对任意宿主或其它扩展的控制权。

故障诊断准确、当前 Pi session 不变；只有用户选择重新验证时创建新代际，且不自动重放 prompt。

## 7. 唯一下一执行入口

1. 只实现并验证当前主导约束：在 `pi-session-protocol.ts` 建立当前 suite 所选 PiProtocolProfile 的 Provider 基线、全-text MessageSource、无文本 ControlBoundary 与整单元 OpaqueProviderSegment；在最小协调契约中返回本扩展 allow/block，并让 runner 覆盖 text/image/mixed、unknown-role drop、foreign custom、thinking/private metadata、locator，以及 hook verified/rejected/unobserved 与独立 transport 结果。该闭环通过后重新调查下一主导约束，不在本入口并行推进 profile、checkpoint、footer、summary 或成本实验。
