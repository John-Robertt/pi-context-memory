# 召回与来源追溯模块

## 1. 当前责任

本模块是任务模型访问当前工作上下文之外来源的唯一入口。它把长时记忆中的任务文本同步为可重建的 OpenViking resource，调用 OpenViking完成向量候选排序，并只把 Session 记忆协调确认仍属于当前 branch 的候选展开给模型。

跨模块流程见 [`../system/source-recall.md`](../system/source-recall.md)，验证见 [`../validation/source-recall.md`](../validation/source-recall.md)。实现位于 [`.pi/extensions/pi-context-memory/recall-and-provenance.ts`](../../.pi/extensions/pi-context-memory/recall-and-provenance.ts)。

## 2. 拥有的数据与接口

模块拥有 OpenViking HTTP 交互、multipart 临时上传、稳定 resource URI 派生、来源文本投影、并发同步合并和候选响应校验。OpenViking 不接收 Pi session file 或 branch 结构。

对 Pi 集成提供：

- 同步一组已归档来源；
- 在指定 session URI 范围内取得有限语义候选；
- 将候选 URI 映射到调用方提供的当前路线来源集合；
- 构造有界搜索预览，并把已核对候选展开为 Pi 权威 entry；

本模块直接实现 OpenViking `0.4.13` 的资源与检索协议。

## 3. 外部表示与算法边界

每个来源使用：

```text
<namespace>/<sha256(session-id)>/<sha256(entry-id)前32位>/source.md
```

entry 子树彼此独立；文件固定为 `source.md`。上传必须使用 `processing_mode=vectors_only` 和 `args.parse_mode=no_split`。OpenViking负责 embedding、向量索引和分数排序；模块不实现相似度、reranking、分块或摘要模型。

来源投影最多 64,000 字符，超限时保留首尾。搜索预览最多 1,200 字符；单次后端候选最多 100，最终命中最多 10；来源展开由调用参数限制在 1,000–20,000 字符。

## 4. 关键不变量

1. OpenViking只产生候选，不决定来源是否有效；
2. OpenViking查询目标必须是当前 branch 已确认来源的精确 URI 列表；
3. 候选 leaf URI 必须与当前路线重新计算的 URI 完全匹配；
4. 最终内容必须来自当前 Pi 权威 entry，不采用 OpenViking abstract 作为事实；
5. 后端错误、索引准备中和正常空结果不能互相伪装；
6. 已存在 URI 的内容与同一 Pi entry 不一致时拒绝覆盖；
7. 模块不修改模型上下文、Pi session、工具结果或 Provider payload。

## 5. 并发、失败与恢复

同一 URI、相同内容的并发同步共享一次进行中的请求；同 URI 的不同内容立即拒绝。每次实际同步都重新读取 URI 内容，资源缺失时从当前已核对来源副本重建；多个实例竞争创建时，冲突方在同一调用期限内等待已提交内容并精确核对。请求使用调用信号和固定超时；响应必须小于等于 10 MiB、状态成功、JSON envelope 有效、资源处理为纯向量，且精确 URI 读回内容一致。

同步失败不删除来源，也不向调用者伪装成功。Session 记忆协调合并普通生命周期中的重复后台任务，并为每次显式搜索提供调用后完整同步屏障；本模块只执行该屏障委托的 OpenViking IO，确认缺失资源已补齐后才请求候选。失败或未就绪不能降级为空结果，后续路线同步或显式搜索可重试。扩展使用 Node HTTP/HTTPS 直连 OpenViking，避免 Pi 专用代理错误转发本地回环请求；只有回环地址允许明文 HTTP，远程地址必须使用 HTTPS。

## 6. 当前范围与后续责任

当前索引覆盖 Pi 路线中的有界任务文本，旧 branch 资源作为可重建来源保留，查询目标只包含当前 branch URI。Session Working Memory 与模型上下文由长时记忆、工作上下文优化和 Pi 集成模块承担；本模块不参与自动上下文队列或采用状态。
