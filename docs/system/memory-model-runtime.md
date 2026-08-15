# 记忆模型配置与 OpenViking 运行时

## 1. 文档角色

本文定义 Pi 集成、长时记忆和项目启动器如何协作实现 [`../features/memory-model-configuration.md`](../features/memory-model-configuration.md)，包括 OpenViking VLM 配置编译、实例重启和运行状态发布。模块责任服从 [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)，验证见 [`../validation/memory-model-runtime.md`](../validation/memory-model-runtime.md)。

## 2. 配置权威与数据边界

默认用户级 `~/.pi/pi-context-memory.jsonc` 是记忆模型目标的唯一权威来源；受控部署或验证可用 `PCR_MEMORY_MODEL_SETTINGS` 统一覆盖 Pi 与启动器读取的路径，覆盖路径在该运行环境中取代默认路径而不形成第二份配置。根结构只包含可为空的 `memoryModel`；非空值是扩展明确支持的最小配置面：

- `provider`：扩展当前能够转换并由项目 OpenViking 配置入口验证的 Provider；
- `model`：对应 Provider 接受的模型 ID 或路由表达式；
- `api_key`：当前 Provider 或 LiteLLM 来源的可选凭据；可直接填写 key，也可使用 `$NAME` 或 `${NAME}` 引用启动器环境变量；
- 该 Provider 当前必要且无法推导的其它连接字段。

界面中的“来源”映射到规范 `provider`。OpenAI-compatible服务通过 `provider: "openai"` 和相应 `api_base` 表达，LiteLLM路由按其模型路由语义表达。配置结构只由 OpenViking schema 明确定义且当前来源需要的字段组成。

文件缺失时，长时记忆模块根据扩展当前支持的配置面原子独占创建 `0600` JSONC 模板；模板说明支持的 Provider、必要字段和认证入口，`memoryModel: null` 表示未配置。已有文件只读解析内容、不自动覆盖，并在读取时把文件权限收紧为 `0600`；语法诊断保留行列，语义诊断定位到 `memoryModel`。该用户配置独立于 Pi session 历史和 `/model` 任务模型。
运行配置由项目基础配置、公共 VLM 默认值和有效用户配置编译为可重建的 `.artifacts/openviking/runtime/openviking.json`。`state.json` 分别记录实际 ready 实例的 `active*` 配置事实与当前应用目标的 `target*` 配置事实，并保存冷启动配置诊断、启动器与子进程 PID、操作 ID、阶段和 readiness；失败目标不会伪装成运行配置。`launcher.json` 保存本地控制入口、启动标识和操作期限，`launcher.lock` 原子约束同一项目运行目录只有一个生命周期所有者。这些生成文件都不承担业务事实权威。
`api_key` 原样写入 `0600` 运行配置；普通字符串是直接凭据，完整 `$NAME` 或 `${NAME}` 由 OpenViking 加载配置时从启动器环境展开。编译预检只检查引用变量是否存在，不展开或记录其值。普通 Provider 和 LiteLLM OpenRouter 需要有效 `api_key`；其它 LiteLLM 路由可按官方目录省略并使用来源环境或云原生认证，`openai-codex` 可使用原生 OAuth。模板只提供当前验证的少量显式云路由示例，不复制完整凭据 registry。运行状态、日志、诊断、evidence 和 Pi session 均不保存或回显 API key、OAuth token、云凭据或认证响应。

## 3. 来源覆盖与转换规则

扩展维护一个稳定、最小的用户配置面，并通过 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 把它转换为当前 OpenViking 配置。配置桥只依赖 OpenViking 聚合导出的配置校验入口，不复制其完整 Provider registry 或 backend 内部路由表；上游新增未知能力不得使现有受支持配置失效。依赖升级后，验证入口重新核对每个受支持配置仍能被目标 OpenViking 加载。

用户提供的模型 ID 按所选 Provider 语义进入生成配置。LiteLLM 使用标准 `provider/model` 路由；具体来源、凭据和特殊格式以其当前官方目录为准，扩展只承诺模板中明确列出的形式。`thinking`、reasoning 和 temperature 等参数不具有跨 Provider 的统一语义；产品结论必须来自目标适配器最终请求，未转发的参数使用 Provider 默认。
配置通过 schema 表示 OpenViking能够加载该调用目标；模型能力表示具体模型能够可靠完成 Working Memory tool calling。两项事实分别观测，模型能力不足时由 Pi 原生路径继续任务。

