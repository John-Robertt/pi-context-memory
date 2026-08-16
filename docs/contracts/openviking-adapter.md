# OpenViking 适配契约

## 1. 文档角色

本文是扩展与 OpenViking 之间唯一需要独立演进的外部适配契约。它定义扩展使用哪些能力、怎样归一化结果、什么事实允许任务请求生效，以及 OpenViking 变化时由谁承担修改责任。

Pi 宿主控制权、session 事实权威和增强请求边界由 [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) 定义；实现位于 `openviking-protocol.ts`、`openviking-config.py` 及调用它们的业务模块。

## 2. 定位与责任

OpenViking 提供来源资源、向量候选、Session Working Memory、异步记忆任务和 context assembly。扩展负责把这些能力转换为受 Pi session、当前 branch、来源和运行代际约束的增强结果。

OpenViking 的接口、字段、配置和输出变化由扩展适配，不转移给 Pi 或用户。项目私有依赖可以锁定可复现版本，验证 runner 可以固定精确坐标；产品契约由已验证能力而不是永久版本号定义。

能力按实际操作分别证明：

- `/health` 证明服务进程响应；
- `/ready` 证明 OpenViking 声明的本地组件 ready；
- 资源写入与精确读回证明来源能力；
- 搜索响应证明候选能力；
- Session create、append、commit、task 和 context 分别证明对应操作；
- 完整生产协议探针证明当前记忆模型能力。

任何一项不能由另一项推断。

## 3. 共同传输边界

所有 OpenViking HTTP 调用统一执行：

- loopback 地址可以使用 HTTP，远程地址必须使用 HTTPS；
- 使用同一 API key、期限、响应大小、JSON envelope 和 HTTP 错误语义；
- 上游响应先归一化，业务模块不直接依赖诊断字段；
- 网络、状态码、超时、取消、大小限制和 JSON 错误具有稳定分类；
- 未知、缺失、矛盾或无效结果返回明确错误。

必要能力错误由 Session 记忆协调锁存；本扩展不确认依赖该能力的增强输出，并调用 `ctx.abort()` 表达当前处理结果。Pi 是否实际停止 Provider 由宿主/transport 观测，不从适配器状态推断。

## 4. 来源索引与召回

来源写入成功由 HTTP 接受、预期稳定 URI 和内容精确读回共同证明。处理统计只用于观察，不替代内容一致性。

OpenViking 搜索只产生候选 URI 和有限数值 score。任一 malformed 候选使本次搜索失败。当前 session、branch、URI 映射、来源内容和最终展开由扩展依据 Pi 权威历史核验。

来源索引属于增强记忆必要数据面。索引写入、读回、同步或查询的 backend、source 和 protocol 错误使当前运行代际失去请求能力；显式工具返回错误，后续任务请求被阻断。工具输入错误和已完整同步后的正常空结果不改变运行能力。

## 5. Session Working Memory

Session create、batch append、commit、task polling 和 context assembly 使用 OpenViking 当前公开协议。

Session append 只发送 MessageSource taskContent、完成状态、source ID，以及同 entry 来源记录中 fullOutputRef 的有界存在性/哈希标记；thinking、私有 metadata、OpaqueProviderSegment、FullOutputCandidate、本机路径与完整结果 blob 不进入 OpenViking。Working Memory 历史输入和 commit retention 使用长时记忆模块拥有的版本化有界策略；`MemoryRuntimeProfile` 只约束记忆模型请求和客户端运行策略。

对于必要刷新，adapter 把 `retentionBudgetIdentity` 映射为明确的 commit retention 与 checkpoint output 边界；结果必须在不截断未知语义的前提下满足该边界。目标 OpenViking/Provider 无法施加或实际证明该边界时，对应任务/记忆 profile 组合保持 unsupported。

commit 只接受：

