# 验证文档

## 1. 目录角色

本目录保存产品结果、架构边界、模块设计和外部契约的当前验证方法。验证类别和生命周期服从 [`../../DOCUMENTION.md`](../../DOCUMENTION.md)；当前实现证据范围和唯一下一入口由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。

## 2. 验证规格

| 验证规格 | 当前责任 | 稳定 evidence 位置 |
| --- | --- | --- |
| [`source-archive.md`](source-archive.md) | session、branch、来源恢复、完整结果和来源屏障 | [`../../validation/evidence/source-archive.json`](../../validation/evidence/source-archive.json) |
| [`source-recall.md`](source-recall.md) | OpenViking 来源索引、当前路线召回和权威展开 | [`../../validation/evidence/source-recall.json`](../../validation/evidence/source-recall.json) |
| [`context-enhancement-state.md`](context-enhancement-state.md) | 复杂长任务、Provider 基线/记忆投影、hook 时点证明、transport 采用和宿主兼容性 | [`../../validation/evidence/context-enhancement.json`](../../validation/evidence/context-enhancement.json)、[`../../validation/evidence/context-quality.json`](../../validation/evidence/context-quality.json) |
| [`memory-model-runtime.md`](memory-model-runtime.md) | 用户配置、运行所有权、实际模型能力证明和请求阻断 | [`../../validation/evidence/memory-model-runtime.json`](../../validation/evidence/memory-model-runtime.json) |

稳定 evidence 只有在 schema、必需 check 集、实现文件哈希、对应验证规格、[`../../validation/suite.json`](../../validation/suite.json) 与当前运行结果一致时有效。suite 文件是用户已选择的宿主/模型坐标和验证政策唯一机器可读入口；OpenViking 依赖版本仍由 `pyproject.toml`/`uv.lock` 拥有。checker 不发起 Provider 请求，只验证已有 evidence 的完整性和新鲜度；任一绑定输入改变都会报告 stale。通过时输出 `input-current (<evidence-class>)`，只表示该 evidence class 的输入仍一致，不表示更高层实际节点或产品验收已完成。

## 3. 验证顺序

验证按风险和产品价值依次执行：

1. 真实 Pi session、来源存储、branch 隔离和完整结果；
2. 真实受管 OpenViking、配置、进程所有权、实际索引和记忆模型能力探针；
3. 真实 Pi Provider 基线、记忆投影、hook 时点证明、transport 采用与 ToolBatch；
4. 真实复杂长任务重复可靠性与任务质量；
5. 被测 Pi/扩展组合的 compaction/tree hook 与实际宿主结果；
6. 完整 API 成本。

前一层失败时停止形成后续产品结论，但保留失败运行及其证据。

### 3.1 核心节点的实际证据

| 核心节点 | 形成完成结论所需的实际证据 | 替身的有限用途 |
| --- | --- | --- |
| 来源归档 | 真实 Pi `SessionManager`、项目内真实文件系统、实际完整工具输出和读回哈希 | 注入写入、损坏和期限失败 |
| 来源索引与召回 | 真实受管 OpenViking、实际 embedding/索引、当前 branch URI 和 Pi message 展开 | 构造 malformed envelope、空结果和后端错误 |
| 记忆模型运行时 | 真实受管 OpenViking 以固定 MemoryRuntimeProfile 调用已配置的实际记忆 Provider/模型，完成探针、accepted refresh、assembly、检查点发布和租约续租；最终请求证明 profile 字段生效 | 穷举协议分支、超时和故障锁存 |
| Pi 集成与增强采用 | 真实 Pi 生命周期；采集 context、hook verified/rejected/unobserved、handler 顺序和 transport 结果 | 前后 handler 篡改、重复 nonce 和本扩展故障 |
| CurrentTurn 与 ToolBatch | 真实 Pi 工具调用、消息持久化、`convertToLlm` Provider 基线、结构化记忆投影、actual 大输出和任务后续行动 | opaque block、边界尺寸、私有 metadata 与 locator 哨兵 |
| 复杂长任务 | 当前实际任务 Provider/模型、实际记忆 Provider/模型、受管 OpenViking、真实工具和独立任务 checker | 不允许替代 |
| 完整成本 | 每个实际 generation 的 Provider usage、响应 ID 与最终账单 | 不允许用估算账单替代 |

