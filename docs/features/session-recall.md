# Session 来源召回

## 1. 文档角色

本文定义任务模型能够观察到的当前 session 来源召回行为。内部协作见 [`../system/source-recall.md`](../system/source-recall.md)，验证见 [`../validation/source-recall.md`](../validation/source-recall.md)。

## 2. 目标与边界

早期信息退出工作上下文后，任务模型可以通过统一的 `recall_session` 工具在当前持久化 Pi session 和 branch 中搜索相关来源，并按 entry ID 展开权威条目。用户不管理索引或记忆生命周期。

召回不跨 session，不采用已经离开当前 branch 的来源，也不把 OpenViking 摘要提升为事实权威。召回结果进入当前回合后继续受增强工作上下文预算约束。

## 3. 可观察行为

### 3.1 `search`

`search` 接收自然语言 query 和有限结果数，返回 OpenViking 排序后仍属于当前 branch 的：

- 来源 entry ID；
- 有限数值相关性分数；
- 来自权威来源副本的有界预览；
- 内容是否需要进一步展开的提示。

没有有效命中时返回明确空结果。索引准备、后端错误、协议错误和正常空结果具有不同语义。

### 3.2 `read_source`

`read_source` 接收 entry ID，并在该 entry 仍属于当前 branch 时展开 Pi 权威条目。结果标明调用预算造成的截断，并提供继续读取完整来源所需的信息。

离开当前 branch、其它 session、不存在或内容不一致的 entry 返回不可采用状态。

### 3.3 错误与运行状态

缺少 query、entry ID 或参数越界属于工具输入错误，任务模型可以修正调用。

OpenViking 不可达、来源索引损坏、响应不可信或必要来源无法恢复表示增强记忆数据面失效：

1. 当前工具调用返回明确错误；
2. Session 记忆协调锁存对应故障；
3. 下一次任务模型请求在 Provider 前被阻断；
4. 用户通过诊断和显式恢复入口修复服务。

错误不能伪装成“没有相关历史”。

## 4. 完成条件

- 不同 session 的冲突事实不会进入对方结果；
- branch 切换后，离开路线的候选不进入当前结果；
- 早期精确细节可以按语义找回并展开到 Pi entry；
- query、候选、预览和展开均有界；
- 正常空结果、输入错误、索引准备和后端故障语义独立；
- 必要召回数据面失败后，新任务模型请求不进入 Provider；
- OpenViking 只决定候选相关性，关键事实来自 Pi 权威来源。
