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
- 从项目安装的 OpenViking `0.4.13` 读取 Provider registry、`VLMConfig` schema 与 LiteLLM backend 路由元数据，并据此创建用户级注释模板；
- 解析 JSONC、规范化 `provider`、`model`、`api_base` 和 `api_version` 的受控投影，生成可重建运行配置与稳定指纹；
- 把已核验 Pi 路线按原生 compaction 边界投影到隔离的 OpenViking Session，线性路线只追加增量，分叉路线使用独立 session；
- 达到固定待归档 token 阈值后 commit，等待 Working Memory 任务终态，并取得固定预算的 session context assembly。

来源读写要求 session ID 和 session file 身份一致；不存在跨 session 搜索入口。来源写入使用同目录临时文件与原子重命名，相同 entry 使用稳定位置。记忆模型配置属于用户而非 session 或项目；模块只独占创建缺失模板，已有 JSONC 始终只读，生成配置只保留凭据环境变量占位符。

Session Working Memory 只接收 Session 记忆协调已经核验的完整路线身份和 entries；写入投影按 Pi `0.84.1` 的 compaction-aware entry 语义保留 `firstKeptEntryId` 范围，并兼容自包含的 `retainedTail`。每个派生 session 只能沿一条连续路线追加，同一路线准备共享任务；正在执行的任务之后只保留该 Pi session 最新的未启动路线，缓存和派生 session 数量有固定上限。派生状态不决定当前 branch，也不能覆盖 Pi 来源。

## 4. 错误与恢复

来源文件创建、序列化、复制、校验或读取失败均显式抛给调用者。已成功写入的其它 entry 保持可用；下一次提交当前路线会按稳定 entry ID 重试。JSONC 语法、未知字段、无效 Provider、缺失连接字段、凭据或 schema 错误均形成带配置路径的诊断，不修改用户文件；是否保留实例或冷启动降级由项目启动器负责。

损坏或身份不匹配的记录不返回为有效来源；后续当前路线提交按稳定 entry ID 重新保存来源，OpenViking资源由有效来源重建。OpenViking Session 创建、追加、commit、任务轮询或 context assembly 失败时不返回部分结果，并丢弃对应运行期镜像；失败、淘汰和 session 关闭会尽力删除扩展自建的派生 Session。清理失败不阻断 Pi 关闭，Pi 集成继续使用原生路径，后续路线可重新准备。

## 5. 验证与限制

来源归档、记忆模型运行时和上下文增强 runner 分别覆盖文件边界、配置编译，以及 OpenViking Session 增量、分支隔离、Working Memory 任务和 context assembly 协议。当前 Session 派生映射保存在扩展运行内存中，重载后从 Pi 路线重建；真实记忆模型语义质量、跨机器同步、备份和保留策略仍由后续纵向验证承担。
