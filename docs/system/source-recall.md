# 来源召回系统设计

## 1. 文档角色

本文定义 Pi 集成、Session 记忆协调、长时记忆与召回和来源追溯模块怎样协作实现 [`../features/session-recall.md`](../features/session-recall.md)。模块内部设计分别由对应模块文档拥有。

## 2. 目标与责任边界

当前设计复用项目适配的 OpenViking 本地 embedding、向量索引和相关性排序，外部协议及兼容责任由 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 统一定义。Pi session、当前 branch 和原始 entry 决定召回生效范围并承担事实权威；OpenViking resource 只承担可重建索引责任。

本流程只拥有来源向量索引和显式召回。Session Working Memory、context assembly 与自动采用已经进入 [`context-enhancement.md`](context-enhancement.md) 的独立流程；两者共享 Pi 路线权威，但不共享队列、排序或失败状态。

## 3. 写入流程

```text
Pi 当前路线
  → Session 记忆协调验证并完成本地来源归档
  → Session 记忆协调把索引工作交给独立的非阻塞执行轮次
  → 召回模块上传每个有任务文本的来源
  → OpenViking以 vectors_only + no_split 建立向量索引
```

外部布局为 `<namespace>/<session-hash>/<entry-hash>/source.md`。每个 entry 使用独立资源子树，因为 OpenViking会把同一 `to` URI 的后续 `add_resource` 视为资源树新快照；共享 session 目标会覆盖先前来源。`parse_mode=no_split` 防止长 Markdown 按标题改写 leaf URI。同步完成后必须从预期 URI 读回相同内容，已有内容不一致时拒绝覆盖。
Pi 集成规范化边界决定哪些 entry 具有可检索任务文本并统一解释消息、工具、bash、自定义上下文和压缩 checkpoint；模型切换、thinking level、label 等控制 entry 不进入索引。召回模块只负责有界 Markdown 投影，长内容保留首尾并标记省略。

索引发生在本地来源归档之后，并与归档队列分离。同一 session 只保留最新的未启动后台路线，显式同步优先于所有未启动后台索引；索引变慢、失败或服务停止不能延迟 Provider 请求，也不能使已经成功的来源归档失败。索引可由当前来源重新构建。

## 4. 查询与采用流程

```text
任务模型调用 recall_session(search)
  → Pi 集成取得当前 SessionRouteSnapshot
  → Session 记忆协调提供调用后启动的完整同步屏障，最多等待 5 秒；缺失资源从本地来源副本补齐
  → 召回模块把当前 branch 已确认来源 URI 列表作为 OpenViking 查询目标
  → 只保留 URI 能映射到当前路线 entry 的候选
  → 返回经当前 Pi entry 核对的有限来源预览、entry ID 与分数

任务模型调用 recall_session(read_source)
  → Session 记忆协调验证当前路线
  → 按 entry ID 展开并核对 Pi 权威条目
  → 返回有界内容
```

OpenViking 只在当前 branch 的精确来源 URI 列表内排序；合法但不属于当前路线的 URI 和重复 URI 由本地核对排除，任一缺少合法 URI 或有限数值 score 的候选则使本次搜索失败，不能表现为正常空结果。过滤保持 OpenViking 原始排序，不实现第二套相关性算法。后端最多返回 100 个候选，最终最多返回 10 项。

显式工具执行前会同步完成当前路线的本地归档；搜索重新同步当前 prompt 之前的历史来源并核对 OpenViking 中的精确 URI，避免为了回答一次召回而把本次 query、tool call 和 tool result 先写入索引。

## 5. 失败与恢复

索引错误单独记录，不改变归档可用状态；后续路线提交或显式搜索会重试未确认来源。每次搜索都等待一个在本次调用后启动的完整同步轮次，而不复用已经运行的路线任务；同一路线可共享尚未启动的后续轮次，每条路线最多保留一个这样的 generation。调用取消或最多 5 秒等待到期后，无人等待的待执行轮次被移除，运行轮次被取消；资源缺失时先从已核对的本地来源副本重建，未完成或失败时明确报错，不查询可能不完整的索引。只有同步成立后后端真实返回零候选才是正常空结果。没有持久化 Pi session 时不建立索引，召回工具明确失败。

`read_source` 只依赖当前 Pi 路线和本地来源，因此不要求 OpenViking 可用。外部资源删除不会删除 Pi session、本地来源副本或完整工具结果；下一次显式搜索会先重建当前历史路线的缺失资源。

## 6. 已验证边界

[`../validation/source-recall.md`](../validation/source-recall.md) 已在 runner 控制的 OpenViking 配置与进程中验证稳定 URI、`vectors_only` 资源、外部资源删除后的同实例重建、调用后完整重同步、session 隔离、branch 过滤、来源预览与 Pi 权威 entry 展开、结果边界、慢索引协调，以及索引和查询错误语义。

Working Memory 与自动上下文采用的控制流证据由 [`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md) 承担；真实任务模型语义质量和完整成本仍由当前开发入口的纵向实验验证。
