# 长时记忆模块

## 1. 当前责任

本模块保存 Pi session 来源副本和完整工具输出，维护 OpenViking Session Working Memory，管理用户记忆模型配置转换，并提供当前受管 OpenViking 代际的实际记忆模型能力证明。

Pi session entry 仍是事实权威；来源文件由 `long-term-memory.ts` 管理，OpenViking Session 派生状态由 `session-working-memory.ts` 管理，配置由 `memory-model-configuration.ts` 管理。向量候选排序属于召回模块，请求采用属于 Session 记忆协调模块。

跨模块流程见 [`../system/source-archiving.md`](../system/source-archiving.md)、[`../system/source-recall.md`](../system/source-recall.md)、[`../system/memory-model-runtime.md`](../system/memory-model-runtime.md) 和 [`../system/context-enhancement.md`](../system/context-enhancement.md)。

## 2. 持久化表示

默认归档根位于 Pi session 目录的 `.pi-context-memory/`：

```text
.pi-context-memory/
└── <session-key>/
    ├── session.json
    ├── sources/<entry-key>.json
    └── large-results/blobs/<content-sha256>.bin
```

`session.json` 保存 session ID 与绝对 session file。`sources/<entry-key>.json` 是唯一来源元数据：message-source 保存 schema/规范化版本、来源引用、Provider role、taskContent、completion、taskContent/authority hash 与可选 fullOutputRef；control-boundary 只存 summary entry 身份。仅全-text 单元可归档，mixed/image 整单元 opaque；thinking/private metadata/locator、excluded bash、扩展私有内容和 summary 不复制。FullOutputCandidate 只在流式复制时存在；blob 完成后才原子发布 fullOutputRef，读取重验大小和 SHA-256。

目录键和文件键由身份哈希派生。目录仅当前用户可访问，文件仅当前用户可读写。验证可通过受控环境变量把数据写入仓库 `.artifacts/`。

## 3. 来源能力与不变量

本模块提供：

- 按 session 写入、读取和列出来源 entry；
- 流式复制完整工具输出并验证内容哈希；
- 读取与当前 Pi entry 关联的完整结果；
- 为工作上下文投影提供来源屏障；
- 为 OpenViking 资源和索引重建提供输入。

来源操作必须满足：

1. session ID 和 session file 与目标归档一致；
2. entry 来自当前 Pi branch；
3. 同一 entry ID 的规范化版本、task-content、完成状态、task-content hash、authority hash 和 fullOutputRef 稳定一致；
4. 含 fullOutputRef 的 source record 只有在 blob 完整写入后发布，不存在第二份 entry metadata；
5. 读取结果重新核对大小、哈希和 entry 身份；
6. 损坏、缺失或身份不匹配的记录不作为可恢复来源；
7. control-boundary 的序列化结果中不存在 summary 或 retainedTail 内容。

当前回合大工具结果被有界投影前，相关来源屏障必须完成。失败由 Session 记忆协调锁存为必要数据面故障。

## 4. 记忆模型配置与能力

模块维护扩展支持的最小用户配置面，并通过 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 转换为 OpenViking 运行配置。

模块按 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 消费用户配置与编译结果，并维护缺失模板的原子创建。凭据值不进入状态、日志、evidence 或 Pi session。

用户配置只选择 Provider、模型、凭据引用和必要连接字段。模块按配置契约接受字段，并按 [`../system/memory-model-runtime.md`](../system/memory-model-runtime.md) 的唯一 `MemoryRuntimeProfile` 定义为精确 Provider、模型和 API 生成运行目标；当前受管进程的实际能力探针决定该目标能否授权增强。

模块区分：

- 配置能够解析；
- OpenViking 能够加载配置；
- 受管子进程和服务 ready；
- 记忆模型实际完成 Working Memory；
- 当前代际具备任务请求能力。

实际能力证明来自隔离 Session 的生产协议探针，绑定 launchId、childPid、模型、配置指纹、`MemoryRuntimeProfile` 指纹、协议版本和探针实现。证明与创建它的受管进程代际共同生效；业务 Session 只负责检查点。`health`、`ready` 或模型对象存在不能建立任务请求能力。

## 5. OpenViking Session 与派生记忆检查点

OpenViking Session 只接收 Session 记忆协调核验过的完整路线身份和 Pi 集成发布的 MessageSource/ControlBoundary。线性后继在同一镜像追加增量；分叉、session replacement 或有效前缀变化使用隔离镜像；ControlBoundary 只贡献无文本路线身份。

本模块发布的 `MemoryCheckpoint` 是可重建派生结果：

```text
MemoryCheckpoint = {
  identity,
  generation,
  coveredRoutePrefixKey,
  coveredRouteEntryIds,
  coveredThroughEntryId,
  retentionBudgetIdentity,
  sourceIds,
  workingMemory,
  activeHistory,
  assemblyHash,
  producedUnderCapabilityProofId
}
```

`identity` 由全部检查点字段的规范化内容形成；`coveredRouteEntryIds` 保存精确前缀 entry 顺序，使当前路线能够在不依赖可变镜像状态的情况下重验前缀，`coveredRoutePrefixKey` 再绑定该前缀的投影内容。
`RefreshTarget` 由 [`session-memory-coordination.md`](session-memory-coordination.md) 拥有，其中 `retentionBudgetIdentity` 由工作上下文优化的预算算法产生。本模块把 target 视为不可拆分身份，只执行或复用完全相同的目标，并把该 identity 写入发布的检查点。

