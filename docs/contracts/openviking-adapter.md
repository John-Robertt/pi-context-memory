# OpenViking 适配契约

## 1. 文档角色

本文是扩展与 OpenViking 之间唯一需要独立演进的外部适配契约。它定义扩展使用哪些能力、怎样归一化结果、什么事实允许功能生效，以及 OpenViking 变化时由谁承担修改责任。系统与模块文档只引用本契约，不复制具体版本字段或响应形态。

Pi 的宿主控制权、session 事实权威和原生降级边界由 [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) 定义；实现位于 `openviking-protocol.ts`、`openviking-config.py` 及调用它们的业务模块。

## 2. 定位与责任

OpenViking 提供来源资源、向量候选、Session Working Memory 和 context assembly。扩展负责把这些能力转换为受 Pi session、当前路线和来源约束的增强结果。

OpenViking 的接口、字段、配置或输出变化由扩展适配，不构成 Pi 或用户必须维护的约束。项目私有 `.venv` 可以锁定当前可复现依赖，验证 runner 可以固定精确坐标；两者都不定义永久兼容边界。升级责任属于项目维护者。

扩展不要求 OpenViking 提供本项目专用接口，也不假设不存在的 capability API。能力由当前公开操作的实际结果证明：`/health` 只证明服务存活；资源写入、搜索、Session、commit、task 和 context 各自由对应操作成功证明。

## 3. 生产契约

### 3.1 共同传输边界

所有 OpenViking HTTP 调用统一执行：

- 回环地址可使用 HTTP，远程地址必须使用 HTTPS；
- 使用同一 API key、期限、响应大小、JSON envelope 和 HTTP 错误语义；
- 上游响应先归一化，业务模块不直接依赖诊断字段；
- 未知、缺失或无效结果使当前能力失败，不阻止 Pi 原生请求。

### 3.2 来源索引与召回

来源写入成功由 HTTP 接受和预期稳定 URI 的内容精确读回共同证明。`queue_status` 等处理统计只用于观察和固定版本验证，不是生产成功条件。

OpenViking 只产生候选和分数。每个候选必须具有合法 URI 和有限数值 score；任一 malformed 候选使本次搜索不可用，不能伪装成正常空结果。当前 session、当前路线、URI 映射、来源内容及最终展开始终由扩展依据 Pi 权威历史核验。

### 3.3 Session Working Memory

Session create、batch append、commit、task polling 和 context assembly 使用 OpenViking 当前公开协议。核心字段经适配层归一化；可选 token 统计缺失时由扩展使用本地保守估算，不把诊断字段升级为必要契约。

Working Memory overview 是派生文本，不以固定语言、标题名称、数量、顺序或长度定义有效性。可采用响应必须包含非空、可识别且带来源 ID 的 active messages；未知内容形态、缺失来源、空 active tail 或已知通用回退都关闭本次增强。overview 的一般任务质量由共享 fixture 和真实质量 checker 验证。

## 4. 配置适配

用户 JSONC 是扩展拥有的稳定、最小配置面，只包含当前用户需要选择的 Provider、模型和必要连接字段。扩展可以支持 OpenViking 能力的明确子集，不承诺复制其全部 Provider registry 或内部 LiteLLM 路由表。

配置桥只在一个位置接触 OpenViking 配置校验入口。上游新增未知 Provider 不得使已有受支持 Provider 失效；上游删除或改变已支持能力时，适配验证必须失败并由维护者更新转换。

`thinking`、reasoning、temperature 等参数只有在目标 Provider 的最终适配请求得到验证时才能形成产品承诺。当前质量 evidence 观察到 OpenViking Codex Responses 适配器没有转发 reasoning 或 temperature，因此 reasoning 使用 Provider 默认；这与 Pi 任务模型的 `thinking: off` 是两项独立条件。

## 5. Pi 降级与生效条件

配置发现、文件读取、Python bridge、OpenViking 健康和所有记忆操作都在 Provider 请求之外执行。Pi `context` hook 只读取已经完成的内存状态和当前路线就绪结果，绝不等待这些操作。

任一能力正在检查、未知、失败、过期或与当前配置及路线不一致时，本次请求保持 Pi 原生消息。后台结果只影响完成后的后续请求，不能改变已经开始的 Provider 请求。

## 6. 兼容与验证

OpenViking 适配变更至少验证：

- 新增未知 Provider 不影响已有受支持配置；
- 可选诊断字段缺失不影响经内容读回证明的来源写入；
- Working Memory 标题、语言或可选 token 字段变化能够归一化；
- malformed 响应只关闭对应增强；
- 配置桥或 OpenViking 延迟不延迟 Pi 原生 Provider 请求；
- 当前项目锁定版本的真实来源、Session 和模型能力仍通过现有纵向 runner。

具体执行入口和当前 evidence 由 [`../validation/README.md`](../validation/README.md) 维护。