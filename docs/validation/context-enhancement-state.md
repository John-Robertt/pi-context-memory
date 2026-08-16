# 增强记忆可靠性与责任边界验证

## 1. 验证责任

本文定义如何证明 [`../features/context-enhancement-state.md`](../features/context-enhancement-state.md) 和 [`../system/context-enhancement.md`](../system/context-enhancement.md) 中的复杂长任务可靠完成、Pi Provider 基线与记忆投影正确、当前回合有界、增强输出时点证明准确、transport 采用可观测，以及 compaction/tree hook 结果不被越权表述。

稳定 evidence 只保存当前目标所需的脱敏结论、运行清单、实现绑定和最小证据索引。原始 session、Provider payload、服务日志和任务产物保存在 Git 忽略的 `.artifacts/`。

## 2. 成功顺序

验证按以下顺序判定：

1. 复杂长任务完成可靠性；
2. 目标、约束、事实、来源和路线质量；
3. 本扩展构造、hook 时点证明与 transport 采用事实一致；
4. compaction/tree handler 返回值与实际宿主结果分别归因；
5. 本扩展故障、诊断和恢复边界；
6. 完整 API 成本。

前一项不成立时，不形成后一项产品结论。

## 3. 运行分类与可靠性

运行分类、blocked 边界、eligible 和 `completionReliability == 100%` 统一引用 [`README.md`](README.md) §5。本规格补充要求：memory-precondition 同时保存本扩展 block/abort、故障区间与 transport 实际请求数；task-provider 保存合法 proof 和独立失败响应。无法独立归因的事件不记 blocked；外部错误恢复后仍按最终 checker 归类，重试计入成本。

## 4. 代表性复杂长任务

真实任务集至少包含三个具有不同主要压力的 fixture，每个 fixture 同时保留统一的任务连续性要求。

### 4.1 工具输出压力任务

- 单个 assistant 消息发起多个并行工具调用；
- 工具以接近零间隔返回；
- 混合小/大/截断/fullOutputPath/error/负向哨兵；验证投影只按结构状态、固定 head/tail、哈希和 fullOutputRef 生成，本机路径不进 payload；
- 后续模型必须依据投影继续修改、验证并完成确定产物；
- checker 核对关键证据来自正确工具与来源。

### 4.2 路线与事实更新任务

- 共同前缀后产生冲突 branch；
- 用户更新目标、约束和决定；
- 执行 tree 往返、fork、clone、resume 和 reload；
- 包含已有 compaction、branch summary 与 retained tail，并在两个 summary 文本中放入污染哨兵；
- 同时执行用户选择 summary 和不选择 summary 的 tree 导航，前者也必须无摘要完成；
- VLM task、assembly 和任务 Provider payload 均不得出现 summary 污染哨兵；
- checker 要求只采用当前路线并排除废弃决定；
- 最终仓库产物和测试必须体现当前决定，而不是只输出路线标签。

### 4.3 长时间连续任务

- 多轮调查、实现、测试失败和修正；
- 多次 Working Memory commit 和 context assembly；
- 慢速但健康的记忆模型任务与连续 Pi turn 重叠；
- 多次召回早期来源；
- current turn 与跨轮历史多次接近预算；
- checker 核对最终产物、当前状态和必要证据。

每个 fixture 必须定义用户目标、硬约束、禁止条件、来源事实、最终产物和独立 checker。任务不能只要求模型复述预置答案；至少需要形成由测试或结构化检查可确定验证的仓库产物。

### 4.4 Fixture 与 checker 契约

每个 fixture 使用版本化 manifest，至少固定：

- `id`、主要压力类型和 fixture 内容哈希；
- 初始仓库或工作区快照及其哈希；
- 初始 Pi session、当前 leaf、branch 与已有 compaction/branch summary 输入；
- 依次提交的用户 turn、允许的 tree/session 操作和输入节奏；
- 可用工具、权限、环境变量名称和网络边界；
- 实际加载的扩展路径、顺序与 `extensionCompositionFingerprint`，以及 manifest 是否要求 transport adopted、compaction cancel 或无摘要 tree；
- 必须形成的文件、行为、事实、来源和禁止结果；
- 必须观察到的协议覆盖，例如并行 ToolBatch、投影、路线换代或召回；
- checker 命令、checker 版本和输出 schema；
- 单操作期限、整次运行期限、eligible 目标数与最大 attempt 数。