## 4. 正常控制流

```text
/memory-model
  → Pi 集成请求长时记忆模块确保用户 JSONC 模板存在
  → 解析并校验 memoryModel，不修改已有文件
  → 对比项目启动器状态并显示配置路径、诊断和实际运行模型

/restart-viking
  → Pi 集成向项目启动器提交应用请求
  → 启动器串行处理请求并重新读取用户 JSONC
  → 配置编译器完成 schema、连接字段和凭据预检
  → 若目标地址不同，先确认目标端口未被未知进程占用
  → 生成项目内、受限权限的 OpenViking 运行配置
  → 优雅停止启动器当前拥有的子进程
  → 启动新子进程并等待 `/health` 健康
  → 原子发布新的运行状态
  → Pi 集成显示实际加载的 Provider 和模型
```

OpenViking 在服务进程内缓存 VLM 实例，因此用户配置变化通过各项目启动器重启自己的服务进程应用。

## 5. 启动器所有权与并发

项目启动器是 OpenViking 进程生命周期所有者。它把受限权限的启动标识和随机 loopback HTTP 控制入口发布到项目运行目录；控制请求必须携带当前启动标识，同时只能由持有实际 `ChildProcess` 的启动器停止子进程。扩展只提交控制请求，OpenViking 子进程和模型请求仍由启动器与 OpenViking 负责。

启动器遵守以下不变量：

1. 启动前原子取得生命周期锁；活锁拒绝第二启动器，死锁不自动接管；
2. 只停止当前启动器持有的 `ChildProcess`，端口状态不作为进程所有权依据；
3. 同一时刻只执行一次启动或重启，后续请求得到明确的进行中状态；
4. 当前实例停止前完成静态配置及不同目标地址的端口预检；
5. 状态始终区分实际运行的 `active*` 与正在应用的 `target*`；
6. 控制客户端为请求生成操作 ID，并从启动器读取覆盖配置 bridge、旧实例停止、readiness 和失败新实例清理的操作期限；客户端断开不会取消已接受的操作，超时后只按同一操作 ID 对账；
7. readiness 超时、子进程提前退出或无法确认子进程停止时发布失败事实，不宣告伪完成；
8. 启动器退出时完成唯一一次串行清理，并只在子进程已停止后释放控制入口与生命周期锁。

多个 Pi 进程读取同一用户配置；每个项目启动器只拥有自己的运行目录和 OpenViking 子进程，用户级配置共享不扩大进程所有权。

## 6. 失败与采用边界

运行中应用以有效 JSONC、匹配的生命周期锁、可用目标端口、有效 schema 和必要凭据为前置条件；不满足时返回精确诊断并保留当前实例。冷启动配置解析或编译失败时，启动器把诊断写入运行状态并使用项目基础配置启动无 VLM 实例；它不修改用户文件，也不把错误目标记为 `active*`。实例停止后新实例未就绪时，`active*` 为空、`target*` 保留失败目标。死锁仍需维护者核对 PID 与托管子进程后显式恢复。

重启会结束在途 OpenViking请求。调用方收到受控失败并保持 Pi Agent 继续；后续生命周期或显式操作重新提交仍然属于当前路线的工作。

配置加载、服务就绪、模型能力和上下文采用是四种独立事实：配置加载表示运行实例采用目标设置；服务就绪表示本地服务可用；模型能力由受控模型探针或实际调用确认；上下文采用只在当前路线结果实际进入 Provider 请求后成立。

## 7. 验证与校准

[`../validation/memory-model-runtime.md`](../validation/memory-model-runtime.md) 及其稳定 evidence 证明扩展支持配置面能够通过当前项目依赖校验、上游默认参数不被伪统一、凭据保持分离、启动器所有权可靠、并发应用确定，以及配置加载、服务就绪、模型能力和上下文采用四项事实相互独立。OpenViking 字段和版本兼容统一服从 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md)。
