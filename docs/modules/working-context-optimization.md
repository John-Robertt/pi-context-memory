# 工作上下文优化模块

## 1. 当前责任

本模块构造任务模型实际工作上下文，负责扩展启用期间的自动压缩、跨轮历史预算和当前回合工具结果治理。

它接收 Session 记忆协调确认有效的路线、长时记忆提供的 Working Memory 与来源、以及 Pi 集成规范化的实际 current turn。它不判断当前 branch、不维护 OpenViking Session、不修改 Pi 历史，也不拥有 Provider、UI 或进程生命周期。

跨模块流程见 [`../system/context-enhancement.md`](../system/context-enhancement.md)，验证见 [`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md)。实现入口为 [`.pi/extensions/pi-context-memory/working-context-optimization.ts`](../../.pi/extensions/pi-context-memory/working-context-optimization.ts)。

## 2. 输入与输出

输入包含：

- 当前运行代际和完整路线身份；
- OpenViking Working Memory overview；
- 来源核验的 active history；
- 当前 user prompt；
- prompt 后的 assistant、tool call、tool result、bash、自定义和召回消息；
- 每项来源的可恢复证明；
- 当前 system prompt、active tool schema 及其规范化哈希；
- Pi 集成提供的 ProviderPayloadProfile（Provider、模型、API、适配版本与保守大小估算）；
- 任务模型上下文窗口和保留输出预算。

输出包含：

- 隐藏增强历史消息；
- 有界 current turn 消息；
- 运行代际与路线身份；
- 最终内容哈希和请求 nonce；
- 使用的来源 entry ID；
- 原始、保留、投影和省略预算统计。

无法构造可信结果时返回结构化失败，不返回空值或原始 Pi messages。

## 3. 上下文结构

任务模型输入按稳定顺序构造：

```text
EnhancedHistory
  当前 Working Memory
  + 来源核验 active history
  + 已采用召回结果

CurrentTurn
  当前 user prompt
  + assistant 文本
  + raw ToolBatch 或 projected ToolBatch
  + 其它允许的当前回合消息
```

`EnhancedHistory` 是一个或多个隐藏 custom message。`CurrentTurn` 保持任务推进顺序，但不要求所有工具输出原样保留。

首轮允许空历史，但仍生成包含运行代际、空路线和来源边界的合法增强消息。

## 4. ToolBatch 解析

一个 `ToolBatch` 包含：

- 一个带一个或多个 tool call 的 assistant 消息；
- 这些调用对应的全部最终 tool result；
- assistant 消息中的相关文本与 thinking 是否进入模型输入，由 Pi 协议规范化决定。

解析必须验证：

1. tool call ID 唯一；
2. 每个调用有且只有一个最终结果；
3. 结果属于同一 assistant 批次；
4. sibling 结果的完成顺序不改变 assistant 源顺序；
5. 内容 block 为已支持形态；
6. 批次来源与当前 session、branch 和路线一致。

验证失败返回 `tool-protocol` 错误。

## 5. 工具批次投影

### 5.1 保留策略

保留策略只依据来源顺序、大小、预算和协议状态，不另行推测工具内容价值：

1. 单批次超过 raw 上限时先形成 projected；
2. 计算完整 CurrentTurn 与预留项后的总量；
3. 超预算时按最旧批次优先，把仍为 raw 的完整批次逐个替换为 projected；
4. 每次替换后重新计算，直到满足预算或没有可替换批次；
5. 全部批次使用最小合法投影后仍超限时返回 `context-budget`。

因此近期批次在预算允许时保持 raw，错误、否定结果和来源信息则由每个 projected 批次的强制字段保证。

### 5.2 投影不变量

投影以完整批次为单位替换 tool call 和 tool result，由本地确定性算法生成，不调用任务模型或记忆模型。表示必须包含：

- 批次顺序、工具名称和调用 ID；
- assistant 文本与允许 thinking block 的类型、大小、哈希和有界 head/tail；
- 参数规范化 JSON 的大小、哈希与固定上限 head/tail；
- 每个结果的成功、错误、取消和截断状态；
- 已支持 content block 的类型、大小、哈希与固定上限 head/tail；
- 为错误、否定文本和完成状态预留的不可省略区域；
- 完整输出路径、Pi entry ID、来源内容哈希或 `recall_session` 展开入口；
- 原始与投影大小、省略范围和恢复方式。

未知 content block、图片语义无法保留、来源未就绪或投影无法表达必要信息时返回失败。

### 5.3 来源前置条件

projected ToolBatch 只能引用长时记忆已确认可恢复的来源。工作上下文构造不自行写文件或调用 OpenViking；它向 Session 记忆协调返回所需来源集合，由协调模块完成屏障后重新构造或继续。

## 6. 预算与选择顺序

预算由任务模型上下文窗口减去 system prompt、tool schema、输出保留和传输余量得到。大小取 ProviderPayloadProfile 的任务模型估算与 UTF-8 保守上界中的较大值；profile 不能为目标 API 提供有界规范化时返回 unsupported，不以乐观估算发送。

模块按以下优先级选择内容：

1. 当前 user prompt；
2. 保持 Provider 合法所需的 CurrentTurn 结构；
3. 当前回合未解决错误、否定结果和必要证据；
4. 当前有效且已经适配器限界的完整 Working Memory；
5. 来源核验的近期 active history；
6. 已采用召回结果和补充背景。

选择过程保持确定性：相同输入、配置和来源得到相同内容与哈希。预算不足以保留前四类必要内容时返回 `context-budget` 故障，不继续压缩必要事实。

## 7. 增强证明

每个成功输出生成一次性证明，至少绑定：

- 运行代际；
- session ID 和 session file；
- 实际 request leaf 与 HistoricalRouteKey；
- CurrentTurnKey（prompt、后续消息与顺序）；
- system prompt 与 active tool schema 哈希；
- 上下文消息内容哈希；
- 请求 nonce；
- 来源集合；
- 预算版本；
- ProviderPayloadProfile 身份（任务 Provider、模型、API 与适配版本）。

证明随隐藏增强消息进入 Provider 序列化结果，并供 Pi 集成在最终请求边界核验。用户文本不能伪造该证明。

## 8. 错误语义

模块返回稳定分类：

- `empty-input`：缺少合法 current prompt 或增强边界；
- `tool-protocol`：调用与结果不完整或错配；
- `unsupported-content`：存在无法可靠处理的内容；
- `source-required`：投影需要尚未完成的来源屏障；
- `source-unrecoverable`：必要内容没有可恢复来源；
- `context-budget`：必要内容无法进入模型窗口；
- `memory-malformed`：Working Memory 或 active history 不符合适配契约；
- `route-mismatch`：输入与路线身份不一致。

错误不生成部分增强消息。Session 记忆协调负责把必要失败锁存为运行故障。

## 9. 验证边界

验证必须覆盖：

- 首轮空历史增强消息；
- 多轮历史稳定、有界和来源绑定；
- 单批和多批并行工具调用；
- 快速连续产生的最大边界工具输出；
- raw/projected 批次的 Provider 协议合法性；
- 错误、取消、否定结果、截断和完整输出恢复；
- 相同输入的确定性内容与哈希；
- current turn、系统 prompt、工具 schema 和输出余量共同预算；
- 未知内容、来源失败和预算不足返回明确故障；
- Provider payload 中增强证明与构造结果一致；
- 复杂长任务 checker 能依据投影继续正确行动。

当前实现与设计之间的状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
