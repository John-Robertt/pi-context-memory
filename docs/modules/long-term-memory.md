# 长时记忆模块

## 1. 当前责任

本模块保存 Pi session 来源副本与完整工具输出，维护 OpenViking Session Working Memory，并生成、解析用户级记忆模型 JSONC 和运行配置。Pi session entry 仍是事实权威；来源文件由 `long-term-memory.ts` 管理，OpenViking Session 派生状态由 `session-working-memory.ts` 管理，配置由 `memory-model-configuration.ts` 管理。向量索引与候选排序仍属于召回模块。

跨模块流程见 [`../system/source-archiving.md`](../system/source-archiving.md)、[`../system/source-recall.md`](../system/source-recall.md) 与 [`../system/context-enhancement.md`](../system/context-enhancement.md)。

## 2. 持久化表示

默认归档根位于 Pi session 目录的 `.pi-context-memory/`；验证可通过 `PCR_ARCHIVE_DIR` 指向仓库内隔离目录：

```text
.pi-context-memory/
└── <session-key>/
    ├── session.json
    ├── sources/<entry-key>.json
    └── large-results/
        ├── blobs/<content-sha256>.bin
        └── records/<entry-key>.json
```

`session.json` 保存 session ID 与绝对 session file。来源记录保存 schema 版本、来源引用、原始 Pi 条目和内容哈希。完整结果在运行配置规定的有界期限内复制到内容寻址 blob，再由 entry 元数据原子发布；读取会重新核对字节数与 SHA-256。期限的默认值与配置入口见 [`../operations/source-archive.md`](../operations/source-archive.md)。

目录键和文件键由身份哈希派生。目录权限为仅当前用户可访问，文件以仅当前用户可读写方式创建。

## 3. 能力与不变量

当前提供：

- 按 session 写入、读取和列出来源条目；
- 流式复制完整工具输出并记录完整性哈希；
- 读取与来源 entry 关联的完整结果；
- 通过 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 维护扩展明确支持的最小记忆模型配置面，并用 OpenViking 聚合配置入口验证生成结果；
- 解析 JSONC、规范化 `provider`、`model`、`api_base` 和 `api_version` 的受控投影，生成可重建运行配置与稳定指纹；
- 把已核验 Pi 路线按原生 compaction 边界投影到隔离的 OpenViking Session，线性路线只追加增量，分叉路线使用独立 session；
- 达到固定待归档 token 阈值后 commit；`accepted` 响应携带 task ID 并进入 Working Memory 轮询，全部消息位于保留窗口时 OpenViking 合法返回 `skipped` 与空 task ID，此时保留来源已核验的 active history，而不是把无任务视为失败。Working Memory 任务在 180 秒有界终态期限内继续运行，完成后用包含 overview 的最终 assembly 更新同一路线结果，超出期限后仍按失败降级。

来源读写要求 session ID 和 session file 身份一致；不存在跨 session 搜索入口。来源写入使用同目录临时文件与原子重命名，相同 entry 使用稳定位置。记忆模型配置属于用户而非 session 或项目；模块只独占创建缺失模板，已有 JSONC 始终只读，生成配置只保留凭据环境变量占位符。

Session Working Memory 只接收 Session 记忆协调已经核验的完整路线身份和 Pi 集成规范化结果；`firstKeptEntryId`、`retainedTail`、消息 role 与内容 block 等 Pi 具体形态只由 `pi-session-protocol.ts` 解释。派生 session 只在有效投影序列保持前缀关系时追加；compaction 使旧 active history 退出有效投影时建立新镜像，避免被压缩内容继续进入 context assembly。同一路线准备共享任务；正在执行的任务之后只保留该 Pi session 最新的未启动路线，缓存和派生 session 数量有固定上限。派生状态不决定当前 branch，也不能覆盖 Pi 来源。

## 4. 错误与恢复

来源文件创建、序列化、复制、校验或读取失败均显式抛给调用者。已成功写入的其它 entry 保持可用；下一次提交当前路线会按稳定 entry ID 重试。JSONC 语法、未知字段、无效 Provider、缺失连接字段、凭据或 schema 错误均形成带配置路径的诊断，不修改用户文件；是否保留实例或冷启动降级由项目启动器负责。

损坏或身份不匹配的记录不返回为有效来源；后续当前路线提交按稳定 entry ID 重新保存来源，OpenViking resource 由有效来源重建。Session 创建、追加或初始 context assembly 失败时不返回结果；commit 运行期间只发布独立完成、来源已核验的 active history assembly，不发布未完成任务产物，任务轮询、终态或最终 assembly 失败会使该临时快照失效。适配层只接受 OpenViking `accepted + task ID` 与 `skipped + 空 task ID` 两种 commit 结果，缺失必要字段、矛盾或未知状态显式失败；标题语言和可选诊断不构成生产门槛，已知无任务信息的通用计数回退仍拒绝采用。失败、淘汰和 session 关闭会丢弃运行期镜像并尽力删除扩展自建的派生 Session。清理失败不阻断 Pi 关闭，后续路线可重新准备。

## 5. 验证与限制

来源归档、记忆模型运行时和上下文增强 runner 分别覆盖文件边界、配置编译，以及 OpenViking Session 增量、有效 compaction 投影、分支隔离、Working Memory 结构和 context assembly 协议。Session 派生映射保存在扩展运行内存中，重载后从 Pi 路线重建；真实记忆模型成对实验已覆盖当前决定与证据入口。跨机器同步、备份和保留策略不属于当前本地纵向交付。
