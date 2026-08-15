# 记忆模型配置与运行能力验证

## 1. 验证责任

本文定义如何证明 [`../features/memory-model-configuration.md`](../features/memory-model-configuration.md) 的用户体验、[`../system/memory-model-runtime.md`](../system/memory-model-runtime.md) 的配置与运行代际，以及 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 的实际记忆模型能力证明成立。

验证先使用本地配置入口、协议替身和受控进程覆盖确定性边界，再使用真实受管 OpenViking 与当前已配置的实际记忆 Provider/模型证明能力探针、accepted task、assembly、续租和恢复。只有替身通过时不能把记忆模型能力标记为完成。

真实验证沿用 manifest 固定的记忆 Provider/模型；坐标不变时，其付费调用属于正常验证，不逐次申请授权。需要改变记忆 Provider 或模型时才停止并请求用户决定。

## 2. 配置转换与文件安全

固定检查包括：

- 候选 Provider 子集通过项目安装的 OpenViking 聚合配置入口；只有实际纵向检查通过的 Provider/模型组合进入已支持矩阵；
- 配置桥不读取上游私有 registry 或 backend 路由表；
- 上游新增未知 Provider 不影响已有受支持配置；
- 模板说明必要字段、认证入口和官方路由来源，不复制完整 Provider 目录；
- 默认路径严格位于隔离 HOME 的 `.pi/pi-context-memory.jsonc`；
- 缺失用户配置原子独占创建，已有普通文件只收紧权限而不改写内容；当前 POSIX runner 核对 `0600`；
- 普通注释、字符串 URL 和尾逗号正确解析；
- 语法和语义错误形成带路径的脱敏诊断；
- direct key、`$NAME` 与 `${NAME}` 都产生只含固定 `${PCR_OPENVIKING_MEMORY_API_KEY}` 引用的运行配置；不可序列化的编译凭据仅在内存中携带，凭据轮换改变配置指纹；
- 受控 Launcher 覆盖 `$A → $B → direct key / null` 与不可解析配置的冷启动；带显式凭据的 child 只由 Launcher 注入当前内部变量，不含用户引用、ambient `OPENROUTER_API_KEY` 或无关 Provider sentinel，并用验证凭据哈希确认采用当前值；source-only child 不注入任何环境变量；
- 实际 OpenRouter 验证通过 `pi auth print-api-key --provider openrouter` 复用 Pi 凭证；任务 Pi observer 观测隔离变量、内部变量和 ambient `OPENROUTER_API_KEY` 均不存在；真实 OpenViking wrapper 观测只有内部变量存在，用户隔离变量与 ambient key 不存在，不记录任何值，并在结束时确认真实 PID 已退出；
- 必要凭据缺失或引用变量未设置时在停止旧实例前失败；
- 无 `api_key` 配置不会隐式继承 ambient 认证环境；需要环境变量的原生认证保持未支持，直到具有独立配置契约与 actual 证据；
- key、OAuth token、云凭据和认证响应不进入状态、日志、evidence 或 Pi session；
- 每个已支持 Provider/模型/API 精确匹配一个带版本与指纹的 MemoryRuntimeProfile；用户配置不接受 profile 内部字段或任意请求体透传；
- profile 的 thinking、temperature、stream、maxInput、maxOutput、requestTimeout、maxRetries、maxConcurrency、capabilityLeaseTtl、renewalLead 和 adapterVersion 都在目标 Provider 最终请求与运行观测中得到实际验证；
- 配置不依赖 OpenViking 隐式默认值，不配置 backup Provider/model，retry 保持同一坐标。

## 3. 命令语义

使用隔离 Pi 和本地任务 Provider 验证：

- `/memory-model` 只创建缺失模板、检查和展示，不接受写入参数；
- 命令准确区分目标配置、目标/active profile、active 进程、service readiness、memory capability 和 requestReady；
- `memoryModel: null` 明确表示没有任务请求能力；
- 配置检查和应用不改变任务模型、Pi session 或 branch；
- 命令自身不产生任务 Provider 请求；
- 配置错误提示具有稳定错误码，同一未变化诊断不重复刷屏；
- `/restart-viking` 只有在服务与实际能力探针都通过后报告 ready；
- 多个 Pi session 观察同一用户文件，配置内容不进入 Pi 对话。

## 4. 启动器所有权与并发

使用受控 OpenViking 子进程验证：

- 启动按“预检—停止旧实例—启动—service readiness—能力探针—发布代际”顺序完成；
- 活锁拒绝第二启动器，死锁需要显式核对；
- 启动器只终止自己持有的子进程；
- 未知进程占用目标端口时在停止旧实例前失败；
- 同一项目的并发应用请求串行且结果确定；
- target 配置与 active process 始终分离；
- 客户端操作 ID 和期限覆盖预检、停止、启动、readiness、能力探针与失败清理；
- 客户端断开不撤销已接受操作，超时结果只按同一操作 ID 对账；
- 子进程提前退出、readiness 失败和能力失败发布准确阶段；
- 连续退出信号共享一次清理，并在子进程终态后释放所有权。

