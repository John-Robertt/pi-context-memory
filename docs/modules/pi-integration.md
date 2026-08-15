# Pi 集成模块

## 1. 当前责任

本模块是系统与 Pi 的唯一集成边界。它观察 Pi 生命周期，通过 `pi-session-protocol.ts` 将版本化 session entry 和消息形态规范化为下游稳定输入，注册用户命令与召回工具，并执行增强上下文、自动压缩和最终 Provider 请求的宿主边界动作。

来源、OpenViking Session 和记忆模型能力由长时记忆模块拥有；运行与路线决定由 Session 记忆协调拥有；有界消息构造由工作上下文优化拥有；排序与来源展开由召回模块拥有；OpenViking 子进程由项目启动器拥有。

实现入口位于 [`.pi/extensions/pi-context-memory/index.ts`](../../.pi/extensions/pi-context-memory/index.ts)。跨模块流程见 [`../system/context-enhancement.md`](../system/context-enhancement.md)、[`../system/memory-model-runtime.md`](../system/memory-model-runtime.md)、[`../system/source-archiving.md`](../system/source-archiving.md) 和 [`../system/source-recall.md`](../system/source-recall.md)。

## 2. 输入与规范化边界

模块从 Pi 读取：

- session ID 与持久化 session file；
- 当前 leaf 和从根到 leaf 的 branch entry；
- `context` 中的实际 Agent messages；
- 当前 system prompt 与 active tool schema；
- tool call、tool result 和 assistant 消息生命周期；
- compaction、tree、fork、clone、resume、reload 和 shutdown 事件；
- 最终 Provider payload；
- 当前模型、上下文窗口和取消信号。

`pi-session-protocol.ts` 独占解释 Pi 版本差异，包括 message role、content block、`firstKeptEntryId`、`retainedTail`、branch summary、bash 与完整输出位置。下游模块只接收稳定的 session、route、current turn 和来源表示。compaction/branch summary 被规范化为不含 summary 文本的 `ControlBoundary`，不得伪装成 user message。

```text
ControlBoundary = {
  type: "compaction" | "branch-summary",
  id,
  parentId,
  firstKeptEntryId? | fromId?
}
```

`summary`、`retainedTail`、`details` 和 `usage` 不进入该下游表示；compaction 前仍在当前 parent 链上的原始 message entry 按其自身身份读取，branch summary 的 `fromId` 只用于边界身份而不展开废弃 branch。

临时 session 没有可恢复来源，不具备增强记忆请求条件。扩展保持初始化或故障状态，直到进入持久化 session 或用户禁用扩展重新启动。

## 3. 对外能力

本模块提供：

- Pi 生命周期到 Session 记忆协调的稳定事件输入；
- `context` 阶段的增强请求闸门；
- 为工作上下文优化提供 ProviderPayloadProfile；
- `before_provider_request` 阶段的最终增强证明核验；
- `session_before_compact` 的增强压缩所有权；
- `session_before_tree` 的 tree summary 抑制；
- `recall_session(search|read_source)`；
- `/memory-model` 和 `/restart-viking`；
- “增强记忆 · 初始化中”“增强记忆”和“增强记忆 · 故障”状态；
- 脱敏的请求、阻断、来源、运行代际和生命周期观测。

## 4. 请求闸门

### 4.1 `context`

每次任务模型调用前：

1. 读取当前 session、branch 和实际 messages；
2. `initializing` 时加入当前代际能力屏障；
3. 请求 Session 记忆协调授权当前请求；
4. 等待精确历史路线、来源屏障和当前回合投影；
5. 重新核对 session、leaf、路线和运行代际；
6. 成功时返回工作上下文优化构造的增强消息；
7. 失败时调用 `ctx.abort()`，保存阻断原因并按责任更新运行状态。

扩展抛错不是阻断机制。最外层 handler 捕获所有可预期错误，并把它们转换为确定的授权失败；返回原始 Pi messages 不是合法结果。

### 4.2 最终 Provider 核验

`before_provider_request` 使用与当前任务 Provider API 匹配的 `PayloadProofAdapter`，把最终序列化 payload 归一化为可核对的模型、系统、工具 schema 与有序消息表示，再与 `context` 保存的预期模型和 Agent messages 比较。核验同时绑定 nonce、代际、实际 leaf、HistoricalRouteKey、CurrentTurnKey、内容哈希和适配版本。

