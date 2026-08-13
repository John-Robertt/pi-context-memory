# Session 来源召回

## 1. 文档角色

本文定义任务模型能够观察到的按需召回行为。内部协作见 [`../system/source-recall.md`](../system/source-recall.md)，验证见 [`../validation/source-recall.md`](../validation/source-recall.md)。

## 2. 目标与边界

当早期信息已退出模型上下文时，任务模型可以通过统一的 `recall_session` 工具在当前持久化 Pi session 中搜索相关来源，并按 entry ID 展开当前 branch 上的权威条目。用户不需要管理索引或记忆生命周期。

召回只辅助当前任务，不自动注入上下文，不生成或修改记忆，不跨 session 搜索，也不采用已经离开当前 branch 的来源。

## 3. 可观察行为

`search` 接收自然语言查询和有限结果数，返回 OpenViking 排序后仍属于当前 branch 的来源 entry ID、相关性分数和权威内容预览。结果数量和每项内容均有界；没有有效命中时明确返回空结果。

`read_source` 接收前一步返回的 entry ID，并在该 entry 属于当前 branch 时展开 Pi 权威条目，同时标记内容是否因调用预算截断。旧 branch、其它 session 和不存在的 entry 返回不可采用状态。

OpenViking 未配置、不可达、超时或返回无效响应时，工具明确报告召回不可用；该失败不阻断 Pi 的 Agent 循环，也不伪装成“没有相关历史”。

## 4. 完成条件

- 不同 session 的冲突事实不会进入对方结果；
- branch 切换后，旧路线候选即使仍在外部索引中也不会进入模型结果；
- 压缩后可按语义找回代表性早期精确细节并展开到 Pi entry；
- 查询、预览和展开结果有界；
- 索引或查询失败时 Pi 原生任务继续；
- OpenViking 只决定候选相关性，关键事实仍来自 Pi 权威来源。
