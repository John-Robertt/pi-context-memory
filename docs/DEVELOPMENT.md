# 当前开发入口

## 1. 文档角色

本文连接 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 与当前实践，维护可运行状态、有效证据、主导约束、交付边界和下一执行入口。

## 2. 当前可运行状态

扩展在 Pi `0.84.1` 上观察持久化 session 的当前 branch，并把权威路线条目归档到 session 隔离的本地来源存储。带 `fullOutputPath` 的 toolResult 保存完整副本；读取和展开都会核对当前 Pi 路线。

扩展提供显式 `recall_session(search|read_source)` 工具。具有任务文本的归档 entry 以稳定 URI 异步写入 OpenViking `0.4.13`，使用本地 embedding 的 `vectors_only` 索引。Session 记忆协调为显式搜索提供调用后完整同步屏障，并合并同路线的待执行轮次。缺失资源从已核对的本地来源副本重建。OpenViking 在当前 branch 来源 URI 集合内排序，扩展核对候选、返回有限预览，并从 Pi 权威 entry 展开。

扩展从锁定 OpenViking Provider registry 与 `VLMConfig` schema 生成 `~/.pi/pi-context-memory.jsonc` 用户模板；`/memory-model` 只检查并展示，`/restart-viking` 通过项目启动器应用。语法和字段错误不覆盖文件，运行中保留旧实例，冷启动退回无 VLM 基础服务。启动器仍以原子锁保持项目级单一所有者并只控制自己的子进程；Pi 模型输入继续显示“Pi 原生”。

归档和索引使用独立队列；当前本地证据覆盖队列协调、索引准备、正常空结果和后端错误语义。Provider 并发与故障后的 Agent 连续性由代表性长任务纵向实验验证。

当前证据状态：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：与当前实现一致，覆盖 session 隔离、branch 切换、来源恢复、完整结果与存储失败边界；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：与当前实现一致，覆盖受控 OpenViking、真实向量索引、队列边界、当前路线召回、来源预览和 Pi 权威 entry 展开；
- [`validation/evidence/memory-model-runtime.json`](../validation/evidence/memory-model-runtime.json)：与当前实现一致，覆盖用户级路径、全 Provider 与 LiteLLM 多来源注释模板、JSONC 诊断与文件保留、配置转换、命令只读、冷启动降级、生命周期所有权、操作对账、状态分离和 Pi 原生状态。

`node scripts/check-validation-evidence.mjs` 当前确认三份 evidence 与实现一致。三个验证 runner 均使用本地资源且不访问外部 Provider。

## 3. 当前主导约束

当前交付聚焦让扩展自动构造并采用有界工作上下文。记忆模型配置与项目托管 OpenViking 重启已经建立；当前主导约束是先用共享长任务 fixture 固定多轮目标更新、冲突 branch、工具证据、Pi 压缩和压缩后继续的可重复基线，再让 OpenViking Session Working Memory 与 context assembly 进入同一纵向验证。

当前本地 evidence 证明来源归档与显式召回边界；自动上下文纵向 evidence 将通过实际 Provider 请求证明路线隔离、降级和状态一致性，并验证 OpenViking Working Memory 与 context assembly 的有效性。

完整成本优势在上述能力可运行后，以同一任务、模型、工具边界、checker 和重复次数运行原生 Pi / 增强路径成对实验，验证两边任务质量与完整 API 账单。

## 4. 当前交付边界

**目标**：完成最小自动有界上下文纵向能力，并确保 Pi 对话回退、分支与原生压缩始终可用，扩展状态始终反映模型输入实际采用增强记忆还是 Pi 原生路径。

**需要完成**：

- 建立覆盖多轮目标更新、冲突 branch、工具证据、Pi 压缩和压缩后继续的共享长任务 fixture；
- 以 OpenViking Session Working Memory 和 context assembly 为基础，在当前 session 与路线约束下构造并采用有界增强上下文；
- Pi 回退、`/tree`、`/fork`、`/clone` 或 `/resume` 后，以当前 leaf 重建采用边界；新路线增强上下文准备期间保持 Pi 原生模型输入；
- 手动、阈值和溢出触发的 Pi 原生压缩继续承担安全底座；增强准备、故障和恢复期间由该路径接续；
- 扩展运行期间持续显示“增强记忆”或“Pi 原生”，状态以实际 Provider 请求采用结果为准；
- 保存路线、上下文消息哈希、采用状态、降级和恢复 trace，并运行同任务的原生 Pi / 增强路径最终 checker。

**完成条件**：记忆模型运行时 evidence 持续通过；至少一个代表性任务分布可重复运行；[`features/context-enhancement-state.md`](features/context-enhancement-state.md) 与 [`validation/context-enhancement-state.md`](validation/context-enhancement-state.md) 的回退、压缩、路线隔离和状态条件全部通过；增强路径任务质量不劣于原生 Pi，并能够进入完整成本成对验证。

## 5. 推进规则

保持 Pi 原生路径和当前来源召回不变量。每次实验比较任务质量和完整成本；结果偏离预期时回到最早缺少证据的判断。结论成立后更新当前设计、证据和本文。

## 6. 下一执行入口

1. 建立 [`validation/context-enhancement-state.md`](validation/context-enhancement-state.md) 定义的共享长任务、路线切换、压缩、故障和状态 fixture；
2. 基于 OpenViking Session Working Memory 和 context assembly，实现以 Pi 当前 session、leaf 和 branch 为采用条件的有界增强上下文；
3. 接入 Pi 上下文、tree、session 与 compaction 生命周期，完成原生降级和持久状态标识；
4. 运行原生 Pi / 增强路径质量与完整成本成对实验，并按结果重新识别主导约束。
