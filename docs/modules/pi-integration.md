# Pi 集成模块

## 1. 当前责任

本模块是系统与 Pi 的唯一集成边界。它观察 Pi 生命周期，通过 `pi-session-protocol.ts` 把 `SessionManager` 的版本化 entry 与消息形态规范化为下游稳定输入，注册 `recall_session`、`/memory-model` 和 `/restart-viking`，并在 `context` hook 中采用当前路线已经就绪的有界增强历史。持久状态实时显示“增强记忆 · 初始化中”“增强记忆 · 生效中”或“增强记忆”；只有增强不可用并强制回退时显示“Pi 原生”。

来源文件、记忆模型配置和 OpenViking Session Working Memory 由长时记忆模块拥有；有界消息构造由工作上下文优化拥有；索引与排序由召回模块拥有；branch 有效性与路线身份由 Session 记忆协调拥有；OpenViking进程由项目启动器拥有。

实现入口位于 [`.pi/extensions/pi-context-memory/index.ts`](../../.pi/extensions/pi-context-memory/index.ts)。跨模块流程见 [`../system/source-archiving.md`](../system/source-archiving.md)、[`../system/source-recall.md`](../system/source-recall.md) 和 [`../system/context-enhancement.md`](../system/context-enhancement.md)。

## 2. 当前目标与责任分工

- 观察 session、当前 branch、消息、工具、压缩和 Provider 生命周期；
- 在 `session_start`、`turn_end`、`session_tree`、`session_compact` 和 `session_shutdown` 排队当前路线归档；
- 归档成功后独立排队来源索引，普通 Provider turn 不等待索引；
- 在 `session_start`、`turn_end`、`session_tree`、`session_compact` 和 `before_agent_start` 异步准备当前路线 Working Memory；
- 在每次 `context` 事件重新计算当前 prompt 之前的路线身份，只采用精确匹配的就绪结果；
- 保留当前 user prompt 及其后的 assistant tool call、tool result 原对象和顺序；
- 注册有界的 `recall_session(search|read_source)` 工具，并在每次执行时提供当前权威路线；
- 通过 `/memory-model` 展示用户配置与实际运行状态，通过 `/restart-viking` 使用项目启动器控制能力；
- 捕获归档、索引和上下文准备错误，保持 Pi Agent 控制流继续。

### 责任边界

本模块负责 Pi 生命周期观察、调度、工具和命令注册、增强消息实际采用、状态展示及故障隔离。它不生成 Working Memory、不格式化增强历史、不执行相关性排序，也不管理 OpenViking子进程。配置命令不写 Pi 消息、不修改任务模型或 branch。

Pi 原生 session 历史、context 构建、tree 导航、compaction 和 Agent 循环保持权威；扩展只通过 Pi 公开 `context` hook 非破坏性替换本次模型消息。

## 3. 数据与不变量

Pi 集成只向其它模块传递规范化的持久化 session 身份、当前 leaf，以及 `SessionManager.getBranch()` 从根到 leaf 返回的原始条目。临时 session 因没有可恢复来源而跳过归档、索引、召回和自动上下文增强。

当前不变量：

1. 只有 `context` handler 可以返回模型消息；它不读取配置或启动文件、Python bridge、OpenViking 工作，只能为同代际、同精确路线的既有 pending 等待最多 1000 ms；
2. 配置检查、本地归档、来源索引和 Working Memory 准备都在 Provider 请求之外执行；
3. `tool_result` 事件发生时权威 toolResult entry 尚未进入 leaf，只能在后续路线提交时处理；
4. branch 是每次调用时 Pi 的当前路线，不被提升为独立任务身份；
5. 自动采用与显式搜索都排除当前 prompt，自身 query、tool call 和结果不会提前进入历史；
6. 采用前必须重新核对 session、session file、leaf、有序 entry 和完整路线指纹；
7. 自动增强绑定 Launcher 当前 ready 的受管 OpenViking 子进程；配置文件变化只更新下一次重启目标与诊断，不销毁当前实例缓存，runtime state 确认子进程停止或替换后才取消旧任务并重建；
8. Provider 观察只记录形状、字节、哈希和 usage，不保存完整 payload；
9. 任一增强错误都不能成为 Pi `extension_error` 或阻止原生模型调用；
10. Provider 实际采用路径以 `context` 决定与 payload 一致性核验为准并独立记录；用户状态由增强生命周期驱动，普通用户文本不能触发“增强记忆”，正常准备中的原生请求也不能触发“Pi 原生”。

## 4. 生命周期与协作

```text
session_start
  → 恢复来源与索引；记忆模型实际运行时可用时准备当前路线
before_agent_start
  → 当前路线进入“增强记忆 · 生效中”；异步准备当前 prompt 之前的历史路线
context
  → 精确命中就绪路线：增强历史 + 当前 Pi turn
  → 未命中或错误：原样返回 Pi 消息
turn_end
  → 归档并索引完整路线；异步准备下一 prompt 可采用的路线
session_before_tree / session_before_compact
  → 记录操作边界；取消操作保持最近任务采用状态，overflow 自动重试另行锁定原生路径
session_tree / session_compact
  → 成功后显示“增强记忆 · 生效中”；操作后的 leaf 成为唯一范围，归档、索引并准备新路线
recall_session
  → 当前路线来源同步、候选排序或 Pi 权威 entry 展开
session_shutdown
  → 最多等待来源归档 5 秒；取消索引与 Working Memory 运行任务，并尽力删除扩展自建的派生 Session
```

## 5. 失败、降级与恢复

来源归档、来源索引和 Working Memory 状态彼此独立。启动、实际子进程重启与运行检查显示“增强记忆 · 初始化中”；OpenViking 正常准备、路线变化、结果过期重建和恢复显示“增强记忆 · 生效中”；精确匹配结果进入模型输入后显示“增强记忆”。待应用配置无效或不同不影响当前 ready 实例；只有运行实例停止、任务失败、超时或后端不可用导致增强不能交付时显示“Pi 原生”，恢复准备成功后再回到增强状态。

显式搜索不可用时工具抛出错误并由 Pi 保存为 `isError` tool result；`read_source` 仍可依赖当前 Pi 路线和本地来源。删除扩展或使用 `--no-extensions` 时，Pi session、tree、compaction 和原生模型路径保持可用。

## 6. 验证与限制

来源归档、来源召回和自动上下文采用分别由对应 validation 文档证明。本地纵向 evidence 实际驱动 Pi `0.84.2` 的 tree 往返、fork/clone/resume/reload、手动/阈值/overflow compaction，并逐次核对 `context`、本地 Provider payload 和状态路径。统一验证配置选择的真实 OpenRouter 模型在 skipped、accepted 与成对质量实验中进一步证明增强请求保持当前决定与证据入口。

当前 evidence 的宿主验证坐标是 Pi `0.84.2`，项目私有 OpenViking 依赖锁定为 `0.4.13`；二者分别表示已验证宿主和可复现依赖，不是要求上游永久保持的产品边界。兼容升级由扩展维护者承担；OpenRouter 记忆 token 已归属，最终 billed cost 的逐 generation 归集仍是下一产品价值验证。
