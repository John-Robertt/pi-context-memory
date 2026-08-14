# 上下文增强回退与状态验证

## 1. 验证责任

本文定义如何证明 [`../features/context-enhancement-state.md`](../features/context-enhancement-state.md) 中当前已实现的有界上下文采用、路线隔离和 Pi 原生降级，并规定后续 tree、compaction 与持久状态纵向验证继续使用的共同 fixture。稳定本地结果保存于 [`../../validation/evidence/context-enhancement.json`](../../validation/evidence/context-enhancement.json)。

## 2. 共享 fixture 与观测

[`../../validation/fixtures/context-enhancement-long-task.json`](../../validation/fixtures/context-enhancement-long-task.json) 固定：

- 多轮目标与硬约束更新；
- 共同前缀后的冲突路线 A、当前路线 B 与 abandoned branch summary；
- assistant tool call、当前路线工具证据和来源 entry ID；
- Pi compaction summary 与压缩后继续的用户 prompt；
- 当前决定、禁止采用的旧决定和最终 checker 输入。

每次模型请求至少观察当前 session ID、leaf ID、路线指纹、输入消息哈希、实际采用路径和增强内容哈希。日志不保存完整 Provider payload；runner 的隔离原始产物只保存在 Git 忽略的 `.artifacts/`。

## 3. 当前本地纵向验证

```bash
node scripts/validate-context-enhancement.mjs
node scripts/check-validation-evidence.mjs
```

runner 使用协议兼容的 OpenViking 与本地任务 Provider 替身，不访问外部 Provider。它验证：

- session、session file、leaf、有序 entry 和完整内容形成唯一采用身份；
- 线性路线复用同一 OpenViking Session，冲突 branch 使用隔离 session；
- 旧路线任务完成时不能被当前路线取得；
- 正在执行的路线之后只保留最新未启动路线，旧排队路线被明确替代；
- Pi entry ID 通过 `source_message_ids` 进入 Working Memory；
- OpenViking Session create、batch append、commit、task polling 和 context assembly 协议完整执行；
- Pi compaction 投影保留 `firstKeptEntryId` 范围、压缩后条目，并兼容自包含 `retainedTail`；
- overview 与 active history 受固定预算和字符上限约束；
- 当前 prompt 及其后的 assistant/tool 消息保持原对象和顺序；
- Pi `context` hook 的有效代际真实本地 Provider payload 采用增强历史；启动时与已 ready 后的 setting/config 指纹失配、首轮和故障路径均保持 Pi 原生；
- 用户文本包含增强标题时仍不能伪造 Provider 采用状态；
- 后端故障期间实际请求与 UI 保持 Pi 原生，同路线重建成功后恢复增强；失败不留下可采用的部分结果，扩展自建 Session 在正常关闭和创建响应仍在途时均得到清理；
- `/tree` A→B→A、回到根、带与不带 branch summary 的选择均按操作后 leaf 重建，并在关键路线实际发送 Provider 请求核对采用与分支隔离；
- `/fork`、`/clone`、每次 `/resume` 与 reload 均等待对应 session/file/leaf 重建后实际发送 Provider 请求；
- 手动、阈值和 overflow compaction 均先保持 Pi 原生路径、只采用操作后的有效投影，并在精确 ready 后由下一次任务 Provider 请求恢复增强；overflow 自动重试对增强超限 payload 持续失败，必须改用不同的 Pi 原生 payload；
- 每个经过 Pi `context` / `before_provider_request` 的对话任务请求都用 payload hash 关联真实 Provider 接收时刻，并与 UI 状态一致；Pi 内部摘要请求不冒充对话采用状态；后续扩展取消 tree 或 compaction 时保持最近一次任务请求状态。

通过条件是所有稳定 checks 为 `true`，且 evidence 的实现文件哈希与当前仓库一致。

## 4. 当前证据边界

本地 runner 证明控制流、协议、完整 Pi tree/session/compaction 生命周期、有界消息构造、实际 Provider payload 采用和故障降级，不访问外部 Provider。

真实记忆模型质量使用同一 fixture 的独立成对入口：

```bash
node scripts/validate-context-quality.mjs
```

该 runner 强制 Pi `0.84.1` 与 OpenViking `0.4.13`，固定单次 native→enhanced 顺序，并由两 arm 共用的观察扩展核对任务模型、thinking、active tools、system prompt 与 Provider 模型配置；任务要求从当前路线事实判定方案而非复述历史中的最终标签，增强 arm 还必须观察结构化 Working Memory 就绪并在实际 Provider 请求采用。稳定结果保存于 [`../../validation/evidence/context-quality.json`](../../validation/evidence/context-quality.json)。当前证据中两个 arm 均返回 `bounded-current-route` 与来源 `b000000c`，不采用已放弃路线；这只证明该固定 fixture 的一次路线连续性样本，不代表一般质量等价。

当前尚未闭合的是完整 API 成本：质量 runner 保存 Pi session 任务模型统计，但 OpenViking 记忆生成请求尚未与 Provider 最终账单逐 generation 归集，因此不能据此宣称完整成本优势。

任一当前路线污染、工具序列破坏、错误状态展示或质量退化都会推翻对应设计，并要求回到最早缺少证据的采用边界。
