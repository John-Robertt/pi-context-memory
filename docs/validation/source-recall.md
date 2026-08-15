# 来源索引、召回与故障边界验证

## 1. 验证责任

本文定义 OpenViking 来源索引、向量召回、session/branch 边界、权威展开、错误分类，以及必要召回数据面失败后的请求阻断。稳定结果保存于 [`../../validation/evidence/source-recall.json`](../../validation/evidence/source-recall.json)。

## 2. 固定本地环境

本地 runner 自行启动项目锁定的真实 OpenViking，使用动态 loopback 端口、隔离 HOME、项目内工作目录和固定来源 fixture。配置使用实际本地 dense embedding、`vectors_only` 和 `no_split`，不调用外部记忆模型；成功候选必须来自 OpenViking 实际索引和搜索，不能由代理预置。

代理只记录资源写入、读回、搜索、删除并注入错误响应，用于核对顺序和故障语义。Pi 集成 runner 另行使用真实 Pi 工具调用；真实纵向 suite 还必须由当前任务 Provider/模型主动调用召回，并在可检查产物中正确采用展开来源。

## 3. 协调验证

确定性场景覆盖：

- 同一 session 的待执行后台路线折叠到最新路线；
- A→B→A branch 往返保持当前来源集合；
- 显式同步优先于普通后台任务；
- 同路线调用共享正确 generation；
- 调用后完整同步屏障、等待期限、abort 和 shutdown；
- 同 URI 同内容并发收敛、异内容拒绝；
- 取消后停止来源遍历，异常传递给全部等待者。

## 4. 索引与召回验证

真实 OpenViking 成功路径与受控错误注入共同覆盖：

- 稳定 session/entry URI、幂等写入和内容精确读回；
- 外部资源删除后的当前来源重建；
- session 隔离与当前 branch 候选过滤；
- 离开 branch 和跨 session 来源排除；
- 全-text foreign custom 按 user 语义建候选；mixed/image/unsupported block 整单元 opaque，当前 unknown role drop；thinking/private metadata、excluded bash、扩展私有内容、summary 与废弃 branch 无候选；
- 以 control entry ID 调用 `read_source` 返回 `not-found`，不暴露 summary 也不锁存故障；
- `read_source` 按当前 Pi entry 重新建立记忆投影，只返回 MessageSource taskContent/completion 或 fullOutputRef 的同身份切片，不暴露 thinking、私有 metadata、OpaqueProviderSegment、FullOutputCandidate 或本机路径；
- 长来源预览边界和 Pi 权威 entry 展开；
- 正常空来源、正常空结果、索引准备、malformed envelope 和后端错误的独立语义；
- loopback 与远程明文地址的安全边界；
- OpenViking 候选进入结果前的当前路线复核；
- query 与 read_source 参数错误不被误判为服务故障。

## 5. 运行故障集成

通过真实 Pi 工具调用链分别注入资源写入、读回、搜索和响应归一化错误，证明：

1. 当前 `recall_session` 返回明确 tool error；
2. 正常空结果不锁存运行故障；
3. 参数错误允许任务模型修正调用；
4. 必要 OpenViking 数据面错误进入 Session 记忆协调故障；
5. 本扩展不确认依赖该数据面的增强输出并调用 `ctx.abort()`；
6. handler 返回与 transport 实际结果分别记录，不从内部故障状态推断 Provider 零请求；
7. 修复并建立新代际后，当前 branch 来源重新同步；
8. 用户重新提交任务后召回和增强请求恢复。

## 6. 执行入口

```bash
node scripts/validate-source-recall.mjs
node scripts/validate-context-enhancement.mjs
node scripts/check-validation-evidence.mjs
```

`source-recall` runner 分别保存真实 OpenViking 与受控故障证据；`context-enhancement` runner 分别记录召回故障后的本扩展 block/abort 和 transport 结果；质量 runner 保存实际任务采用与产物。原始 artifact 写入 `.artifacts/`，stable evidence 记录级别、坐标、检查和实现绑定。

## 7. 结果边界

本验证证明来源索引、候选过滤、权威展开和运行故障集成。Working Memory、ToolBatch、复杂长任务可靠性和完整成本由对应上下文与质量验证承担。当前 evidence 有效范围由 [`../DEVELOPMENT.md`](../DEVELOPMENT.md) 维护。
