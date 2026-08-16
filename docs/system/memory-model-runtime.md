# 记忆模型配置与 OpenViking 运行时

## 1. 文档角色

本文定义 Pi 集成、长时记忆和项目启动器如何协作实现 [`../features/memory-model-configuration.md`](../features/memory-model-configuration.md)，包括用户配置、运行配置编译、OpenViking 实例所有权、记忆模型实际能力验证、运行代际发布和故障恢复。模块责任服从 [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)，验证见 [`../validation/memory-model-runtime.md`](../validation/memory-model-runtime.md)。

## 2. 配置权威与数据边界

默认用户级 `~/.pi/pi-context-memory.jsonc` 是记忆模型目标的唯一权威来源；受控部署或验证可用 `PCR_MEMORY_MODEL_SETTINGS` 覆盖路径。根结构只包含可为空的 `memoryModel`；非空值是扩展明确支持的最小配置面：

- `provider`：扩展能够转换并由 OpenViking 配置入口验证的 Provider；
- `model`：对应 Provider 接受的模型 ID 或路由表达式；
- `api_key`：当前来源的可选直接凭据或 `$NAME` / `${NAME}` 环境引用；
- 该 Provider 当前必要且无法推导的连接字段。

`memoryModel: null` 表示没有可运行记忆模型。扩展启用时，该状态不能发布任务请求能力。

文件缺失时，长时记忆模块原子独占创建 JSONC 模板；已有文件只读解析，不自动覆盖，并在平台支持时收紧为仅当前用户可读写。直接填写 key 时，用户配置本身包含该值；使用环境引用时，用户配置只保存变量名。语法和语义诊断保留定位信息，凭据值不进入诊断。

Launcher 按 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 的凭据契约完成预检编译，并以最小环境启动受管 OpenViking。编译凭据只存在于 Launcher 内存和目标子进程的固定内部变量；运行配置、状态、诊断和 Pi 进程不持有实际值。运行状态分别表达目标配置、profile、实际子进程、服务 readiness、模型能力证明和任务请求能力。

## 3. 用户配置与内部运行 profile

用户配置只选择记忆 Provider、模型、凭据引用和 OpenViking 该 Provider 公开且经适配器审查的必要连接字段。扩展按 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 接受配置字段，并为当前精确目标生成版本化 `MemoryRuntimeProfile` 和 OpenViking 配置。

```text
MemoryRuntimeProfile = {
  profileVersion,
  provider, model, api,
  thinking, temperature, stream, maxOutput,
  requestTimeout, maxRetries, maxConcurrency,
  adapterVersion
}
```

每个字段都有当前运行责任：thinking、temperature、stream、maxOutput、timeout、retry 与 concurrency 显式进入受审查的 OpenViking VLM 配置边界；实际 task usage 再核对 Provider、模型和模型调用。profile 不承诺 OpenViking 未公开的最终 wire 字段，也不含凭据、存储路径、任务模型预算、来源 retention 或 Provider fallback；历史输入与检查点 retention 由长时记忆模块的独立有界策略负责。retry 只能重试同一 Provider/模型/API。

配置桥接受当前契约中的 OpenViking schema 字段和凭据形态；每个精确 Provider、模型和连接配置都必须在当前受管子进程上产生 accepted task、匹配 usage 与 marker-bearing Working Memory，才为该进程发布能力证明。schema 或探针失败时保持未授权。

运行配置指纹同时绑定用户目标、profile 指纹和 adapter 版本。profile 代码变化属于待应用运行目标，只有显式重启和实际能力探针成功后进入 active 代际；当前 ready 实例继续使用自己的已绑定 profile。

配置 schema 成功只证明 OpenViking 能够加载目标设置，不证明具体模型能够完成 Working Memory。任务请求能力需要独立的实际能力探针。

## 4. 运行事实与代际

系统维护以下相互独立的运行事实：

