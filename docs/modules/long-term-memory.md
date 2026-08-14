# 长时记忆模块

## 1. 当前责任

本模块承担两项同属长时记忆边界的当前责任：保存 Pi session 来源副本与完整工具输出，以及生成、解析用户级记忆模型 JSONC 并编译 OpenViking VLM 运行配置。Pi session entry 仍是事实权威；本模块不生成摘要、Working Memory 或向量索引。实现分别位于 `long-term-memory.ts` 与 `memory-model-configuration.ts`。

跨模块流程见 [`../system/source-archiving.md`](../system/source-archiving.md) 与 [`../system/source-recall.md`](../system/source-recall.md)。

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
- 解析 JSONC、规范化 `provider`、`model`、`api_base` 和 `api_version` 的受控投影，生成可重建运行配置与稳定指纹。

来源读写要求 session ID 和 session file 身份一致；不存在跨 session 搜索入口。来源写入使用同目录临时文件与原子重命名，相同 entry 使用稳定位置。记忆模型配置属于用户而非 session 或项目；模块只独占创建缺失模板，已有 JSONC 始终只读，生成配置只保留凭据环境变量占位符。

本模块不判断 branch 当前有效性，不读取 Pi `SessionManager`，不调用外部后端，也不把归档副本提升为事实权威。OpenViking资源可以删除并从本层重建，不能反向覆盖本层来源。

## 4. 错误与恢复

来源文件创建、序列化、复制、校验或读取失败均显式抛给调用者。已成功写入的其它 entry 保持可用；下一次提交当前路线会按稳定 entry ID 重试。JSONC 语法、未知字段、无效 Provider、缺失连接字段、凭据或 schema 错误均形成带配置路径的诊断，不修改用户文件；是否保留实例或冷启动降级由项目启动器负责。

损坏或身份不匹配的记录不返回为有效来源；后续当前路线提交按稳定 entry ID 重新保存来源，OpenViking 资源由有效来源重建。

## 5. 验证与限制

来源归档验证覆盖幂等写入、session 隔离、原子记录读取、完整文件复制和失败传播；记忆模型运行时验证覆盖用户路径、注释模板、JSONC 诊断、文件保留、registry/schema 转换、LiteLLM 多来源路由、凭据分离和确定性配置。当前只支持本地持久化 Pi session；外部索引不包含完整大型工具 blob，跨机器同步、备份和保留策略仍不在当前边界。
