# 当前开发入口

## 1. 文档角色

本文连接 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 与当前实践，维护可运行状态、有效证据、主导约束、交付边界和下一执行入口。

## 2. 当前可运行状态

当前 evidence 的宿主坐标是 Pi `0.84.2`，项目私有记忆依赖锁定为 OpenViking `0.4.13`。扩展通过独立 Pi 规范化边界观察持久化 session 当前 branch，把权威路线归档到 session 隔离的本地来源存储，并异步同步可检索任务文本。`recall_session(search|read_source)` 在当前路线内排序、预览和展开 Pi 权威 entry；带 `fullOutputPath` 的 toolResult 保存完整副本。上游版本变化由扩展适配，不要求用户降级 Pi。

用户正常运行时通过 `~/.pi/pi-context-memory.jsonc` 配置 OpenViking 记忆模型；开发验证不要求修改该文件。模型能力与成本 runner 共用 [`validation/model.json`](../validation/model.json) 的单一 `openRouterModel`，由它派生 Pi 任务路线和 LiteLLM 记忆路线；质量 runner 在 `.artifacts/` 写入隔离配置并通过 `PCR_MEMORY_MODEL_SETTINGS` 只注入验证进程，真实采用 runner 则核对同一配置与托管 runtime。OpenRouter 记忆请求的密钥通过 `PCR_OPENVIKING_VLM_API_KEY` 提供给验证 launcher。`/memory-model` 检查用户配置和运行状态，`/restart-viking` 安全应用；没有实际运行的记忆模型时，来源召回继续可用，模型上下文保持 Pi 原生。

共享长任务 fixture 固定目标更新、冲突 branch、工具证据、Pi compaction 和压缩后继续。记忆模型可用后，扩展在 Provider 请求之外异步把当前有效投影写入 OpenViking Session：线性后继复用镜像，分叉或 compaction 改变有效前缀时隔离镜像；batch append 后先发布来源已核验的精确路线 active history assembly。达到阈值后，OpenViking `accepted` commit 在 180 秒有界终态期限内生成 Working Memory，完成后以 overview 更新同一路线；`skipped` commit 表示消息都位于保留窗口，空 task ID 不再使 active history 失效。共同适配层拒绝矛盾或未知状态、缺失来源、未知内容、空 active tail、通用回退与其它 malformed 响应。

Pi `context` hook 只读取内存中的当前受管 OpenViking 子进程和路线状态，不读取配置或启动新 OpenViking 工作；用户配置只描述下一次重启目标，变化或校验失败不会中断仍然 ready 的实例。精确路线已有在途准备时最多等待 1000 ms 取得来源核验结果，无 pending 或超时立即按 Pi 原生消息继续。采用时重新核对当前 prompt 之前的 session、session file、leaf、有序 entry 和完整路线指纹。`before_agent_start` 使用 Pi 当时已持久化的完整历史，不再误删上一轮；tree、compaction、session replacement 与 reload 从 Pi 当前 leaf 重建。状态栏实时区分“增强记忆 · 初始化中”“增强记忆 · 生效中”“增强记忆”和服务不可用时的“Pi 原生”；Provider 实际采用路径独立记录。

当前证据：

