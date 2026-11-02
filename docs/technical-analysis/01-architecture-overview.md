# 01 · 架构总览

## 1. 项目定位

**Aulos** 是一个本地运行的 AI 编程 Agent：

- 用户用自然语言下达任务，Agent 自主读文件、改代码、跑命令、查资料，循环直到任务完成；
- 提供两种形态：终端 CLI（`main.py`）与桌面应用（Tauri 2 + Web UI）；
- 基于开源项目 MiniCC 扩展而来，行级对比约 **92% 为重写/新增**；
- 不绑定官方 API：任何兼容 Anthropic / OpenAI 协议的模型服务均可（接口地址、Key、模型可自定义）；
- 配置兼容 Claude Code 格式（用户 → 项目 `.claude/settings.json` → local 三级合并），老用户可无缝迁移。

## 2. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 内核语言 | Python ≥ 3.14 | 约 38k 行核心实现 |
| 后端门面 | FastAPI + uvicorn + pydantic | Web/桌面共用的 REST + WebSocket 服务 |
| 模型接入 | anthropic / openai 官方 SDK | 双协议适配，含重试与限流退避 |
| Agent 生态 | mcp（MCP 客户端）、playwright（真实浏览器工具）、trafilatura + websearch（抓取/搜索）、pillow（图像） | |
| 桌面壳 | **Tauri 2**（Rust + 系统 WebView2） | Electron 壳已弃用，保留为可选打包目标 |
| 后端分发 | PyInstaller | 把 `server.py` 冻结为独立 `aulos-server.exe`，由 Tauri 拉起 |
| 前端 | 原生 JavaScript（无框架） | 按功能域拆分文件，jsdom + Playwright 测试 |
| 测试 | pytest + timeout + xdist | 1,316 用例，全量并行约 30 秒 |
| 工具链 | uv / Node.js / cargo | 仅打包与前端测试需要 Node 和 cargo |

## 3. 分层架构图（文字版）

```
┌─ 终端入口 ────────────────────────────────────────────────┐
│ main.py (根, 4行shim) → aulos/main.py                     │
│   斜杠命令 / headless 模式 (-p "任务" --output-format json) │
└──────────────────────┬───────────────────────────────────┘
                       │
┌─ 桌面壳 ─────────────┴───────────────────────────────────┐
│ src-tauri/ (Rust, Tauri 2)                               │
│   拉起/复用后端 + WebView2 加载 UI + 自动更新              │
└──────────────────────┬───────────────────────────────────┘
                       │ WebSocket(流式事件) + REST(配置/会话) + 令牌门禁
┌─ Web 后端门面 ────────┴───────────────────────────────────┐
│ server.py (根 shim) → aulos/server.py (FastAPI)           │
│   线程模型: 事件循环线程 ↔ 工作线程, 三代理镜像内核事件     │
│   aulos/web/: 按功能域拆分的 REST 模块                     │
└──────────────────────┬───────────────────────────────────┘
                       │
┌─ Agent 内核 (aulos/ 包) ──────────────────────────────────┐
│ runtime.py    Agent 主循环: 一致点/预算/打断/并行工具       │
│ ├─ api_client.py   多协议客户端(Anthropic/OpenAI) + 重试   │
│ ├─ tools.py 等     bash/read/edit/grep/web/浏览器/后台任务 │
│ ├─ permissions.py  三级权限 + 敏感路径强制确认              │
│ ├─ compact.py      三层上下文压缩 + CJK token 估算          │
│ ├─ memory/         跨会话记忆 (store/inject/tools)          │
│ ├─ multi_agent.py  Leader→subagent 编排 (防套娃)            │
│ ├─ mcp_client.py   stdio/http/sse 三种 MCP 接入            │
│ ├─ skills.py       SKILL.md 技能包, 渐进式披露              │
│ ├─ fsatomic.py     Windows 原子写 (唯一临时名+退避重试)     │
│ └─ config/storage  三级配置合并 / 会话 JSONL 增量持久化     │
└───────────────────────────────────────────────────────────┘

前端:   static/    原生 JS 按功能域拆文件
官网:   website/   静态落地页
测试:   tests/     102 文件 1316 用例; tests/web/ 前端测试 + E2E
评测:   evals/     6 类真实 Agent 任务 + 基线回归
打包:   build-exe.cmd / build-mac.sh / scripts/ (PyInstaller + Tauri)
```

