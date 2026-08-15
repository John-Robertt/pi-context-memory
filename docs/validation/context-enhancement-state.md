# 上下文增强回退与状态验证

## 1. 验证责任

本文定义如何证明 [`../features/context-enhancement-state.md`](../features/context-enhancement-state.md) 中当前已实现的有界上下文采用、路线隔离和 Pi 原生降级，并规定后续 tree、compaction 与持久状态纵向验证继续使用的共同 fixture。稳定本地结果保存于 [`../../validation/evidence/context-enhancement.json`](../../validation/evidence/context-enhancement.json)。

## 2. 共享 fixture 与观测

[`../../validation/fixtures/context-enhancement-long-task.json`](../../validation/fixtures/context-enhancement-long-task.json) 固定：

- 多轮目标与硬约束更新；
- 共同前缀后的冲突路线 A、当前路线 B 与 abandoned branch summary；
- assistant tool call、当前路线工具证据和来源 entry ID；
- Pi compaction summary 与压缩后继续的用户 prompt；
- 当前决定、禁止采用的旧决定和最终 checker 输入。

每次模型请求至少观察当前 session ID、leaf ID、路线指纹、输入消息哈希、实际采用路径和增强内容哈希。日志不保存完整 Provider payload；runner 的隔离原始产物只保存在 Git 忽略的 `.artifacts/`。

## 3. 当前本地纵向验证

```bash
node scripts/validate-context-enhancement.mjs
node scripts/check-validation-evidence.mjs
```

runner 使用协议兼容的 OpenViking 与本地任务 Provider 替身，不访问外部 Provider。它验证：

- session、session file、leaf、有序 entry 和完整内容形成唯一采用身份；即使历史投影完全相同，不同 session 或 session file 也不得复用 OpenViking 镜像；
- 线性路线复用同一 OpenViking Session，冲突 branch 使用隔离 session；
- 旧路线任务完成时不能被当前路线取得；
- 正在执行的路线之后只保留最新未启动路线，旧排队路线被明确替代；
- Pi entry ID 通过 `source_message_ids` 进入 Working Memory；
- OpenViking Session create、batch append、commit、task polling 和 context assembly 协议完整执行；`accepted` 的 Phase 1 返回后立即发布 active history，Phase 2 在快速路线队列外轮询，运行期间连续线性路线均在 1000 ms 内得到精确 active context；每个镜像至多一个 commit task，期间新增 token 不被旧任务清零，完成时只按最新 revision 提升最新精确路线；`skipped` 携带空 task ID、保留来源核验 active history 且不访问 tasks API；生产默认终态期限为 180 秒，期限内完成的慢任务以 Working Memory 最终 assembly 更新最新路线，超过期限时保留已核验 active history；
- Pi compaction 投影保留 `firstKeptEntryId` 范围、压缩后条目，并兼容自包含 `retainedTail`；
- Working Memory overview 的标题、语言和可选 token 统计不构成生产协议；本地归一化拒绝缺失来源 ID、未知内容形态、空 active tail、通用失败回退和其它 malformed 响应；
- `context` hook 在当前运行实例或精确路线没有在途准备时立即发送 Pi 原生请求；精确路线已有在途任务时只等待最多 1000 ms，来源核验 active history 一旦发布便不等待 Working Memory commit 即可采用，超时仍按原生降级；待应用配置变化不使当前实例失效，runtime state 确认子进程停止或替换后才取消旧代并恢复；实际采用路径与用户状态分别观测；
- 当前 prompt 及其后的 assistant/tool 消息保持原对象和顺序；
- Pi `context` hook 的当前受管子进程代际在真实本地 Provider payload 中采用增强历史；启动首轮和故障路径可保持 Pi 原生，待应用配置与 active 设置不同、配置目标变为 null 或核验进程不持有 Launcher 凭据时，当前 ready 实例仍持续准备并采用增强；
- 用户文本包含增强标题时仍不能伪造 Provider 采用状态；
- 初始 assembly 故障期间实际请求与 UI 保持 Pi 原生，同路线重建成功后恢复增强；Phase 2 失败、超时或最终 assembly 失败时不采用未核验 Working Memory，但保留 Phase 1 后来源核验的 active history；慢任务在途的镜像淘汰和 shutdown 不污染更新路线，扩展自建 Session 在正常关闭、commit 在途和创建响应在途时均得到清理；
- `/tree` A→B→A、回到根、带与不带 branch summary 的选择均按操作后 leaf 重建，并在关键路线实际发送 Provider 请求核对采用与分支隔离；
- `/fork`、`/clone`、每次 `/resume` 与 reload 均等待对应 session/file/leaf 重建后实际发送 Provider 请求；
- 手动、阈值和 overflow compaction 均先保持 Pi 原生路径、只采用操作后的有效投影，并在精确 ready 后由下一次任务 Provider 请求恢复增强；overflow 自动重试对增强超限 payload 持续失败，必须改用不同的 Pi 原生 payload；
- 每个经过 Pi `context` / `before_provider_request` 的对话任务请求都用 payload hash 关联真实 Provider 接收时刻；Provider 实际采用路径继续与 payload 一致，用户状态则独立证明“初始化中 → 生效中 → 增强记忆”及故障时精确的“Pi 原生”转换；Pi 内部摘要请求不冒充对话采用状态；取消 tree 或 compaction 时保持既有生命周期状态。