任一核心节点只有替身成功而没有对应实际证据时，其状态是未验证，不是完成。替身 runner 仍是故障语义和确定性覆盖的必要补充。

### 3.2 付费验证授权

[`../../validation/suite.json`](../../validation/suite.json) 固定用户已选择的 Pi protocol profile、任务/记忆 Provider 路由、模型和验证政策；runner 在开始前将实际 API、OpenViking 锁定版本、extensionCompositionFingerprint 与 handler 顺序、MemoryRuntimeProfile/adapter、凭据指纹、fixture、期限及停止条件补全为带哈希的 resolved run manifest。沿用这些模型坐标的付费验证无需逐次授权；Provider/模型变化仍交由用户决定。扩展组合变化只使原兼容性证据失效并要求重新观测，不授权本扩展调整加载顺序。

只有需要改变任务 Provider、任务模型、记忆 Provider 或记忆模型时才停止并请求用户决定。认证、配额或服务故障按 blocked/failed 规则记录，不能未经授权改用其它 Provider 或模型。

支持矩阵按实际证据发布：当前坐标通过 actual 检查后才能声明支持；仅通过 controlled/替身检查的 Provider、模型或 API 适配保持未验证。

## 4. 受控本地入口

```bash
node scripts/check-maintenance-sources.mjs
node scripts/validate-source-archive.mjs
node scripts/validate-source-recall.mjs
node scripts/validate-memory-model-runtime.mjs
node scripts/validate-context-enhancement.mjs
node scripts/check-validation-evidence.mjs
```

本地 runner 使用隔离文件、受控进程和协议替身，不访问外部任务 Provider。它们必须实际驱动对应 Pi 与 OpenViking 边界，而不是只检查静态代码；其结果只证明受控分支，不能把关键节点或产品 suite 标记为完成。

原始运行产物写入 Git 忽略的 `.artifacts/`；稳定 evidence 只保存脱敏的检查结果、运行坐标、实现绑定和最小证据索引。

## 5. 真实复杂长任务可靠性

真实验证必须覆盖 suite policy 列出的三类代表性 fixture，并对每类达到 manifest 的 `eligibleTarget`；当前政策值只在 [`../../validation/suite.json`](../../validation/suite.json) 维护。每个 fixture 使用真实任务模型、真实记忆模型和受管 OpenViking；blocked attempt 不占目标名额，样本不足时结果为 inconclusive。

```bash
node scripts/validate-context-quality.mjs
```

当前 `validate-context-quality.mjs` 只消费 suite 中的 `pairedQualityRepetitions`，形成固定 fixture 的真实 Provider 成对诊断；它不等于上述复杂长任务 suite。后者完成前不得以该 evidence 声明可靠性或一般质量。
suite 开始前以带哈希的 run manifest 固定：

- fixture、工作区、任务、checker 命令及各自版本与哈希；
- 任务 Provider/模型/API、task thinking、记忆 Provider/模型/API 和 MemoryRuntimeProfile/adapter 指纹；
- 工具、权限、初始仓库和输入；
- 执行顺序、缓存条件、随机种子和停止条件；
- 外部服务独立观测；
- `eligibleTarget`、`maxAttempts`、操作期限、运行期限和停止规则。

任务 checker 独立运行，只依据最终工作区、公开任务产物、Pi 权威 session 与测试结果判定成功；增强状态、请求采用和账单由协议 checker 分别判定。

运行只分：completed（最终 checker 通过且 evidence 完整）、failed（未通过/中断/需用户介入/证据不完整）或 blocked（独立外部进程、网络、认证或 Provider 证据确认无法继续）。内部错误和无法归因事件属于 failed；恢复后继续的运行按最终 checker 归类。

声明范围内通过条件为：

```text
completionReliability = completed / (completed + failed) = 100%
```

run manifest、每个已执行 attempt、停止原因和未执行数量都进入 evidence，不以补跑成功替换失败。

