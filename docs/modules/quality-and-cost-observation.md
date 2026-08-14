# 质量与成本观测模块

## 1. 当前责任

本模块定义开发期任务质量与完整 API 成本的比较方法。当前本地 runner 验证来源与上下文采用控制流，真实 Provider runner 提供单个固定任务的原生 Pi / 增强路径成对质量样本；一般质量与完整成本仍需后续纵向实验。

实际扩展保持用户运行路径简洁。开发 runner 在仓库内归集实验数据，稳定 evidence 保存脱敏结果。

## 2. 成对实验设计

原生 Pi arm 与 `pi-context-memory` 增强 arm 共享：

- 代表性长任务 fixture 和最终 checker；
- Provider、模型、thinking、工具边界和重复次数；
- 受控执行顺序、缓存状态和请求核对方式。

完整成本包括任务模型、记忆生成、召回、重试和降级触发的全部 API 请求。每个 generation 都关联唯一 Pi message 和最终 Provider 账单。

成本优势成立需要两个结果：

1. 两个 arm 都有效完成任务，增强路径保持任务连续性、当前事实和必要证据；
2. 增强 arm 的完整 API 账单低于原生 Pi arm。

实际账单承担相对比较职责。

## 3. 当前交付状态

当前已有两个验证层次：日常本地 runner 证明完整 Pi 生命周期与采用控制流；`validate-context-quality.mjs` 使用同一长任务 fixture、真实 OpenViking Working Memory 和同一任务模型运行原生/增强 arm，确定性 checker 要求从当前路线事实判定方案、返回来源 entry 且排除废弃路线。最新稳定 evidence 中两个 arm 均通过，增强 arm 确认实际采用增强 Provider 请求；该结果只是一项固定顺序、单次运行的路线连续性样本，不代表一般质量等价。

当前未闭合的是完整成本归属：Pi session 统计只覆盖任务侧账单，OpenViking 记忆生成、重试和降级请求还没有与 Provider 最终账单建立逐 generation 对应。完成该归集前，现有 token 与任务侧 cost 只能解释机制，不能证明产品成本优势。日常入口见 [`../validation/README.md`](../validation/README.md)，当前开发方向见 [`../DEVELOPMENT.md`](../DEVELOPMENT.md)。

## 4. 证伪条件

- 两个 arm 的任务输入、模型、工具或 checker 存在差异；
- 任一 arm 未通过最终任务 checker；
- 任一 API generation 缺少最终账单或唯一归属；
- OpenViking LLM、VLM、提取、合并或重试请求缺少成本归集；
- 增强 arm 的完整账单达到或超过原生 Pi arm；
- 实验结果仅由压缩率、缓存命中率或单项召回指标支持。