```text
targetConfig
  用户请求应用的配置指纹

targetProfile
  目标 Provider/模型/API 对应的 MemoryRuntimeProfile 指纹

activeProcess
  启动器实际拥有的 launchId + childPid

serviceReady
  OpenViking 服务健康与必要本地组件可用

memoryCapability
  当前 activeProcess 和模型配置完成实际 Working Memory 探针的证明

requestReady
  activeProcess、serviceReady 和 memoryCapability 同时代际一致
```

用户配置模块拥有 targetConfig/targetProfile。项目启动器拥有 activeProcess、serviceReady 和状态文件原子发布；`memory-runtime-capability.ts` 拥有生产探针、proof 校验与代际身份。Launcher 只编排这些能力函数，不另建协议成功语义。Session 记忆协调和 Pi 集成只消费能力模块对当前 runtime snapshot 的校验结果。
运行代际由启动器身份、子进程身份、能力 proof ID、active 配置指纹、active profile 指纹和 adapter 版本共同构成；proof ID 防止操作系统复用 PID 时误采纳其它代际的 optimizer 或 Session 状态。memoryCapability 在该代际启动或显式恢复时由实际探针生成，并与该代际共同生效。每个 constructed 请求绑定该代际；Provider hook 重新读取当前 runtime，只有同一代际和同一 proof 仍有效才确认。启动器、子进程、能力 proof、active 配置/profile 或 adapter 变化创建新代际；其它代际的 checkpoint、refresh 和请求证明不能进入当前代际。实际记忆调用失败时锁存故障；显式重启或恢复探针成功后进入新代际。

Launcher 发布原始 runtime state；能力模块验证其绑定并形成当前代际结果，Session 记忆协调和 Pi 集成据此决定请求。用户配置文件变化本身不改变 active 代际。

## 5. 实际能力探针

能力探针使用扩展生产依赖的公开 OpenViking Session 能力验证当前模型：

1. 创建隔离的探针 Session；
2. 写入确定性消息和来源 ID；
3. 触发能够实际调用记忆模型的 commit；
4. 验证 commit 结果、任务终态和错误语义；
5. 取得 context assembly；
6. 独立核对非空、非 fallback 且包含版本化 marker 的 Working Memory overview，以及只属于探针的 retained source；
7. 删除探针 Session；
8. 发布 Provider、模型、API、配置、`MemoryRuntimeProfile`、子进程、协议版本、探针实现和实际请求证据共同绑定的能力证明。

能力探针在建立受管进程代际或用户显式恢复时运行。进程退出、显式重启、active 绑定变化或 proof/usage 不一致会终止该证明；运行期间的外部 Provider 认证、配额或服务故障由下一次实际记忆操作发现并按故障边界阻断。业务 Session 的检查点刷新保持独立。

`/health`、`/ready`、配置加载、模型对象创建或 `skipped` no-op 不能单独证明记忆模型能力。探针必须确认实际模型调用成功，并把 token 与费用归入运行观测。

探针使用固定有界输入、MemoryRuntimeProfile 的请求与重试边界和有界清理流程。慢但在 profile 支持边界内成功的实际调用必须完成；失败形成脱敏、可归因的故障，不发布 `requestReady`。

## 6. 正常控制流

```text
/memory-model
  → 确保用户模板存在
  → 解析并校验 memoryModel
  → 读取目标配置/profile、active 进程/profile、服务和能力状态
  → 显示配置、运行实例、能力证明与故障诊断

/restart-viking
  → 启动器串行接受应用请求
  → 重新读取用户目标，生成并校验该目标的 MemoryRuntimeProfile，完成预检
  → 生成绑定 profile 指纹且只含固定内部凭据引用的运行配置
  → 确认目标端口和实例所有权
  → 停止当前启动器拥有的旧子进程
  → 启动新子进程并等待服务 readiness
  → 能力模块执行实际记忆模型能力探针
  → Launcher 原子发布包含能力 proof 的 runtime state，能力模块验证并形成新运行代际
  → Pi 集成从当前 branch 重建增强上下文
```

当前 ready 实例在新配置预检期间继续运行。预检失败保持旧代际和请求能力不变。

## 7. 启动器所有权与并发

