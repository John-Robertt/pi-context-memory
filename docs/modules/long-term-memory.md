# 长时记忆模块

## 1. 当前责任

本模块当前是 Pi session 来源副本和完整工具输出的文件承载层。它让退出模型上下文的 Pi 条目仍可恢复，并为来源召回模块提供可重建外部索引的输入；Pi session entry 仍是事实权威，本模块不生成摘要、Working Memory 或向量索引。

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
- 读取与来源 entry 关联的完整结果。

所有读写要求 session ID 和 session file 身份一致；不存在跨 session 搜索入口。写入使用同目录临时文件与原子重命名，相同 entry 使用稳定位置。

本模块不判断 branch 当前有效性，不读取 Pi `SessionManager`，不调用外部后端，也不把归档副本提升为事实权威。OpenViking资源可以删除并从本层重建，不能反向覆盖本层来源。

## 4. 错误与恢复

文件创建、序列化、复制、校验或读取失败均显式抛给调用者。已成功写入的其它 entry 保持可用；下一次提交当前路线会按稳定 entry ID 重试，不回滚整个 session。

损坏或身份不匹配的记录不返回为有效来源；后续当前路线提交按稳定 entry ID 重新保存来源，OpenViking 资源由有效来源重建。

## 5. 验证与限制

来源归档验证覆盖幂等写入、session 隔离、原子记录读取、完整文件复制和失败传播。当前只支持本地持久化 Pi session；外部索引不包含完整大型工具 blob，跨机器同步、备份和保留策略仍不在当前边界。
