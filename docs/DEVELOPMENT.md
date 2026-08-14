# 当前开发入口

## 1. 文档角色

本文连接 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 与当前实践，维护可运行状态、有效证据、主导约束、交付边界和下一执行入口。

## 2. 当前可运行状态

扩展在 Pi `0.84.1` 上观察持久化 session 的当前 branch，把权威路线条目归档到 session 隔离的本地来源存储，并把可检索任务文本异步同步到 OpenViking `0.4.13` 的本地向量索引。`recall_session(search|read_source)` 在当前路线内排序、预览和展开 Pi 权威 entry；带 `fullOutputPath` 的 toolResult 保存完整副本。

用户通过 `~/.pi/pi-context-memory.jsonc` 配置 OpenViking 记忆模型；`/memory-model` 检查配置和当前运行状态，`/restart-viking` 通过项目启动器安全应用。没有实际运行的记忆模型时，来源召回继续可用，模型上下文保持 Pi 原生。

共享长任务 fixture 已固定多轮目标更新、冲突 branch、工具证据、Pi compaction 和压缩后继续。记忆模型实际运行时可用后，扩展在 Provider 请求之外异步把 Session 记忆协调确认的路线增量写入 OpenViking Session：线性后继复用 session，分叉路线隔离，Pi compaction 按有效保留范围投影；达到阈值后 commit 并等待 Working Memory 任务终态，再取得固定 token budget 的 context assembly。正在执行的任务之后只保留最新未启动路线，失败、淘汰和关闭会清理扩展自建 Session。

Pi `context` hook 每次重新核对当前 prompt 之前的 session、session file、leaf、有序 entry 和完整路线指纹。只有有效用户配置、运行中 OpenViking 的 active/target setting 与 config 指纹以及就绪缓存同代时，本次模型消息才采用一个有界增强历史加当前 Pi turn；准备中、代际不一致、过期、错误或路线不一致时保持全部 Pi 原生消息。状态由最近一次 `context` 采用决定和 Provider payload 一致性共同确认，普通用户文本不能伪造“增强记忆”。

当前证据：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：session 隔离、branch 切换、来源恢复、完整结果与存储失败；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：受控 OpenViking、向量索引、队列边界、当前路线召回和权威展开；
- [`validation/evidence/memory-model-runtime.json`](../validation/evidence/memory-model-runtime.json)：用户配置、配置编译、安全重启、生命周期所有权和冷启动降级；
- [`validation/evidence/context-enhancement.json`](../validation/evidence/context-enhancement.json)：共享 fixture、路线身份、分支与排队隔离、Working Memory/context assembly 协议、compaction 有效保留范围、严格有界构造、当前 turn 保留、运行配置代际、Provider 状态防伪、实际 payload 采用、故障降级和在途关闭清理。

四个 runner 均使用本地资源；`node scripts/check-validation-evidence.mjs` 核对 evidence 与当前实现。

## 3. 当前主导约束

最小有界上下文纵向链路已经可运行。当前主导约束转为把它接入完整 Pi session 生命周期并用真实记忆模型任务结果校准：现有 evidence 尚未覆盖 `/tree` 的 A→B→A、`/fork`、`/clone`、`/resume`、手动/阈值/overflow compaction、重载后的采用状态，以及真实 Working Memory 对任务质量和完整成本的影响。

本地协议 evidence 证明控制流正确，但不能证明摘要语义足以维持长任务，也不能证明增强路径总 API 成本低于原生 Pi。下一交付必须先完成生命周期与状态一致性，再运行共享 fixture 的真实 Provider 成对实验。

## 4. 当前交付边界

**目标**：完成 Pi tree、session replacement 与原生 compaction 生命周期接入，使任何路线变化、重载、故障和恢复期间的实际模型输入与状态标识一致，同时保留已验证的有界增强和显式召回边界。

**需要完成**：

- `/tree` 的 A→B、A→B→A、回到根和 branch summary 两种选择；
- `/fork`、`/clone`、`/resume` 后按新 session 与 leaf 重建采用边界；
- 手动、阈值和 overflow Pi 原生 compaction 保持安全底座，派生重建遵循有效 compaction entry、保留范围和压缩后条目；
- session replacement、reload、准备、故障和恢复期间持续保存路线、消息哈希、采用路径与状态 trace；
- 状态以每次实际 Provider 请求为准，不以 OpenViking在线或后台完成代替采用；
- 使用共享 fixture 运行真实记忆模型质量 checker，再进入原生 Pi / 增强路径完整成本成对实验。

**完成条件**：四份本地 evidence 持续通过；[`features/context-enhancement-state.md`](features/context-enhancement-state.md) 和 [`validation/context-enhancement-state.md`](validation/context-enhancement-state.md) 中完整 tree、session、compaction、故障与状态条件通过；增强路径任务质量不劣于原生 Pi，并形成可归集全部任务与记忆请求的成本实验入口。

## 5. 推进规则

保持 Pi 原生路径、当前路线身份和来源权威不变量。真实 Provider 实验固定任务、模型、工具边界、checker 和重复次数；结果偏离预期时回到最早缺少证据的 Working Memory、采用或生命周期判断，不通过增加状态分支掩盖未知。

## 6. 下一执行入口

1. 接入 `session_before_compact`、`session_compact`、`session_tree`、session replacement 与 reload，完成当前 leaf 重建和持久采用状态；
2. 扩展共享 fixture runner，覆盖 tree 往返、fork/clone/resume、三类 compaction、故障恢复与 UI/Provider 请求一致性；
3. 运行真实记忆模型的原生 Pi / 增强路径质量实验；
4. 两个 arm 质量均成立后归集完整 API 账单，并按结果重新识别主导约束。
