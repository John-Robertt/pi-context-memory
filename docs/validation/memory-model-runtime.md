# 记忆模型配置与 OpenViking 重启验证

## 1. 验证责任

本文定义如何证明 [`../features/memory-model-configuration.md`](../features/memory-model-configuration.md) 的最小配置体验及 [`../system/memory-model-runtime.md`](../system/memory-model-runtime.md) 的配置转换、实例所有权和重启边界成立。

验证按风险先运行本地资源和协议替身，再在凭据可用时运行 [`../../validation/model.json`](../../validation/model.json) 选择的 OpenRouter 模型能力与成本环节。

## 2. 配置转换

验证扩展明确支持的 Provider 子集能够通过项目安装的 OpenViking 聚合配置入口，并为每个受支持 Provider 生成配置 fixture。OpenAI-compatible 服务和 LiteLLM 使用代表性连接配置覆盖对应转换路径。

固定检查包括：

- 上游新增未知 Provider 不进入用户配置面，也不会使已有受支持 Provider 失效；
- 配置桥只使用 OpenViking 聚合导出的 `OpenVikingConfig` 与 `VLMConfig` 校验入口，不读取其私有 registry 或 backend 路由表；
- 模板说明扩展验证的 Provider、必要字段、认证入口、少量显式云路由示例和 LiteLLM 官方目录，不复制内部关键词和路由顺序；
- 生成配置不主动覆盖跨 Provider 语义不一致的 `thinking`、reasoning、temperature 或 stream；adapter probe 另外核对 LiteLLM OpenRouter 请求保留模型路由、转发 temperature `0` 且不转发 reasoning；
- 默认路径严格为隔离 HOME 下的 `.pi/pi-context-memory.jsonc`，缺失目录不向组或其他用户开放，缺失文件以 `0600` 原子独占创建，已有普通文件读取时收紧为 `0600` 且内容不变；已有和悬空符号链接保持不变；
- 空文件、纯注释和 `memoryModel: null` 均表示未配置；普通注释、字符串内 URL 和尾逗号可解析；
- 语法和语义错误形成有路径的脱敏诊断，已有文件不被检查、命令或启动器覆盖；
- `api_key` 归属于单个记忆模型设置；直接 key 与 `$NAME` / `${NAME}` 环境引用都原样编译到 `0600` 运行配置，引用在 OpenViking 加载时展开；必需字段缺失或引用变量未设置时在停旧实例前失败；无需 API key 的 LiteLLM 云原生认证及 `openai-codex` 原生认证仍可省略；用户 key 不进入状态、诊断、日志、evidence 或 Pi session；
- 真实质量 runner 通过 Pi 认证命令解析 `openrouter` key 并只返回环境引用与单次子进程环境；本地替身验证命令参数、环境继承、调用失败脱敏以及父进程环境不被修改。

生成结果直接通过项目安装的 OpenViking 配置入口解析。依赖升级后由维护者重新运行同一入口；固定版本 VLM adapter 探针继续单独观察消息、tools、tool choice 和 function call 行为，但其内部路由细节不进入生产配置契约。
## 3. 命令语义

使用隔离项目和 faux Pi Provider 验证：

- `/memory-model` 只创建缺失模板、检查并展示用户配置，不接受写入参数且不改变文件；
- session 启动时无 Provider 请求地提示配置错误，同一内容哈希只自动提示一次，内容变化后可再次提示，Pi 原生路径继续；
- 检查和应用配置后，任务模型、Pi session branch 和 Provider 调用数保持不变；
- 命令准确区分用户配置与运行实例，并在不一致时提示 `/restart-viking`；
- `/restart-viking` 返回实际加载模型，`memoryModel: null` 在应用前显示等待重启、应用后显示无 VLM 且已生效；readiness、模型能力与上下文采用分别表达；
- 两个 Pi session 观察同一用户文件，配置内容不进入 Pi 对话。