项目启动器是 OpenViking 进程生命周期所有者。它发布受限权限的启动标识和 loopback 控制入口；扩展只提交控制请求，只有持有实际 `ChildProcess` 的启动器可以停止子进程。

启动器遵守以下不变量：

1. 启动前原子取得生命周期锁；活锁拒绝第二启动器，死锁需要维护者显式核对；
2. 只管理当前启动器持有的子进程，不以端口状态推断所有权；
3. 同一时刻只执行一次启动或重启；
4. 当前实例停止前完成静态配置、凭据引用和目标端口预检；
5. 状态始终区分 target、active process、service readiness 和 memory capability；
6. 控制请求使用操作 ID 和覆盖预检、停止、启动、readiness、能力探针与失败清理的完整期限；
7. readiness、能力探针或进程终态失败时发布准确故障，不宣告伪完成；
8. 启动器退出时完成一次串行清理，并只在子进程停止后释放控制入口和生命周期锁。

多个 Pi 进程读取同一用户配置；每个项目启动器只拥有自己的运行目录和 OpenViking 子进程。运行目录及状态文件属于当前本地用户的受限信任域；本系统不把能够以同一用户修改仓库、扩展或运行目录的进程视为隔离对手，普通 JSON proof 也不宣称提供该级防篡改。

## 8. 故障与恢复边界

以下情况不发布任务请求能力：

- 配置解析、schema、必要字段校验或 MemoryRuntimeProfile 生成失败；
- 凭据引用未设置或认证失败；
- Launcher 所有权、锁或目标端口不满足条件；
- 子进程停止、启动失败或 readiness 超时；
- 实际记忆模型能力探针失败；
- 当前 active 进程、配置/profile 指纹、adapter 与能力证明代际不一致。

启动器可为诊断、来源恢复或重新配置保留不含任务请求能力的基础服务；Pi 集成在该状态不确认增强输出并调用 abort，handler 返回与 transport 实际结果分别观测。

运行中的 OpenViking 请求在重启时以受控失败结束。Session 记忆协调锁存旧代故障，新代验证通过后从当前 Pi branch 重建；系统不复用旧代结果或自动发送用户 prompt。

## 9. 观测与安全

运行状态和日志可以保存：Provider、模型、API、配置与 profile 指纹、adapter 版本、launchId、childPid、阶段、错误码、期限、探针 token、任务 ID 和内容哈希。

以下内容不得保存或回显：API key、OAuth token、云凭据、认证响应、完整任务 payload 和完整探针响应。用户配置与子进程环境遵循第 2 节的数据边界；观测只记录变量是否存在或凭据哈希是否匹配，不记录实际值。

配置加载、readiness、记忆模型能力、运行代际、本扩展授权、hook 时点证明和 transport 最终采用分别观测，不能相互推断。

## 10. 验证与校准

设计成立需要证明：

- 配置桥接受的目标都生成精确绑定的 MemoryRuntimeProfile；每个实际受管进程只有在能力探针通过后才发布请求能力；
- profile 的模型请求字段精确进入受审查 OpenViking VLM 配置，实际 task usage 绑定目标 Provider/模型，生成配置不存在 backup；
- 用户文件权限、内容所有权和凭据保密边界成立；
- `/memory-model` 准确展示相互独立的运行事实；
- `/restart-viking` 保持实例所有权、并发和失败清理不变量；
- 服务 readiness 成功但模型能力失败时不发布请求能力；
- 能力探针确实触发目标记忆模型并验证 Working Memory 结果；
- 能力证明与进程代际共同生效，空闲期记忆 Provider 请求数保持为零；进程退出、重启或绑定不一致会撤销能力；
- 当前 ready 实例不受未应用配置变化影响；
- 配置、服务、能力和代际失败时，本扩展不确认增强输出并调用 abort；transport 结果独立观测；
- 新代际只采用从当前 Pi branch 重建的结果；
- 能力探针与正常记忆调用的 token 和成本可归属。

具体 fixture、故障矩阵和 evidence 由 [`../validation/memory-model-runtime.md`](../validation/memory-model-runtime.md) 定义。