检查点只能覆盖与 assembly 请求完全一致、且不跨越 OpaqueProviderSegment 的路线前缀；其中 Working Memory 与 active history 均通过 OpenViking 适配器限界并回到当前 MessageSource。合法空历史使用扩展本地空检查点。检查点内容由本模块拥有，Session 记忆协调只持有身份、兼容关系和刷新状态。

OpenViking append 只使用 MessageSource 的公开 taskContent、完成状态和 source ID，不读取 thinking、私有 metadata、OpaqueProviderSegment、FullOutputCandidate、本机路径或完整结果 blob。单条索引投影最多 32 KiB：未超限时保持正文，超限时只保留有界前缀并显式写入原始字节数、taskContentHash 和 `recall_session read_source` 恢复入口，不能把省略投影冒充原文；权威 taskContent 与完整工具结果继续留在来源归档。单次 batch append 最多 100 条且 JSON 最多 256 KiB，并按先达到的边界分批。

后台刷新遵守：

1. 在 `agent_settled` 的完整用户回合边界、路线切换预热，或来源后缀达到任务上下文/长时记忆输入预算高水位时，为确定的路线 watermark 安排刷新；中间 `turn_end` 与单个工具结果只归档已最终化来源，不单独触发 Working Memory；
2. 完整 RefreshTarget 相同的调用共享；尚未启动的线性后继只有 retentionBudgetIdentity 相同才合并到最新 watermark；运行中的目标不可升级或换绑，新预算请求在其完成后重新评估并按需创建自己的目标；
3. commit `accepted` 必须观察 task 终态；只有 completed 且最终 assembly、来源和预算核验成功时才原子发布新检查点；
4. 机会性 commit `skipped` 保留现有检查点与来源后缀，不发布伪检查点；`refresh-required` 使用与预算版本绑定的显式 retention 边界，仍返回 skipped 时报告契约/策略错误，不重复形成无界任务；
5. accepted task 失败、取消、达到 profile 期限或 assembly 不可信时向调用方返回刷新错误；机会性后台刷新失败只保留旧 checkpoint+delta 并记录诊断，只有当前请求依赖该结果的必要刷新失败才锁存故障；stopping 中由扩展发起的取消只完成清理；
6. 检查点缓存、镜像、pending 和完成结果均有固定上限；迟到结果只属于创建它的完整 RefreshTarget。

任务请求不以“刷新完成”作为普遍前置条件。Session 记忆协调可以组合与当前路线前缀兼容的最近检查点和其后的来源可恢复后缀；只有该组合无法满足内容完整性或任务模型预算时，才等待一个能够推进覆盖 watermark 的必要刷新。分支路线只能复用覆盖前缀仍是当前 branch 精确前缀的检查点，不能采用分叉后的旧路线记忆。

## 6. 对外能力

本模块向相邻模块提供：

- `archiveRoute`：幂等保存当前路线来源；
- `ensureRecoverable`：确认指定 entry 和完整结果可恢复；
- `findCompatibleCheckpoint`：返回覆盖前缀仍是当前路线精确前缀的最近检查点；
- `refreshCheckpoint`：为完整 RefreshTarget 创建或复用后台 OpenViking 刷新；
- `probeCapability`：验证当前受管模型实际 Working Memory 能力；
- `runtimeCapability`：返回与当前 active 进程绑定的能力证明；
- 来源列表、完整结果读取和 OpenViking 索引输入；
- 受控 shutdown 与扩展创建 Session 清理。

接口返回明确成功或错误，不以空内容表示故障。

## 7. 错误与恢复

错误按来源、配置、服务、能力和协议分类：

- 来源创建、复制、校验或读取失败直接返回；
- JSONC、schema、字段或凭据错误形成带路径的脱敏诊断；
- Session create、append、commit 或 assembly 失败不发布 MemoryCheckpoint；
- 未知、矛盾、缺失来源或通用失败内容不进入上下文；
- ready 代际中的 accepted refresh 非成功终态使能力证明失效；
- 当前受管子进程停止或替换使旧代全部派生状态失效。

重新提交同一有效来源可按稳定 entry ID 修复局部归档。运行代际故障的恢复由显式 OpenViking 重启或能力重新验证触发；新代际从当前 Pi branch 和已核验本地来源重建。

清理失败不会改变 Pi session 事实，但进入运行观测。系统不因清理结果自动发送任务请求。

## 8. 验证边界

验证分别证明：

- session、branch、文件权限、原子写入和内容完整性；
- 当前回合投影前的来源屏障；
- 用户配置保持最小，生成配置精确绑定实际验证的 `MemoryRuntimeProfile` 且凭据不泄漏；
- 实际能力探针确实调用目标记忆模型；
- OpenViking Session 增量、分支隔离、commit、task、assembly 与检查点原子发布；
- 慢速后台刷新期间兼容检查点与来源后缀仍可用，只有必要刷新形成增强构造屏障；
- `skipped` 与能力证明具有不同语义；
- task 失败使本扩展停止确认依赖结果的输出，transport 另行观测；
- 新运行代际不复用旧代 context；
- session shutdown 和镜像淘汰保持有界清理。

当前实现与设计之间的状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