- [`validation/evidence/source-archive.json`](../validation/evidence/source-archive.json)：session 隔离、branch 切换、来源恢复、完整结果与存储失败；
- [`validation/evidence/source-recall.json`](../validation/evidence/source-recall.json)：受控 OpenViking、向量索引、队列边界、当前路线召回和权威展开；
- [`validation/evidence/memory-model-runtime.json`](../validation/evidence/memory-model-runtime.json)：用户配置、配置编译、安全重启、生命周期所有权和冷启动降级；
- [`validation/evidence/context-enhancement.json`](../validation/evidence/context-enhancement.json)：共享 fixture、路线与代际身份、合法 skipped commit、1000 ms 精确 pending 等待、commit 运行期间的 active history 采用、慢任务完成与超时降级、完整 Pi 生命周期、Provider/UI 一致性和清理；
- `scripts/validate-real-context-adoption.mjs`：统一验证模型的真实采用入口，不预等待 Working Memory；Pi `0.84.2` 下 skipped 场景的零间隔第二轮 Provider payload 已采用增强，accepted 场景在最终 Working Memory 完成前已用 active history 发出增强请求，原始产物保存在 Git 忽略的 `.artifacts/real-context-adoption/`；
- [`validation/evidence/context-quality.json`](../validation/evidence/context-quality.json)：最近一次两个 arm 均保持当前决定 `bounded-current-route` 与来源 `b000000c`，并记录实际任务/记忆模型坐标、记忆调用路由与 token；本次状态生命周期改动后实现绑定已过期，需在验证凭据可用后重新运行质量 runner。

四个本地 runner 与模型质量、真实采用 runner 共同构成验证链；按风险先运行本地检查，凭据可用时继续模型能力与成本环节。`node scripts/check-validation-evidence.mjs` 只读核对五份稳定 evidence，不会重新发起 Provider 请求；当前只报告 `context-quality` evidence 的实现绑定待刷新。

## 3. 当前主导约束

增强状态现按“增强记忆 · 初始化中 → 增强记忆 · 生效中 → 增强记忆”实时展示，只有配置、代际或后端不可用并强制回退时显示“Pi 原生”；Provider 实际采用路径保持独立记录。四份本地 evidence 已覆盖启动、路线变化、tree/session/compaction、后端失败和恢复，并与当前实现一致。

当前立即约束是质量 evidence 尚未与状态生命周期改动后的扩展入口及统一模型配置重新绑定；验证进程取得 OpenRouter 凭据后直接重跑 `validate-context-quality.mjs`，确认任务质量仍成立。随后主导约束回到完整账单归属：把每个任务、记忆、重试和降级请求绑定到 OpenRouter 最终 billed cost，才能判断增强路径是否具有完整成本优势。

## 4. 当前交付边界

**目标**：在任务质量保持成立后，把原生与增强 arm 的全部 OpenRouter billed cost 归入同一可复核实验，判断增强路径是否具有完整成本优势。

**需要完成**：

- 为任务模型和 OpenViking 记忆模型请求记录可与 OpenRouter 账单关联的 run/request 身份，不保存凭据或完整 payload；
- 把记忆生成、任务调用、重试与降级请求全部归入对应 arm；
- 使用同一任务、模型、thinking、工具边界和重复次数执行 native/enhanced 成对实验；
- 同时保留 checker 结果、Provider payload 采用事实、token usage 与最终 billed cost。

**完成条件**：两个 arm 均有效完成任务，所有 OpenRouter 请求可完整归属且无未解释费用；增强 arm 的完整 billed cost 低于 native arm 时，才能形成成本优势结论。

## 5. 推进规则

保持 Pi 原生接续能力、当前路线身份和来源权威不变量，但不把 Pi 原生接续计为增强成功。真实 Provider 实验固定任务模型、记忆模型、thinking、工具边界和输入间隔；结果偏离预期时回到最早缺少证据的 commit、active assembly、pending 等待或 Provider 采用边界，不通过放宽路线核验掩盖未知。

## 6. 下一执行入口

1. 向验证进程提供 `PCR_OPENVIKING_VLM_API_KEY` 后直接运行 `node scripts/validate-context-quality.mjs`，恢复质量 evidence 与当前扩展入口的实现绑定；
2. 调查 OpenRouter 与 LiteLLM 响应中可稳定关联账单的 request/generation 标识和 billed cost 字段；
3. 把关联信息加入成对质量 runner 的 run-local 原始产物与稳定 evidence 校验；
4. 固定重复次数运行 native/enhanced 两个 arm，核对完整费用归属与任务质量；只有归属完整后才比较并形成成本结论。
