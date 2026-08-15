# 召回与来源追溯模块

## 1. 当前责任

本模块是任务模型访问当前工作上下文之外来源的唯一入口。它把长时记忆中的任务文本同步为可重建的 OpenViking resource，调用 OpenViking完成向量候选排序，并只把 Session 记忆协调确认仍属于当前 branch 的候选展开给模型。

跨模块流程见 [`../system/source-recall.md`](../system/source-recall.md)，验证见 [`../validation/source-recall.md`](../validation/source-recall.md)。实现位于 [`.pi/extensions/pi-context-memory/recall-and-provenance.ts`](../../.pi/extensions/pi-context-memory/recall-and-provenance.ts)。

## 2. 拥有的数据与接口

模块拥有稳定 resource URI 派生、来源索引业务流程、并发同步合并和候选核验；共同 HTTP、envelope、期限和错误语义由 [`../contracts/openviking-adapter.md`](../contracts/openviking-adapter.md) 统一提供。OpenViking 不接收 Pi session file 或 branch 结构。

对 Pi 集成提供：

- 同步一组已归档来源；
- 在指定 session URI 范围内取得有限语义候选；
- 将候选 URI 映射到调用方提供的当前路线来源集合；
- 构造有界搜索预览，并把已核对候选展开为 Pi 权威 taskContent；同来源存在稳定 `fullOutputRef` 时附加经大小与哈希复核的有界完整输出；

本模块消费 OpenViking 适配契约提供的资源与检索能力，不直接拥有版本兼容规则。

## 3. 外部表示与算法边界

每个来源使用：

```text
<namespace>/<sha256(session-id)>/<sha256(entry-id)前32位>/source.md
```

entry 子树彼此独立；文件固定为 `source.md`。上传必须使用 `processing_mode=vectors_only` 和 `args.parse_mode=no_split`。OpenViking负责 embedding、向量索引和分数排序；模块不实现相似度、reranking、分块或摘要模型。

来源投影、搜索预览、后端候选、最终命中和展开范围均有界；当前数值只由实现中的 `RECALL_LIMITS` 拥有，工具 schema 直接复用同一契约。超限来源按固定首尾规则截断，不由正文语义决定。

## 4. 关键不变量

1. OpenViking只产生候选，不决定来源是否有效；
2. OpenViking查询目标必须是当前 branch 已确认来源的精确 URI 列表；
3. 候选 leaf URI 必须与当前路线重新计算的 URI 完全匹配；
4. 最终事实内容来自当前 Pi 权威 message entry 重新投影的 taskContent；完整工具输出只来自同 entry 已核验的 `fullOutputRef`，不采用 OpenViking abstract；
5. compaction、branch summary 文本及其 `fromId` 废弃 branch 不建立事实索引；
6. 后端错误、索引准备中和正常空结果不能互相伪装；
7. 已存在 URI 的内容与同一 Pi entry 不一致时拒绝覆盖；
8. 模块不修改模型上下文、Pi session、工具结果或 Provider payload。

## 5. 并发、失败与恢复

同一 URI、相同内容的并发同步共享一次进行中的请求；同 URI 的不同内容立即拒绝。每次同步重新读取 URI 内容，资源缺失时从当前已核对来源副本重建；多个实例竞争创建时，冲突方在同一调用期限内等待已提交内容并精确核对。成功由 OpenViking 接受写入和预期 URI 内容精确读回共同证明；处理统计不参与生产判断。

同步失败向调用者返回稳定错误，并由 Session 记忆协调根据错误责任锁存必要数据面故障。每次显式搜索具有调用后完整同步屏障；确认缺失资源补齐后才请求候选。失败、未就绪和正常空结果保持独立语义。扩展使用 Node HTTP/HTTPS 直连 OpenViking；只有 loopback 地址允许明文 HTTP，远程地址必须使用 HTTPS。

## 6. 当前范围与协作责任

索引覆盖 Pi 当前路线中的有界任务文本，离开 branch 的资源可以作为可重建来源保留，但查询目标只包含当前 branch URI。Session Working Memory 和工作上下文由长时记忆、工作上下文优化和 Pi 集成承担；本模块不构造自动上下文，也不决定请求采用。召回数据面错误通过 Session 记忆协调进入统一故障与请求阻断状态。
