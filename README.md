# aulos

**中文** | [English](README_EN.md)

一个 Claude Code 风格的 AI 编程 Agent，从零实现的完整开源项目：终端 REPL + 桌面端双入口，
内置工具循环、上下文工程（三层压缩 + 主上下文瘦身）、MCP 接入、三级权限体系、多 Agent
编排、Agent 级评测框架与会话持久化。

> Python 3.14 + FastAPI + Tauri 2，兼容任意 Anthropic / OpenAI API 格式的模型服务
>（接口地址、Key、模型均可自定义）。
>
> 本项目基于 [MiniCC](https://github.com/Louisym/MiniCC) 开发，在其 Agent 架构基础上
> 扩展而来，详见[致谢](#项目来源与致谢)。

## 功能特性

### Agent 内核

- **工具循环**：模型自主决定调用工具 → 执行 → 回传结果，循环往复直到完成；SSE/WS 流式
  输出、thinking 块、循环层 token 与迭代预算、超预算软收束（收束原因写入历史，
  下一轮模型接着干而不是从头查）
- **Headless 模式**：`main.py -p "任务" --output-format json` 单命令执行，结构化输出
  退出码 / 结果 / usage——评测框架与脚本化调用的底座
- **多 Agent 编排**：Leader 通过 `agent_tool` / `agent_status` / `agent_reap` /
  `agent_list` 派生 subagent 并行干活，白名单防递归、孤儿 agent 启动对账

### 上下文工程

- **三层压缩体系**：MicroCompact（估算超阈值时把保留窗外的高产出可复现工具结果
  替换为占位符，零 LLM 调用）→ Session Memory（后台代理空闲时增量维护滚动摘要，
  压缩激活时直接采用，零现场调用）→ Full Compact（超压缩阈值时 side-call 生成
  结构化摘要，规则摘要兜底，一次大调用）
- **主上下文瘦身四件套**（治"进上下文的东西太多"）：
  - `read_file` / `grep` 行预算：超限全文落盘 `~/.aulos/tool-outputs/`，会话只留
    首部 + 落盘标记，需要时可读回
  - 同文件重读去重：未变文件的整读回一行 `unchanged`；写入推进变异序号、外部修改、
    `force=true` 均回全文
  - 贴图降采样：单边超限或体积超限的截图等比压缩，原图落盘，会话只带缩后版
  - subagent 委派引导：宽泛调研类任务在系统提示层引导派生 subagent，避免主上下文堆积
- **重复只读护栏**：同一只读调用（read_file/grep/glob，路径规范化记账）第 2 次警告、
  第 3 次拒绝——治理模型反自旋；另有回合级结论检查点提醒对靶
- **Prompt cache 友好**：系统提示词设动态边界，稳定前缀（OS 信息/CLAUDE.md/技能清单）
  与动态尾段分离，命中缓存

### 工具与生态

- **内置工具集**：`bash` / `powershell`（Windows 走 Git Bash，UTF-8 无乱码）、
  `read_file` / `write_file` / `edit_file`（read-before-write + stale 检查）、
  `grep` / `glob`（纯 Python，免 shell）、后台任务 `task_output` / `task_stop`、
  任务清单 `todo`、计划卡 `present_plan`、网页抓取 `web_fetch` / `web_search`
- **浏览器实测**：`browser_navigate` / `browser_snapshot` / `browser_click` /
  `browser_type` / `browser_console` 等（Playwright 无头 Chromium），可实际操作
  Web 系统做功能验证
- **MCP 客户端**：接入外部 MCP 服务器（`stdio` / `http` / `sse` 三种 transport），
  工具以 `mcp__<server>__<tool>` 命名进注册表；官方 SDK 是 asyncio 的而工具循环是
  同步线程模型，每台服务器一个 daemon 线程独占 event loop 桥接；连接失败仅告警不挡
  启动；未登记权限的外部工具走保守审批默认。详见 [MCP 配置](#mcp-配置)
- **Skills 技能包**：Claude Code 兼容的 `SKILL.md` 技能（YAML frontmatter + 正文指令 +
  任意辅助文件），用户级 / 项目级两级作用域；渐进式披露——系统提示只进 name +
  description 清单，正文按需 `skill_read`，十个技能不撑爆上下文
- **跨会话记忆**：对话中让模型记、或 `/memory add` 手动添加；结构化 JSON 存储，
  容量触发淘汰（hits 主导 + 新近度加权，`source:user` 永不自动淘汰，淘汰条目归档）

### 可靠性与观测

- **三级权限体系**：`plan`（只读）→ `workspace-write`（工作目录内可写）→
  `danger-full-access`（全放行）；越权触发审批（CLI y/N 面板 / Web 审批卡）。
  敏感路径（`.git/`、`~/.aulos/`、`~/.ssh/`、shell 配置文件）**任何模式含全放行
  都强制人工裁决**——防"rm -rf .git"类不可逆破坏与模型自逃脱
- **限流重试**：连接抖动指数退避 + 429 专用长退避曲线，重试进度实时上报界面
- **max_tokens 截断自愈**：截断后注入恢复提示继续循环
- **长回合延迟治理**：回合内思考自动降档（只改请求参数不改用户设置）、迭代软收束
  提醒、每轮调用耗时/用量一行 JSON 落盘 `~/.aulos/logs/`（"哪轮慢、慢在哪"直接看日志）
- **会话持久化**：JSONL 增量落盘（原子写）、断点恢复（`-c` / `--resume`）、自动命名、
  并发会话隔离

### 界面

- **CLI REPL**：斜杠命令、语法高亮、流式渲染
- **桌面端**（Tauri 2 为主壳，Electron 备选壳）：自定义标题栏、计划卡、设置页、
  多供应商随时切换、气泡/文档流两种回复风格
- **摸鱼电台**：内置在线电台（网易云音乐 + B 站视频转音频，榜单 + 流式播放 + 歌词）
- **桌宠**：独立悬浮窗，可与后台会话交互

## 架构总览

```
┌─────────────┐   ┌──────────────────────────────────┐
│  CLI (main) │   │  桌面端: Tauri 2 壳 + WebView    │
└──────┬──────┘   │  (Electron 备选壳) static/ 前端  │
       │          └──────────────┬───────────────────┘
       │            WebSocket/REST (token 门禁)
       │          ┌──────────────┴───────────────────┐
       └──────────►   server.py (FastAPI 后端)        │
                  └──────────────┬───────────────────┘
                                 │
        ┌────────────────────────┴───────────────────────┐
        │ runtime.py  Agent 工具循环（线程池并行工具执行） │
        ├────────────────────────────────────────────────┤
        │ api_client  流式客户端+重试    tools  工具集    │
        │ mcp_client  MCP 接入           skills 技能包    │
        │ permissions 权限/审批          hooks  生命周期  │
        │ multi_agent 多Agent编排        compact 压缩     │
        │ memory      跨会话记忆         call_log 调用日志│
        │ config      分层配置           storage  会话库  │
        └────────────────────────────────────────────────┘
                    数据目录: ~/.aulos/
```

| 模块 | 职责 |
|---|---|
| `main.py` | CLI 入口：REPL、斜杠命令、headless、工具 spec、装配（CLI 与 Web 共用） |
| `server.py` | FastAPI 后端：WebSocket 推流、权限审批桥、会话/设置/MCP/记忆 REST API |
| `runtime.py` | Agent 主循环：事件流、并行工具执行、打断、预算、护栏与检查点 |
| `api_client.py` | Anthropic / OpenAI 流式客户端、思考档位、退避重试 |
| `tools.py` | 内置工具实现与注册表（后台任务、行预算落盘、取消检查点） |
| `mcp_client.py` | MCP 客户端：三种 transport、同步-异步桥接、工具名前缀注册 |
| `skills.py` | SKILL.md 发现与渐进式披露注入 |
| `memory/` | 跨会话记忆：存储、淘汰、注入渲染、工具接线 |
| `permissions.py` | 权限模式层级、策略、敏感路径强制裁决、CLI/Web 审批器 |
| `multi_agent.py` / `agent_tools.py` | 多 Agent 编排内核 / 工具接线层 |
| `compact.py` | 三层压缩：MicroCompact、Session Memory、LLM 摘要与续接 |
| `config.py` | 三级配置发现合并、MCP/供应商配置读写 |
| `storage.py` / `fsatomic.py` | 会话存储（JSONL）/ Windows 原子文件写 |
| `call_log.py` | 每轮模型调用耗时/用量日志 |
| `hooks.py` / `retry.py` / `prompt.py` | Pre/PostToolUse 钩子 / 退避曲线 / 系统提示词构建 |
| `static/` | Web 前端（无框架，原生 JS） |
| `src-tauri/` / `electron/` | 桌面壳：拉起后端、令牌门禁、单实例、看门狗 |

## 快速开始

### 环境要求

- **Python ≥ 3.14**，推荐 [uv](https://docs.astral.sh/uv/)
- **Git for Windows**（Windows 必装）——命令执行器依赖 Git Bash（MSYS2 coreutils
  对 UTF-8 字节直通，PowerShell 会按 GBK 转码导致乱码），未检测到时拒绝启动
- 打包桌面端另需 Rust 工具链（cargo）与 Node.js

### 安装

```bash
uv sync
```

### 配置模型服务

在项目根目录新建 `.env` 填写（CLI 读取）：

```ini
API_KEY=sk-xxx        # CLI 用的 key
```

Web 端不读 `.env`：首次启动进入初始化页，在界面里填写 API Key、接口地址与模型，
配置保存到 `~/.aulos/settings.json`，支持添加多个供应商随时切换。

### 启动 CLI

```bash
uv run python main.py            # 新会话
uv run python main.py -c         # 继续最近一次会话
uv run python main.py --resume <id>   # 恢复指定会话
uv run python main.py --list     # 列出全部会话
```

CLI 斜杠命令：`/help` `/status` `/compact` `/mode` `/thinking` `/rename` `/skills`
`/memory` `/exit`

### Headless / 脚本调用

```bash
uv run python main.py -p "统计 src 下函数总数写入 count.txt" --output-format json
```

`--output-format json` 输出结构化结果（退出码、最终回复、usage），`--model` 与
`--permission-mode` 可临时覆盖配置。评测框架即构建在此入口之上。

### 启动 Web 端

```bash
uv run python server.py          # 默认 127.0.0.1:8000
uv run python server.py --port 8020
```

浏览器打开后即与 CLI 共享同一份会话记录与工具集；带图形界面（自定义标题栏、
计划卡、设置页、摸鱼电台、桌宠）建议用桌面端。

## MCP 配置

在任意配置层级（见[配置说明](#配置说明)）的 JSON 里加 `mcpServers`：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/tmp"]
    },
    "remote-tools": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" },
      "timeout": 30
    }
  }
}
```

- `type` 支持 `stdio`（本地子进程）/ `http` / `sse`；`stdio` 可带 `args`、`env`、`cwd`
- 工具以 `mcp__<server>__<tool>` 命名注册，与内置工具永不冲突
- 单台服务器连接失败只标记 failed + 告警，不阻塞启动，其余服务器正常工作
- MCP 工具的权限、钩子、输出截断复用内置管线；未在权限表登记的工具按"任意命令"档
  审批（能力未知的外部工具，保守默认）
- 桌面端设置页可视化管理 MCP 服务器

## Agent 评测（evals/）

Agent 级评测框架：用真实的 `main.py -p` 跑任务夹具，确定性断言 + LLM 判分打分，
产出可对比的回归基线。改 prompt、调压缩参数、上新功能之后跑一遍，就知道整体是
变好还是变坏。

```bash
uv run python evals/run_evals.py                        # 全量, 有基线则自动对比
uv run python evals/run_evals.py --only fix-failing-test  # 只跑指定任务
uv run python evals/run_evals.py --save-baseline        # 本次结果存为基线
uv run python evals/run_evals.py --list                 # 只列任务不跑
```

- 内置任务：`count-functions` / `fix-failing-test` / `implement-function` /
  `rename-across-files` / `review-buggy-code` / `delegate-subagent`
- 退出码全过 0 / 有失败 1，可直接当 CI 门槛；基线 `evals/baseline.json` 随仓库走
- 被测 Agent 是 subprocess（走真实入口），评测不 import 被测代码——测的是用户实际
  拿到的东西；`--agent-cmd` 可换桩 Agent，框架自测不烧 token
- 加任务：`evals/tasks/<名字>/` 下放 `task.txt`（任务文本）+ `project/`（夹具项目，
  每次复制到全新临时工作区）+ 可选 `checks.py`（确定性断言）与 `judge.txt`（LLM 判分标准）
- 跑真任务要花钱（每任务一次完整 Agent 会话），`--only` 挑任务、先小后大

## 配置说明

配置按优先级从低到高深度合并：

| 位置 | 作用域 |
|---|---|
| `~/.aulos/settings.json`（及 `.claude.json`） | 用户全局 |
| `<项目>/.claude/settings.json`（及 `.claude.json`） | 项目级 |
| `<项目>/.claude/settings.local.json` | 本地个人 |

可配置项（key 与 Claude Code 兼容）：

```json
{
  "model": "glm-5.3-flash",
  "thinkingLevel": "high",
  "permissionMode": "workspace-write",
  "timeout": 30,
  "maxIterations": 128,
  "tokenBudget": 100000,
  "turnTokenBudget": 65536,
  "contextWindow": 1000000,
  "mcpServers": {},
  "hooks": {
    "PreToolUse": ["python check.py"],
    "PostToolUse": []
  }
}
```

- `contextWindow` 影响 auto-compact 阈值（默认按 1M 窗口的 75% 推导）；第三方中转
  若砍窗口务必调小
- 环境变量覆盖：`CLAUDE_MODEL`、`CLAUDE_TIMEOUT`、`CLAUDE_MAX_ITERATIONS`、
  `CLAUDE_TOKEN_BUDGET`、`CLAUDE_TURN_TOKEN_BUDGET`、`CLAUDE_THINKING_LEVEL`、
  `CLAUDE_CONTEXT_WINDOW`

## 权限模式

| 模式 | 说明 |
|---|---|
| `plan` | 计划模式：读文件/搜索类工具放行，写操作硬拒（附提示引导切模式或一键批准计划） |
| `workspace-write` | 工作目录内可写文件、可派生 subagent；执行命令仍需审批 |
| `danger-full-access` | 全放行（含任意命令执行） |

工具按"只读 / 本地写 / 任意命令"三档登记所需权限，越权即触发审批：
CLI 是黄色 y/N 面板（Ctrl+C 一律朝安全侧拒绝），Web 端是弹窗审批卡。

**敏感路径强制裁决**：写/删 `.git/`、`~/.aulos/`、`~/.ssh/`、shell 配置文件等
敏感路径时，无论当前权限模式（含 `danger-full-access`）都强制人工确认——命令
白名单不能短路，防止模型改掉自己的权限配置或不可逆破坏。

## 桌面端打包

一键打包（PyInstaller 冻结后端 → cargo tauri build）：

```cmd
build-exe.cmd
```

产物在 `dist\`（NSIS 安装包，Tauri 2 + WebView2）。细节见 [PACKAGING.md](PACKAGING.md)：
端口自动避让（8000 被占时退让 8010–8019）、父子进程看门狗、令牌门禁等。

`build-mac.sh` 与 `scripts/build-linux-tauri.sh` 提供 macOS / Linux 打包入口；
`electron/` 为备选桌面壳（Electron + electron-builder，跨平台 dmg/NSIS/portable）。

## 发版

三平台产物由 GitHub Actions 在打 tag 时自动构建并发布（`.github/workflows/release.yml`）：

```bash
git tag v4.2.0
git push origin v4.2.0
# 等 Release workflow 跑完（约 15-25 分钟）, 产物自动挂到 GitHub Release
```

| 平台 | 产物 | 自动更新 |
|---|---|---|
| Windows | `aulos_<ver>_x64-setup.exe` | ✅（NSIS + 更新签名） |
| macOS (Apple Silicon) | `aulos_<ver>_aarch64.dmg` + `.app.tar.gz` | ✅（更新包带 minisign 签名） |
| Linux | `aulos_<ver>_amd64.AppImage` | ✅ |

- `latest.json` 含三平台更新条目, 已装用户通过自动更新收到新版本
- 手动触发（Actions 页 Run workflow）：只构建并传 artifact, 不发 Release
- 签名密钥走仓库 Secrets（`TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`）；
  缺失时构建成功但无 `.sig`, 不能作为自动更新目标
- macOS 未做 Apple 公证：首次打开需右键 → 打开, 或 `xattr -cr /Applications/aulos.app`
- Linux 运行时依赖（缺 GStreamer 插件时窗口/工具正常, 但网页音频无声）:

  ```bash
  sudo apt install libwebkit2gtk-4.1-0 gstreamer1.0-plugins-base     gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav
  ```

  AppImage 下若仍无声, 先在系统终端确认 `gst-inspect-1.0 --version` 正常。
  AppImage 打包形态暂不含与捆绑库匹配的 GStreamer 插件, 电台在该形态下
  不可用——应用会在播放前探测管线, 不可用时自动停用 (只弹提示, 不会卡死)。
- Wayland 会话 (Ubuntu 22.04/24.04 默认): Wayland 协议不允许客户端置顶/编程
  挪窗, 桌宠会被其他窗口遮挡且拖不动。应用检测到 Wayland + XWayland 时自动设
  `GDK_BACKEND=x11` 走 XWayland 恢复该行为 (决策记录在 `~/.aulos/boot.log`)。
  想回原生 Wayland: 启动前 `export AULOS_GDK_BACKEND=wayland`, 代价是桌宠
  可能被遮挡、拖不动。
- VMware 等无 3D 加速环境: 应用自动设置 `WEBKIT_DISABLE_DMABUF_RENDERER=1`
  回退 WebKitGTK 的非加速渲染路径——否则窗口会停留在过期帧/空白 (页面
  实际正常)。已显式设置该变量的环境不受影响。

## 测试

```bash
uv run pytest
```

70+ 个测试文件（800+ 用例），CI 在 GitHub Actions 上跑（`ci.yml`）。覆盖：runtime
工具循环、权限模式与敏感路径、多 Agent、三层压缩（MicroCompact / Session Memory /
auto-compact）、MCP 客户端与配置、记忆、Skills、评测 harness（桩 Agent 端到端）、
限流重试、原子落盘、并发会话、后台任务、附件、上下文瘦身、延迟治理、Windows shell
选壳等。

## 深入阅读

[guides/](guides/) 下有 13 篇按模块拆解的实现笔记（models / tools / api_client /
config / permissions / hooks / retry / prompt / compact / storage / multi_agent /
runtime / main），适合按顺序阅读源码。[docs/optimization-backlog.md](docs/optimization-backlog.md)
记录了对照 Claude Code 参考设计逐项评估后的优化清单与落地状态。

## 项目来源与致谢

本项目基于 [Louisym/MiniCC](https://github.com/Louisym/MiniCC) 开发，在其 Agent
架构的基础上进行了多方向扩展与定制，例如 MCP 接入、三层压缩体系、上下文瘦身、
评测框架、三级权限体系、多 Agent 编排、Skills、跨会话记忆、桌面端多壳与摸鱼电台等。

感谢 MiniCC 原作者的工作；欢迎参考、交流与 PR。

## 免责声明

本项目用于学习 Agent 架构设计，`danger-full-access` 模式下模型可执行任意命令，
请注意在可信环境下使用。

## License

[MIT](LICENSE)
