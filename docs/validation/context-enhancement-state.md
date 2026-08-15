# 增强记忆可靠性与请求独占验证

## 1. 验证责任

本文定义如何证明 [`../features/context-enhancement-state.md`](../features/context-enhancement-state.md) 和 [`../system/context-enhancement.md`](../system/context-enhancement.md) 中的复杂长任务可靠完成、当前回合有界、路线隔离、增强请求独占、自动压缩接管和故障阻断。

稳定 evidence 只保存当前目标所需的脱敏结论、运行清单、实现绑定和最小证据索引。原始 session、Provider payload、服务日志和任务产物保存在 Git 忽略的 `.artifacts/`。

## 2. 成功顺序

验证按以下顺序判定：

1. 复杂长任务完成可靠性；
2. 目标、约束、事实、来源和路线质量；
3. 增强 Provider 请求独占；
4. 自动压缩和 tree summary 所有权；
5. 故障阻断、诊断和恢复；
6. 完整 API 成本。

前一项不成立时，不形成后一项产品结论。

## 3. 运行分类与可靠性

每次运行记录为：

- `completed`：最终任务 checker 通过且证据完整；
- `failed`：checker 未通过、任务中断、需要用户介入或证据不完整；
- `blocked`：独立服务观测确认必要外部依赖不可用；memory-precondition 请求由增强闸门阻断，task-provider 请求具有合法增强证明但由 Provider 明确失败。

```text
eligibleRuns = completed + failed
completionReliability = completed / eligibleRuns
```

声明验证范围内通过条件为：

```text
completionReliability == 100%
```

内部等待、输出速度、输出规模、并发、队列、竞态、操作超时、预算和实现错误均属于产品责任，不能形成 blocked。

blocked 只能由 runner 独立采集的进程、网络、认证或 Provider 响应证明，不能依据扩展自己的故障分类决定。证据必须覆盖故障发生时间与该运行所需操作的时间区间。

`memory-precondition` 阻塞表示配置、OpenViking 或记忆模型在任务 Provider 前不可用，对应任务 Provider 增量必须为零。`task-provider` 阻塞可以发生在合法增强请求已经发送之后；该请求仍必须具有增强证明，且 Provider 的失败响应必须由 runner 独立记录。

外部错误在同一运行内恢复且任务继续时，该运行仍按最终 checker 归为 completed 或 failed，重试进入完整成本；只有外部条件使运行无法继续时才归为 blocked。

## 4. 代表性复杂长任务

真实任务集至少包含三个具有不同主要压力的 fixture，每个 fixture 同时保留统一的任务连续性要求。

### 4.1 工具输出压力任务

- 单个 assistant 消息发起多个并行工具调用；
- 工具以接近零间隔返回；
- 同时包含小结果、最大正常结果、截断结果、完整输出路径、错误和否定结果；
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
- 必须形成的文件、行为、事实、来源和禁止结果；
- 必须观察到的协议覆盖，例如并行 ToolBatch、投影、路线换代或召回；
- checker 命令、checker 版本和输出 schema；
- 单操作期限、整次运行期限、eligible 目标数与最大 attempt 数。

每个 attempt 使用独立工作区、Pi session、受管 OpenViking 运行代际与业务 Session、观察日志和 run ID，不复用能力证明、路线缓存、Working Memory 或其它派生任务状态。

任务 checker 在 Agent settled 后以独立进程运行，只读取 fixture 声明的最终工作区、公开任务产物、Pi 权威 session 与测试结果。它不能读取 Working Memory、路线缓存、请求授权或扩展自报状态来决定任务成功，并返回：

```text
{ passed, checks, artifactHashes, sourceAssertions, error? }
```

增强独占、故障归因、协议覆盖和成本由 runner 的协议 checker 另行判断，不能让任务 checker 的成功掩盖原生请求、来源错误或账单缺失。manifest 要求的协议覆盖未发生时，该 attempt 因证据不完整记为 failed。

## 5. 重复与样本完整性

本地协议和并发压力 runner 对每类时序执行至少 100 个确定性或种子可复现样本。

真实任务模型与真实记忆模型验证中，每个复杂长任务 fixture 的 `eligibleTarget` 至少为 10。runner 按预声明顺序执行 attempt，直到达到 eligible 目标、发生使 100% 结论已被推翻的 failed，或达到 `maxAttempts`。

blocked attempt 保留但不占 eligible 名额；达到最大 attempt 后仍不足目标样本时，结果为 `inconclusive`，不能通过可靠性门槛。任务与记忆 Provider/模型/API、凭据引用指纹、OpenViking、thinking、工具、初始仓库、输入节奏、随机种子、期限、样本数和停止规则在开始前写入 `ValidationCoordinates` 与 run manifest 并计算哈希；运行中任一 Provider/模型变化使 suite 停止且证据无效。

run manifest、每个已执行 attempt 和停止原因都进入 evidence：

- 提前失败时记录未执行数量和 `stoppedBy: first-failed`，不声称完成预声明样本；