每个 attempt 使用独立工作区、Pi session、受管 OpenViking 运行代际与业务 Session、观察日志和 run ID，不复用能力证明、MemoryCheckpoint、refresh、VerifiedActiveDelta、请求 proof 或其它派生任务状态。

任务 checker 在 Agent settled 后以独立进程运行，只读取 fixture 声明的最终工作区、公开任务产物、Pi 权威 session 与测试结果。它不能读取 Working Memory、路线缓存、请求授权或扩展自报状态来决定任务成功，并返回：

```text
{ passed, checks, artifactHashes, sourceAssertions, error? }
```

增强采用、责任边界、故障归因、协议覆盖和成本由 runner 的协议 checker 另行判断；任务成功不能掩盖 transport 变化、Provider 基线违规、来源错误或账单缺失。manifest 要求的覆盖未发生时，attempt 因证据不完整记为 failed。

## 5. 重复与样本完整性

本地协议和并发压力 runner 对每类时序执行 suite policy 的 `deterministicTimingSamples` 个确定性或种子可复现样本。

真实任务模型与真实记忆模型验证中，每个复杂长任务 fixture 必须达到 suite policy 的 `eligibleTarget`。runner 按预声明顺序执行 attempt，直到达到 eligible 目标、发生使 100% 结论已被推翻的 failed，或达到 `maxAttempts`；当前数值只在 [`../../validation/suite.json`](../../validation/suite.json) 维护。

blocked attempt 不占 eligible 名额；样本不足为 inconclusive。ValidationCoordinates 固定 Provider/模型/API、Pi/OpenViking、extensionCompositionFingerprint 与 handler 顺序、MemoryRuntimeProfile/adapter、凭据、tools、fixture、节奏、期限和停止规则。Provider/模型或 profile 变化停止 suite；扩展组合变化使当前兼容性坐标失效并要求新运行，但不授权本扩展调整顺序。

run manifest、每个已执行 attempt 和停止原因都进入 evidence：

- 提前失败时记录未执行数量和 `stoppedBy: first-failed`，不声称完成预声明样本；

- 不删除失败运行；
- 不因模型输出不理想重新分类；
- interrupted 运行只有独立外部阻塞证据时才可标记 blocked；
- 重试作为原运行的一部分归集，不生成替代成功样本。

## 6. 本地控制流验证

本地 runner 使用协议兼容 OpenViking、记忆模型和任务 Provider 替身，不访问外部 Provider。它必须实际驱动 Pi 生命周期并验证下列受控分支，但不能据此证明实际记忆能力、真实 Provider 采用、复杂任务完成或产品 suite 通过：