通过条件是所有稳定 checks 为 `true`，且 evidence 的实现文件哈希与当前仓库一致。

## 4. 当前证据边界

本地 runner 证明控制流、协议、完整 Pi tree/session/compaction 生命周期、有界消息构造、实际 Provider payload 采用和故障降级，不访问外部 Provider。

真实采用入口从 [`../../validation/model.json`](../../validation/model.json) 的单一 `openRouterModel` 派生任务路线 `openrouter/<openRouterModel>` 和记忆路线 `litellm/openrouter/<openRouterModel>`，并核对 `PCR_MEMORY_MODEL_SETTINGS` 解析到的配置（未设置时才回落到用户配置）及同一环境下的托管 runtime；开发验证可让 launcher 与 runner 共用仓库 `.artifacts/` 下的隔离配置和 runtime，不要求修改用户文件。runner 只需选择 `skipped|accepted` 场景，固定 5 秒宿主启动窗口但不轮询或预等待 Working Memory。skipped 场景在首轮结束后零间隔发出第二轮；accepted 场景预置超过保留窗口的历史，要求 Provider 先采用 active history、同一路线最终 Working Memory 后完成。该入口属于模型能力与成本验证，原始产物只保存在 Git 忽略目录：

```bash
PCR_REAL_ADOPTION_SCENARIO=accepted \
node scripts/validate-real-context-adoption.mjs
```

将场景改为 `skipped` 可验证零轮次间隔的 no-op commit 路径。任务与记忆调用都经 OpenRouter，后者由 OpenViking 的 LiteLLM adapter 路由。

真实记忆模型质量使用同一 fixture 的独立成对入口：

```bash
node scripts/validate-context-quality.mjs
```

该 runner 的 evidence 坐标固定为 Pi `0.84.2` 与 OpenViking `0.4.13`，固定单次 native→enhanced 顺序；它通过 Pi `auth print-api-key --provider openrouter` 复用 Pi 已解析的认证，把 key 只放入本次 Launcher 的 `PCR_CONTEXT_QUALITY_OPENROUTER_API_KEY` 环境，并把派生记忆路线及对应环境引用写入当前 run 的 `0600` `.artifacts/context-quality/<run>/memory-model.jsonc`。Pi 验证子进程继续使用自己的认证存储，不继承该隔离变量；runner 不读取或改写 `~/.pi/pi-context-memory.jsonc`。观察扩展核对 Pi thinking、active tools、system prompt 与 Provider 模型；adapter probe 证明配置的 LiteLLM OpenRouter 路由、temperature `0` 和 API key 被转发，但 reasoning 不被转发。任务要求从当前路线事实判定方案，增强 arm 还必须观察 Working Memory 就绪并在实际 Provider 请求采用。稳定结果保存于 [`../../validation/evidence/context-quality.json`](../../validation/evidence/context-quality.json)，并记录本次实际模型坐标与脱敏凭据来源；配置、日志、结果和 evidence 均不保存 key。

当前尚未闭合的是完整 billed cost：质量 runner 已保存 Pi 任务模型统计和 OpenViking 记忆模型 token 归属，但尚未把每个 generation 与 OpenRouter 最终账单逐项关联，因此不能据此宣称完整成本优势。

任一当前路线污染、工具序列破坏、错误状态展示或质量退化都会推翻对应设计，并要求回到最早缺少证据的采用边界。