## 4. 生命周期、所有权与并发

使用可控的本地 OpenViking替身和项目启动器验证：

- 正常应用按“预检—停止—启动—`/health` 健康—发布状态”顺序完成；来源召回 runner 另外证明健康后的真实资源操作；
- 子进程退出和 readiness 超时发布失败状态，失败目标与实际运行配置分离；
- 冷启动配置无效、必需 `api_key` 缺失或引用的环境变量未设置时发布不含 key 的诊断并启动无 VLM 基础服务，错误模型不进入 `active*`；
- 两个启动器竞争时只有原子取得生命周期锁的进程成为所有者，死锁要求显式核对后恢复；
- 项目启动器未运行、控制信息与锁不匹配或启动标识错误时返回明确诊断；
- 当前实例运行时，未知进程占用不同目标端口会在停止旧实例前失败并保留旧实例；
- 启动器只终止自己持有的子进程，未知端口进程不被终止；
- 两个 Pi 进程并发应用只产生一个有效实例和一个确定的运行配置；
- 客户端使用覆盖配置 bridge、两次最坏停止、readiness 与响应余量的完整操作期限；本地替身让旧实例和失败新实例都忽略 `SIGTERM`，证明失败清理在期限内结束；
- 断开已接受请求后应用仍完成；状态以请求操作 ID 发布，超时客户端不把其它 ready 状态误判为本次成功；
- 启动器连续收到退出信号时共享一次清理，确认子进程退出后再释放所有权。

测试记录进程 ID、启动标识、配置指纹、控制请求结果和 readiness 转换，不记录控制凭据。

## 5. 降级与状态分离

在当前实例继续运行、重启替换和新实例 readiness 后分别发起受控调用，证明：

- 修改、清空或写错待应用配置不会停止当前 ready 实例，重启预检失败也保留该实例；
- `api_key` 使用环境引用且只有 Launcher 环境持有实际值时，Pi 核验进程仍可通过配置指纹识别并使用当前 ready 实例，且不会显示或记录凭据；
- 旧子进程真正停止后，Pi `context` 不等待重启操作，任务请求立即使用 Pi 原生路径；
- 在途 OpenViking 请求结束为受控失败，后续有效工作按当前路线重新提交；
- 显式召回失败形成 Pi 可处理的错误结果；
- 启动与实际服务重启显示“增强记忆 · 初始化中”，服务可用但当前路线尚未采用时显示“增强记忆 · 生效中”，运行实例或服务不可用并强制回退时只显示“Pi 原生”；
- 配置加载、服务就绪、模型能力、用户生命周期状态和每次 Provider 实际采用路径能够独立观测。

## 6. 模型能力边界

本地协议替身覆盖项目锁定 OpenViking 依赖中的 VLM adapter 类型，检查消息、tools、tool choice 与 function call 转换。扩展支持的用户配置面和固定版本 adapter 行为分别验证；后者不反向定义生产配置范围。

具体模型的 Working Memory create/update 能力由真实受控 fixture 或实际调用确认。能力不足时，Pi 原生路径继续任务并提供模型能力诊断。

模型能力与成本环节从统一配置派生任务与记忆路线，并记录任务 usage/cost、记忆 token 路由、工具调用结果和取消行为。最终 billed cost 仍需与 OpenRouter 账单逐 generation 关联。

## 7. 证据责任

`node scripts/validate-memory-model-runtime.mjs` 使用隔离设置、faux Pi Provider 和本地 OpenViking 协议替身，覆盖配置转换、命令无副作用、VLM adapter 协议、凭据路由、所有权、并发应用、降级和状态分离；结果保存到 [`../../validation/evidence/memory-model-runtime.json`](../../validation/evidence/memory-model-runtime.json)。evidence 纳入 `scripts/check-validation-evidence.mjs` 的当前实现哈希与精确检查集。统一配置选择的模型结果由质量与成本 runner 继续验证。
