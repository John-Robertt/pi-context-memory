# 长时记忆模块

## 1. 当前责任

本模块保存 Pi session 来源副本和完整工具输出，维护 OpenViking Session Working Memory，管理用户记忆模型配置转换，并提供当前受管 OpenViking 代际的实际记忆模型能力证明。

Pi session entry 仍是事实权威；来源文件由 `long-term-memory.ts` 管理，OpenViking Session 派生状态由 `session-working-memory.ts` 管理，配置由 `memory-model-configuration.ts` 管理。向量候选排序属于召回模块，请求采用属于 Session 记忆协调模块。

跨模块流程见 [`../system/source-archiving.md`](../system/source-archiving.md)、[`../system/source-recall.md`](../system/source-recall.md)、[`../system/memory-model-runtime.md`](../system/memory-model-runtime.md) 和 [`../system/context-enhancement.md`](../system/context-enhancement.md)。

## 2. 持久化表示

默认归档根位于 Pi session 目录的 `.pi-context-memory/`：

```text
.pi-context-memory/
└── <session-key>/
    ├── session.json
    ├── sources/<entry-key>.json
    └── large-results/
        ├── blobs/<content-sha256>.bin
        └── records/<entry-key>.json
```

`session.json` 保存 session ID 与绝对 session file。来源记录是 `message-source | control-boundary`：前者保存 schema 版本、来源引用、原始 Pi message entry 和内容哈希；后者只保存 compaction/branch summary 的 type、ID、parent 与边界引用，不保存 summary、retainedTail、details 或 usage。完整结果流式复制到内容寻址 blob，再由 entry 元数据原子发布；读取重新核对字节数与 SHA-256。

目录键和文件键由身份哈希派生。目录仅当前用户可访问，文件仅当前用户可读写。验证可通过受控环境变量把数据写入仓库 `.artifacts/`。

## 3. 来源能力与不变量

本模块提供：

- 按 session 写入、读取和列出来源 entry；
- 流式复制完整工具输出并验证内容哈希；
- 读取与当前 Pi entry 关联的完整结果；
- 为工作上下文投影提供来源屏障；
- 为 OpenViking 资源和索引重建提供输入。

来源操作必须满足：

1. session ID 和 session file 与目标归档一致；
2. entry 来自当前 Pi branch；
3. 同一 entry ID 的内容和哈希稳定一致；
4. 完整结果元数据只有在 blob 完整写入后发布；
5. 读取结果重新核对大小、哈希和 entry 身份；
6. 损坏、缺失或身份不匹配的记录不作为可恢复来源；
7. control-boundary 的序列化结果中不存在 summary 或 retainedTail 内容。

当前回合大工具结果被有界投影前，相关来源屏障必须完成。失败由 Session 记忆协调锁存为必要数据面故障。

## 4. 记忆模型配置与能力

模块维护扩展支持的最小用户配置面，并通过 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 转换为 OpenViking 运行配置。

用户配置只读解析；缺失模板以 `0600` 原子创建。直接凭据和环境引用原样进入受限运行配置，凭据值不进入状态、日志、evidence 或 Pi session。

模块区分：

- 配置能够解析；
- OpenViking 能够加载配置；
- 受管子进程和服务 ready；
- 记忆模型实际完成 Working Memory；
- 当前代际具备任务请求能力。

实际能力证明来自隔离 Session 的生产协议探针，绑定 launchId、childPid、模型、配置指纹、协议版本、探针实现和 `validUntil`。同代际业务 accepted task 只有在完整 assembly 核验后续租；`health`、`ready`、模型对象存在或过期证明不能建立任务请求能力。

## 5. OpenViking Session Working Memory

Session Working Memory 只接收 Session 记忆协调核验过的完整路线身份和 Pi 集成规范化结果：

- 线性后继在同一镜像追加新增 entry；
- 分叉、session replacement 或有效前缀变化使用隔离镜像；
- compaction 与 branch summary entry 只贡献路线边界身份，其 summary 文本不发送给 OpenViking task 或 context 接口；
- 权威 message entry ID 通过来源字段进入 OpenViking；
- batch append、commit、task polling 和 context assembly 统一经过适配契约；
- 同一精确路线共享准备任务；
- pending、ready 和镜像数量有固定上限；
- 迟到结果只属于创建它的运行代际和路线。

commit 接受 `accepted + task ID` 或 `skipped + 空 task ID`。`skipped` 只表示本次没有触发记忆提取，保留来源核验的 active history；它不能单独建立记忆模型能力证明。

accepted Working Memory task 完成并通过 assembly 核验前不发布路线结果；`skipped` 可以使用既有 Working Memory 与来源核验 active history，但不能续租能力证明。每个已启动 task 必须观察终态；ready 运行中的失败、取消、超时或 assembly 失败使当前运行代际进入能力故障，stopping 期间由扩展发起的取消只完成清理。

## 6. 对外能力

本模块向相邻模块提供：

- `archiveRoute`：幂等保存当前路线来源；
- `ensureRecoverable`：确认指定 entry 和完整结果可恢复；
- `prepareRoute`：为精确路线准备 OpenViking Session context；
- `probeCapability`：验证当前受管模型实际 Working Memory 能力；
- `runtimeCapability`：返回与当前 active 进程绑定的能力证明；
- 来源列表、完整结果读取和 OpenViking 索引输入；
- 受控 shutdown 与扩展创建 Session 清理。

接口返回明确成功或错误，不以空内容表示故障。

## 7. 错误与恢复

错误按来源、配置、服务、能力和协议分类：

- 来源创建、复制、校验或读取失败直接返回；
- JSONC、schema、字段或凭据错误形成带路径的脱敏诊断；
- Session create、append、commit 或首次 assembly 失败不发布路线；
- 未知、矛盾、缺失来源或通用失败内容不进入上下文；
- Working Memory task 非成功终态使能力证明失效；
- 当前受管子进程停止或替换使旧代全部派生状态失效。

重新提交同一有效来源可按稳定 entry ID 修复局部归档。运行代际故障的恢复由显式 OpenViking 重启或能力重新验证触发；新代际从当前 Pi branch 和已核验本地来源重建。

清理失败不会改变 Pi session 事实，但进入运行观测。系统不因清理结果自动发送任务请求。

## 8. 验证边界

验证分别证明：

- session、branch、文件权限、原子写入和内容完整性；
- 当前回合投影前的来源屏障；
- 配置转换、凭据保密和用户文件所有权；
- 实际能力探针确实调用目标记忆模型；
- OpenViking Session 增量、分支隔离、commit、task 和 assembly；
- `skipped` 与能力证明具有不同语义；
- task 失败使后续 Provider 请求被阻断；
- 新运行代际不复用旧代 context；
- session shutdown 和镜像淘汰保持有界清理。

当前实现与设计之间的状态由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
