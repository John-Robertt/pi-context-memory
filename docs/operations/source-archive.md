# 来源归档运行与维护

## 1. 可用行为

项目扩展 [`.pi/extensions/pi-context-memory/index.ts`](../../.pi/extensions/pi-context-memory/index.ts) 被 Pi 加载后，会自动归档持久化 session 的当前活动路线。临时 session 不归档；归档本身不修改模型输入。

当前宿主验证坐标由 [`../../validation/suite.json`](../../validation/suite.json) 选择并由 evidence 记录实际观测。Pi 变化后的兼容验证由项目维护者承担；扩展不会要求用户降级宿主。维护者使用以下无 Provider 本地入口复核：

```bash
node scripts/validate-source-archive.mjs
```

若同时启用 OpenViking来源召回，还应运行 [`session-recall.md`](session-recall.md) 中的召回验证。

## 2. 数据与配置

默认数据根是当前 Pi session 目录内的 `.pi-context-memory/`。每个 session 独立存放来源记录和完整工具输出。归档包含完整用户、assistant 和工具会话条目，应按 Pi session 同等敏感级别保护。

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PCR_ARCHIVE_DIR` | Pi session 目录中的 `.pi-context-memory/` | 覆盖本地来源副本与完整输出的数据根；相对路径按 Pi 当前工作目录解析 |
| `PCR_ARCHIVE_COPY_TIMEOUT_MS` | `long-term-memory.ts` 的归档复制默认 | 覆盖单个完整工具输出的流式复制期限，必须是正整数毫秒 |

`PCR_ARCHIVE_DIR` 主要用于隔离验证或受控部署，目标位置应由单一信任域专用并保持受限权限。`PCR_ARCHIVE_COPY_TIMEOUT_MS` 接受正整数毫秒；配置错误会阻止扩展加载。

## 3. 诊断与故障

设置 `PCR_OBSERVATION_LOG` 后，扩展会追加 JSONL 观察记录：

- `archive_complete`：当前路线提交成功；
- `archive_skipped`：session 没有持久化来源；
- `archive_error`：归档失败，记录触发点和错误。

归档在 session 内按顺序异步执行，普通 Provider turn 不等待无关磁盘 I/O；完整输出复制受 `PCR_ARCHIVE_COPY_TIMEOUT_MS` 约束，退出等待由归档模块的关闭策略拥有。请求所需来源或 FullOutputCandidate 尚未稳定发布时必须等待对应来源屏障；失败会使本扩展 block 并锁存故障，不返回原始 Pi messages，也不自动恢复或重放 prompt。修复后由用户重启并重新验证；当前尚未符合该契约的实现以 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 为准。

OpenViking索引使用独立队列和独立错误状态；索引失败不会把已经成功的本地归档标记为失败。

## 4. 停用与清理

使用 `--no-extensions` 或不加载本项目扩展即可停用增强，Pi session 保持可用。停用不会自动删除归档。

Pi session JSONL 承担权威历史，归档承担来源恢复、完整结果和外部索引重建责任。确认上下文外恢复责任结束后，可以删除目标 session 的归档目录。当前保留与清理由操作者执行。

## 5. 限制

当前归档只在本机文件系统工作，不提供跨机器同步、备份、加密密钥管理或用户管理界面。语义索引是独立的可选派生层；来源归档成立不代表 Working Memory、自动召回或上下文换代已经可用。
