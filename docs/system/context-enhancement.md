# 自动上下文增强系统设计

## 1. 文档角色

本文定义 Pi 集成、Session 记忆协调、长时记忆与工作上下文优化模块怎样协作，把 OpenViking Session Working Memory 和 context assembly 作为当前路线的有界增强上下文。用户可观察行为见 [`../features/context-enhancement-state.md`](../features/context-enhancement-state.md)，证明方法见 [`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md)。

## 2. 目标与边界

系统在不修改 Pi session 历史、tree、工具执行和原生压缩语义的前提下，用当前用户 prompt 之前的权威路线准备增强上下文。准备未完成、结果过期或 OpenViking 不可用时，本次模型调用保持 Pi 原生消息。

OpenViking 负责 Session Working Memory、活跃消息预算和 context assembly；Pi 当前 session、leaf、连续父链与原始 entry 决定结果能否采用。扩展不实现第二套摘要模型、相关性算法或事实权威。

## 3. 路线与采用身份

Session 记忆协调对每个快照验证 session ID、session file、leaf、entry 唯一性和连续父链，并从完整 entry 内容生成路线指纹。准备结果绑定：

- Pi session ID 与 session file；
- 当前历史 leaf；
- 有序 entry ID 集合；
- 完整路线指纹。

`context` hook 每次采用前重新计算路线身份，并轻量核对运行中 active/target setting、config 指纹及当前配置文件内容。只有运行配置代际与四项路线身份完全一致的就绪结果可以替换历史消息；仅 leaf 相同、后台任务完成或 OpenViking session 可读都不构成采用条件。

当前 prompt 及其后续 assistant tool call、tool result 始终保留为 Pi 原生消息。增强内容只替换当前 prompt 之前的历史，避免破坏 Provider 对工具调用序列的要求。

## 4. 准备与采用流程

```text
session_start / turn_end / session_tree / session_compact / before_agent_start
  → Pi 集成取得当前权威路线
  → Session 记忆协调验证路线并生成采用身份
  → 长时记忆模块按路线准备 OpenViking Session
      → 同一路线去重
      → 线性后继只追加新增 entry
      → 分叉路线使用隔离的 OpenViking Session
      → 达到归档阈值时 commit，等待 Working Memory 后台任务终态
      → 以固定 token budget 请求 context assembly
  → 工作上下文优化格式化有界增强历史
  → 就绪结果按完整路线身份和运行中记忆模型配置代际缓存

context
  → 重新取得当前 prompt 之前的路线身份
  → 精确命中就绪结果：增强消息 + 当前 Pi turn
  → 未命中、过期或错误：保持全部 Pi 原生消息
```

准备在 Provider 请求之外异步执行；OpenViking 延迟不能阻塞 Pi 原生调用。同一路线共享准备任务，运行任务之后只保留同一 Pi session 最新的未启动路线，防止旧分支形成无界积压；每个派生 session 的追加和 commit 保持串行。缓存与派生 session 数量有固定上限，淘汰只损失增强就绪度，不影响 Pi 历史。

## 5. 内容投影与预算

长时记忆模块把当前路线中的用户、assistant、工具结果、bash、自定义上下文、branch summary 和 compaction summary 投影为 OpenViking 文本消息，并通过 `source_message_ids` 保留 Pi entry ID。Pi compaction 投影遵循有效 compaction entry、`firstKeptEntryId` 保留范围和压缩后条目，并兼容自包含 `retainedTail`；模型切换、thinking level、label 和扩展内部状态不进入投影。

OpenViking 返回最新 Working Memory overview 与预算后的活跃消息。非空 overview 必须具备 OpenViking `0.4.13` 的七段 Working Memory 结构；通用计数回退或残缺 overview 不可采用。扩展把有效内容格式化为一个隐藏的 Pi custom message，并再次执行字符上限保护；不把 OpenViking 消息 ID、摘要或状态写回 Pi session。显式 `recall_session` 继续承担来源级核对，增强摘要不能替代 Pi 权威 entry。

## 6. 失败、分支与恢复

- 路线切换立即使旧指纹结果不可采用；迟到结果只能进入自己的路线缓存。
- OpenViking 创建、追加、commit、任务轮询或 context assembly 任一步失败，本轮保持 Pi 原生消息；失败、淘汰与关闭会尽力删除扩展自建的派生 Session，清理失败不阻断 Pi。
- 没有已配置且实际运行的记忆模型时不准备自动增强上下文，模型调用保持 Pi 原生；显式来源召回继续可用。
- 配置校验失败、active/target 指纹不一致或重启开始时立即禁用增强并销毁旧代缓存；新代配置与运行状态一致后才重建。
- tree、compaction、session replacement 与 reload 先把采用状态切回 Pi 原生；新实例或新路线只从 Pi 当前 leaf 重建，准备完成且实际进入 Provider 请求后再显示增强。

## 7. 验证与校准

共享长任务 fixture 固定目标更新、冲突路线、工具证据、compaction 和压缩后继续。本地 runner 证明完整 tree 往返、fork/clone/resume/reload、三类 compaction、路线精确采用、迟到结果隔离、预算上限、当前 turn 保留和后端故障降级。真实 Provider 成对质量 runner 证明同一任务模型下原生与增强 arm 均保持当前决定和证据入口；完整 API 成本继续由成本实验归集。
