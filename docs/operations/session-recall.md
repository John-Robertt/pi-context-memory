# Session 来源召回运行与维护

## 1. 安装与启动

前置条件由安装入口检查 Node.js 门槛；Pi 必须能够加载本扩展当前公开 hook。当前宿主坐标只在 [`../../validation/suite.json`](../../validation/suite.json) 选择，并由 evidence 记录实际观测；扩展不安装、降级或替换用户的 Pi，宿主变化必须重新运行行为探针。

```bash
node scripts/install-dependencies.mjs
```

[`../../config/toolchain.json`](../../config/toolchain.json) 是 Node 门槛、uv 版本和安装器摘要的机器可读权威；安装脚本先核对 Node，再校验 uv bootstrap，读取项目 Python 版本入口，并按 `uv.lock` 把 OpenViking 和本地 embedding 的精确依赖闭包安装到项目内 `.tools/`、`.venv/` 与 `.cache/`，不创建用户级 Python 可执行入口，也不修改系统 Python 或 shell PATH。Python 版本由 [`.python-version`](../../.python-version) 与 `pyproject.toml` 的兼容范围共同约束，OpenViking 直接依赖由 `pyproject.toml` 拥有、解析结果由 `uv.lock` 拥有。基础服务配置位于 [`../../config/openviking.json`](../../config/openviking.json)；首次启动 Pi 或 OpenViking 时，系统在 `~/.pi/pi-context-memory.jsonc` 独占创建用户级注释模板。
启动 OpenViking。若 `memoryModel.api_key` 使用环境变量引用，只在 launcher 终端提供该来源变量；例如使用 OpenRouter 环境变量认证时：

```bash
export OPENROUTER_API_KEY="<OpenRouter API key>"
node scripts/start-openviking.mjs
```

启动脚本拥有项目 OpenViking 的生命周期：它原子取得运行锁，预检配置和目标端口，按 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 隔离凭据，并以最小环境启动受管子进程。服务健康后，启动器用隔离 Session 完成真实记忆模型能力探针；探针成功才发布与进程代际绑定的 `requestReady`。状态、运行配置、日志和诊断不回显凭据，child 输出在转发前实时脱敏。`state.json` 分别发布服务、请求能力、active/target profile 和能力 proof；Pi 每次请求重新核对该状态。启动器只停止自己持有且身份一致的子进程。首次启动会把本地 embedding 模型下载到项目 `.cache/openviking/models/`。能力建立后，在另一个终端从同一仓库根目录启动 Pi：

```bash
pi
```

项目被信任后，Pi 自动加载扩展并注册 `recall_session`。来源索引始终使用本地 embedding 和 `vectors_only`。显式来源召回与自动增强是不同责任：未配置或未验证记忆模型时，召回工具仍可独立使用，但本扩展不会确认自动增强请求，也不会在内部返回 Pi 原生 messages；请求结果和后续处理按故障诊断由用户决定。已配置模型只有在能力、来源和 assembly 均通过当前 profile 核验后才能产生有界增强历史。

项目内正常路径由启动脚本托管本地 OpenViking；仅使用显式召回时也可以通过 `PCR_OPENVIKING_URL` 连接受信服务，但 `/restart-viking` 只控制项目启动器拥有的本地实例。验证方法与成本证明边界见 [`../validation/README.md`](../validation/README.md)。

## 2. 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PCR_OPENVIKING_URL` | `config/openviking.json` 的 `server` | 覆盖 OpenViking 服务根 URL；未设置时扩展与启动器消费同一基础配置 |
| `PCR_OPENVIKING_API_KEY` | 未设置 | 需要服务 API key 认证时发送 `X-API-Key` |
| `PCR_MEMORY_MODEL_SETTINGS` | 未设置 | 受控部署或验证覆盖记忆模型 JSONC 路径；普通运行不设置，设置时 Pi 与启动器必须使用同一值 |
| `PCR_OPENVIKING_TIMEOUT_MS` | `openviking-protocol.ts` 的请求默认 | 覆盖单次来源或 Session API 请求期限；Working Memory 终态期限由当前 MemoryRuntimeProfile/实现策略拥有 |
| `PCR_OPENVIKING_READINESS_TIMEOUT_MS` | `DEFAULT_OPENVIKING_READINESS_TIMEOUT_MS` | 覆盖启动器等待 `/health` 健康的期限 |
| `PCR_OPENVIKING_STOP_TIMEOUT_MS` | `DEFAULT_OPENVIKING_STOP_TIMEOUT_MS` | 覆盖启动器升级为 `SIGKILL` 前等待子进程退出的期限 |
| `PCR_OBSERVATION_LOG` | 未设置 | 仅供开发验证追加脱敏 JSONL 运行观察 |

来源归档的数据根和完整输出复制期限由 [`source-archive.md`](source-archive.md) 统一说明。远程 OpenViking 必须使用 HTTPS 和适当认证。索引内容来自完整用户、assistant、工具及压缩来源，应按 Pi session 同等敏感级别保护。

## 3. 使用

执行 `/memory-model` 查看用户配置路径和当前运行模型。编辑 `~/.pi/pi-context-memory.jsonc`，把 `memoryModel: null` 替换为文件中的 Provider 示例并填写模型、`api_key` 及必要连接字段；`api_key` 可直接填写，也可写 `$NAME` 或 `${NAME}`。保存后执行 `/restart-viking`。恢复为 `null` 并重启会停用 VLM、保留基础来源服务。命令不改写 JSONC，且只向当前项目启动器提交应用请求。普通运行由用户自行选择记忆模型；开发验证从 [`../../validation/suite.json`](../../validation/suite.json) 派生 Pi 任务路线和记忆路线，再通过隔离配置运行，不要求修改用户文件。无需 API key 的来源可以省略该字段；具体认证仍由目标来源负责，是否受支持以对应 actual evidence 为准。

