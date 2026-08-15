# 验证文档

## 1. 目录角色

本目录保存产品结果、架构边界、模块设计和外部契约的当前验证方法。验证类别和生命周期服从 [`../../DOCUMENTION.md`](../../DOCUMENTION.md)；当前实现证据范围和唯一下一入口由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。

## 2. 验证规格

| 验证规格 | 当前责任 | 稳定 evidence 位置 |
| --- | --- | --- |
| [`source-archive.md`](source-archive.md) | session、branch、来源恢复、完整结果和来源屏障 | [`../../validation/evidence/source-archive.json`](../../validation/evidence/source-archive.json) |
| [`source-recall.md`](source-recall.md) | OpenViking 来源索引、当前路线召回和权威展开 | [`../../validation/evidence/source-recall.json`](../../validation/evidence/source-recall.json) |
| [`context-enhancement-state.md`](context-enhancement-state.md) | 复杂长任务可靠性、current turn 有界、增强独占、压缩接管和故障恢复 | [`../../validation/evidence/context-enhancement.json`](../../validation/evidence/context-enhancement.json)、[`../../validation/evidence/context-quality.json`](../../validation/evidence/context-quality.json) |
| [`memory-model-runtime.md`](memory-model-runtime.md) | 用户配置、运行所有权、实际模型能力证明和请求阻断 | [`../../validation/evidence/memory-model-runtime.json`](../../validation/evidence/memory-model-runtime.json) |

稳定 evidence 只有在 schema、必需 check 集、实现文件哈希、验证规格和当前运行结果一致时有效。checker 不发起 Provider 请求，只验证已有 evidence 的完整性和新鲜度。

## 3. 验证顺序

验证按风险和产品价值依次执行：

1. 真实 Pi session、来源存储、branch 隔离和完整结果；
2. 真实受管 OpenViking、配置、进程所有权、实际索引和记忆模型能力探针；
3. 真实 Pi 生命周期、当前任务 Provider 采用、请求闸门、ToolBatch 与受控故障注入；
4. 真实复杂长任务重复可靠性与任务质量；
5. 增强请求独占和 Pi 摘要零调用；
6. 完整 API 成本。

前一层失败时停止形成后续产品结论，但保留失败运行及其证据。

### 3.1 核心节点的实际证据

| 核心节点 | 形成完成结论所需的实际证据 | 替身的有限用途 |
| --- | --- | --- |
| 来源归档 | 真实 Pi `SessionManager`、项目内真实文件系统、实际完整工具输出和读回哈希 | 注入写入、损坏和期限失败 |
| 来源索引与召回 | 真实受管 OpenViking、实际 embedding/索引、当前 branch URI 和 Pi message 展开 | 构造 malformed envelope、空结果和后端错误 |
| 记忆模型运行时 | 真实受管 OpenViking 调用已配置的实际记忆 Provider/模型，完成探针、accepted task、轮询和 assembly | 穷举协议分支、超时和故障锁存 |
| Pi 集成与增强采用 | 真实 Pi 生命周期和 hook；allow 路径由当前实际任务 Provider 接收并返回；block 路径由隔离传输观测证明零请求 | 篡改 payload、重复 nonce 和故障注入 |
| CurrentTurn 与 ToolBatch | 真实 Pi 工具调用、真实消息持久化、实际大输出来源和当前任务模型的后续行动 | 生成边界尺寸与不支持形态 |
| 复杂长任务 | 当前实际任务 Provider/模型、实际记忆 Provider/模型、受管 OpenViking、真实工具和独立任务 checker | 不允许替代 |
| 完整成本 | 每个实际 generation 的 Provider usage、响应 ID 与最终账单 | 不允许用估算账单替代 |

任一核心节点只有替身成功而没有对应实际证据时，其状态是未验证，不是完成。替身 runner 仍是故障语义和确定性覆盖的必要补充。

### 3.2 付费验证授权

suite 启动时把当前任务 Provider/模型/API、记忆 Provider/模型、OpenViking、thinking、凭据引用指纹、样本数、`maxAttempts` 和停止条件写入 manifest。沿用这些坐标执行实际验证是正常流程，即使产生费用也不逐次向用户索要授权。

只有需要改变任务 Provider、任务模型、记忆 Provider 或记忆模型时才停止并请求用户决定。认证、配额或服务故障按 blocked/failed 规则记录，不能未经授权改用其它 Provider 或模型。

支持矩阵按实际证据发布：当前坐标通过 actual 检查后才能声明支持；仅通过 controlled/替身检查的 Provider、模型或 API 适配保持未验证。

## 4. 受控本地入口

