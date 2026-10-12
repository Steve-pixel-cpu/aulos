# Aulos

**中文** | [English](README_EN.md)

一个 Claude Code 风格的 AI 编程 Agent，完整开源：终端 REPL + 桌面端双入口，
内置工具循环、三层上下文压缩、MCP 接入、三级权限体系、多 Agent 编排、
Agent 级评测框架与会话持久化。

> Python 3.14 + FastAPI + Tauri 2，兼容任意 Anthropic / OpenAI API 格式的
> 模型服务（接口地址、Key、模型均可自定义）。
>
> 本项目基于 [MiniCC](https://github.com/Louisym/MiniCC) 开发并扩展而来，
> 详见[致谢](#项目来源与致谢)。

## 功能特性

**Agent 内核**

- 工具循环：模型自主调用工具 → 执行 → 回传，SSE/WS 流式、thinking 块、
  token 与迭代预算、超预算软收束
- Headless 模式：`main.py -p "任务" --output-format json`，评测与脚本化调用底座
- 多 Agent 编排：Leader 派生 subagent 并行干活，白名单防递归、孤儿对账

**上下文工程**

- 三层压缩：MicroCompact（零 LLM 占位符化）→ Session Memory（后台滚动摘要）
  → Full Compact（side-call 结构化摘要，规则兜底）
- 主上下文瘦身：工具输出行预算落盘、同文件重读去重、贴图降采样、
  宽调研引导派 subagent；重复只读调用第 3 次拒绝（反自旋护栏）
- Prompt cache 友好：稳定前缀与动态尾段分离

**工具与生态**

- 内置 `bash`/`powershell`/`read_file`/`write_file`/`edit_file`/`grep`/`glob`/
  后台任务/`todo`/`web_search`/`web_fetch` 等；Playwright 浏览器实测工具组
- MCP 客户端：`stdio`/`http`/`sse` 三种 transport，工具以
  `mcp__<server>__<tool>` 注册，详见 [MCP 配置](#mcp-配置)
- Skills 技能包：Claude Code 兼容 `SKILL.md`，渐进式披露不撑上下文
- 跨会话记忆：对话中让模型记或 `/memory add`，容量触发智能淘汰

**可靠性与观测**

- 三级权限体系 `plan` → `workspace-write` → `danger-full-access`，越权触发
  审批；敏感路径（`.git/`、`~/.ssh/` 等）**任何模式强制人工裁决**
- 限流指数退避重试、max_tokens 截断自愈、每轮调用耗时/用量落盘
- 会话持久化：JSONL 原子增量落盘、断点恢复（`-c`/`--resume`）、并发隔离

**界面**

- CLI REPL（斜杠命令、语法高亮、流式渲染）与 Tauri 2 桌面端（设置页、
  多供应商切换、计划卡）；内置摸鱼电台（网易云/B站）与桌宠悬浮窗

## 架构总览

```
CLI (main.py) ──┐
                ├─► aulos/server.py (FastAPI 门面) ─► aulos/web/ 包（server_common
桌面壳 (src-tauri) ─► WebSocket/REST                基座 + music/bilibili/pets/
                │                             stats/settings/policy REST 域）
                │     aulos/radio/ 包（网易云/B站曲库）
                ▼
        aulos/runtime.py Agent 工具循环 ─► aulos/api_client / tools /
        permissions / compact / multi_agent / skills / memory /
        mcp_client / config / storage ……  数据目录: ~/.aulos/
```

全部 Python 实现收在 **`aulos/`** 包内；根目录只留 `main.py` / `server.py`
两个启动 shim（evals、Tauri/Electron 壳与打包脚本硬编码这两个路径，勿删）。

| 位置 | 职责 |
|---|---|
| `main.py` / `server.py`（根） | 启动 shim：分别跳入 `aulos.main` / `aulos.server` |
| `aulos/main.py` / `aulos/server.py` | CLI 入口 / Web 后端门面（re-export 各域共享名） |
| `aulos/runtime.py` | Agent 主循环：事件流、并行工具执行、打断、预算、护栏 |
| `aulos/api_client.py` `tools.py` `permissions.py` `compact.py` 等 | 流式客户端+重试 / 内置工具 / 权限审批 / 三层压缩（内核模块） |
| `aulos/web/` | 后端功能域包：`server_common` 基座 + 电台/桌宠/遥测/设置/策略 REST |
| `aulos/radio/` | 摸鱼电台曲库：网易云音乐与 B 站抓取解析 |
| `aulos/memory/` `skills.py` `mcp_client.py` `multi_agent.py` | 跨会话记忆 / 技能包 / MCP 接入 / 多 Agent 编排 |
| `aulos/config.py` `storage.py` | 三级配置发现合并 / 会话 JSONL 存储 |
| `static/` `src-tauri/` | Web 前端（原生 JS 多文件域拆分）/ Tauri 2 桌面壳（Electron 壳已弃用） |

## 快速开始

### 环境要求

- **Python ≥ 3.14**，推荐 [uv](https://docs.astral.sh/uv/)
- **Git for Windows**（Windows 必装）——命令执行器依赖 Git Bash（MSYS2
  对 UTF-8 字节直通，PowerShell 按 GBK 转码会乱码），未检测到拒绝启动
- 打包桌面端另需 Rust 工具链（cargo）与 Node.js

### 安装与配置

```bash
uv sync
```

CLI 读项目根 `.env`：`API_KEY=sk-xxx`。Web 端不读 `.env`：首启进入初始化页，
在界面填 API Key/接口/模型，存 `~/.aulos/settings.json`，支持多供应商切换。

### 启动

```bash
uv run python main.py                    # CLI 新会话（-c 继续 / --resume <id> / --list）
uv run python main.py -p "任务" --output-format json   # headless 单命令
uv run python server.py                  # Web 后端, 默认 http://127.0.0.1:8000
```

CLI 斜杠命令：`/help` `/status` `/compact` `/mode` `/thinking` `/rename`
`/skills` `/memory` `/exit`。Web 端与 CLI 共享会话记录与工具集；要图形界面
（标题栏/计划卡/电台/桌宠）用桌面端打包产物。

## MCP 配置

在任意配置层级的 JSON 里加 `mcpServers`：

```json
{
  "mcpServers": {
    "filesystem": { "type": "stdio", "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/tmp"] },
    "remote-tools": { "type": "http", "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }, "timeout": 30 }
  }
}
```

- `type` 支持 `stdio`（本地子进程，可带 `args`/`env`/`cwd`）/ `http` / `sse`
- 工具名 `mcp__<server>__<tool>` 与内置永不冲突；单机连接失败只告警不挡启动
- 权限/钩子/输出截断复用内置管线；未登记权限的外部工具走保守审批
- 桌面端设置页可可视化管理

## Agent 评测（evals/）

用真实 `main.py -p` 跑任务夹具，确定性断言 + LLM 判分，产出可对比回归基线：

```bash
uv run python evals/run_evals.py                    # 全量, 有基线自动对比
uv run python evals/run_evals.py --only fix-failing-test --save-baseline
```

- 内置任务：count-functions / fix-failing-test / implement-function /
  rename-across-files / review-buggy-code / delegate-subagent
- 加任务：`evals/tasks/<名字>/` 放 `task.txt` + `project/`（夹具）+ 可选
  `checks.py` / `judge.txt`；跑真任务烧 token，先 `--only` 挑小的
- CI：nightly 全量 + 桩 Agent 冒烟（`.github/workflows/evals.yml`）

## 配置与权限

配置按优先级从低到高深度合并：`~/.aulos/settings.json`（用户全局）→
`<项目>/.claude/settings.json`（项目级）→ `.claude/settings.local.json`（本地）。
key 与 Claude Code 兼容：`model` / `thinkingLevel` / `permissionMode` / `timeout` /
`maxIterations` / `tokenBudget` / `turnTokenBudget` / `contextWindow` /
`mcpServers` / `hooks`；环境变量覆盖 `CLAUDE_MODEL` 等同名项。
第三方中转砍窗口务必调小 `contextWindow`（默认按 1M 窗口 75% 推导压缩阈值）。

| 权限模式 | 说明 |
|---|---|
| `plan` | 只读：读文件/搜索放行，写操作硬拒（引导切模式或批准计划） |
| `workspace-write` | 工作目录内可写、可派生 subagent；执行命令仍需审批 |
| `danger-full-access` | 全放行（含任意命令） |

越权触发审批（CLI y/N 面板 / Web 审批卡）；敏感路径写入删除在任何模式
（含全放行）都强制人工确认——防不可逆破坏与模型自改权限配置。

调用遥测：每次模型调用落盘 `~/.aulos/logs/runtime-YYYYMMDD.log`，
浏览器开 `/stats.html` 看面板（哪轮慢、token 花在哪、缓存命中率）。

## 桌面端打包与发版

```cmd
build-exe.cmd          :: Windows 一键: PyInstaller 冻结后端 → cargo tauri build
```

macOS/Linux 用 `build-mac.sh` / `scripts/build-linux-tauri.sh`。发版：
`git tag v5.1.6 && git push origin v5.1.6`，三平台产物由 GitHub Actions
自动构建发布（Windows `.exe` / macOS `.dmg` / Linux `.AppImage`，均带自动更新）。
细节见 [PACKAGING.md](PACKAGING.md) 与 [docs/desktop-release-notes.md](docs/desktop-release-notes.md)
（Linux 依赖、Wayland/VMware 排障、签名密钥）。

## 测试

```bash
uv run pytest          # 1070 用例；CI: .github/workflows/ci.yml
```

覆盖 runtime 工具循环、权限与敏感路径、多 Agent、三层压缩、MCP、记忆、
Skills、评测 harness、重试、原子落盘、并发会话、上下文瘦身等。
前端回归：`npm run test:web`（jsdom）+ `tests/web/e2e.py`（Playwright）。

## 深入阅读

- [guides/](guides/)：13 篇按模块拆解的实现笔记（读源码伴侣）
- [docs/refactoring-roadmap.md](docs/refactoring-roadmap.md)：模块拆分路线（后端/前端）
- [docs/naming-history.md](docs/naming-history.md)：命名双轨约定与改名史
- [docs/optimization-backlog.md](docs/optimization-backlog.md)：对照 Claude Code 的优化清单

## 项目来源与致谢

本项目基于 [Louisym/MiniCC](https://github.com/Louisym/MiniCC) 开发，在其
Agent 架构基础上扩展了 MCP 接入、三层压缩、上下文瘦身、评测框架、三级
权限、多 Agent 编排、Skills、跨会话记忆、桌面端与摸鱼电台等。感谢原作者
的工作；欢迎参考、交流与 PR。

## 免责声明

本项目用于学习 Agent 架构设计，`danger-full-access` 模式下模型可执行任意
命令，请注意在可信环境下使用。

## License

[MIT](LICENSE)
