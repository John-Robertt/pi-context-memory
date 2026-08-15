# Session 来源召回运行与维护

## 1. 安装与启动

前置条件是 Node.js `>=22.19.0` 和一个能够加载本扩展当前公开 hook 的 Pi。当前 evidence 的宿主验证坐标为 Pi `0.84.2`；扩展不安装、降级或替换用户的 Pi，后续宿主兼容由项目维护者跟随验证。

```bash
node scripts/install-dependencies.mjs
```

安装脚本使用 `uv.lock`，把当前可复现的 uv、Python 3.12、OpenViking `0.4.13` 和本地 embedding 依赖安装到项目内 `.tools/`、`.venv/` 与 `.cache/`，不修改系统 Python 或 shell PATH。OpenViking 版本是项目私有依赖锁定，不是对外部服务的永久版本要求。基础服务配置位于 [`../../config/openviking.json`](../../config/openviking.json)；首次启动 Pi 或 OpenViking 时，系统在 `~/.pi/pi-context-memory.jsonc` 独占创建用户级注释模板。
启动 OpenViking。若 `memoryModel.api_key` 使用环境变量引用，只在 launcher 终端提供该来源变量；例如当前开发验证的 OpenRouter 路线使用：

```bash
export OPENROUTER_API_KEY="<OpenRouter API key>"
node scripts/start-openviking.mjs
```

启动脚本作为项目 OpenViking 生命周期所有者运行：它先原子创建 `.artifacts/openviking/runtime/launcher.lock`，再预检配置与目标端口，把当前来源的 `memoryModel.api_key` 直接值或环境引用原样编译到 `0600` 运行配置，启动子进程并等待 `/health` 返回 `healthy=true`。环境引用必须在 launcher 环境中存在，并由 OpenViking 加载配置时展开；状态、日志和诊断不回显字段值。Pi 进程无需持有引用变量，也不重建 launcher 的可执行配置来决定当前增强是否可用，而是采用 runtime state 发布的 ready 受管子进程。OpenViking `0.4.13` 的 `/ready` 还包含 `viking://` 目录检查，不作为进程启动屏障；来源读写能力由召回验证单独覆盖。`launcher.json` 发布 loopback 控制入口和完整操作期限，`state.json` 分别发布实际运行实例与下一次应用目标；脚本只停止自己持有的子进程。启动器 PID、启动标识、锁和子进程必须一致。首次启动会把约 46 MiB 的本地 embedding 模型下载到项目 `.cache/openviking/models/`。服务健康后，在另一个终端从同一仓库根目录启动 Pi：

```bash
pi
```

项目被信任后，Pi 自动加载扩展并注册 `recall_session`。来源索引始终使用本地 embedding 和 `vectors_only`。当用户配置的记忆模型已经由项目启动器实际加载时，扩展还会异步维护当前路线的 OpenViking Session Working Memory；精确路线的 active history assembly 通过来源核验后即可采用有界增强历史，不等待 Working Memory 生成，任务完成后再以 overview 更新同一路线结果。未配置模型时保持来源召回与 Pi 原生上下文。

项目内正常路径由启动脚本托管本地 OpenViking；仅使用显式召回时也可以通过 `PCR_OPENVIKING_URL` 连接受信服务，但 `/restart-viking` 只控制项目启动器拥有的本地实例。日常验证使用 runner 自启的受控本地 OpenViking 或协议替身，完整成本验证随自动上下文优化纵向交付建立，实验设计见 [`../validation/README.md`](../validation/README.md)。

## 2. 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PCR_OPENVIKING_URL` | `http://127.0.0.1:1933` | OpenViking服务根 URL |
| `PCR_OPENVIKING_API_KEY` | 未设置 | 需要服务 API key 认证时发送 `X-API-Key` |
| `PCR_MEMORY_MODEL_SETTINGS` | 未设置 | 受控部署或验证覆盖记忆模型 JSONC 路径；普通运行不设置，设置时 Pi 与启动器必须使用同一值 |
| `PCR_OPENVIKING_TIMEOUT_MS` | `30000` | 单次来源或 Session API 请求期限；Working Memory 任务另有 180 秒终态期限 |
| `PCR_OPENVIKING_READINESS_TIMEOUT_MS` | `30000` | 启动器等待 `/health` 健康的期限 |
| `PCR_OPENVIKING_STOP_TIMEOUT_MS` | `5000` | 启动器在升级为 `SIGKILL` 前等待子进程退出的期限 |
| `PCR_OBSERVATION_LOG` | 未设置 | 仅供开发验证追加脱敏 JSONL 运行观察 |

来源归档的数据根和完整输出复制期限由 [`source-archive.md`](source-archive.md) 统一说明。远程 OpenViking 必须使用 HTTPS 和适当认证。索引内容来自完整用户、assistant、工具及压缩来源，应按 Pi session 同等敏感级别保护。

## 3. 使用

执行 `/memory-model` 查看用户配置路径和当前运行模型。编辑 `~/.pi/pi-context-memory.jsonc`，把 `memoryModel: null` 替换为文件中一个 Provider 示例并填写模型、`api_key` 及必要连接字段；`api_key` 可直接填写，也可写 `$NAME` 或 `${NAME}`。保存后执行 `/restart-viking`。恢复为 `null` 并重启会停用 VLM、保留基础来源服务。命令不改写 JSONC，且只向当前项目启动器提交应用请求。普通运行由用户自行选择记忆模型；开发验证从 [`../../validation/model.json`](../../validation/model.json) 的一个 `openRouterModel` 派生 Pi 任务路线和 LiteLLM 记忆路线，再通过带 `${OPENROUTER_API_KEY}` 引用的隔离配置运行，不要求修改用户文件。无需 API key 的云原生或 LiteLLM 认证路线可以省略该字段；具体来源的官方环境变量或凭据链继续由该来源负责。

