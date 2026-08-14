# 工作上下文优化模块

## 1. 当前责任

本模块是任务模型工作上下文的构造者。它接收长时记忆模块形成的 OpenViking Working Memory 与预算后活跃消息，生成可由 Pi 集成采用的有界历史消息。Pi session 仍是事实权威；本模块不判断 branch 是否当前、不维护 OpenViking Session、不修改 Pi 历史，也不拥有 UI、tree、compaction 或 Provider 生命周期。

跨模块流程见 [`../system/context-enhancement.md`](../system/context-enhancement.md)，验证见 [`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md)。实现入口为 [`.pi/extensions/pi-context-memory/working-context-optimization.ts`](../../.pi/extensions/pi-context-memory/working-context-optimization.ts)。

## 2. 输入、输出与不变量

输入由已绑定路线身份的 assembled session context 组成：最新 Working Memory overview、OpenViking按固定 token budget 保留的活跃消息和估算 token。输出包含同一路线身份、派生 session ID、有界历史文本、Working Memory 状态和估算 token。

必须满足：

1. 输出保留输入路线身份，不以“最后完成”代替“当前有效”；
2. overview 与活跃消息合并为一个固定字符上限的隐藏 Pi custom message；
3. 当前 prompt 及其后的 assistant tool call、tool result 保持 Pi 原生对象和顺序；
4. 没有当前 prompt、assembled context 为空或路线结果未就绪时不替换消息；
5. 输出只提供派生上下文和来源 entry ID 线索，关键事实仍通过 `recall_session` 回到 Pi 权威 entry；
6. 非空 Working Memory overview 必须具备 OpenViking `0.4.13` 的完整七段结构，通用回退摘要不能进入增强上下文。

## 3. 构造与采用边界

工作上下文优先保留有界 Working Memory，再用剩余预算保留 OpenViking active history 的最近部分。格式化结果明确标记 Pi 历史 leaf 和来源 entry ID，不复制 OpenViking内部状态。

Pi 集成在 `context` hook 中重新取得当前 prompt 之前的路线身份。只有 Session 记忆协调计算的身份与就绪结果完全一致时，才使用：

```text
隐藏增强历史消息 + 当前 Pi user prompt + 当前 turn 后续消息
```

本模块提供纯构造与应用能力，不直接注册 hook、状态栏、命令或工具。长时记忆模块拥有 OpenViking Session 写入、commit、Working Memory 和 context assembly；Session 记忆协调拥有路线有效性；Pi 集成拥有实际采用与状态展示。

## 4. 失败与限制

格式化或输入校验失败时不返回增强消息，Pi 集成保持原始消息。当前实现已验证固定预算、当前 turn 保留、完整 Pi tree/session/compaction 生命周期和 Provider payload 实际采用；真实记忆模型成对质量实验已证明当前决定与证据入口保持一致。完整 API 成本归集属于质量与成本观测的下一交付。
