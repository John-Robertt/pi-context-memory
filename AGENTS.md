# Agent Guide

## 先理解方向

开始工作时，按问题深度找到对应的权威来源：

- [`PRODUCT.md`](PRODUCT.md)：理解用户价值、产品边界和结果优先级；
- [`ARCHITECTURE.md`](ARCHITECTURE.md)：理解系统路线、模块责任和依赖方向；
- [`DOCUMENTION.md`](DOCUMENTION.md)：判断文档应建在哪里、承担什么责任以及何时更新或删除；
- [`docs/README.md`](docs/README.md)：进入当前已经存在的设计、验证、运行和开发文档；
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：确认当前状态、已有证据、交付边界和唯一的下一执行入口；
- `docs/modules/*.md`：进入具体模块后，理解其当前实现设计。

从当前任务和 `docs/DEVELOPMENT.md` 出发，按判断需要进入相应权威来源。`AGENTS.md` 提供导航入口。

## 安装与命令入口

所有命令都从仓库根目录执行。开发运行的 Node.js 门槛由 [`config/toolchain.json`](config/toolchain.json) 统一定义并由安装入口检查；当前可复现 evidence 的 Pi 坐标由 [`validation/suite.json`](validation/suite.json) 选择，宿主升级兼容由维护者重新验证。项目安装脚本依据锁文件统一管理私有依赖：

```bash
node scripts/install-dependencies.mjs
```

该脚本固定 uv bootstrap，读取项目的 Python 版本入口，并按 `uv.lock` 安装 OpenViking 与本地 embedding 的精确依赖闭包到项目内 `.tools/`、`.venv/` 与 `.cache/`。安装和运行细节以 [`docs/operations/session-recall.md`](docs/operations/session-recall.md) 为准。

正常使用时，在一个终端启动 OpenViking，在另一个终端启动 Pi：

```bash
node scripts/start-openviking.mjs
pi
```

验证先运行与改动范围最接近的免费入口，尽早发现本地错误，再按 [`docs/validation/README.md`](docs/validation/README.md) 完成对应核心节点的实际纵向验证：

```bash
node scripts/check-maintenance-sources.mjs
node scripts/check-validation-evidence.mjs
node scripts/validate-source-archive.mjs
node scripts/validate-source-recall.mjs
```

免费检查和协议替身只证明本地边界与受控故障，不能把关键功能标记为完成。记忆能力、Provider 采用、复杂长任务和成本结论必须分别使用真实受管 OpenViking、当前实际记忆 Provider/模型、当前实际任务 Provider/模型和真实账单。

只要验证沿用 suite manifest 中已经配置的任务与记忆 Provider/模型，付费调用属于正常验证流程，不需要再次向用户索要授权。只有需要改变任务 Provider、任务模型、记忆 Provider 或记忆模型时才停止并请求用户决定；认证、配额和服务错误不得通过未经授权的模型或 Provider 切换规避。

完整成本验证只在复杂长任务可靠性、质量可信、增强独占和故障恢复成立后执行。实验采用同一任务、模型、工具边界、checker 和重复次数的原生 Pi / 增强路径成对运行，完整归集两边 API 账单；两个 arm 均有效完成任务且增强路径账单更低时，成本优势成立。

## 用问题引导行动

调查、设计或实现时，持续追问：

1. 这项工作改善哪个实际长任务结果？
2. 它是否保持 Pi 的入口和控制权，并保证扩展启用期间只有增强请求可以发送？
3. 信息是否属于正确的 session、当前 branch，并能回到可信来源？
4. 当前判断来自运行证据，还是尚未验证的接口或算法推测？
5. 任务质量得到保持后，包含记忆生成、召回、重试和故障恢复在内的完整成本是否更好？
6. 哪些结构是当前交付真正需要的，哪些可以暂不引入或直接移除？

这些问题的答案应把工作收敛到一个最小、可运行、可证伪的纵向交付。

## 推进方式

从现状和基线开始观察，找到当前最限制目标的约束；在既定架构边界内完成能改变该约束的最小纵向交付。扩展启用期间保持增强请求独占；Pi 原生路径只作为禁用扩展并重新启动后的独立运行方式。随后运行代表性任务和相关检查，比较预期、实际结果、任务质量与完整成本。

如果结果偏离预期，回到最早缺少证据的判断继续调查，不用更多分支、抽象或后台机制掩盖未知。结果成立后，按 `DOCUMENTION.md` 更新受影响的功能、系统、模块、契约、验证或运行文档，以及 `docs/DEVELOPMENT.md` 的当前状态和下一入口，并删除被本次变化替代的内容。

产品价值、范围或架构路线需要改变时，把证据和取舍交给用户决定；模块内部的数据、接口、算法和验证方式，则在已有战略边界内自主完成。

## 完成时应留下什么

一次工作完成后，仓库应留下三样东西：可运行的目标结果、足以复核该结果的证据、与当前实现一致的最少文档和代码。没有当前使用者、责任或验证路径的内容不应因为“以后可能需要”而保留。
