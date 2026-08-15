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
- 缺失文件以 `0600` 原子独占创建，已有普通文件只收紧权限而不改写内容；
- 普通注释、字符串 URL 和尾逗号正确解析；
- 语法和语义错误形成带路径的脱敏诊断；
- 直接 key 与 `$NAME` / `${NAME}` 环境引用原样编译到 `0600` 运行配置；
- 必要凭据缺失或引用变量未设置时在停止旧实例前失败；
- 无需 API key 的来源使用其原生认证；
- key、OAuth token、云凭据和认证响应不进入状态、日志、evidence 或 Pi session；
- `thinking`、reasoning、temperature 等参数只有在最终适配请求验证后进入契约。

## 3. 命令语义

使用隔离 Pi 和本地任务 Provider 验证：

- `/memory-model` 只创建缺失模板、检查和展示，不接受写入参数；
- 命令准确区分目标配置、active 进程、service readiness、memory capability 和 requestReady；
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
7. 能力证明绑定 launchId、childPid、模型、配置、协议、探针版本和 `validUntil`。

以下状态不能通过：

- 只有 `/health` 或 `/ready` 成功；
- 配置成功但模型调用失败；
- commit 返回 `skipped`；
- task failed、cancelled、未知或超时；
- assembly 为空、缺失来源、跨路线或包含通用失败文本；
- 探针证明与 active 子进程或配置指纹不一致。

真实模型探针保存 Provider、模型、task、token、响应 ID 和内容哈希，不保存完整响应或凭据。探针费用进入完整成本归属。

实际证据还必须覆盖一次业务 Session accepted task 对能力租约的续租、一次租约到期后的实际重新探针，以及一次实际进程中断后 `/restart-viking` 创建新代际并恢复。协议替身只能补充失败矩阵。

## 6. 运行代际与请求能力

分别改变 target 配置、active 子进程、service readiness、模型能力和适配版本，验证：

- 用户文件变化不改变当前 ready 代际；
- 重启预检失败保持当前 ready 实例；
- active 子进程停止立即撤销旧代 requestReady；
- 新子进程 service ready 但能力未通过时任务 Provider 请求数为零；
- 同代际业务 accepted task 只有在完整 assembly 核验后续租；
- 能力证明到期且续租 pending 或失败时任务 Provider 请求数为零；
- 能力证明只对绑定的子进程、配置和适配版本有效；
- 新代际不复用旧代 pending、ready context 或请求证明；
- 新代际只从当前 Pi branch 重建；
- 运行实例与配置目标不一致时诊断准确但不影响有效旧代。

## 7. 故障阻断与恢复

分别注入配置、凭据、Launcher、锁、端口、进程、readiness、模型能力、task 和 assembly 故障。每个场景必须证明：

- 新任务模型请求在 Provider 前被阻断；
- Provider 接收数不增加；
- 状态为“增强记忆 · 故障”或仍处于初始化；
- `/memory-model` 显示准确、脱敏的责任阶段；
- 当前 Pi session 和来源保持不变；
- 系统不自动发送或重放用户 prompt；
- 用户修复并执行 `/restart-viking` 后创建新代际；
- 新代际能力探针通过后恢复“增强记忆”；
- 用户重新提交的任务使用增强 Provider payload。

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

`memory-model-runtime` evidence 分别保存 controlled 与 actual 检查：配置、权限、所有权和协议故障可以由受控证据覆盖；能力探针、业务续租、租约到期、实际重启与恢复必须关联固定 `ValidationCoordinates`、真实 Provider 响应 ID/usage 和原始 artifact。`context-enhancement` evidence 保存故障后的 Provider 零增量和恢复采用；真实质量 evidence 保存实际模型与账单归属。

runner 和 stable evidence 必须随实现更新后才能证明本文目标。当前有效证据范围由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
