# 来源召回验证

## 1. 验证责任

本文定义 OpenViking 来源索引、向量召回、session/branch 边界、权威展开和恢复边界的证明方法。稳定结果保存于 [`../../validation/evidence/source-recall.json`](../../validation/evidence/source-recall.json)。

## 2. 固定环境

runner 自行启动 OpenViking `0.4.13`，使用动态回环端口、隔离 HOME、项目内工作目录和 [`../../validation/fixtures/openviking-source-recall.json`](../../validation/fixtures/openviking-source-recall.json)。配置固定本地 dense embedding，并关闭 VLM、memory extraction、intent、watch scheduler 和 agent evolution。

每个来源使用 `vectors_only`。代理记录资源写入、搜索、读取和删除请求，用于核对索引及恢复顺序。

## 3. 协调验证

确定性探针覆盖：

- 同一 session 的待执行后台路线折叠到最新路线，包括 A→B→A 往返；
- 显式同步优先处理，同路线调用共享正确 generation；
- 调用后完整轮次、等待超时、abort 和 shutdown；
- 同 URI 同内容并发收敛、异内容并发拒绝；
- 取消后停止来源遍历，同步异常传递给等待者。

## 4. 索引与召回验证

受控 OpenViking 场景覆盖：

- 稳定 session/entry URI、幂等资源写入，以及资源响应不含 `queue_status` 等诊断时仍以预期 URI 内容读回确认成功；
- 外部资源删除后的同实例重建；
- session 隔离与当前 branch 候选过滤；
- 旧 branch 来源和跨 session 来源排除；
- 长来源预览边界与 Pi 权威 entry 展开；
- 空来源、正常空结果、malformed 成功 envelope 和后端错误的独立语义；
- 本地地址与远程明文地址的安全边界；
- OpenViking 候选进入结果前的当前路线复核。

## 5. 执行入口

```bash
node scripts/validate-source-recall.mjs
node scripts/check-validation-evidence.mjs
```

runner 使用本地资源，并在输入哈希保持一致且全部 checks 通过后原子更新稳定 evidence。原始产物写入 `.artifacts/source-recall/`。

## 6. 结果边界

本验证证明来源协调、派生索引和显式召回的本地正确性。Working Memory 与自动上下文采用由 [`context-enhancement-state.md`](context-enhancement-state.md) 的本地 evidence 证明；真实任务质量和完整 API 成本继续遵循 [`README.md`](README.md) 的同任务成对设计。