## 5. 实际记忆模型能力探针

本地协议替身和真实 OpenViking 都必须观察探针完整流程：

1. 创建隔离 Session；
2. 写入带来源 ID 的确定性消息；
3. commit 返回 `accepted + task ID`；
4. task 达到 completed；
5. context assembly 具有有效 Working Memory 和当前来源；
6. 探针 Session 被删除；
7. 能力证明绑定 launchId、childPid、Provider、模型、API、配置、MemoryRuntimeProfile、adapter、探针版本和 `validUntil`。

以下状态不能通过：

- 只有 `/health` 或 `/ready` 成功；
- 配置成功但模型调用失败；
- commit 返回 `skipped`；
- task failed、cancelled、未知或超时；
- assembly 为空、缺失来源、跨路线或包含通用失败文本；
- 探针证明与 active 子进程或配置指纹不一致。

真实模型探针保存 Provider、模型、task、token、响应 ID 和内容哈希，不保存完整响应或凭据。探针费用进入完整成本归属。
实际证据还必须覆盖一次业务 Session accepted task 完成 assembly、发布 MemoryCheckpoint 并续租，一次进入 renewalLead 后旧证明仍授权且后台续租，一次 `validUntil` 到期后的实际请求屏障与重新探针，以及一次实际进程中断后 `/restart-viking` 创建新代际并恢复。协议替身只能补充失败矩阵。

## 6. 运行代际与请求能力

分别改变 target 配置、active 子进程、service readiness、模型能力和适配版本，验证：

- 用户文件变化不改变当前 ready 代际；
- 重启预检失败保持当前 ready 实例；
- active 子进程停止立即撤销旧代 requestReady；
- 新子进程 service ready 但能力未通过时，本扩展不确认增强输出；abort 与 transport 结果分别记录；
- 同代际业务 accepted task 只有在完整 assembly 核验并发布 MemoryCheckpoint 后续租；
- 进入 renewalLead 后旧证明在 `validUntil` 前继续授权，后台续租不会制造请求停顿；
- 能力证明到期且续租 pending/失败时，本扩展不确认增强输出；不从内部状态推断最终 Provider 零请求；
- 能力证明只对绑定的子进程、配置、MemoryRuntimeProfile 和 adapter 版本有效；
- 新代际不复用旧代 checkpoint、refresh、能力租约或请求证明；
- 新代际只从当前 Pi branch 重建；
- 运行实例与配置目标不一致时诊断准确但不影响有效旧代。

## 7. 故障阻断与恢复

分别注入配置、凭据、Launcher、锁、端口、进程、readiness、模型能力、task 和 assembly 故障。每个场景必须证明：

- 本扩展不确认增强输出并调用 `ctx.abort()`；
- handler 返回和 transport 实际结果分别记录；
- 状态为“增强记忆 · 故障”或仍处于初始化；
- `/memory-model` 显示准确、脱敏的责任阶段；
- 当前 Pi session 和来源保持不变；
- 系统不自动发送或重放用户 prompt；
- 扩展不自动修改 Pi、其它扩展、Provider 或模型；
- 用户选择修复并重新验证时创建新代际，探针通过后恢复“增强记忆”；
- 用户重新提交的任务由新的增强输出处理。

## 8. 当前 ready 实例与待应用配置

验证当前 ready 实例运行期间：

- 修改、清空或写错用户配置只更新目标诊断；
- 配置文件 watcher 不销毁 active 能力证明；
- `/restart-viking` 预检失败保留旧实例；
- 成功重启在旧实例停止后撤销旧代并建立新代；
- Pi 进程无需持有 Launcher 环境中的实际 key 即可核对当前代际；
- 任何观测不显示或记录 key。

## 9. 执行入口与 evidence

目标入口为：

```bash
node scripts/validate-memory-model-runtime.mjs
node scripts/validate-context-enhancement.mjs
node scripts/validate-context-quality.mjs
node scripts/check-validation-evidence.mjs
```

`memory-model-runtime` evidence 分别保存 controlled/actual：配置、权限、所有权和协议故障可由受控证据覆盖；profile 采用、能力探针、租约、重启与恢复关联固定 ValidationCoordinates、真实响应 ID/usage 和 artifact。`context-enhancement` evidence 分别记录本扩展 block/abort 与 transport 实际结果，不从内部状态推断最终采用。

runner 和 stable evidence 必须随实现更新后才能证明本文目标。当前有效证据范围由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
