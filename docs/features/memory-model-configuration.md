# 记忆模型配置与 OpenViking 快速重启

## 1. 文档角色

本文定义用户在 Pi 内配置记忆模型并让配置快速生效的可观察行为。产品边界见 [`../../PRODUCT.md`](../../PRODUCT.md)，跨模块流程见 [`../system/memory-model-runtime.md`](../system/memory-model-runtime.md)，验证要求见 [`../validation/memory-model-runtime.md`](../validation/memory-model-runtime.md)。

OpenViking原生配置、运行配置格式和进程通信由系统设计统一管理；本文只拥有用户输入、命令结果和降级体验。

## 2. 目标与边界

系统在 `~/.pi/pi-context-memory.jsonc` 维护用户级 OpenViking VLM 配置。文件不存在时创建合法的空配置，并以注释列出项目锁定 OpenViking 版本支持的全部 Provider、模型目标、连接字段及认证入口；已有文件始终由用户拥有，系统不自动覆盖或修复。

记忆模型设置独立于 Pi `/model` 的任务模型设置。修改记忆模型保持当前任务模型和 Pi session branch 不变，也不产生任务模型调用或对话消息。

凭据由环境变量、云原生凭据链或 OpenViking支持的认证机制提供，不进入记忆模型设置和 Pi session。

## 3. `/memory-model`

`/memory-model` 创建缺失模板并显示配置文件路径、当前有效配置、项目托管实例实际加载的模型及二者是否一致。命令只检查和展示，不重写 JSONC；用户直接编辑文件后使用 `/restart-viking` 应用。

JSONC 根只接受可为空的 `memoryModel`，其非空值通过锁定 OpenViking 的 Provider registry、字段能力和完整 schema 校验。语法错误报告文件与行列，语义错误报告配置字段；空配置表示不启用记忆模型，执行 `/restart-viking` 会切换为无 VLM 基础服务。

`provider: "litellm"` 表示多来源路由层，不等同于单一模型来源。模板从锁定 OpenViking LiteLLM backend 列出内置来源的规范模型前缀、关键词识别顺序和来源凭据环境变量，以及保持原样的显式云路由、云原生认证范围、`zai/` 特例和自定义 OpenAI-compatible 写法。LiteLLM 官方目录仅作为更多格式参考；未列路由不属于当前模板保证范围。
## 4. `/restart-viking`

`/restart-viking` 将当前有效的用户级记忆模型配置应用到当前项目启动器管理的 OpenViking 实例。命令在执行期间显示“正在应用”，并在新实例达到 readiness 后返回实际加载的来源和模型。

启动器控制信息缺失、生命周期锁不匹配、实例所有权不匹配或目标端口由其它进程占用时，命令返回对应诊断和项目启动入口。目标端口在停止旧实例前检查；项目启动器只管理自己创建的实例。

同一用户的 Pi session 读取同一配置文件；每个项目仍由自己的启动器管理独立 OpenViking 实例。同一项目的应用请求串行执行，客户端按启动器期限等待，连接中断不撤销已接受操作，超时结果只按同一操作 ID 对账。

## 5. 降级、状态与恢复

运行中实例应用新配置前先完成 JSONC、schema、凭据和目标端口预检；错误配置不改变文件，也不停止旧实例。冷启动遇到无效配置时，启动器明确记录诊断并启动无 VLM 的基础 OpenViking，使来源召回继续可用；Pi Agent 和原生上下文路径始终继续。

扩展在 session 启动和后续 turn 前检查配置；同一诊断只提示一次，配置恢复有效后清除诊断抑制。用户随时可以通过 `/memory-model` 获取完整路径和当前错误。
界面的“增强记忆”或“Pi 原生”继续以实际 Provider 请求采用的上下文路径为准。服务 readiness 和记忆模型设置已生效作为独立运行事实展示；当前路线增强结果实际进入模型输入后，状态才显示“增强记忆”。

readiness 检查只验证本地服务，不产生外部 Provider 调用。具体模型的 Working Memory 能力由受控验证和实际调用确认。

## 6. 完成条件

- 用户只填写 OpenViking VLM Provider、模型和该 Provider 要求的必要连接信息，其余 OpenViking 配置由系统生成；
- 可选范围与项目锁定 OpenViking版本的 VLM 能力描述一致；
- 凭据与用户 JSONC、Pi session 和运行状态保持分离；
- `/memory-model` 只检查并准确区分用户配置和运行实例，不覆盖用户文件；
- `/restart-viking` 只控制项目启动器拥有的实例，并在 readiness 后报告实际加载设置；
- 配置无效或服务异常期间，错误目标不生效，冷启动基础服务和 Pi 原生任务路径继续运行；
- 多 Pi session 观察同一用户配置，每个项目的实例所有权和并发应用保持隔离；
- 记忆模型设置、Pi 任务模型和增强路径状态保持独立语义。