- 不删除失败运行；
- 不因模型输出不理想重新分类；
- interrupted 运行只有独立外部阻塞证据时才可标记 blocked；
- 重试作为原运行的一部分归集，不生成替代成功样本。

## 6. 本地控制流验证

本地 runner 使用协议兼容 OpenViking、记忆模型和任务 Provider 替身，不访问外部 Provider。它必须实际驱动 Pi 生命周期并验证下列受控分支，但不能据此证明实际记忆能力、真实 Provider 采用、复杂任务完成或产品 suite 通过：

- 初始化期间提交的 prompt 加入能力屏障，ready 后同一请求增强发送；
- 初始化完成前任务 Provider 请求数为零；
- 用户取消初始化等待不锁存服务故障，也不增加 Provider 请求；
- 没有权威 session file 的临时 session 请求数为零；
- 首轮空历史仍携带合法增强证明；
- `context` 可以创建或加入精确路线准备；
- accepted Working Memory task 终态与 assembly 核验前，依赖路线的任务 Provider 增量为零；
- skipped commit 只复用既有 Working Memory 和来源核验 active history，不续租能力；
- 路线准备耗时显著高于相邻请求间隔时最终增强发送，操作超时则 Provider 请求数不增加；
- 路线 pending 期间用户状态保持“增强记忆”；
- 多工具批次完整匹配，raw 和 projected payload 均符合 Provider 协议；
- 未持久化但预算内的实际 ToolBatch 可以 raw 发送并绑定 CurrentTurnKey；
- projected ToolBatch 等待权威 entry 与来源屏障，任一失败时请求被阻断；
- 预算包含系统 prompt、工具 schema、current turn 和输出保留；
- 相同输入形成相同上下文哈希；
- session、session file、实际 leaf、HistoricalRouteKey、CurrentTurnKey、完整内容和运行代际形成唯一采用身份；
- 分支、迟到结果、替换 session 和 reload 保持隔离；
- 每个候选任务 Provider API 的 PayloadProofAdapter 先以 controlled payload 核对 raw 与 projected 序列化结果；只有另有 actual Provider 证据的 API 才标记受支持；
- model_select 清除 pending 证明和预算缓存，下一请求绑定新模型；
- 未支持或 malformed payload 在网络前阻断；
- `before_provider_request` 中系统、工具 schema、消息或增强证明被删除或修改时，网络请求数不增加；
- 用户文本不能伪造增强证明；
- nonce 只能消费一次，重复、迟到和并发复用不能进入 Provider；
- threshold、overflow 和 manual compaction 不产生 Pi 摘要请求；
- Pi `0.84.2` 中，选择 summary 的 tree 导航先显示禁用提示并仍到达目标，但原生 summary Provider 增量和新 `branch_summary` entry 数均为零；
- 无 summary 的 tree 导航保持原有 leaf 操作语义；
- 未通过宿主行为探针的版本取消带 summary 导航，不放行原生 summarizer；
- 已有 compaction/branch summary 污染哨兵不进入 VLM 或任务 Provider payload；
- shutdown 清理有界且不污染后续 session。

## 7. 真实 Provider 请求与任务质量

真实 runner 从 manifest 读取并固定当前已配置的任务 Provider/模型、记忆 Provider/模型和受管 OpenViking；坐标不变时直接执行必要的付费调用，不逐次申请授权。

在复杂 fixture 计数前，实际纵向检查点必须全部通过：

- 真实记忆 Provider/模型完成能力探针、accepted Working Memory task、轮询和来源核验 assembly；
- 真实受管 OpenViking 完成来源写入、实际索引、检索和当前 Pi message 展开；
- 真实 Pi 首轮、历史路线换代和 CurrentTurn 工具循环均由当前任务 Provider 接收增强 payload 并继续行动；
- 实际大工具输出至少各触发一次 raw 与 projected 路径，后续任务模型依据投影和来源正确完成检查；
- 实际 OpenViking 中断、能力租约到期和修复重启分别形成零任务请求阻断、新代际恢复和用户重提后的成功请求；
- tree summary 抑制、compaction 取消和现有 summary 污染隔离由真实 Pi session 证明。

任一检查点只有替身证据或没有实际发生时，真实 suite 为 failed/inconclusive，不能开始可靠性计数。真实 runner 同时采集：

- Pi session 与最终任务产物；
- 任务 checker 结果；
- OpenViking 进程和实际模型能力状态；
- 每个 `context` 授权、请求证明和 Provider 接收事件；
- 工具调用、结果、来源屏障和投影统计；
- Working Memory task 终态；
- compaction 与 tree summary 的 Provider 请求及新 entry 计数；
- 任务模型和记忆模型 usage；
- 用户介入、重试、阻断和结束原因。

每个 eligible 运行必须满足：

- 最终 checker 通过；
- 无用户手工重试、记忆整理或目标重述；
- 无内部死锁、无界等待或悬挂后台任务；
- 工具调用和结果无丢失、错序或跨批次污染；
- 当前目标、约束、事实和来源保持正确；
- 每个发送到任务 Provider 的请求都具有当前增强证明；
- 没有任务请求采用原始 Pi 历史替代增强上下文；
- 没有 Pi 原生 compaction 或 tree summary 模型请求；
- tree 未新建 `branch_summary` entry，已有 summary 文本未进入 VLM 或任务 payload。

