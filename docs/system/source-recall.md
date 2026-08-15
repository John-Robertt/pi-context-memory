# 来源召回系统设计

## 1. 文档角色

本文定义 Pi 集成、Session 记忆协调、长时记忆与召回和来源追溯模块怎样协作实现 [`../features/session-recall.md`](../features/session-recall.md)。OpenViking 协议由 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 统一定义。

## 2. 目标与责任边界

来源召回复用 OpenViking 本地 embedding、向量索引和候选排序。Pi session、当前 branch 和原始 entry 决定查询范围并承担事实权威；OpenViking resource 只承担可重建索引责任。

本流程拥有来源向量索引、显式搜索和权威展开。Session Working Memory 与自动工作上下文由 [`context-enhancement.md`](context-enhancement.md) 负责。两条流程共享当前 Pi 路线、长时记忆来源、OpenViking 运行代际和统一故障状态，但拥有独立队列与内容算法。

## 3. 写入流程

```text
Pi 当前路线
  → Session 记忆协调验证并完成本地来源归档
  → 召回模块取得有可检索任务文本的当前来源
  → 每个来源上传到独立稳定 URI
  → OpenViking 以 vectors_only + no_split 建立向量索引
  → 扩展从预期 URI 精确读回内容
  → Session 记忆协调发布该路线索引状态
```

外部布局为 `<namespace>/<session-hash>/<entry-hash>/source.md`。每个 entry 使用独立资源子树；`no_split` 保持稳定 leaf URI。已有 URI 内容与同一 Pi entry 不一致时拒绝覆盖。

Pi 集成按 [`../modules/pi-integration.md`](../modules/pi-integration.md) 发布可检索 MessageSource。只有全-text 单元有正文；mixed/image/unsupported public block 整单元 opaque，当前 unknown role 按 Pi drop。thinking/private metadata、excluded bash、扩展私有内容、ControlBoundary、summary 与废弃 branch 也不建立候选。

索引在本地来源归档之后运行。普通生命周期可以合并尚未开始的重复路线；显式搜索具有当前调用专属的完整同步屏障。

## 4. 查询与采用流程

```text
recall_session(search)
  → Pi 集成取得当前 SessionRouteSnapshot
  → 排除当前 query、tool call 和 tool result
  → Session 记忆协调完成当前路线来源与索引屏障
  → 召回模块把当前 branch 的精确 URI 列表交给 OpenViking
  → 候选 URI 映射回当前路线来源
  → 返回经 Pi entry 核对的有限预览、entry ID 和 score

recall_session(read_source)
  → Session 记忆协调验证当前 branch
  → 按 entry ID 重新规范化当前 Pi 权威 message entry，并在 task-content、完成状态与 authority hash 一致后读取 MessageSource；若存在已核验完整结果 blob，可按同一来源身份读取有界切片；control entry 返回 not-found
  → 返回有界内容和截断状态
```

OpenViking 只在当前 branch 精确 URI 范围内排序。候选必须具有合法 URI 和有限数值 score；任一 malformed 候选使搜索失败。过滤保持 OpenViking 原始顺序，不实现第二套相关性算法。

搜索候选、最终命中、预览和来源展开都有固定上限。结果进入模型当前回合后继续受 ToolBatch 与工作上下文预算约束。

## 5. 错误与运行故障

错误分为：

- `input`：缺少 query、entry ID 或参数越界；
- `not-found`：entry 不存在或不属于当前 branch；
- `not-ready`：当前同步屏障仍在操作期限内；
- `source`：本地来源无法恢复或内容不一致；
- `backend`：OpenViking 连接、资源、索引或搜索失败；
- `protocol`：候选或 envelope 不可信。

input 与 not-found 作为工具结果返回，不改变运行能力。source、backend 和 protocol 表示本扩展召回数据面失效：当前工具返回错误、协调器锁存故障，后续增强构造不被确认并调用 `ctx.abort()`；宿主/transport 实际结果另行观测。

正常空结果只在当前路线来源同步成功且后端真实返回零有效候选时成立。任何故障都不能转换为空结果。

`read_source` 的权威展开可以只依赖 Pi 当前路线和本地来源；但若它发现来源损坏或身份不一致，仍进入统一来源故障。

## 6. 并发与恢复

- 同一 URI 和内容的并发同步共享请求；
- 同 URI 不同内容立即拒绝；
- 显式同步优先于未启动后台轮次；
- 同一调用的屏障完成全部当前来源后才搜索；
- 调用取消移除无人等待的任务；
- pending 和运行任务数量有明确上限；
- 外部资源删除后从当前已核验本地来源重建。

用户修复 OpenViking 或来源条件并显式建立新运行代际后，系统从当前 branch 重新同步资源。旧 branch 资源可以保留，但不进入当前查询目标。

## 7. 验证边界

[`../validation/source-recall.md`](../validation/source-recall.md) 证明稳定 URI、资源读回、并发同步、session 隔离、branch 过滤、候选错误、权威展开和运行故障集成。

[`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md) 分别证明召回错误时本扩展的 block/abort、transport 实际结果，以及用户选择重新验证后的新代际行为。
