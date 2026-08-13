# 记忆模型配置与 OpenViking 重启验证

## 1. 验证责任

本文定义如何证明 [`../features/memory-model-configuration.md`](../features/memory-model-configuration.md) 的最小配置体验及 [`../system/memory-model-runtime.md`](../system/memory-model-runtime.md) 的配置转换、实例所有权和重启边界成立。

日常验证使用本地资源和协议替身，不产生外部 Provider 调用。真实模型能力与成本验证使用显式授权的受控入口。

## 2. 配置转换

验证从项目锁定依赖加载 OpenViking Provider registry 与 `VLMConfig` schema，并为 registry 中的每个 Provider生成配置 fixture；OpenAI-compatible服务和 LiteLLM路由使用代表性连接配置覆盖对应扩展路径。

固定检查包括：

- 配置界面和编译器观察到的 Provider集合与 OpenViking registry 一致；
- 项目设置只包含规范 `provider`、`model` 和 schema 要求的具体非凭据连接字段；
- 每个字段都具有 OpenViking schema 定义的类型和语义，未知字段被拒绝；
- 模型 ID 按所选 Provider语义进入生成配置；
- 每个 Provider生成正确的连接字段和公共默认值；
- 环境变量、云原生凭据链和 Provider/OpenViking认证存储与生成产物、状态、日志及 Pi session 保持分离；
- 未知 Provider、空模型、缺失必要连接字段、无效 schema 和缺失必要凭据在当前实例停止前返回明确错误；
- 相同输入产生相同配置指纹，运行配置可从项目设置和 OpenViking权威 schema 重建。

生成结果直接通过项目安装的 OpenViking schema 解析。Provider registry 中的每一项都是必需检查，依赖升级后同一入口自动观察并验证新的集合。

## 3. 命令语义

使用隔离项目和 faux Pi Provider 验证：

- `/memory-model` 正确读取、选择并原子保存项目级设置；
- 保存后任务模型、Pi session branch 和 Provider 调用数保持不变；
- 命令准确区分已保存设置与运行实例设置，并在不一致时提示 `/restart-viking`；
- `/restart-viking` 返回启动器实际加载的 Provider 和模型，readiness、模型能力与增强上下文采用分别表达；
- 两个 Pi session 观察同一项目设置，且设置保持在 Pi 对话之外。

## 4. 生命周期、所有权与并发

使用可控的本地 OpenViking替身和项目启动器验证：

- 正常应用按“预检—停止—启动—readiness—发布状态”顺序完成；
- 子进程退出、readiness 超时、陈旧所有权信息和控制请求中断均发布对应失败状态；
- 项目启动器未运行时返回启动入口；
- 未知进程占用目标端口时保持该进程和当前系统状态；
- 启动器只终止与当前启动标识匹配的子进程；
- 两个 Pi 进程并发应用只产生一个有效实例和一个确定的运行配置；
- 启动器收到退出信号时清理自己拥有的子进程。

测试记录进程 ID、启动标识、配置指纹、控制请求序号和 readiness 转换，不记录控制凭据。

## 5. 降级与状态分离

在当前实例停止前、新实例启动中和 readiness 后分别发起受控调用，证明：

- 应用配置期间 Pi Agent 继续，模型上下文采用 Pi 原生路径；
- 在途 OpenViking请求结束为受控失败，后续有效工作按当前路线重新提交；
- 显式召回失败形成 Pi 可处理的错误结果；
- readiness 后保持“Pi 原生”，直到当前 session 与路线核验通过的增强结果实际进入 Provider 请求；
- 配置加载、服务就绪、模型能力和上下文采用四项事实能够独立观测。

## 6. 模型能力边界

本地协议替身覆盖项目锁定 OpenViking依赖中的 VLM adapter 类型，检查消息、tools、tool choice 与 function call 转换。Provider registry 决定配置范围，协议探针证明 adapter 行为，两者使用独立通过条件。

具体模型的 Working Memory create/update 能力由真实受控 fixture 或实际调用确认。能力不足时，Pi 原生路径继续任务并提供模型能力诊断。

真实 Provider验证单独记录模型、Provider、请求次数、usage、成本、工具调用结果和取消行为，与日常免费 runner 保持分离。

## 7. 证据责任

该能力的本地 runner 与稳定 evidence 覆盖配置转换、命令无副作用、所有权、并发应用、降级和状态分离。evidence 纳入 `scripts/check-validation-evidence.mjs` 的当前实现哈希与精确检查集；真实 Provider结果只作为明确授权的能力证据，不成为日常验证前置条件。