> 根目录的 `main.py` / `server.py` 是刻意保留的几行转发 shim：evals、打包脚本都按根路径拉起入口，不能删。

## 4. 目录职责表

| 目录 | 职责 |
|---|---|
| `aulos/` | Python 内核包：Agent 主循环、模型客户端、内置工具、权限、压缩、多 Agent、MCP、技能、记忆、REST 接口 |
| `src-tauri/` | Tauri 2 桌面壳：Rust 入口、打包配置（NSIS / updater / resources）、窗口能力权限 |
| `static/` | Web 前端（原生 JS）：主界面、设置页、WebSocket 处理、统计面板；也是 Tauri 的 frontendDist |
| `electron/` | 已弃用的 Electron 壳，仅保留作可选打包目标与迁移参照 |
| `evals/` | Agent 级评测框架：真实入口跑任务夹具 + 机械检查 + LLM 判分 + 基线回归 |
| `tests/` | pytest 套件（1316 用例），含 slow 集成测试与前端 E2E |
| `guides/` | 13 篇按模块拆解的实现笔记（模型→工具→权限→压缩→存储→多 Agent→主循环） |
| `scripts/` | 发版与调试脚本：三平台构建、latest.json 生成、版本号管理 |
| `tools/` | 一次性批处理脚本（i18n 批量应用/审计、图集处理） |
| `website/` | 纯静态宣传站 |
| 根目录 | 两个启动 shim（main.py / server.py）+ 构建脚本 + PACKAGING.md + AGENTS.md |

## 5. 核心机制清单

### Agent 核心机制
- **自主工具循环**：模型自选工具（读/改文件、跑命令、搜索），流式逐字输出，thinking 过程实时可见；token/迭代预算与超限收束。
- **Headless 免交互模式**：`main.py -p "任务" --output-format json` 单命令跑完，可脚本化——这也是评测框架的基础。
- **多 Agent 并行编排**：Leader 派生 subagent 并行干活，白名单防无限套娃，重启自动清理幽灵任务；`agent_wait` 阻塞等待让结果收集零模型回合（等待下沉到 Python 层，替代逐轮轮询）；支持执行层模型分层（子代理用便宜模型，省钱不牺牲决策质量）。
- **三层上下文压缩**：长对话不爆窗口（详见 [02-core-designs.md](02-core-designs.md) 第 3 节）。
- **上下文瘦身**：超长工具输出落盘按需取、重复读取去重、截图自动缩小、只读操作重复 3 次拒止防死循环。
- **跨会话记忆**：对话中让 Agent 记住事实，按使用频率 + 新近度自动淘汰。

### 集成与生态
- **MCP 客户端**：stdio / http / sse 三种接法，外部工具与内置工具同走权限/钩子/截断链路。
- **Skills 技能包**：兼容 Claude Code `SKILL.md` 格式，渐进式披露不占上下文。
- **Playwright 真实浏览器工具**：Agent 可实测网页功能，渠道自动回退 chromium→Chrome→Edge（Win10/11 必有 Edge，等效零额外下载）。

### 安全与可靠
- **三级权限体系**：plan（只读）→ workspace-write → danger-full-access，超权弹人工审批。
- **敏感路径强制确认**：`.git/`、`~/.ssh/` 等任何权限模式下都要求人工确认——防模型自我放权。
- **会话持久化**：JSONL 增量原子写（崩溃不损坏），支持续聊 / resume / list，多进程并发互不干扰。
- API 限流指数退避、截断自动续写、用量统计面板（耗时/token/缓存命中率）。

### 工程质量与发布
- **分层质量保障**：1316 单元测试 → 前端 jsdom + Playwright 双层回归 → 6 类真实 Agent 评测 + 基线 → CI 门槛。
- **一键跨平台发版**：打 tag 触发 GitHub Actions 自动构建三平台安装包 + Tauri updater 自动更新。
