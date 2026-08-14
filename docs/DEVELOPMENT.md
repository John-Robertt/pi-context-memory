# 当前开发入口

## 1. 文档角色

本文连接 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 与当前实践，维护可运行状态、有效证据、主导约束、交付边界和下一执行入口。

## 2. 当前可运行状态

扩展在 Pi `0.84.1` 上观察持久化 session 的当前 branch，把权威路线条目归档到 session 隔离的本地来源存储，并把可检索任务文本异步同步到 OpenViking `0.4.13` 的本地向量索引。`recall_session(search|read_source)` 在当前路线内排序、预览和展开 Pi 权威 entry；带 `fullOutputPath` 的 toolResult 保存完整副本。

用户通过 `~/.pi/pi-context-memory.jsonc` 配置 OpenViking 记忆模型；`/memory-model` 检查配置和当前运行状态，`/restart-viking` 通过项目启动器安全应用。没有实际运行的记忆模型时，来源召回继续可用，模型上下文保持 Pi 原生。

共享长任务 fixture 固定多轮目标更新、冲突 branch、工具证据、Pi compaction 和压缩后继续。记忆模型可用后，扩展在 Provider 请求之外异步把当前有效投影写入 OpenViking Session：普通线性后继复用镜像，分叉或 compaction 改变有效投影前缀时使用隔离镜像；达到阈值后 commit、等待 Working Memory 任务终态并取得固定 token budget 的 context assembly。非空 overview 必须具备 OpenViking `0.4.13` 的完整七段 Working Memory 结构，模型失败产生的通用计数回退不可采用。

Pi `context` hook 每次重新核对当前 prompt 之前的 session、session file、leaf、有序 entry 和完整路线指纹。只有用户配置、运行中 active/target setting 与 config 指纹、就绪缓存同代且路线一致时，本次模型消息才采用有界增强历史加当前 Pi turn。tree、compaction、session replacement 与 reload 先回到 Pi 原生，操作后的实例从 Pi 当前 leaf 重建；状态由实际 `context` 决定并在 Provider payload 再核对，普通用户文本不能伪造“增强记忆”。

当前证据：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：session 隔离、branch 切换、来源恢复、完整结果与存储失败；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：受控 OpenViking、向量索引、队列边界、当前路线召回和权威展开；
- [`validation/evidence/memory-model-runtime.json`](../validation/evidence/memory-model-runtime.json)：用户配置、配置编译、安全重启、生命周期所有权和冷启动降级；
- [`validation/evidence/context-enhancement.json`](../validation/evidence/context-enhancement.json)：共享 fixture、路线与代际身份、有效 compaction 投影、tree 往返、fork/clone/resume/reload、三类 compaction、Provider/UI 状态一致性、故障降级和清理；
- [`validation/evidence/context-quality.json`](../validation/evidence/context-quality.json)：真实 OpenViking Working Memory 下原生 Pi / 增强 arm 使用同一任务模型，均保持当前决定 `bounded-current-route`、来源 `b000000c` 并排除废弃路线。

四个日常 runner 使用本地资源；真实质量 runner 独立执行。`node scripts/check-validation-evidence.mjs` 免费只读核对五份 evidence 与当前实现，不会重新发起 Provider 请求。

## 3. 当前主导约束

完整 Pi 生命周期已成立；真实记忆模型只证明一个固定长任务 fixture 的成对路线连续性样本，不能外推为一般质量等价。当前可执行主导约束是为该成对入口补齐完整 API 成本归属：质量 runner 能读取两个 Pi session 的任务模型 token 与 cost，但尚未把 OpenViking Working Memory 生成、重试和降级请求逐 generation 对应到 Provider 最终账单。

现有单次样本中增强 arm 的任务侧输入明显更小，只能解释有界上下文机制；缓存条件不同且记忆请求账单缺失，不能据此证明完整成本优势。下一交付先建立完整请求归属，再扩展任务与重复次数，并交替 arm 顺序复核质量和完整成本。

## 4. 当前交付边界

**目标**：建立原生 Pi / 增强路径的完整 API 请求与最终账单归属，使任务质量成立后的成本比较覆盖任务模型、Working Memory 生成、重试与降级。

**需要完成**：

- 为每个质量实验 run、arm 和 generation 建立稳定身份；
- 归集 Pi 任务请求与 OpenViking 记忆请求的 Provider 最终 input、output、cache 和金额；
- 明确失败、重试、降级与未实际发送请求的归属语义；
- 固定任务、模型、thinking、工具、checker、执行顺序、缓存条件和重复次数；
- 两个 arm 任一质量失败时，本轮不形成成本优势结论。

**完成条件**：四份本地 evidence 持续通过；真实质量 evidence 持续满足两个 arm 的 checker 与增强实际采用；每个实际 generation 都有唯一账单归属；增强 arm 的完整成功任务账单低于原生 Pi arm。

## 5. 推进规则

保持 Pi 原生路径、当前路线身份和来源权威不变量。真实 Provider 实验固定任务、模型、工具边界、checker 和重复次数；结果偏离预期时回到最早缺少证据的 Working Memory、采用或生命周期判断，不通过增加状态分支掩盖未知。

## 6. 下一执行入口

1. 在质量 runner 中为 Pi 与 OpenViking 请求建立共同 run/arm/generation 归属；
2. 从 Provider 最终响应或账单来源收集全部 token、cache 与金额，拒绝缺失 generation；
3. 扩展代表性任务与重复次数，预先规定并交替 arm 顺序，先复核两个 arm 质量；
4. 比较完整成功任务账单，并按结果重新识别主导约束。
