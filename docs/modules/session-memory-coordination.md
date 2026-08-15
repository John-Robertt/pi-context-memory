# Session 记忆协调模块

## 1. 当前责任

本模块是每个持久化 Pi session 内记忆生命周期、运行故障和任务模型请求授权的协调者。它接收 Pi 集成提供的会话事实，统一约束来源归档、OpenViking Working Memory、当前回合投影和最终工作上下文。

它不生成派生记忆、不执行 OpenViking IO、不构造 Provider payload，也不解析任务业务语义。跨模块流程见 [`../system/context-enhancement.md`](../system/context-enhancement.md)、[`../system/source-archiving.md`](../system/source-archiving.md) 和 [`../system/source-recall.md`](../system/source-recall.md)。

## 2. 拥有的状态

每个协调实例固定属于一个 Pi session ID 与 session file，并拥有：

- 运行状态：`initializing | ready | faulted | stopping`；
- 当前 OpenViking 运行代际与能力证明；
- 每条精确路线的 `preparing | ready | failed` 状态；
- 来源归档与完整结果屏障；
- 有界 pending 请求授权和单次请求证明；
- 故障错误码、脱敏原因、发生阶段和恢复入口。

用户配置目标、OpenViking 子进程、来源文件和实际上下文内容由相邻模块拥有；协调模块只保存必要引用、身份和有效性状态。

## 3. 路线身份与不变量

每次操作接收当前路线快照：session ID、session file、实际 leaf，以及从根到 leaf 的规范化 message entry 与 ControlBoundary。协调模块从中派生完整 `SessionRouteSnapshot`、当前 prompt 之前的 `HistoricalRouteKey` 和 prompt 之后的 `CurrentTurnKey`。必须同时满足：

1. 快照身份与协调实例完全一致；
2. entry ID 唯一，父链从根到 leaf 连续；
3. 非空路线的末 entry 等于 leaf；
4. message entry 的完整内容参与路线指纹；ControlBoundary 只以 type、ID、parent 和边界引用参与，summary、retainedTail、details 与 usage 不参与；
5. CurrentTurn 实际消息具有稳定顺序和内容哈希；已持久化部分与 Pi entry 精确一致，投影内容必须具有权威 entry 与来源；
6. 来源列出和展开只返回当前快照仍存在的权威 message entry；
7. message 来源副本与同 ID 的 Pi entry 内容一致，ControlBoundary 与同 ID control entry 身份一致且不含 summary 文本；
8. 派生结果的运行代际与当前未过期能力证明一致；
9. 请求授权同时绑定实际 leaf、HistoricalRouteKey、CurrentTurnKey 和最终内容哈希。

任一条件不成立时拒绝该输入，不用本地缓存或 OpenViking 数据修补 Pi 当前状态。

## 4. 运行状态机

```text
initializing
  → 能力证明与当前来源可用 → ready
  → 任一必要条件失败       → faulted

ready
  → 配置、服务、模型、来源、路线、内容或证明失败 → faulted

faulted
  → 显式重启或重新验证创建新代际 → initializing

任意状态
  → session shutdown → stopping
```

`faulted` 是锁存状态。后台任务成功、文件变化或服务自行恢复不能直接回到 ready；恢复必须创建新代际并重新核验当前 branch。

路线 pending 是 ready 运行状态内的内部状态，不改变用户展示。路线失败或操作期限结束使运行状态进入 faulted。

## 5. 对外能力

本模块提供：

- 验证并归档当前路线；
- 计算完整路线身份；
- `awaitGenerationReady`：让初始化期间的请求等待当前代际能力屏障；
- `ensureRouteReady`：创建、复用或等待精确路线准备；
- `awaitAuthorityEntry`：把需要投影的实际 CurrentTurn 消息核对到已持久化 Pi entry；
- `ensureSourceBarrier`：确认被投影内容具有可恢复来源；
- `authorizeRequest`：组合运行、路线、来源和上下文构造结果，返回允许或阻断；
- `verifyRequestProof`：在最终 Provider 边界原子复核并消费单次请求证明；
- `latchFault`：原子锁存首个当前代际故障和后续相关证据；
- `beginGeneration`：显式恢复时清理旧代派生状态并进入初始化；
- 当前路线来源列表和权威展开；
- 有界的后台索引、准备、取消与 shutdown 协调。

请求授权结果只有：

```text
allow { enhancedContext, requestProof }
block { faultCode, diagnostic }
```

不存在返回原始 Pi messages 的授权结果。

## 6. 并发与期限

- 同一运行代际共享一个能力初始化或续租任务；
- 同一运行代际和路线共享一个准备任务；
- 同一 session 的来源写入保持 entry 顺序；
- 新线性路线可以复用已完成前缀；
- 分叉路线拥有独立派生状态；
- 未启动的过期路线可以被更新路线替代；
- 已运行任务保留自己的身份，迟到结果不能进入当前路线；
- pending、ready、索引和清理任务都有固定上限；
- 操作期限结束形成明确失败，不选择另一条请求路径；
- 调用取消只移除对应等待者；最后一个消费者离开时可取消未发布任务并恢复 absent，不改变已经发布的其它路线事实或锁存服务故障。

## 7. 故障语义

故障按责任分类：

- `configuration`：用户配置、schema、连接字段或凭据；
- `runtime`：Launcher、子进程、readiness 或运行代际；
- `capability`：记忆模型实际能力；
- `source`：归档、完整输出、哈希、身份或恢复；
- `route`：session、leaf、父链、指纹、迟到结果或期限；
- `protocol`：OpenViking 响应未知、矛盾或缺失；
- `context`：工具批次、预算、内容形态或来源投影；
- `provider-proof`：最终 payload 与授权决定不一致；
- `shutdown`：关闭和资源清理。

故障记录不包含凭据或完整 payload。当前代际已经锁存故障后，后续请求直接返回同一主故障，并可追加不改变主归因的观测。

## 8. 恢复与 session 生命周期

显式重启或能力重新验证成功后，Pi 集成调用 `beginGeneration`：

1. 取消旧代 pending；
2. 清除旧代 ready 和请求证明；
3. 保留 Pi 权威 session 与已核验本地来源；
4. 绑定新 OpenViking 代际和能力证明；
5. 重新验证当前 branch；
6. 准备合法空路线或当前历史路线；
7. ready 后允许新的任务模型请求。

session replacement、fork、clone、resume 和 reload 创建与新 session 身份绑定的协调实例。shutdown 进入 stopping，拒绝新授权并有界等待必要来源写入。

## 9. 验证边界

验证必须覆盖：

- 跨 session、损坏父链、相同 entry ID 不同内容和错误 leaf 拒绝；
- 路线 pending 对用户状态不可见；
- 慢路线等待、取消、超时、替代和迟到结果隔离；
- 来源屏障失败阻断 Provider；
- 当前代际任一必要故障锁存并阻断后续请求；
- 显式恢复创建新代际且不复用旧结果；
- allow 请求具有唯一证明，block 请求不增加 Provider 调用；
- 并行工具与快速路线变化不产生无界队列；
- shutdown 不泄漏任务或污染替换 session。