- 初始化 prompt 等待能力屏障，ready 后本扩展构造 allow；hook 与 transport 结果另行记录；
- 初始化前取消不锁存服务故障，本扩展不继续构造；
- 无权威 session file 时本扩展返回 block/abort；上述两类 transport 都记 observed-zero | observed-nonzero | unobserved，不由内部状态推断；
- 首轮空历史仍携带合法增强证明；
- Provider 基线矩阵覆盖 user/assistant/toolResult、text/image/mixed、bash exclusion、thinking/private metadata、fullOutputPath、任意 customType、当前未知 role 和未来 Pi 可见 block：逐项对齐 `convertToLlm`/探针；当前未知 role drop，全-text 单元可投影，含 image/unsupported public block 的完整 message/ToolBatch 只形成 opaque；
- OpaqueProviderSegment 在预算内原样到达本扩展 hook；检查点不跨越它，预算不足时只产生 `opaque-content-unrepresentable` 和用户诊断，不把 foreign 内容判为非法或自动改变其它扩展；
- 多段工具循环中的中间 `turn_end` 只归档已最终化来源且不产生 commit；`agent_settled` 后至多形成符合 RefreshTarget 合并规则的刷新；
- `context` 选择 coveredRoutePrefixKey 仍为当前路线精确前缀的 MemoryCheckpoint，并形成来源完整的 VerifiedActiveDelta；
- refresh pending/running 时，兼容 checkpoint+delta 可入预算则本扩展立即构造 allow；hook/transport 结果分别记录；
- 缺少兼容检查点、旧检查点过大或 delta 需覆盖时，本扩展在精确 RefreshTarget 完成前不发布 allow；完成后按当前路线重算。`ctx.abort()`/等待结果与 transport 实际请求分别记录；
- 机会性 skipped 保留既有检查点与 delta，不发布检查点、不改变运行能力 proof；`refresh-required` 携带显式 retention 边界却返回 skipped 时一次性进入协议/策略故障，不重复提交；
- 完整 RefreshTarget 相同才共享；未启动线性后继只在 retentionBudgetIdentity 相同时合并，运行任务保持目标，新 entry 留在 delta，分叉与迟到结果不能污染；
- 刷新显著慢于相邻请求时，可用历史继续；必要刷新失败只使本扩展不确认依赖输出，transport 是否仍有其它请求由外部观测分类；
- 后台刷新、必要等待和队列期间用户状态保持“增强记忆”。
- 多工具批次完整匹配，raw 和 projected payload 均符合 Provider 协议；
- 未持久化、未截断且预算内的实际 ToolBatch 可以 raw 保留；含 FullOutputCandidate 的内容在 fullOutputRef 发布前不获得本扩展 allow；
- projected ToolBatch 等待权威 entry 与来源屏障，失败时本扩展返回 block 诊断；
- ProviderPayloadProfile 预算覆盖上下文窗口、system prompt、tool schema、framing、transport margin、current turn 和实际输出上限；改变模型、API、system 或 tools 始终使旧请求 profile 失效，并只在历史可用空间或 estimator 变化时改变 retentionBudgetIdentity；
- 必要 refresh pending 时缩小任务历史预算，旧 RefreshTarget 不直接完成新请求；旧结果只作为候选 checkpoint 由新预算重算：过大时创建新 retentionBudgetIdentity 目标，新目标检查点可容纳时发送，当前身份的最小合法检查点仍超限时一次性 `context-budget`，不重复刷新；
- Pi footer 显示最近任务 Provider usage/尾部估算并以 `(增强)` 标识，保留模型、累计 usage、费用与 branch；显示值和记忆模型窗口不影响授权，扩展不修改持久化 compaction setting；
- 相同输入形成相同上下文哈希；
- session、session file、实际 leaf、HistoricalRouteKey、CurrentTurnKey、MemoryCheckpoint identity、VerifiedActiveDelta hash、ProviderPayloadProfile、规范化内容和运行代际形成唯一采用身份；
- 分支、迟到结果、替换 session 和 reload 保持隔离；
- 每个候选任务 Provider API 的 PayloadProofAdapter 先以 controlled payload 核对 raw 与 projected 序列化结果；只有另有 actual Provider 证据的 API 才标记受支持；
- model_select 清除 pending 证明和预算缓存，下一请求绑定新模型；
- 本 handler 可见 malformed payload 记 hookRejected；constructed 输出因更早 handler/取消而未到达本 handler 时记 hookUnobserved，二者 transport 结果都另行保存；
- 本 handler 前的 payload/proof 修改记 hookRejected；本 handler 后修改不改变 verified 时点事实，但 transport 哈希不一致且 false claim 为零；
- 用户文本不能伪造增强证明；nonce 只能在本 handler 时点消费一次；
- foreign customType 按 Pi Provider 基线处理，无需额外注册；其它扩展及其 handler 顺序保持不变；
- compaction/tree handler 的返回值、调用顺序、实际 summary Provider 请求和新 entry 分别记录；
- suite 所选且已通过探针的 `PiProtocolProfile` 基准组合中，返回 `{ cancel: true }` 或空 summary 后实际结果符合探针；后加载受控 handler 改变结果时记录 `host-behavior-unverified`，不归因为本扩展控制失败，也不自动处理其它 handler；
- 未通过行为探针的宿主不被声明为已抑制 summary，扩展只给出兼容性诊断；
- 已有 compaction/branch summary 污染哨兵不进入 VLM 或任务 Provider payload；
- shutdown 清理有界且不污染后续 session。

## 7. 真实 Provider 请求与任务质量

真实 runner 从 manifest 读取并固定当前已配置的任务 Provider/模型、记忆 Provider/模型和受管 OpenViking；坐标不变时直接执行必要的付费调用，不逐次申请授权。

在复杂 fixture 计数前，实际纵向检查点必须全部通过：

