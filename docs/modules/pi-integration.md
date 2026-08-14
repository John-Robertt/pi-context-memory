# Pi 集成模块

## 1. 当前责任

本模块是系统与 Pi 的唯一集成边界。它观察 Pi 生命周期，通过 `pi-session-protocol.ts` 把 `SessionManager` 的版本化 entry 与消息形态规范化为下游稳定输入，注册 `recall_session`、`/memory-model` 和 `/restart-viking`，并在 `context` hook 中采用当前路线已经就绪的有界增强历史。状态持续显示本次模型输入实际使用“增强记忆”或“Pi 原生”。

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

1. 只有 `context` handler 可以返回模型消息；它只读取内存中的配置代际和已就绪路线，不等待文件、Python bridge 或 OpenViking；
2. 配置检查、本地归档、来源索引和 Working Memory 准备都在 Provider 请求之外执行；
3. `tool_result` 事件发生时权威 toolResult entry 尚未进入 leaf，只能在后续路线提交时处理；
4. branch 是每次调用时 Pi 的当前路线，不被提升为独立任务身份；
5. 自动采用与显式搜索都排除当前 prompt，自身 query、tool call 和结果不会提前进入历史；
6. 采用前必须重新核对 session、session file、leaf、有序 entry 和完整路线指纹；
7. 自动增强只采用后台已验证的运行代际；配置文件或 runtime state 变化先同步使内存代际失效，再异步销毁旧缓存并重建；
8. Provider 观察只记录形状、字节、哈希和 usage，不保存完整 payload；
9. 任一增强错误都不能成为 Pi `extension_error` 或阻止原生模型调用；
10. Provider 状态以最近一次 `context` 采用决定为准，payload 中的增强标记只做一致性核验，普通用户文本不能触发“增强记忆”。

## 4. 生命周期与协作

```text
session_start
  → 恢复来源与索引；记忆模型实际运行时可用时准备当前路线
before_agent_start
  → 状态先回到 Pi 原生；异步准备当前 prompt 之前的历史路线
context
  → 精确命中就绪路线：增强历史 + 当前 Pi turn
  → 未命中或错误：原样返回 Pi 消息
turn_end
  → 归档并索引完整路线；异步准备下一 prompt 可采用的路线
session_before_tree / session_before_compact
  → 记录操作边界；取消操作保持最近任务采用状态，overflow 自动重试另行锁定原生路径
session_tree / session_compact
  → 成功后切回 Pi 原生；操作后的 leaf 成为唯一范围，归档、索引并准备新路线
recall_session
  → 当前路线来源同步、候选排序或 Pi 权威 entry 展开
session_shutdown
  → 最多等待来源归档 5 秒；取消索引与 Working Memory 运行任务，并尽力删除扩展自建的派生 Session
```

## 5. 失败、降级与恢复

来源归档、来源索引和 Working Memory 状态彼此独立。OpenViking准备中、任务失败、结果过期、路线变化或没有实际运行的记忆模型时，`context` 保持 Pi 原生消息并显示“Pi 原生”。精确匹配结果实际进入模型输入后才显示“增强记忆”。

显式搜索不可用时工具抛出错误并由 Pi 保存为 `isError` tool result；`read_source` 仍可依赖当前 Pi 路线和本地来源。删除扩展或使用 `--no-extensions` 时，Pi session、tree、compaction 和原生模型路径保持可用。

## 6. 验证与限制

来源归档、来源召回和自动上下文采用分别由对应 validation 文档证明。本地纵向 evidence 实际驱动 Pi `0.84.1` 的 tree 往返、fork/clone/resume/reload、手动/阈值/overflow compaction，并逐次核对 `context`、本地 Provider payload 和状态路径。真实记忆模型成对实验进一步证明增强请求保持当前决定与证据入口。

当前 evidence 的宿主验证坐标是 Pi `0.84.1`，项目私有 OpenViking 依赖锁定为 `0.4.13`；二者分别表示已验证宿主和可复现依赖，不是要求上游永久保持的产品边界。兼容升级由扩展维护者承担，完整 API 成本归集仍是后续产品价值验证。
