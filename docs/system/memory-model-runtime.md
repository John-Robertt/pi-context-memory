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

文件缺失时，长时记忆模块原子独占创建 `0600` JSONC 模板；已有文件只读解析，不自动覆盖，并在读取时收紧为 `0600`。语法和语义诊断保留定位信息，凭据值不进入诊断。

运行配置由项目基础配置和有效用户配置编译为可重建的项目内 `0600` 文件。运行状态区分目标配置、实际子进程、服务 readiness、模型能力证明和任务请求能力；这些生成文件不承担业务事实权威。

## 3. 配置转换规则

扩展维护稳定、最小的用户配置面，并通过 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 转换为当前 OpenViking 配置。转换只依赖 OpenViking 聚合配置校验入口，不复制上游完整 Provider registry 或 backend 内部路由表。

用户模型 ID 按所选 Provider 语义进入生成配置。LiteLLM 使用其来源路由；`thinking`、reasoning、temperature 等参数只有在目标适配器最终请求得到验证后才形成契约。

配置 schema 成功只证明 OpenViking 能够加载目标设置，不证明具体模型能够完成 Working Memory。任务请求能力需要独立的实际能力探针。

## 4. 运行事实与代际

系统维护以下相互独立的运行事实：

```text
targetConfig
  用户请求应用的配置指纹

activeProcess
  启动器实际拥有的 launchId + childPid

serviceReady
  OpenViking 服务健康与必要本地组件可用

memoryCapability
  当前 activeProcess 和模型配置完成实际 Working Memory 探针的证明

requestReady
  activeProcess、serviceReady 和未过期 memoryCapability 同时代际一致
```

用户配置与长时记忆模块拥有 targetConfig；项目启动器拥有 activeProcess 和 serviceReady；长时记忆模块拥有 memoryCapability；Session 记忆协调只有在四项绑定一致且证明未过期时发布 requestReady。

运行代际由启动器身份、子进程身份、active 配置指纹和能力证明共同构成。任何字段变化都创建新代际；旧代 pending、ready context 和请求证明不得进入新代际。

Pi 集成只消费 Session 记忆协调发布的 `requestReady` 代际。用户配置文件变化本身不改变 active 代际。

## 5. 实际能力探针

能力探针使用扩展生产依赖的公开 OpenViking Session 能力验证当前模型：

1. 创建隔离的探针 Session；
2. 写入确定性消息和来源 ID；
3. 触发能够实际调用记忆模型的 commit；
4. 验证 commit 结果、任务终态和错误语义；
5. 取得 context assembly；
6. 核对非空、可识别、来源完整且不含通用失败内容的结果；
7. 删除探针 Session；
8. 发布模型、配置、子进程、协议版本、探针实现和 `validUntil` 共同绑定的能力证明。

能力证明按有界租约维护。当前代际中实际完成并通过 assembly 核验的业务 Working Memory task 可以续租；没有此类结果时，在租约到期前执行隔离续租探针。任务请求遇到临近或已到期证明时等待续租结果，不使用过期证明。

`/health`、`/ready`、配置加载、模型对象创建或 `skipped` no-op 不能单独证明记忆模型能力。探针必须确认实际模型调用成功，并把 token 与费用归入运行观测。

探针使用有界输入、期限和清理流程。探针失败形成脱敏、可归因的故障，不发布 `requestReady`。

## 6. 正常控制流

```text
/memory-model
  → 确保用户模板存在
  → 解析并校验 memoryModel
  → 读取目标配置、active 进程、服务和能力状态
  → 显示配置、运行实例、能力证明与故障诊断

/restart-viking
  → 启动器串行接受应用请求
  → 重新读取并预检用户配置
  → 生成受限权限运行配置
  → 确认目标端口和实例所有权
  → 停止当前启动器拥有的旧子进程
  → 启动新子进程并等待服务 readiness
  → 长时记忆执行实际记忆模型能力探针
  → Session 记忆协调原子发布新运行代际与 requestReady
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

多个 Pi 进程读取同一用户配置；每个项目启动器只拥有自己的运行目录和 OpenViking 子进程。

## 8. 故障与恢复边界

以下情况不发布任务请求能力：

- 配置解析、schema 或必要字段失败；
- 凭据引用未设置或认证失败；
- Launcher 所有权、锁或目标端口不满足条件；
- 子进程停止、启动失败或 readiness 超时；
- 实际记忆模型能力探针失败；
- 当前 active 进程与能力证明代际不一致；
- 能力证明到期且续租探针未成功。

启动器可以为诊断、来源恢复或重新配置保留不含任务请求能力的基础服务，但 Pi 集成必须将该状态视为初始化或故障，不能发送任务模型请求。

运行中的 OpenViking 请求在重启时以受控失败结束。Session 记忆协调锁存旧代故障，新代验证通过后从当前 Pi branch 重建；系统不复用旧代结果或自动发送用户 prompt。

## 9. 观测与安全

运行状态和日志可以保存：Provider、模型、配置指纹、launchId、childPid、阶段、错误码、期限、探针 token、任务 ID 和内容哈希。

以下内容不得保存或回显：API key、OAuth token、云凭据、认证响应、完整任务 payload 和完整探针响应。

配置加载、服务 readiness、模型能力、运行代际、请求授权和最终 Provider 采用分别观测。任何一项不能由其它状态推断。

## 10. 验证与校准

设计成立需要证明：

- 所有受支持配置均能通过当前 OpenViking 配置入口；
- 用户文件权限、内容所有权和凭据保密边界成立；
- `/memory-model` 准确展示相互独立的运行事实；
- `/restart-viking` 保持实例所有权、并发和失败清理不变量；
- 服务 readiness 成功但模型能力失败时不发布请求能力；
- 能力探针确实触发目标记忆模型并验证 Working Memory 结果；
- 当前 ready 实例不受未应用配置变化影响；
- 配置、服务、能力和代际失败时任务 Provider 请求数不增加；
- 新代际只采用从当前 Pi branch 重建的结果；
- 能力探针与正常记忆调用的 token 和成本可归属。

具体 fixture、故障矩阵和 evidence 由 [`../validation/memory-model-runtime.md`](../validation/memory-model-runtime.md) 定义。
