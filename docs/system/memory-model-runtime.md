# 记忆模型配置与 OpenViking 运行时

## 1. 文档角色

本文定义 Pi 集成、长时记忆和项目启动器如何协作实现 [`../features/memory-model-configuration.md`](../features/memory-model-configuration.md)。模块责任服从 [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)，验证见 [`../validation/memory-model-runtime.md`](../validation/memory-model-runtime.md)。

## 2. 配置权威与数据边界

项目级记忆模型设置是用户选择的唯一权威来源。持久化结构是 OpenViking VLM schema 的受控投影，由以下部分组成：

- `provider`：来自项目锁定 OpenViking版本的 Provider registry；
- `model`：对应 Provider 接受的模型 ID 或路由表达式；
- Provider schema 要求且无法由系统推导的具体非凭据连接字段。

界面中的“来源”映射到规范 `provider`。OpenAI-compatible服务通过 `provider: "openai"` 和相应 `api_base` 表达，LiteLLM路由按其模型路由语义表达。配置结构只由 OpenViking schema 明确定义且当前来源需要的字段组成。

该设置由同一项目的 Pi session 共享，独立于 Pi session 历史和 `/model` 任务模型。写入先通过当前 OpenViking schema 校验，再原子替换项目设置。

运行配置由基础 OpenViking配置、公共 VLM 默认值和项目级记忆模型设置编译得到，是可删除、可重建的启动产物。运行状态只保存实例所有权、启动标识、配置指纹、Provider、模型、readiness 和控制入口所需的非凭据元数据。

凭据由环境变量、云原生凭据链或 Provider/OpenViking认证存储提供。项目设置、生成的运行配置和运行状态只保存凭据引用或环境变量占位符，不保存展开后的 API key、OAuth token、云凭据或认证响应。

## 3. 来源覆盖与转换规则

项目锁定 OpenViking版本的 Provider registry 与 `VLMConfig` schema 共同定义可配置范围。配置界面和编译器从同一能力描述获得 Provider集合、字段要求和默认值；产品补充面向用户的名称、说明和凭据入口提示。OpenViking升级后，同一验证入口重新核对转换覆盖。

用户提供的模型 ID 按 Provider语义进入生成配置。OpenAI-compatible服务、LiteLLM路由和后端原生认证均沿 OpenViking现有 VLM 接口工作，项目转换层只补全可推导的标准地址、公共请求默认值和凭据读取方式。

配置通过 schema 表示 OpenViking能够加载该调用目标；模型能力表示具体模型能够可靠完成 Working Memory tool calling。两项事实分别观测，模型能力不足时由 Pi 原生路径继续任务。

## 4. 正常控制流

```text
/memory-model
  → Pi 集成从长时记忆模块获得 OpenViking VLM 能力描述
  → 收集 provider、model 和 schema 要求的必要连接字段
  → 校验并原子保存项目级记忆模型设置
  → 对比启动器运行状态并显示“已生效”或“等待应用”

/restart-viking
  → Pi 集成向项目启动器提交应用请求
  → 启动器串行处理请求并重新读取项目设置
  → 配置编译器完成 schema、连接字段和凭据预检
  → 生成项目内、受限权限的 OpenViking运行配置
  → 优雅停止启动器当前拥有的子进程
  → 启动新子进程并等待 readiness
  → 原子发布新的运行状态
  → Pi 集成显示实际加载的 Provider 和模型
```

OpenViking在服务进程内缓存 VLM 实例，因此项目设置变化通过重启服务进程应用。

## 5. 启动器所有权与并发

项目启动器是 OpenViking进程生命周期所有者。它在项目目录内发布受限权限的所有权与控制信息，并只接受与当前启动标识匹配的项目本地请求。扩展消费控制能力，OpenViking子进程和模型请求仍由启动器与后端负责。

启动器遵守以下不变量：

1. 只停止自己创建且仍与当前启动标识匹配的子进程；
2. 端口状态用于诊断，启动标识决定实例所有权；
3. 同一时刻执行一次启动或重启，后续请求共享该结果或得到明确的进行中状态；
4. 当前实例停止前完成全部静态预检；
5. readiness 超时或子进程提前退出时发布失败状态；
6. 启动器退出时清理自己拥有的子进程。

多个 Pi 进程读取同一项目设置并请求同一启动器，OpenViking实例所有权始终属于启动器。

## 6. 失败与采用边界

有效启动器控制信息、匹配的实例所有权、可用端口、有效配置和必要凭据共同构成应用前置条件。前置条件不满足时，控制请求返回对应诊断并保持当前实例；当前实例停止后新实例未就绪时，后端保持不可用状态并等待下一次有效启动。

重启会结束在途 OpenViking请求。调用方收到受控失败并保持 Pi Agent 继续；后续生命周期或显式操作重新提交仍然属于当前路线的工作。

配置加载、服务就绪、模型能力和上下文采用是四种独立事实：配置加载表示运行实例采用目标设置；服务就绪表示本地服务可用；模型能力由受控模型探针或实际调用确认；上下文采用只在当前路线结果实际进入 Provider 请求后成立。

## 7. 验证与校准

[`../validation/memory-model-runtime.md`](../validation/memory-model-runtime.md) 证明配置转换覆盖项目锁定 OpenViking版本的全部 Provider、连接字段保持有界、凭据保持分离、启动器所有权可靠、并发应用确定，以及配置加载、服务就绪、模型能力和上下文采用四项事实相互独立。
