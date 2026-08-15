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

后台运行检查以 Launcher 发布的受管 OpenViking 子进程作为运行代际。用户配置文件只描述下一次重启的目标；配置变化只刷新诊断，不能使仍在运行的实例、内存代际或缓存失效。runtime state 显示当前子进程停止或被新子进程替换时，扩展才取消旧任务并按新的 `launchId + childPid` 重建。`context` hook 本身不读取文件或启动 OpenViking 工作，只重新计算路线身份、核对当前运行实例，并可为同实例同路线的既有 pending 作有界等待。只有运行实例与四项路线身份完全一致的结果可以替换历史消息。

当前 prompt 及其后续 assistant tool call、tool result 始终保留为 Pi 原生消息。增强内容只替换当前 prompt 之前的历史，避免破坏 Provider 对工具调用序列的要求。

## 4. 准备与采用流程

```text
session_start / turn_end / session_tree / session_compact / before_agent_start
  → Pi 集成取得当前权威路线
  → Session 记忆协调验证路线并生成采用身份
  → 长时记忆模块按路线准备 OpenViking Session
      → 同一路线去重
      → 线性后继只追加新增 entry
      → OpenViking 镜像绑定 Pi session 与 session file；不同所有权或分叉路线使用隔离 Session
      → batch append 与必要的 commit Phase 1 在镜像快速队列内串行；Phase 1 返回后立即以固定 token budget assembly，来源核验后发布该精确路线 active history
      → `accepted` 的慢速 Phase 2 在队列外轮询；期间同一镜像继续追加线性后继，任务完成后按镜像最新 revision 重新 assembly，只提升仍匹配的最新精确路线
      → 每个镜像同时至多一个 commit task；期间新增 token 独立累计，旧任务完成后达到阈值才启动下一次 commit；`skipped` 保留 active history 且不轮询空 task ID
  → 工作上下文优化格式化有界增强历史
  → 就绪结果按完整路线身份和当前受管 OpenViking 子进程代际缓存

context
  → 重新取得当前 prompt 之前的路线身份
  → 精确命中就绪结果：增强消息 + 当前 Pi turn
  → 精确路线已有在途准备：最多等待 1000 ms，只观察该任务是否发布来源核验结果
  → 无精确 pending、等待超时、过期或错误：保持全部 Pi 原生消息并记为增强降级
```

准备在 Provider 请求之外异步执行；`context` hook 不读取配置、不创建任务，也不为无精确 pending 的路线访问 OpenViking。为避免零间隔下一轮早于 active assembly，它只可在同代际、同精确路线已有在途任务时等待最多 1000 ms；到期立即原生降级。同一路线共享准备任务，快速队列只串行创建、追加、commit Phase 1、assembly 和提升等镜像状态变更；慢速 Phase 2 轮询独立运行，不阻塞后续路线。运行中的快速操作之后只保留同一 Pi session 最新的未启动路线，防止旧分支形成无界积压。缓存与活跃派生 session 数量有固定上限；有 commit 在途的淘汰镜像先标记 retired，任务终态后再删除，淘汰只损失增强就绪度，不影响 Pi 历史。

## 5. 内容投影与预算

Pi 集成先把当前路线中的用户、assistant、工具结果、bash、自定义上下文、branch summary 和 compaction 规范化；长时记忆只把规范化结果投影为 OpenViking 文本消息，并通过 `source_message_ids` 保留 Pi entry ID。`firstKeptEntryId`、`retainedTail`、消息 role 与内容 block 的版本差异只在 Pi 集成边界解释。

OpenViking 返回 Working Memory overview 与预算后的活跃消息，具体字段和兼容差异由 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 统一归一化。commit 只接受 `accepted + task ID` 或 `skipped + 空 task ID`；后者表示保留窗口内没有可归档消息，不是失败。overview 的语言和标题不是生产协议；通用计数回退、矛盾或未知 commit 状态与无法归一化的响应不可采用。扩展把有效内容格式化为一个隐藏的 Pi custom message，并再次执行字符上限保护；不把 OpenViking 消息 ID、摘要或状态写回 Pi session。显式 `recall_session` 继续承担来源级核对，增强摘要不能替代 Pi 权威 entry。

## 6. 失败、分支与恢复

- 路线切换立即使旧指纹结果不可采用；迟到结果只能进入自己的路线缓存。
- OpenViking 创建、追加、commit Phase 1 或首次 context assembly 失败时，该精确路线不发布并按 Pi 原生接续；合法 `skipped` commit 保留 active history。Phase 2 失败、超时或最终 assembly 失败时，不采用未核验的 Working Memory，但保留 Phase 1 后已经来源核验的 active history；后续路线仍可继续追加和重试。迟到任务只能提升完成时镜像最新 revision 对应的精确路线，不能删除或覆盖更新路线。失败、淘汰与关闭会尽力删除扩展自建的派生 Session，清理失败不阻断 Pi。
- 没有已配置且实际运行的记忆模型时不准备自动增强上下文，模型调用保持 Pi 原生；显式来源召回继续可用。
- 配置校验失败或配置目标改变时，当前 ready 的受管实例继续提供增强，直到用户执行重启；重启预检失败同样保留旧实例。只有 runtime state 表明旧子进程已停止时才取消旧代缓存；新子进程 ready 后按新的进程代际重建。
- tree、compaction、session replacement 与 reload 使新实例或新路线只从 Pi 当前 leaf 重建；重建期间显示“增强记忆 · 初始化中”或“增强记忆 · 生效中”，准备结果实际进入 Provider 请求后显示“增强记忆”。只有服务不可用并强制回退时显示“Pi 原生”。

## 7. 验证与校准

共享长任务 fixture 固定目标更新、冲突路线、工具证据、compaction 和压缩后继续。本地 runner 证明完整 tree 往返、fork/clone/resume/reload、三类 compaction、路线精确采用、迟到结果隔离、预算上限、当前 turn 保留和后端故障降级。真实 Provider 成对质量 runner 证明同一任务模型下原生与增强 arm 均保持当前决定和证据入口；完整 API 成本继续由成本实验归集。
