# 当前开发入口

## 1. 文档角色

本文连接 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 与当前实践，维护可运行状态、有效证据、主导约束、交付边界和下一执行入口。

## 2. 当前可运行状态

扩展在 Pi `0.84.1` 上观察持久化 session 的当前 branch，并把权威路线条目归档到 session 隔离的本地来源存储。带 `fullOutputPath` 的 toolResult 保存完整副本；读取和展开都会核对当前 Pi 路线。

扩展提供显式 `recall_session(search|read_source)` 工具。具有任务文本的归档 entry 以稳定 URI 异步写入 OpenViking `0.4.13`，使用本地 embedding 的 `vectors_only` 索引。Session 记忆协调为显式搜索提供调用后完整同步屏障，并合并同路线的待执行轮次。缺失资源从已核对的本地来源副本重建。OpenViking 在当前 branch 来源 URI 集合内排序，扩展核对候选、返回有限预览，并从 Pi 权威 entry 展开。

归档和索引使用独立队列；当前本地证据覆盖队列协调、索引准备、正常空结果和后端错误语义。Provider 并发与故障后的 Agent 连续性由代表性长任务纵向实验验证。

当前有效证据：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：session 隔离、branch 切换、来源恢复、完整结果与存储失败边界；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：受控 OpenViking 配置、真实向量索引、队列边界、当前路线召回、来源预览和 Pi 权威 entry 展开。

`node scripts/check-validation-evidence.mjs` 核对两份 evidence 与当前实现。两个验证 runner 使用本地资源。

## 3. 当前主导约束

当前能力依赖任务模型主动调用显式召回，任务模型上下文继续由 Pi 管理。代表性长任务需要进一步区分召回触发、查询质量、候选质量和累计工作状态对任务连续性的影响。

完整成本优势要求自动上下文优化先形成可运行能力。随后用同一任务、模型、工具边界、checker 和重复次数运行原生 Pi / 增强路径成对实验，验证两边任务质量与完整 API 账单。

## 4. 当前交付边界

**目标**：确定显式来源召回在代表性长任务中的质量边界，并识别当前最限制任务连续性的因素。

**需要完成**：

- 使用共享 fixture、模型和最终 checker 运行 Pi 原生路径与当前显式召回路径；
- 覆盖多轮目标更新、冲突 branch、工具证据和压缩后的任务继续；
- 记录召回调用、查询命中、权威展开和最终任务结果；
- 从 trace 区分召回触发、查询、候选和累计工作状态问题；
- 根据证据选择自动召回或 Working Memory 的最小纵向实现。

**完成条件**：至少一个代表性任务分布可重复运行，trace 和最终 checker 能够确定下一主导约束。

自动注入、Pi context 控制、用户级跨 session memory、后端抽象和生产保留策略由后续证据决定。

## 5. 推进规则

保持 Pi 原生路径和当前来源召回不变量。每次实验比较任务质量和完整成本；结果偏离预期时回到最早缺少证据的判断。结论成立后更新当前设计、证据和本文。

## 6. 下一执行入口

1. 建立需要压缩后继续规划、核对工具证据并处理事实更新的代表性任务；
2. 对 Pi 原生与显式 `recall_session` 路径重复运行，保存召回调用、候选、展开和最终 checker trace；
3. 按召回触发、查询、候选和累计工作状态分类结果；
4. 实现证据确定的最小自动记忆能力；
5. 在自动上下文优化纵向交付中建立同任务的原生 Pi / 增强路径成本实验。