## 6. 增强采用与责任边界

每个真实和本地运行必须核对：

```text
constructedEnhancedOutputs == hookVerifiedOutputs + hookRejectedOutputs + hookUnobservedOutputs
hookVerifiedOutputs == transportAdopted + changedAfterHook + transportUnobserved
falseTransportAdoptionClaims == 0
extensionContinuedAfterBlock == 0
providerBaselineViolations == 0
memoryProjectionViolations == 0
crossComponentMutations == 0
summaryContaminationHits == 0
```

本节是指标唯一权威定义。constructed 输出在 hook 分为 verified/rejected/unobserved；只有 verified 再按 transport adopted/changed/unobserved 分账，其它 transport 事实仍保存但不称增强采用。`extensionContinuedAfterBlock` 只检查本扩展 block 后未继续构造/确认，transport 结果不作本扩展必达项。其余违规分别对照 Pi 转换/探针、MessageSource/opaque 归宿、跨组件修改和 summary 污染。

禁用扩展验证只证明新 Pi 进程未加载本扩展及禁用动作不删除其数据；Pi 后续 session/tree/tool/compaction 仅作外部观测，不属于增强运行结论。

## 7. 完整成本验证

只有复杂长任务可靠性、任务质量、来源/路线可信、增强采用结论准确和 manifest 要求的宿主兼容性成立后，才运行成对成本实验。坐标不变时按既有授权执行，只有 Provider/模型变化交由用户决定。

两个 arm 共享相同 fixture、checker、任务模型、Provider、thinking、工具、权限、初始工作区、输入、停止条件和重复次数。每个 pair 使用独立工作区；arm 顺序在 manifest 中预先平衡，缓存策略固定且可观测。完整成本包含：

- 任务模型请求；
- 记忆模型初始化与续租能力探针；
- Working Memory 生成、提取和合并；
- 召回、重试、故障处理及被测组合实际产生的 compaction/tree summary；
- 其它由增强系统触发的 API generation。

每个 generation 必须关联唯一 run、arm、责任和 Provider 最终账单。两个 arm 都有效完成任务且费用归属完整后，增强 arm 完整 billed cost 更低才形成成本优势。

## 8. 维护规则

可变事实按责任保持单一机器可读权威：

| 事实 | 权威来源 | 变化后的动作 |
| --- | --- | --- |
| Node 门槛、uv bootstrap 与摘要 | `config/toolchain.json` | 先通过安装入口，再重跑受影响 evidence |
| Python 开发版本 | `.python-version`；兼容范围由 `pyproject.toml` | 重新锁定依赖并纵向验证 |
| OpenViking 直接依赖与闭包 | `pyproject.toml`、`uv.lock` | 核对 schema/adapter 契约并重跑实际节点 |
| Pi profile、任务/记忆模型和样本政策 | `validation/suite.json` | 生成新 resolved run manifest；Provider/模型变化先由用户决定 |
| OpenViking 配置适配字段和凭据规则 | `config/openviking-adapter-contract.json` | 未经 schema 与适配器探针验证不得扩展支持 |
| 请求预算、timeout、retry 与租约 | 对应 Runtime/Payload profile 或责任模块 | profile/实现指纹变化使相关 evidence stale |
| 版本、usage、账单、端口与运行结果 | run artifact/evidence | 只由 runner 实际观测，不回写为长期配置 |

升级只修改对应权威入口；runner 解析实际坐标并生成带哈希的 resolved manifest，行为探针和 actual suite 通过后才替换稳定 evidence。长期文档引用权威来源或说明契约，不复制当前版本、模型和运行期测量值。
- 验证规格先定义需要证明和可能推翻设计的事实；
- runner 只保留当前责任需要的 fixture、观测和 checker；
- 当前实现不满足目标规格时更新 `DEVELOPMENT.md`，不让与当前规格不一致的 evidence 代替目标证明；
- 失败运行、blocked 证据和样本清单不可选择性删除；
- 新证据替代旧结论后更新稳定 evidence，不保留历史报告；
- 责任消失或被其它验证完整覆盖时，删除对应 check 和专用基础设施。