```bash
node scripts/validate-source-archive.mjs
node scripts/validate-source-recall.mjs
node scripts/validate-memory-model-runtime.mjs
node scripts/validate-context-enhancement.mjs
node scripts/check-validation-evidence.mjs
```

本地 runner 使用隔离文件、受控进程和协议替身，不访问外部任务 Provider。它们必须实际驱动对应 Pi 与 OpenViking 边界，而不是只检查静态代码；其结果只证明受控分支，不能把关键节点或产品 suite 标记为完成。

原始运行产物写入 Git 忽略的 `.artifacts/`；稳定 evidence 只保存脱敏的检查结果、运行坐标、实现绑定和最小证据索引。

## 5. 真实复杂长任务可靠性

真实验证至少维护三个代表性 fixture：工具输出压力、路线与事实更新、长时间连续任务。每个 fixture 使用真实任务模型、真实记忆模型和受管 OpenViking，`eligibleTarget` 至少为 10；blocked attempt 不占目标名额，样本不足时结果为 inconclusive。

```bash
node scripts/validate-context-quality.mjs
```

suite 开始前以带哈希的 run manifest 固定：

- fixture、工作区、任务、checker 命令及各自版本与哈希；
- 任务模型、记忆模型、Provider 和 thinking；
- 工具、权限、初始仓库和输入；
- 执行顺序、缓存条件、随机种子和停止条件；
- 外部服务独立观测；
- `eligibleTarget`、`maxAttempts`、操作期限、运行期限和停止规则。

任务 checker 独立运行，只依据最终工作区、公开任务产物、Pi 权威 session 与测试结果判定成功；增强状态、请求采用和账单由协议 checker 分别判定。

运行分类为 completed、failed 或 blocked。只有独立进程、网络、认证或 Provider 证据可以形成 blocked；内部错误和无法归因的中断属于 failed。

声明范围内通过条件为：

```text
completionReliability = completed / (completed + failed) = 100%
```

run manifest、每个已执行 attempt、停止原因和未执行数量都进入 evidence，不以补跑成功替换失败。

## 6. 增强路径独占

每个真实和本地运行必须核对：

```text
sentTaskRequests == enhancedVerifiedRequests
unverifiedSentTaskRequests == 0
blockedRequestsProviderDelta == 0
nativeCompactionRequests == 0
nativeBranchSummaryRequests == 0
createdBranchSummaryEntries == 0
summaryContaminationHits == 0
```

`blockedRequestsProviderDelta` 只统计增强协调器已判定 block 的请求；任务 Provider 在合法增强发送后的外部失败不进入该指标。

Provider 实际接收 payload 是采用事实。增强证明关联 run、request、任务 Provider、模型与 API、session、实际 leaf、HistoricalRouteKey、CurrentTurnKey、运行代际、system prompt、tool schema、消息哈希、PayloadProofAdapter 版本和 nonce。隔离本地接收端证明序列化与 block 零请求；产品完成证据还必须关联当前实际任务 Provider 的响应 ID 和 usage。

禁用扩展验证使用新的 Pi 进程，证明 Pi 原生 session、tree、工具和 compaction 独立可用；它不属于增强运行的请求级状态。

## 7. 完整成本验证

只有复杂长任务可靠性、任务质量、来源与路线可信和增强独占全部成立后，才运行 Pi 原生基线与增强路径的成对成本实验。实验沿用同一 manifest 中已配置的 Provider/模型，属于已授权的正常付费验证，不再次请求用户确认。

两个 arm 共享相同 fixture、checker、任务模型、Provider、thinking、工具、权限、初始工作区、输入、停止条件和重复次数。每个 pair 使用独立工作区；arm 顺序在 manifest 中预先平衡，缓存策略固定且可观测。完整成本包含：

- 任务模型请求；
- 记忆模型初始化与续租能力探针；
- Working Memory 生成、提取和合并；
- 召回、重试、故障处理及异常 tree summary（通过门槛要求为零）；
- 其它由增强系统触发的 API generation。

每个 generation 必须关联唯一 run、arm、责任和 Provider 最终账单。两个 arm 都有效完成任务且费用归属完整后，增强 arm 完整 billed cost 更低才形成成本优势。

## 8. 维护规则

- 验证规格先定义需要证明和可能推翻设计的事实；
- runner 只保留当前责任需要的 fixture、观测和 checker；
- 当前实现不满足目标规格时更新 `DEVELOPMENT.md`，不让与当前规格不一致的 evidence 代替目标证明；
- 失败运行、blocked 证据和样本清单不可选择性删除；
- 新证据替代旧结论后更新稳定 evidence，不保留历史报告；
- 责任消失或被其它验证完整覆盖时，删除对应 check 和专用基础设施。
