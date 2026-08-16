# 记忆模型配置与 OpenViking 重启

## 1. 文档角色

本文定义用户在 Pi 内配置记忆模型、检查运行状态、修复故障和应用新配置的可观察行为。产品边界见 [`../../PRODUCT.md`](../../PRODUCT.md)，跨模块流程见 [`../system/memory-model-runtime.md`](../system/memory-model-runtime.md)，验证要求见 [`../validation/memory-model-runtime.md`](../validation/memory-model-runtime.md)。

OpenViking 原生配置、生成配置格式和进程通信由系统设计管理；本文只拥有用户输入、命令结果、状态和恢复体验。

## 2. 目标与边界

系统在 `~/.pi/pi-context-memory.jsonc` 维护用户级记忆模型配置。文件不存在时创建合法模板，并以通用示例说明 `provider`、`model`、`api_key`、`api_base` 和 `api_version`；模板不列出 Provider 支持清单。每个精确配置由锁定 OpenViking 的 schema、配置构造和受管进程实际能力探针共同判定。已有文件由用户拥有，系统不自动覆盖；直接填写 key 时该文件包含实际值，环境引用只保存变量名。

记忆模型设置独立于 Pi `/model` 的任务模型设置。修改或应用记忆模型配置不改变任务模型、Pi session 或当前 branch，也不产生任务模型请求。

用户不配置 thinking、temperature、timeout、retry、并发或 Working Memory 策略。系统为配置桥接受的精确 Provider/模型/API 生成同一版本化内部 profile，不依赖上游隐式默认值，也不配置备用 Provider/model；该目标只有在当前受管进程的真实能力探针通过后才可授权增强。

`memoryModel.api_key` 归属于当前 Provider 或 LiteLLM 来源，可直接填写，也可使用 `$NAME` 或 `${NAME}` 引用 Launcher 环境变量。系统按凭据契约完成预检和子进程隔离；配置、运行状态、诊断、日志和 Pi session 不回显凭据。

扩展启用时，只有当前记忆模型实际能力已验证，本扩展才确认增强输出。`memoryModel: null` 时保持初始化/故障；请求到达后只执行本扩展已定义的等待或 abort，transport 结果另行观测，后续由用户决定。

## 3. `/memory-model`

`/memory-model` 创建缺失模板并显示：

- 配置文件路径；
- 当前配置的 Provider 和模型；
- 项目受管 OpenViking 实例实际加载的 Provider、模型和内部运行 profile；
- 配置与运行实例是否一致；
- 服务 readiness；
- 记忆模型实际能力证明及其绑定代际；
- 当前运行故障、最近一次扩展授权阻断原因和恢复入口。

命令只检查和展示，不重写用户 JSONC。语法错误报告文件与行列，语义错误报告对应字段；诊断保持脱敏。


## 4. `/restart-viking`

`/restart-viking` 将当前有效用户配置应用到当前项目启动器拥有的 OpenViking 实例：

1. 读取用户 JSONC，并为精确 Provider/模型/API 生成内部运行 profile；
2. 完成 schema、连接字段、凭据引用和目标端口预检；
3. 保持旧实例运行直到新目标具备启动条件；
4. 停止当前启动器拥有的旧子进程；
5. 启动新子进程并等待服务 readiness；
6. 对配置的记忆模型执行实际能力探针；
7. 发布新的运行代际和能力证明；
8. 从当前 Pi branch 重建增强上下文。

命令只有在实际能力验证通过后报告增强记忆 ready。OpenViking `/health` 或 `/ready` 单独成功不构成记忆模型能力证明。

`/restart-viking` 也是增强故障的统一显式恢复入口：用户修复来源存储或 OpenViking 数据面条件后，命令创建新运行代际并从当前 Pi branch 重新核验来源与工作上下文。

启动器控制信息缺失、生命周期锁不匹配、实例所有权不匹配或目标端口由其它进程占用时，命令返回对应诊断，不管理未知进程。

## 5. 配置变化与运行实例

用户文件描述下一次显式应用的目标。当前 ready 实例继续绑定自己的配置指纹和能力证明，直到用户执行 `/restart-viking`：

- 修改、清空或暂时写错用户文件不改变当前 ready 实例；
- 重启预检失败不停止当前 ready 实例；
- 当前实例停止后，本扩展进入初始化且不确认增强输出；
- 新实例服务或模型能力验证失败时进入“增强记忆 · 故障”。

系统分别表达配置有效、服务 ready、模型能力通过和增强请求采用，不能用其中一项代替其它事实。

## 6. 故障与恢复

当前 active 运行所依赖的配置、凭据、服务或模型能力不可用时：

- 错误配置不覆盖用户文件；
- 错误目标不发布为 active 运行实例；
- 本扩展不确认依赖错误运行条件的增强输出，并调用 `ctx.abort()`；
- 状态显示“增强记忆 · 故障”；
- `/memory-model` 提供脱敏原因和修复入口。

诊断可以给出 `/restart-viking`、配置修复、继续当前组合或禁用扩展等事实与入口，但不自动选择。用户选择重新验证时，新代际完成实际能力验证后恢复“增强记忆”；系统不自动发送故障前 prompt，也不修改 Pi、其它扩展或 Provider/模型。

## 7. 完成条件

- 用户只配置记忆模型 `provider`、`model`、可选 `api_key`、`api_base` 和 `api_version`；
- 环境引用的实际值不进入用户配置或生成配置；直接 key 只存在于用户自行填写的配置；
- 界面、状态、诊断、日志、evidence 和 Pi session 不回显凭据；
- `/memory-model` 准确区分用户配置、内部运行 profile、运行实例、服务 readiness 和模型能力；
- 稳定字段来自锁定 OpenViking VLM schema，Provider 字符串不由扩展枚举；每个实际目标只有在当前受管进程中完成 task usage 与 Working Memory 能力探针后才授权，生成配置不含 Provider/model fallback；
- `/restart-viking` 只控制项目启动器拥有的实例；
- 新运行代际只有在与当前受管进程、proof ID 和配置一致的实际记忆模型能力证明存在时确认增强输出；
- 配置、服务或能力故障时，本扩展不确认增强输出；`ctx.abort()` 和 transport 结果分别观测；
- 当前 ready 实例不受未显式应用的配置变化影响；
- 多个 Pi session 观察同一用户配置，每个项目的实例所有权保持隔离；
- 修复恢复和禁用扩展具有明确、互不混用的入口。
