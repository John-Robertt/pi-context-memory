# 验证文档

## 1. 目录角色

本目录保存当前可执行的验证设计与证据入口，说明产品结果、架构边界、模块设计和契约的证明方法。验证类别和生命周期服从 [`DOCUMENTION.md`](../../DOCUMENTION.md)。

## 2. 当前验证

| 验证规格 | 当前责任 | 证据入口 |
| --- | --- | --- |
| [`source-archive.md`](source-archive.md) | 日常验证来源归档的 session 隔离、branch 约束、来源恢复和完整结果 | [`../../validation/evidence/source-archive.json`](../../validation/evidence/source-archive.json) |
| [`source-recall.md`](source-recall.md) | 日常验证 OpenViking 来源索引、显式召回边界和权威展开 | [`../../validation/evidence/source-recall.json`](../../validation/evidence/source-recall.json) |

两个 runner 使用本地资源。`scripts/validation-evidence.mjs` 集中维护实现输入与必需 check 集；runner 在执行前后核对输入哈希，并在完整通过后更新稳定 evidence。

```bash
node scripts/validate-source-archive.mjs
node scripts/validate-source-recall.mjs
node scripts/check-validation-evidence.mjs
```

checker 核对 evidence schema、精确 check 集、通过状态、文件集合和当前实现哈希。

## 3. 完整成本验证

完整成本实验随自动上下文优化的可运行纵向交付一起建立。实验必须固定并共享以下条件：

- 同一代表性长任务 fixture 与最终结果 checker；
- 同一 Provider、模型、thinking、工具边界和重复次数；
- 原生 Pi arm 与 `pi-context-memory` 增强 arm 的受控执行顺序及缓存状态；
- 两个 arm 触发的全部任务模型、记忆生成、召回、重试和降级 API 请求账单；
- 每个 Provider generation 与 Pi message 的唯一对应关系。

成本优势的通过条件为：两个 arm 都有效完成任务，增强 arm 的完整 API 账单低于原生 Pi arm。账单金额用于成对比较。

该实验在上下文、召回、压缩或记忆策略形成可运行纵向交付时执行，并用结果校准实现方向。

## 4. 维护规则

- 日常验证证明当前实现正确性；
- 原始运行产物写入 Git 忽略的 `.artifacts/`；
- 稳定 evidence 保存脱敏检查、实现输入和结果摘要；
- 每项验证规格都具有当前责任、执行入口和维护路径；
- 新成本验证替换本节的待交付定义，并与自动上下文优化在同一纵向交付中完成。
