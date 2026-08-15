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

必要能力错误由 Session 记忆协调锁存，后续任务模型请求在 Provider 前被阻断。适配层不返回可被解释为正常空结果的故障值。

## 4. 来源索引与召回

来源写入成功由 HTTP 接受、预期稳定 URI 和内容精确读回共同证明。处理统计只用于观察，不替代内容一致性。

OpenViking 搜索只产生候选 URI 和有限数值 score。任一 malformed 候选使本次搜索失败。当前 session、branch、URI 映射、来源内容和最终展开由扩展依据 Pi 权威历史核验。

来源索引属于增强记忆必要数据面。索引写入、读回、同步或查询的 backend、source 和 protocol 错误使当前运行代际失去请求能力；显式工具返回错误，后续任务请求被阻断。工具输入错误和已完整同步后的正常空结果不改变运行能力。

## 5. Session Working Memory

Session create、batch append、commit、task polling 和 context assembly 使用 OpenViking 当前公开协议。

commit 只接受：

- `accepted`：必须携带非空 task ID，并观察该任务终态；
- `skipped`：必须为空 task ID，表示当前保留策略下没有触发记忆提取。

其它组合均为协议错误。`skipped` 可以保留来源核验的 active history，但不能证明记忆模型实际能力。

每个 accepted task 的合法终态为：

- `completed`：允许读取并核验最终 assembly；
- `failed | cancelled`：ready 运行中的业务任务表示当前能力失败；stopping 期间由扩展发起的取消只作为清理终态；
- 在任务期限内的 `pending | running | cancelling`：继续观察；
- 其它状态：协议错误。

ready 运行中的任务超过期限、失败、取消或最终 assembly 错误，使绑定它的运行代际失去任务请求能力。

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

## 7. 记忆模型能力证明

任务请求能力探针使用与生产相同的 Session、commit、task 和 context 契约。证明必须绑定：

- 启动器 launchId 和 OpenViking childPid；
- active Provider、模型和配置指纹；
- OpenViking 协议或适配版本；
- 探针输入版本；
- accepted task ID、成功终态和 assembly 哈希；
- 证明生成时间、`validUntil` 和操作期限。

只有确实触发目标记忆模型并完成有效 assembly 的探针可以发布能力证明。`health`、`ready`、配置加载、模型对象创建和 skipped commit 不满足该条件。
能力证明是有界租约。每次任务请求必须使用未过期且仍绑定 active 子进程的证明；同代际业务 Session 中实际完成的 accepted task 可以按相同核验规则续租。证明临近或达到 `validUntil` 时，系统完成实际模型续租探针后才能继续授权；续租 pending 属于内部等待，失败或超时锁存能力故障。
探针 Session 与业务 Session 隔离，结束后删除。探针 token、费用和失败重试进入完整成本归属。

## 8. 配置适配

用户 JSONC 是扩展拥有的稳定最小配置面，只包含当前需要选择的 Provider、模型、`api_key` 和必要连接字段。扩展只声明具有实际纵向证据的 OpenViking Provider/模型子集，不复制其全部 Provider registry 或 LiteLLM 路由表；只有配置转换或协议替身通过的组合保持未验证。

`api_key` 普通字符串作为直接凭据，完整 `$NAME` 或 `${NAME}` 由 OpenViking 配置加载器从启动器环境展开。要求凭据的来源缺失字段或引用变量未设置时，在停止旧实例前失败；无需 API key 的来源可以使用其原生认证。

凭据不进入运行状态、诊断、日志、evidence 或 Pi session。配置桥只在一个位置接触 OpenViking 配置校验入口；上游新增未知 Provider 不得使现有受支持配置失效。

`thinking`、reasoning、temperature 等参数只有在目标 Provider 最终适配请求得到验证后才形成产品契约。

## 9. 生效与故障条件

一个 OpenViking 运行代际只有同时满足以下条件才可用于任务请求：

- 配置解析和编译成功；
- 启动器所有权有效；
- active 子进程与状态一致；
- 服务 readiness 成功；
- 记忆模型能力证明与 active 配置、子进程和适配版本一致；
- 当前业务 Session 操作继续满足本契约。

配置发现、服务启动和能力探针可以在任务请求之前执行。`context` 调用可以创建或加入精确路线准备，并在操作期限内等待；等待结束只返回有效结果或明确错误。

当前业务操作使能力证明失效时，协调器锁存故障。新代际通过显式重启或重新验证建立。

## 10. 兼容与验证

OpenViking 适配变更至少验证：

- 新增未知 Provider 不影响已有受支持配置；
- 可选诊断字段缺失不影响经内容读回证明的来源写入；
- Working Memory 标题、语言和可选 token 字段变化能够归一化；
- malformed、跨路线或通用失败结果形成明确错误；
- accepted、skipped 和 task 终态语义准确；
- 服务 ready 与模型能力失败能够独立表达；
- 能力探针实际触发目标模型并形成绑定证明；
- 运行代际变化使旧证明和业务 context 失效；
- 必要能力错误使任务 Provider 请求数不增加；
- 当前项目锁定依赖的来源、Session、模型和清理能力通过纵向 runner。

具体执行入口和有效 evidence 由 [`../validation/README.md`](../validation/README.md) 维护。