- 真实记忆 Provider/模型按固定 MemoryRuntimeProfile 完成能力探针、accepted refresh、轮询、来源核验 assembly 和 MemoryCheckpoint 发布，最终请求记录证明 profile 字段实际生效且无 Provider/model fallback；
- 真实受管 OpenViking 完成来源写入、实际索引、检索和当前 Pi message 展开；
- 真实 Pi 首轮、checkpoint+delta、必要 refresh 与 CurrentTurn 循环均有独立 `transportAdopted` 和后续行动证据；慢 refresh 重叠时，不依赖该 refresh 的 turn 仍完成；
- 实际大工具输出至少各触发一次 raw 与 projected 路径，后续任务模型依据投影和来源正确完成检查；
- OpenViking 中断、能力 proof/进程身份失效和用户修复分别记录本扩展 block/新代际行为与 transport 实际请求数；空闲期记忆 Provider 请求数保持为零；不从内部状态推断零请求；
- 真实 Pi session 的 text/image/mixed、user/assistant/tool/bash/custom 与 Pi 基线一致；foreign custom text 不因 customType 丢失，mixed/image 整单元 opaque，当前未知 role 按 Pi drop；thinking 等 raw 协议按 Pi 保留但不进长期记忆，private metadata/locator 不泄漏；
- fullOutputRef 在临时文件删除后仍可恢复；image/未来 Pi 可见 opaque 预算内原样保留，超预算只形成本扩展能力诊断；
- compaction/tree handler 返回、实际宿主结果、增强 footer 与 summary 污染隔离分别由真实 Pi session 证明。

任一检查点只有替身证据或没有实际发生时，真实 suite 为 failed/inconclusive，不能开始可靠性计数。真实 runner 同时采集：

- Pi session 与最终任务产物；
- 任务 checker 结果；
- OpenViking 进程和实际模型能力状态；
- 每个 `context` 授权、请求证明和 Provider 接收事件；
- 工具调用、结果、来源屏障和投影统计；
- MemoryCheckpoint、VerifiedActiveDelta、refresh task 目标/终态、assembly 和 profile 采用；
- compaction 与 tree summary 的 Provider 请求及新 entry 计数；
- 任务模型和记忆模型 usage；
- 用户介入、重试、阻断和结束原因。

每个 eligible 运行必须满足：

- 最终 checker 通过；
- 无用户手工重试、记忆整理或目标重述；
- 无内部死锁、无界等待或悬挂后台任务；
- 后台 refresh pending 时兼容检查点与 delta 继续推进，只有必要 refresh 形成等待；
- 工具调用和结果无丢失、错序或跨批次污染；
- 当前目标、约束、事实和来源保持正确；
- constructed 输出完整分入 hook verified/rejected/unobserved；verified 的 transport 再分 adopted/changed/unobserved，且无虚假采用声明；
- 没有本扩展内部失败被记为增强成功；OpaqueProviderSegment 只按 Pi 基线保留；
- manifest 若声明当前 Pi/扩展组合支持 compaction/tree 抑制，则实际 summary 请求和新 entry 符合声明；不符合时该兼容性声明失败，但扩展不修改其它组件；
- 已有 summary 文本未进入本扩展 VLM、来源或增强历史。

## 8. 责任边界与增强采用判定

每个运行按 [`README.md`](README.md) §6 的权威指标核对构造、hook、transport、Provider 基线、记忆投影、跨组件修改、block 和 summary 污染。

evidence 保存 transport 最终哈希或不可观测原因，使验证总则 §6 的分类可由外部 artifact 重算；changed/unobserved 不得宣称为最终增强采用。

manifest 可以把 `changedAfterHook == 0`、`transportUnobserved == 0`、native summary 请求或新 entry 为零设为某个明确 Pi/扩展组合的兼容性通过条件。该结果只描述被测组合，不形成对任意 Pi 或其它扩展的行为要求。

增强时点证明仍关联 run/request、Provider/模型/API、session/leaf、HistoricalRouteKey、CurrentTurnKey、MemoryCheckpoint、VerifiedActiveDelta、OpaqueProviderSegment、运行代际、构造时能力 proof ID、hook 时点 runtime snapshot、system/tools、消息哈希、ProviderPayloadProfile/PayloadProofAdapter 和 nonce；稳定 evidence 只保存非敏感身份、哈希与计数。

## 9. 故障与恢复矩阵

分别注入：