- `accepted`：必须携带非空 task ID，并观察该任务终态；
- `skipped`：必须为空 task ID，表示当前保留策略下没有触发记忆提取。
其它组合均为协议错误。机会性 `skipped` 保留扩展已有检查点与来源后缀，但不能证明记忆模型能力或发布新检查点。`refresh-required` commit 携带与预算版本绑定的显式 retention 边界；该调用返回 skipped 表示契约/策略未能收缩必要后缀，直接返回协议错误，不自动循环提交。

每个 accepted task 的合法终态为：

- `completed`：允许读取并核验最终 assembly；
- `failed | cancelled`：ready 运行中的业务任务表示当前能力失败；stopping 期间由扩展发起的取消只作为清理终态；
- 在任务期限内的 `pending | running | cancelling`：继续观察；
- 其它状态：协议错误。

ready 运行中的 accepted task 超过绑定 `MemoryRuntimeProfile` 的请求期限、失败、取消或最终 assembly 错误，使绑定它的运行代际失去任务请求能力。业务 refresh task 的 pending/running 本身不使已有兼容 MemoryCheckpoint 失效；任务请求是否等待由检查点与 VerifiedActiveDelta 的完整性和任务模型预算决定，而不是由 OpenViking task 是否存在决定。

## 6. Context assembly

Working Memory overview 是派生文本，不以固定语言、标题、数量、顺序或长度定义有效性。可采用 assembly 必须满足：

- assembly 请求与响应绑定扩展业务 Session、运行代际和精确 HistoricalRouteKey；
- 响应 envelope 与核心字段可归一化；
- active messages 非空，首轮空历史使用扩展本地合法表示；
- message role 和 content block 为已支持形态；
- 每个 active message 具有当前路线来源 ID；
- 不包含当前路线之外来源；
- 不包含已知通用失败文本；
- 估算 token 和最终字符预算有界；
- overview 与 active history 可以形成确定性内容哈希。

未知内容形态、缺失来源、空 active tail、跨路线来源或通用失败内容返回协议错误。

扩展只在 accepted task completed 且 assembly 通过上述核验后发布 `MemoryCheckpoint`。检查点绑定 assembly 请求的精确 HistoricalRoute 前缀、覆盖 watermark、retentionBudgetIdentity、来源集合、assembly hash、运行代际和 producing capability proof ID；proof ID 只用于追溯，后续请求另行要求同代际当前能力 proof 有效。assembly 之后的 Pi entry 不回填到该检查点，而由协调器形成 VerifiedActiveDelta。`skipped` 不发布新检查点，保留旧检查点与 delta。

## 7. 记忆模型能力证明

任务请求能力探针使用与生产相同的 Session、commit、task 和 context 契约。证明必须绑定：

- 启动器 launchId 和 OpenViking childPid；
- active Provider、模型、API、配置指纹与 `MemoryRuntimeProfile` 指纹；
- OpenViking 协议或适配版本；
- 探针输入版本；
- accepted task ID、成功终态和 assembly 哈希；
- 证明生成时间和操作期限。

只有确实触发目标记忆模型并完成有效 assembly 的探针可以发布能力证明。`health`、`ready`、配置加载、模型对象创建和 skipped commit 不满足该条件。
能力证明与创建它的受管进程代际共同生效。进程退出、显式重启、active 绑定变化或 proof/usage 不一致时失效；外部 Provider 故障由下一次实际记忆操作发现并阻断。
探针 Session 与业务 Session 隔离，结束后删除。探针 token 和费用进入完整成本归属。

## 8. 配置适配

用户 JSONC 是扩展拥有的稳定最小配置面，只包含 Provider、模型、`api_key` 和必要连接字段。[`../../config/openviking-adapter-contract.json`](../../config/openviking-adapter-contract.json) 唯一定义配置桥接受的 Provider 字段、凭据规则、VLM schema 指纹和适配器类别；配置桥据此为精确目标生成 `MemoryRuntimeProfile`，当前受管进程的生产探针决定实际请求能力。