## 8. 增强独占判定

每个运行至少核对：

```text
sentTaskRequests == enhancedVerifiedRequests
unverifiedSentTaskRequests == 0
blockedRequestsProviderDelta == 0
nativeCompactionRequests == 0
nativeBranchSummaryRequests == 0
createdBranchSummaryEntries == 0
summaryContaminationHits == 0
```

`createdBranchSummaryEntries` 是 attempt 初始 session 之后的增量；`summaryContaminationHits` 扫描来源文件、OpenViking 资源/Session 请求、assembly 和最终任务 Provider payload 中的预置污染哨兵。

`blockedRequestsProviderDelta` 只统计协调器已经判定 block 的任务请求；task-provider 在合法增强发送后的外部失败计入 sentTaskRequests，不进入该指标。

Provider 采用事实由扩展之外的传输观测建立：本地场景使用真实 HTTP 接收端核对请求数和 payload 哈希；真实 Provider 场景在全部扩展 transform 之后、HTTP 发送边界记录最终序列化哈希，并关联 Provider 响应 ID、状态和 usage。`context` 决定、扩展状态栏或扩展自己的日志不能单独证明采用。

增强证明必须关联 run ID、request ID、任务 Provider、模型与 API、session、实际 leaf、HistoricalRouteKey、CurrentTurnKey、运行代际、system prompt 哈希、tool schema 哈希、消息哈希、PayloadProofAdapter 版本和 nonce。稳定 evidence 保存哈希与计数，不保存完整 payload。

## 9. 故障与恢复矩阵

分别注入：

- 配置语法、schema、必要字段和凭据错误；
- Launcher 缺失、所有权冲突和子进程退出；
- service readiness 失败；
- 记忆模型实际能力探针失败；
- Session create、append、commit、task 和 context 错误；
- 来源归档、完整输出复制和哈希错误；
- 路线操作超时、后端取消和迟到结果；
- 用户主动取消等待但运行代际仍然健康；
- ToolBatch 不完整、未知 content block 和预算不足；
- 最终 Provider payload 证明被修改。

用户主动取消属于控制场景，只要求本次 Provider 增量为零、等待者释放且运行代际保持健康；以下故障锁存条件不适用于该场景。

每个故障场景必须证明：

1. Provider 接收数不增加；
2. 状态为“增强记忆 · 故障”；
3. 诊断错误码和责任阶段准确；
4. 当前 Pi session、branch 和来源保持不变；
5. 系统不自动重放 prompt 或工具；
6. 显式修复创建新代际；
7. 新代际只从当前 branch 重建；
8. 用户重新提交后使用增强路径完成任务。

## 10. 禁用扩展边界

独立运行验证退出增强实例、禁用扩展并重新启动 Pi 后：

- Pi 原生 session、tree、工具和 compaction 正常工作；
- 增强故障状态不进入新实例；
- 用户记忆配置、本地来源和 OpenViking 数据不被删除；
- 禁用是进程启动选择，不是请求级切换。

## 11. 成本门槛

只有以下条件全部成立后，运行才能进入成本实验：

- 全部预声明 eligible 增强运行完成；
- 任务质量与路线 checker 全部通过；
- 增强独占指标全部成立；
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
- `ValidationCoordinates`：Pi、OpenViking、任务 Provider/模型/API、记忆 Provider/模型、thinking、工具、凭据引用指纹与未变更证明；
- 每个核心检查点的 `evidenceLevel: actual | controlled`、实际运行 ID 和原始 artifact 索引；
- 实际 Provider 的脱敏响应 ID、usage、generation 责任与账单索引；
- fixture、初始工作区和 checker 的路径、版本与哈希；
- 每个 attempt 的 ID、分类、开始结束时间、停止原因和 artifact 索引；
- task checker 的逐项结果与最终产物哈希；
- 独立外部服务事件和 blocked 归因；
- 任务 Provider 的 sent、enhancedVerified、unverified 与 gate-blocked 计数；
- compaction/tree summary 请求、新 branch summary entry、summary 污染命中、Working Memory 和 API generation 归属；
- eligible、completed、failed、blocked、inconclusive 和可靠性聚合；
- 实现文件清单、哈希与最终 `passed`。

完整 session、payload、工具输出、服务日志、账单明细和工作区保存在对应 attempt 的 `.artifacts/` 目录。稳定 evidence 只保存哈希、计数、脱敏错误和相对索引。

runner 和 stable evidence 必须随实现更新后才能证明本文目标。`passed` 只有在所有核心检查点具有 actual 证据、Provider/模型坐标未变、eligible 目标完整、全部 task checker 通过、增强独占成立、外部阻塞证据闭合且实现与验证规格哈希一致时为 true。当前证据有效范围与下一实现入口由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