系统不会改写已有 JSONC 的注释。若文件仍是未配置的旧模板，可先备份并删除该文件，再执行 `/memory-model` 生成当前模板；已经配置的文件应保留设置，只按新模板说明手工调整 LiteLLM 段。
```jsonc
{
  "memoryModel": {
    "provider": "litellm",
    "model": "openrouter/<provider>/<model-id>",
    "api_key": "${OPENROUTER_API_KEY}"
  }
}
```

扩展只选择 Provider、模型和必要连接字段，不主动写入 `thinking`、reasoning、temperature 等跨 Provider 控制。实际语义由 OpenViking 目标适配器及最终请求共同决定；当前 LiteLLM OpenRouter evidence 保留模型路由，转发 adapter 默认 temperature `0`，不转发 reasoning。Pi 任务模型的 `thinking: off` 仍是独立条件。
LiteLLM 的 `model` 直接写上游来源路由，当前 OpenRouter 形式为 `openrouter/<provider>/<model-id>`。

模板给出 Bedrock、SageMaker、Vertex AI 的显式云路由示例；自定义 OpenAI-compatible 端点使用 `model: "openai/<model-id>"` 并填写 `api_base`。这些示例定义产品当前明确验证的路由形态，更多来源、认证和模型前缀以模板链接的 LiteLLM 官方目录为准。
任务模型可以调用：

```text
recall_session(action="search", query="早期数据库约束", limit=5)
recall_session(action="read_source", entry_id="<search 返回的 entry ID>", max_chars=8000)
```

搜索最多返回 10 项；OpenViking 只负责候选排序，预览来自与当前 Pi entry 精确核对的本地来源副本，`read_source` 展开当前 Pi 权威 entry。`read_source` 不依赖 OpenViking，因此已经取得 entry ID 时，即使后端随后不可用仍可尝试展开当前来源。

自动增强不调用显式召回工具，也不把 OpenViking摘要提升为事实权威。它只替换当前 prompt 之前的历史，当前 turn 保持 Pi 原生；关键事实仍可通过 `recall_session` 展开到当前 Pi entry。

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
- `working_context_ready|error|rejected`：保存路线指纹、派生 session、token、内容哈希或脱敏错误；
- `context`：保存原始与实际采用消息的哈希、字节、路线指纹及 `enhanced|pi-native` 路径。

真实采用诊断从 [`../../validation/model.json`](../../validation/model.json) 派生任务与记忆模型，只需选择 `accepted` 或 `skipped` 场景；runner 核对 `PCR_MEMORY_MODEL_SETTINGS` 解析到的配置（未设置时才是用户 JSONC）与同一环境下 runtime 的 active/target 坐标，不一致时拒绝运行。开发验证可让 launcher 与 runner 使用同一个 `.artifacts/` 隔离配置，无需修改用户文件。任务模型由 Pi 直接调用 OpenRouter，记忆模型由 OpenViking 经 LiteLLM 调用同一 OpenRouter 账户：

```bash
PCR_REAL_ADOPTION_SCENARIO=accepted \
node scripts/validate-real-context-adoption.mjs
```

runner 固定 5 秒宿主启动窗口但不预等待 Working Memory；`skipped` 场景默认零额外轮次间隔核对第二轮，`accepted` 场景核对 active history 请求先于最终 Working Memory。原始 session、观察、RPC 和 Pi 任务 usage 只写入 `.artifacts/real-context-adoption/`；OpenRouter 最终账单仍是 billed cost 权威。
`.artifacts/openviking/runtime/state.json` 区分 `starting`、`ready`、`restarting`、`failed` 和 `stopped`，以 `active*` 表示实际模型、`target*` 表示应用目标。Pi 状态栏实时显示“增强记忆 · 初始化中”“增强记忆 · 生效中”或“增强记忆”；只有增强不可用并强制回退时显示“Pi 原生”。`/memory-model` 另外显示配置、运行模型与最近实际采用路径。运行中配置错误保持旧实例，冷启动配置错误启动无 VLM 基础服务；启动器 PID、启动标识、锁和子进程必须一致。

索引队列独立于来源归档和 Provider 请求。慢索引不会阻塞 Pi turn；显式召回重新同步当前历史路线并最多等待 5 秒，仍未完成时以“索引准备中”失败，不能伪装成空结果。查询不可达、超时或响应无效时 tool result 标为错误，Pi Agent 仍可继续。

## 6. 停用与清理

启动器正常退出会删除 `launcher.lock`。若 `SIGKILL` 或主机中断留下死锁，先核对锁内 `launcherPid` 已不存在；若锁在元数据写完前中断而为空或损坏，则同时确认 `launcher.json` 没有存活 PID。再确认目标端口没有遗留的项目托管子进程；只有这些条件成立时才删除 `launcher.lock` 和陈旧 `launcher.json` 后重新启动。启动器不会自动接管死锁，以免误停仍在工作的 OpenViking。

使用 `--no-extensions` 停用全部扩展，或通过 Pi 工具选择不启用 `recall_session`。在启动器终端发送 `Ctrl+C` 会先停止其拥有的 OpenViking 子进程并移除控制入口与生命周期锁；停用和停止均不删除 Pi session、本地归档、用户级记忆模型 JSONC 或 OpenViking 资源。

OpenViking 资源可以按目标 session URI 递归删除；删除不会修改 Pi 权威历史，后续路线提交或显式搜索会从仍存在的本地来源副本重建。删除本地来源归档则会失去来源恢复和重建依据，不应把外部派生索引当作替代备份。