`api_key` 普通字符串作为直接凭据；完整 `$NAME` 或 `${NAME}` 只在预检编译边界从 Launcher 环境解析。要求凭据的来源缺失字段或引用变量未设置时，在停止旧实例前失败。配置桥只生成固定 `${PCR_OPENVIKING_MEMORY_API_KEY}` 引用；实际值由 Launcher 保留在内存，并仅在 spawn 时赋给受管 OpenViking 子进程的同名内部变量。Launcher 不复制其它宿主环境；需要 ambient 变量的原生认证必须先增加独立受审查接口，不能从当前无 key 配置隐式获得。OpenViking 只负责按其配置加载契约展开固定引用，不解析用户配置语义。
实际凭据值只进入用户直接填写的配置、预检编译过程内存，以及受管 OpenViking 子进程的固定内部环境变量；使用环境引用时，生成配置和用户配置均不保存实际值。本系统不把记忆凭据注入任务 Pi；受管 OpenViking 不继承用户引用变量、ambient Provider key 或其它宿主环境，spawn 时只注入当前编译结果携带的内部值。凭据值不进入运行状态、诊断、日志、evidence 或 Pi session。Python 配置桥、TypeScript 用户配置校验和适配器 runner 都消费同一受审查契约；OpenViking VLM schema 指纹不匹配时停止配置适配。上游新增 Provider 需要先把其公开字段和凭据边界纳入该契约；已有契约项仍由每次真实能力探针判断当前精确配置是否可用。

`MemoryRuntimeProfile` 的字段与责任由 [`../system/memory-model-runtime.md`](../system/memory-model-runtime.md) 唯一定义；本契约负责把字段映射到 OpenViking 配置或客户端运行策略。运行配置不得依赖未受审查的隐式默认值，不配置 backup Provider/model，也不接受用户任意请求体透传。

## 9. 生效与故障条件

一个 OpenViking 运行代际只有同时满足以下条件才可用于任务请求：

- 用户目标通过当前 OpenViking 配置契约解析和编译，并生成与该目标一致的 MemoryRuntimeProfile；
- 启动器所有权有效；
- active 子进程与状态一致；
- 服务 readiness 成功；
- 记忆模型能力证明与 active 配置、profile、adapter、子进程一致；
- 当前业务 Session 操作继续满足本契约。

配置发现、服务启动和初始能力探针可以在任务请求之前执行，业务 refresh 只在当前消费者需要时运行。每次 `context` 授权和 Provider hook 都重新读取并核对当前代际能力 proof；进程、绑定或 proof 不匹配时直接阻断。兼容 MemoryCheckpoint 与 VerifiedActiveDelta 无法形成可信有界历史时，另行等待对应的必要 refresh。

当前业务操作使能力证明失效时，协调器锁存故障。新代际通过显式重启或重新验证建立。

## 10. 兼容与验证

OpenViking 适配变更至少验证：

- 配置桥接受的目标生成精确绑定的 MemoryRuntimeProfile，字段进入受审查配置，且无 backup Provider/model；当前受管进程只有在真实能力探针通过后才授权；
- 上游新增未知 Provider 需更新公开字段/凭据契约，默认值变化不绕过显式 profile；
- 可选诊断字段缺失不影响经内容读回证明的来源写入；
- Working Memory 标题、语言和可选 token 字段变化能够归一化；
- malformed、跨路线或通用失败结果形成明确错误；
- accepted、skipped、task 终态、MemoryCheckpoint 发布与 VerifiedActiveDelta 语义准确；
- 慢速 refresh pending 时兼容检查点保持可用，只有必要 refresh 形成请求屏障；
- retentionBudgetIdentity 能在实际 commit/assembly 中形成可验证的 checkpoint 输出边界；任务历史预算缩小时生成新边界，无法施加时阻断对应增强请求；
- 服务 ready 与模型能力失败能够独立表达；
- 能力探针实际触发目标模型并形成绑定证明；
- 运行代际变化使旧证明和业务 context 失效；
- 必要能力错误使本扩展拒绝确认增强输出；`ctx.abort()` 返回与实际 transport 结果分别观测；
- 当前项目锁定依赖的来源、Session、模型和清理能力通过纵向 runner。

具体执行入口和有效 evidence 由 [`../validation/README.md`](../validation/README.md) 维护。
