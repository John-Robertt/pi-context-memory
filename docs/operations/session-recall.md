# Session 来源召回运行与维护

## 1. 安装与启动

前置条件：Node.js `>=22.19.0` 和 Pi `0.84.1`。从仓库根目录执行：

```bash
node scripts/install-dependencies.mjs
```

安装脚本使用 `uv.lock`，把固定版本的 uv、Python 3.12、OpenViking `0.4.13` 和本地 embedding 依赖分别安装到项目内 `.tools/`、`.venv/` 与 `.cache/`，不修改系统 Python 或 shell PATH；重复执行会同步回同一锁定环境。运行服务读取 [`../../config/openviking.json`](../../config/openviking.json)，该配置没有外部 VLM 或计费凭据。

启动 OpenViking：

```bash
node scripts/start-openviking.mjs
```

首次启动会把约 46 MiB 的本地 embedding 模型下载到项目 `.cache/openviking/models/`。看到服务启动后，在另一个终端从同一仓库根目录启动 Pi：

```bash
pi
```

项目被信任后，Pi 自动加载 `.pi/extensions/pi-context-memory/index.ts` 并注册 `recall_session`。扩展把已归档、具有任务文本的 Pi 来源异步同步到 OpenViking；每个来源使用 `vectors_only`，OpenViking VLM、记忆提取和 Working Memory 保持关闭。

OpenViking由独立本地或受信服务提供。日常来源召回验证使用 runner 自启的受控本地 OpenViking 和本地 embedding。完整成本验证随自动上下文优化纵向交付建立，实验设计见 [`../validation/README.md`](../validation/README.md)。

## 2. 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PCR_OPENVIKING_URL` | `http://127.0.0.1:1933` | OpenViking服务根 URL |
| `PCR_OPENVIKING_API_KEY` | 未设置 | 需要 API key 认证时发送 `X-API-Key` |
| `PCR_OPENVIKING_TIMEOUT_MS` | `30000` | 单次上传、索引或查询期限 |
| `PCR_OBSERVATION_LOG` | 未设置 | 仅供开发验证追加脱敏 JSONL 运行观察 |

来源归档的数据根和完整输出复制期限由 [`source-archive.md`](source-archive.md) 统一说明。远程 OpenViking 必须使用 HTTPS 和适当认证。索引内容来自完整用户、assistant、工具及压缩来源，应按 Pi session 同等敏感级别保护。

## 3. 使用

任务模型可以调用：

```text
recall_session(action="search", query="早期数据库约束", limit=5)
recall_session(action="read_source", entry_id="<search 返回的 entry ID>", max_chars=8000)
```

搜索最多返回 10 项；OpenViking 只负责候选排序，预览来自与当前 Pi entry 精确核对的本地来源副本，`read_source` 展开当前 Pi 权威 entry。`read_source` 不依赖 OpenViking，因此已经取得 entry ID 时，即使后端随后不可用仍可尝试展开当前来源。

当前不自动调用、注入或管理召回，也不启用 OpenViking用户级 memory、Session Working Memory 或 context takeover。

## 4. 数据与恢复

外部资源布局为：

```text
viking://resources/pi-context-memory/
└── <sha256(session-id)>/
    └── <sha256(entry-id) 前 32 位>/
        └── source.md
```

每个 entry 使用独立资源子树，避免后一次上传替换同 session 的其它来源。资源使用 `parse_mode=no_split` 保持稳定 leaf URI。Pi session JSONL 是事实权威，本地来源归档是恢复副本和索引重建输入，OpenViking 只保存可重建的派生索引。

若 OpenViking 数据被清理，后续路线提交会异步重建，下一次显式搜索也会重新核对当前历史路线并先补齐缺失资源；补齐失败时搜索明确报错，不伪装成正常空命中。已有 URI 内容与同一 Pi entry 不一致时，扩展拒绝覆盖并记录错误。

## 5. 诊断与降级

观察记录包括：

- `source_index_complete`：当前路线的可检索来源已确认；
- `source_index_error`：上传、索引或一致性确认失败；
- `source_recall_search`：保存查询哈希、后端候选数、当前路线候选数和最终命中数；
- `source_recall_expand`：保存展开 entry ID、输出字节和截断状态。

索引队列独立于来源归档和 Provider 请求。慢索引不会阻塞 Pi turn；显式召回重新同步当前历史路线并最多等待 5 秒，仍未完成时以“索引准备中”失败，不能伪装成空结果。查询不可达、超时或响应无效时 tool result 标为错误，Pi Agent 仍可继续。

## 6. 停用与清理

使用 `--no-extensions` 停用全部扩展，或通过 Pi 工具选择不启用 `recall_session`。停用不删除 Pi session、本地归档或 OpenViking资源。

OpenViking 资源可以按目标 session URI 递归删除；删除不会修改 Pi 权威历史，后续路线提交或显式搜索会从仍存在的本地来源副本重建。删除本地来源归档则会失去来源恢复和重建依据，不应把外部派生索引当作替代备份。
