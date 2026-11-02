# Aulos 技术分析

> 对 Aulos（本地 AI 编程 Agent）的工程技术分析：架构与核心设计、典型问题的排查与解决过程、关键设计决策的权衡。
> 所有结论均可在仓库中找到对应的代码/文档/测试证据。

## 项目一句话

**Aulos** 是一个本地运行的 AI 编程 Agent：用自然语言下达任务，Agent 自主读文件、改代码、跑命令、查资料直到完成，提供终端 CLI 和桌面应用两种形态。基于开源项目 MiniCC 扩展而来（行级对比约 92% 为重写/新增），不绑定官方 API，任何兼容 Anthropic / OpenAI 协议的模型服务均可接入。

## 关键指标

| 指标 | 数值 | 说明 |
|---|---|---|
| Python 内核规模 | ~38,000 行 | 全部核心实现位于 `aulos/` 包 |
| 测试用例 | 1,316 个 | pytest + xdist 并行，全量约 30 秒 |
| 前端测试 | 30+ 个 jsdom 测试 + Playwright E2E | 含流式/竞态专项 |
| Agent 级评测 | 6 类任务 + 基线回归 | 机械检查 + LLM 判分 |
| 版本迭代 | 32 个版本 tag | v1.2 → v5.6.0 |
| 安装包体积 | 133MB → 28MB | Electron → Tauri 2 迁移 |
| 发版自动化 | 三平台 CI 自动发布 | Windows exe / macOS dmg / Linux AppImage + 自动更新 |

## 文档导航

| 文件 | 内容 |
|---|---|
| [01-architecture-overview.md](01-architecture-overview.md) | 项目定位、技术栈、分层架构、目录职责、核心机制清单 |
| [02-core-designs.md](02-core-designs.md) | 8 个核心技术设计：问题域 → 解法 → 代码证据 |
| [03-troubleshooting-cases.md](03-troubleshooting-cases.md) | 10 个真实问题的排查与解决复盘 + 方法论总结 |
| [04-design-tradeoffs.md](04-design-tradeoffs.md) | 设计决策的权衡分析 + 迭代演进时间线 |

## 内容边界说明

本文档聚焦 Agent 内核、上下文工程、并发可靠性、质量保障、发布工程等工程内容。
产品中的娱乐向功能（如背景音乐、桌面陪伴组件）不在分析范围内。