系统只在配置文件缺失时生成当前模板；已有配置由用户维护，字段和 LiteLLM 路由按当前模板及 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 校对。需要创建新的未配置模板时，先备份并删除原文件，再执行 `/memory-model`。
```jsonc
{
  "memoryModel": {
    "provider": "litellm",
    "model": "openrouter/<provider>/<model-id>",
    "api_key": "${OPENROUTER_API_KEY}"
  }
}
```

扩展用户配置只选择 Provider、模型和必要连接字段；thinking、temperature、stream、timeout、retry 等运行策略由版本化 `MemoryRuntimeProfile` 显式写入 OpenViking 公共 VLM 配置，不依赖隐式默认值。LiteLLM 路由表达式及认证字段以目标适配器契约为准。

模板展示当前配置契约接受的 Provider 和云路由字段；该次受管启动的真实能力探针决定精确配置能否用于增强，suite 坐标只限定 stable evidence。
任务模型可以调用：

```text
recall_session(action="search", query="早期数据库约束", limit=5)
recall_session(action="read_source", entry_id="<search 返回的 entry ID>")
```

搜索数量、查询、预览和展开边界由 `recall-and-provenance.ts` 的 `RECALL_LIMITS` 与工具 schema 共同拥有；OpenViking 只负责候选排序，预览来自与当前 Pi entry 精确核对的本地来源副本。`read_source` 展开当前 Pi 权威 taskContent；同一来源存在稳定 `fullOutputRef` 时，先重验 blob 大小和 SHA-256，再在同一字符上限内附加有界完整输出正文。`read_source` 不依赖 OpenViking，因此已经取得 entry ID 时，即使后端随后不可用仍可尝试展开当前来源。

自动增强不调用显式召回工具，也不把 OpenViking 摘要提升为事实权威。当前 prompt 之前的历史由已核验派生记忆与来源后缀表达；current turn 从 Pi Provider 基线出发，并在预算需要时对完整 ToolBatch 使用保持协议关系的确定性投影。关键事实仍可通过 `recall_session` 展开到当前 Pi entry。

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
- `source_recall_expand`：保存展开 entry ID、输出字节和截断状态；
- `memory_model_config_error`：保存脱敏配置诊断；同一错误在 Pi 中只提示一次；
- `openviking_restart_complete|error`：保存运行配置指纹或脱敏错误；
- `checkpoint_refresh_complete|error|rejected`：保存 RefreshTarget 路线、结果、检查点身份、派生 Session 或脱敏错误；
- `context_allowed|context_blocked`：分别保存 checkpoint/delta/预算绑定的构造证明或阻断原因；`before_provider_request` 保存对当前路线、检查点、delta、`hookOutcome`、`contextAuthorization` 与 payload 哈希的时点复核，最终 transport 由职责外观测确认。

开发验证的场景、runner、artifact 和采用判定由 [`../validation/context-enhancement-state.md`](../validation/context-enhancement-state.md) 统一定义。
`.artifacts/openviking/runtime/state.json` 区分 `starting`、`ready`、`restarting`、`failed` 和 `stopped`，并分别记录 `serviceReady`、`requestReady`、active/target profile 与进程代际绑定的能力 proof。扩展对用户只展示“增强记忆 · 初始化中”“增强记忆”或“增强记忆 · 故障”；这些状态只表达本扩展生命周期，不证明 transport 采用。`/memory-model` 展示配置、运行模型、profile、能力和请求状态。启动器 PID、启动标识、锁和子进程必须一致。

索引队列独立于来源归档和 Provider 请求。慢索引不会阻塞 Pi turn；显式召回重新同步当前历史路线，并按 `DEFAULT_REQUIRED_SOURCE_INDEX_TIMEOUT_MS` 的必要来源期限等待；仍未完成时以“索引准备中”失败，不能伪装成空结果。查询不可达、超时或响应无效时 tool result 标为错误，Pi Agent 仍可继续。

## 6. 停用与清理

启动器正常退出会删除 `launcher.lock`。若 `SIGKILL` 或主机中断留下死锁，先核对锁内 `launcherPid` 已不存在；若锁在元数据写完前中断而为空或损坏，则同时确认 `launcher.json` 没有存活 PID。再确认目标端口没有遗留的项目托管子进程；只有这些条件成立时才删除 `launcher.lock` 和陈旧 `launcher.json` 后重新启动。启动器不会自动接管死锁，以免误停仍在工作的 OpenViking。

使用 `--no-extensions` 停用全部扩展，或通过 Pi 工具选择不启用 `recall_session`。在启动器终端发送 `Ctrl+C` 会先停止其拥有的 OpenViking 子进程并移除控制入口与生命周期锁；停用和停止均不删除 Pi session、本地归档、用户级记忆模型 JSONC 或 OpenViking 资源。

OpenViking 资源可以按目标 session URI 递归删除；删除不会修改 Pi 权威历史，后续路线提交或显式搜索会从仍存在的本地来源副本重建。删除本地来源归档则会失去来源恢复和重建依据，不应把外部派生索引当作替代备份。