只有完整表示与授权决定一致的 payload 可以发送。未知 API、未知 payload 形态、必要字段缺失、消息变化或证明不一致都返回 `provider-proof` 故障；适配层不能只检查 sentinel 存在。

核验失败时调用 `ctx.abort()`。观测记录 Provider、模型、payload 哈希、增强证明和阻断码，不保存完整 payload。

## 5. Pi 原生摘要抑制

`session_before_compact` 在扩展运行期间确定性取消 Pi compaction：

- threshold 和 overflow 锁存工作上下文故障；
- manual 提示增强记忆已经自动管理上下文；
- handler 不调用外部服务，确保 compaction 决定简单、同步且可验证。

`session_before_tree` 不等待记忆服务。Pi `0.84.2` 中，用户选择 summary 时先提示“增强记忆已禁用 tree summary，本次按无摘要导航”，再返回 `{ summary: { summary: "" } }`：宿主因此跳过原生 summarizer，继续无摘要导航且不创建 `branch_summary` entry。未选择 summary 时不改变导航。宿主升级若尚未通过该行为探针，则带 summary 的操作返回 `{ cancel: true }`，不得冒险放行原生摘要请求。

`pi-session-protocol.ts` 发布 `treeSummarySuppressionVerified` 宿主能力；当前只对通过行为探针的 Pi `0.84.2` 为 true，无法确定版本或未验证版本一律为 false。

Pi session 中已有 compaction 和 branch summary entry 的身份、顺序与分支关系仍用于路线解释；其 summary 文本一律从长时记忆、来源召回、工作上下文与 Provider 证明输入中排除。compaction 前的原始 message entry 仍按当前 branch 读取；branch summary 指向的废弃 branch 内容不回灌当前路线。

## 6. 状态与诊断

用户状态只由运行生命周期驱动：

- `initializing` → “增强记忆 · 初始化中”；
- `ready` → “增强记忆”；
- `faulted` → “增强记忆 · 故障”。

路线 pending、队列长度、镜像变化和 Working Memory task 不改变 ready 状态展示。故障诊断通过通知、`/memory-model` 和脱敏观测提供具体原因。

配置文件变化只刷新目标配置诊断，不改变当前 ready 运行代际。重启和能力重新验证由显式命令触发。

## 7. 来源与召回集成

模块在 session、turn、tree、compaction 和 shutdown 生命周期提交当前权威路线归档。当前回合需要投影大工具结果时，授权流程等待对应来源屏障。

`recall_session` 每次执行都重新取得当前 branch：

- `search` 在当前路线来源中使用 OpenViking 排序；
- `read_source` 展开当前 Pi 权威 entry；
- 结果进入当前回合后仍受工作上下文预算约束。

召回错误以工具错误返回；若错误表明必要记忆数据面已经失效，Session 记忆协调同时锁存运行故障。

## 8. 生命周期与关闭

```text
session_start
  → 建立协调实例并进入初始化
  → 检查受管代际和能力证明
  → 从当前 branch 恢复来源与增强上下文

before_agent_start / turn_end
  → 提交当前路线和来源准备

model_select
  → 清除 pending 请求证明和模型预算缓存
  → 核对新模型 API 的 PayloadProofAdapter

context / before_provider_request
  → 授权、应用并核验增强请求

session_tree / session replacement / reload
  → 以操作后的 session 和 leaf 重建

session_shutdown
  → 停止接受请求
  → 有界等待必要来源写入
  → 取消运行任务并清理扩展资源
```

关闭不自动发送消息或继续中断任务。清理结果进入观测。

## 9. 验证边界

本模块必须证明：

- 每个已发送 Provider payload 都与当前增强授权一致；
- 声明支持的任务 Provider/模型/API 组合具有实际 Provider 响应证据，只有 controlled adapter 检查的组合保持未验证；
- 配置、服务、模型、来源、路线、预算和 payload 失败时 Provider 请求数不增加；
- 多工具和大输出 current turn 保持 Provider 协议合法；
- Pi compaction 和 tree summary 均不产生摘要请求，tree 不新建 `branch_summary` entry；
- 已有 compaction/branch summary 文本不进入任何下游内容；
- tree、fork、clone、resume 和 reload 后只采用新路线；
- 路线等待不进入用户状态；
- 禁用扩展并重新启动后 Pi 原生行为不受扩展运行状态影响。

当前实现与设计之间的交付状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