- 配置语法、schema、必要字段和凭据错误；
- Launcher 缺失、所有权冲突和子进程退出；
- service readiness 失败；
- 记忆模型实际能力探针失败；
- Session create、append、commit、task 和 context 错误；
- 来源归档、完整输出复制和哈希错误；
- checkpoint 前缀不兼容、必要 refresh profile 超时、后端取消、分支切换和迟到结果；
- 用户主动取消等待但运行代际仍然健康；
- ToolBatch 不完整、OpaqueProviderSegment 超预算和普通 context-budget；
- `context` 决定后、Provider hook 前使受管子进程身份失效、runtime 能力撤销、能力 proof ID 改变或 payload proof 被修改；handler 之后的变化按 §8 记为 transport 兼容性观测，不作为本扩展故障注入。

用户取消只要求本扩展释放等待者且不发布 allow；`ctx.abort()` 与 transport 实际结果分别记录，不锁存服务故障。

每个故障场景必须证明：

1. 本扩展不发布 allow，调用 `ctx.abort()`；transport 记录实际结果，不能由内部状态推断；
2. 状态为“增强记忆 · 故障”；
3. 诊断错误码和责任阶段准确；
4. 当前 Pi session、branch 和来源保持不变；
5. 系统不自动重放 prompt 或工具；
6. 显式修复创建新代际；
7. 新代际只从当前 branch 重建；
8. 用户重新提交后使用增强路径完成任务。

## 10. 禁用扩展边界

独立运行只核对禁用边界：

- 新进程未加载本扩展的 handler、状态或增强消息；
- 禁用动作不删除用户记忆配置、本地来源或 OpenViking 数据；
- 该选择不是增强进程内的请求级切换；
- session、tree、工具和 compaction 的后续行为仅记录为 Pi 观测，不作为本扩展兼容性声明。

## 11. 成本门槛

只有以下条件全部成立后，运行才能进入成本实验：

- 全部预声明 eligible 增强运行完成；
- 任务质量与路线 checker 全部通过；
- 增强构造、hook 时点和 transport 采用证据完整，且没有虚假最终采用声明；
- blocked 归因完整；
- 所有任务与记忆 generation 可归属。

成本实验方法见 [`README.md`](README.md) 和 [`../modules/quality-and-cost-observation.md`](../modules/quality-and-cost-observation.md)。

## 12. 执行入口与 evidence

统一入口为：

```bash
node scripts/validate-context-enhancement.mjs
node scripts/validate-context-quality.mjs
node scripts/check-validation-evidence.mjs
```

稳定 evidence 至少保存：

- schema、suite ID、run manifest 哈希和验证规格哈希；
- `ValidationCoordinates`：Pi、OpenViking、任务/记忆 Provider/模型/API、extensionCompositionFingerprint 与 handler 顺序、MemoryRuntimeProfile/adapter、task thinking、工具和凭据引用指纹；
- 每个核心检查点的 `evidenceLevel: actual | controlled`、实际运行 ID 和原始 artifact 索引；
- 实际 Provider 的脱敏响应 ID、usage、generation 责任与账单索引；
- fixture、初始工作区和 checker 的路径、版本与哈希；
- 每个 attempt 的 ID、分类、开始结束时间、停止原因和 artifact 索引；
- task checker 的逐项结果与最终产物哈希；
- 独立外部服务事件和 blocked 归因；
- constructed、hookVerified/hookRejected/hookUnobserved、verified transport 分区、其它 transport 结果、falseClaim 和 extensionContinuedAfterBlock 计数；
- compaction/tree handler 返回与实际 summary 请求/entry 结果、Provider 基线/记忆投影违规、跨组件修改、summary 污染、MemoryCheckpoint/refresh/profile 和 API generation 归属；
- eligible、completed、failed、blocked、inconclusive 和可靠性聚合；
- 实现文件清单、哈希与最终 `passed`。

完整 session、payload、工具输出、服务日志、账单明细和工作区保存在对应 attempt 的 `.artifacts/` 目录。稳定 evidence 只保存哈希、计数、脱敏错误和相对索引。

runner 和 stable evidence 必须随实现更新后才能证明本文目标。`passed` 只有在核心检查点具有 actual 证据、任务 checker 通过、责任边界与采用结论准确、外部阻塞证据闭合且实现/规格哈希一致时为 true；某个 Pi/扩展组合的 transport 或 summary 兼容性只在 manifest 明确要求且实际成立时通过。当前状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
