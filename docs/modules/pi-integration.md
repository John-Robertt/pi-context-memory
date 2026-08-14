# Pi 集成模块

## 1. 当前责任

本模块是系统与 Pi 的唯一集成边界。它观察 Pi 生命周期，把 `SessionManager` 当前路线转换为来源快照，注册 `recall_session`、`/memory-model` 和 `/restart-viking`，并持续显示当前模型输入仍采用“Pi 原生”。来源数据与记忆模型配置编译由长时记忆模块拥有，索引与排序由召回模块拥有，branch 有效性由 Session 记忆协调模块拥有，OpenViking 进程由项目启动器拥有。

实现入口位于 [`.pi/extensions/pi-context-memory/index.ts`](../../.pi/extensions/pi-context-memory/index.ts)。来源归档与召回流程分别见 [`../system/source-archiving.md`](../system/source-archiving.md) 和 [`../system/source-recall.md`](../system/source-recall.md)。

## 2. 当前目标与责任分工

- 观察 session、当前 branch、消息、工具、压缩和 Provider 生命周期；
- 在 `session_start`、`turn_end`、`session_tree` 和 `session_shutdown` 排队当前路线归档；
- 归档成功后向 Session 记忆协调提交后台索引请求，普通 Provider turn 不等待索引；
- 注册有界的 `recall_session(search|read_source)` 工具，并在每次执行时提供当前权威路线；
- 通过 `/memory-model` 检查并展示用户 JSONC，通过 `/restart-viking` 消费项目启动器控制能力而不直接管理子进程；
- 在 session 与 turn 边界异步检查配置，同一错误只提示一次；只在启动器 PID、启动标识和锁一致时采用运行状态，区分用户配置、实际模型、应用目标和 readiness；
- 捕获归档和索引错误，保持 Pi Agent 控制流继续；
- 允许通过受控故障注入验证 Pi 原生扩展错误边界。

### 责任边界

本模块负责 Pi 生命周期观察、归档与索引调度、工具和命令注册、运行状态展示及故障隔离。来源文件与配置编译由长时记忆模块承担；embedding 与排序由召回模块承担；子进程所有权由项目启动器承担；context、压缩、tree 导航和 Agent 循环由 Pi 提供。配置命令不写 Pi 消息、不修改任务模型或 branch，context 当前继续沿 Pi 原生路径构造。

## 3. 数据与不变量

Pi 集成只向其它模块传递规范化的持久化 session 身份、当前 leaf，以及 `SessionManager.getBranch()` 从根到 leaf 返回的原始条目。临时 session 因没有可恢复来源而跳过归档、索引和召回。

当前不变量：

1. 普通生命周期处理器不返回消息或 Provider 替换结果；
2. 本地归档与外部索引使用不同队列，索引不能延迟后续归档或 Provider 请求；
3. `tool_result` 事件发生时权威 toolResult entry 尚未进入 leaf，只能在后续路线提交时归档；
4. branch 是每次调用时 Pi 的当前路线，不被提升为独立任务身份；
5. 显式搜索只提交当前 prompt 之前的历史，并等待 Session 记忆协调提供的调用后完整同步屏障；缺失资源未补齐、同步失败或未就绪时不能查询部分索引；
6. Provider 观察只记录形状、字节、哈希和 usage，不保存完整 payload；
7. 归档和索引异常在本边界捕获，不能成为 Pi `extension_error`。

## 4. 生命周期与协作

```text
session_start
  → 异步恢复当前路线来源和索引
input / agent / turn / context / provider / message / tool events
  → 只读观察
turn_end
  → 排队权威路线归档；成功后独立排队索引
session_tree
  → 按新 leaf 归档并索引新路线
recall_session(search)
  → 当前路线本地归档 → 重新同步并核对目标历史路线，最多等待 5 秒 → 成功后请求 OpenViking 候选 → 当前路线核对
recall_session(read_source)
  → 当前路线本地归档 → Session 协调展开权威 entry
session_shutdown
  → 对来源归档最多等待 5 秒；取消未完成的派生索引等待
```

## 5. 失败、降级与恢复

来源归档错误记录为 `archive_error`；索引错误记录为 `source_index_error`，两者状态彼此独立。OpenViking不可用不会把已经成功的本地归档标为失败。

显式搜索不可用时工具抛出错误，Pi 将其保存为 `isError` tool result 并继续 Agent；只有完成当前路线同步后，后端真实返回零候选才构成正常空命中。后续路线或显式搜索会重试未确认索引，不建立持久任务队列或独立 Runtime。

删除扩展、使用 `--no-extensions` 或不启用召回工具时，Pi session 和原生路径保持可用。

## 6. 验证与限制

来源归档验证见 [`../validation/source-archive.md`](../validation/source-archive.md)，来源召回验证见 [`../validation/source-recall.md`](../validation/source-recall.md)。当前支持 Pi `0.84.1` 与 OpenViking `0.4.13`；依赖升级后重跑相关验证。
