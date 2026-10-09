# aulos

[中文文档](README.md) | **English**

> Language switch: the Chinese README is the canonical, most up-to-date version; this translation may lag slightly behind.

A Claude Code–style AI coding agent, built from scratch as a complete open-source
project: terminal REPL + desktop app, with an agentic tool loop, context
engineering (three-tier compaction + main-context slimming), MCP support,
a three-level permission system, multi-agent orchestration, an agent-level eval
harness, and session persistence.

> Python 3.14 + FastAPI + Tauri 2. Works with any model service exposing an
> Anthropic- or OpenAI-compatible API (custom base URL, key, and model).
>
> Built on top of [MiniCC](https://github.com/Louisym/MiniCC) with substantial
> extensions — see [Acknowledgments](#acknowledgments).

## Features

### Agent Core

- **Tool loop**: the model decides which tools to call → executes → feeds results
  back, looping until done; SSE/WS streaming, thinking blocks, loop-level token
  and iteration budgets, and soft budget exhaustion (the stop reason is written
  back into history so the next turn continues instead of re-investigating)
- **Headless mode**: `main.py -p "task" --output-format json` runs a single task
  and emits structured output (exit code / result / usage) — the foundation for
  the eval harness and scripted invocation
- **Multi-agent orchestration**: the leader spawns subagents via `agent_tool` /
  `agent_status` / `agent_reap` / `agent_list` to work in parallel, with a
  whitelist against recursion and orphan reconciliation on startup

### Context Engineering

- **Three-tier compaction**:
  **MicroCompact** (when the estimate exceeds a threshold, high-yield
  reproducible tool results outside the keep-window are replaced with
  placeholders — zero LLM calls) →
  **Session Memory** (a background worker maintains a rolling summary while the
  session is idle; used directly when compaction activates — zero on-the-spot
  calls) →
  **Full Compact** (above the compaction threshold, a side-call generates a
  structured summary with a rule-based fallback — one large call)
- **Main-context slimming** (four pieces, for "too much stuff entering the
  context"):
  - `read_file` / `grep` line budgets: oversized output spills to
    `~/.aulos/tool-outputs/`, the session keeps only the head plus a
    spill marker that can be read back later
  - Same-file re-read dedup: unchanged files answer a one-line `unchanged`;
    writes advance a mutation epoch, external modifications and `force=true`
    return full content
  - Image downscaling: oversized screenshots are proportionally resized, the
    original is spilled to disk, and only the shrunk version enters the session
  - Subagent delegation guidance: broad research tasks are steered toward
    subagents at the system-prompt level to keep the main context lean
- **Repeated-read guard**: the same read-only call (read_file/grep/glob, with
  path-normalized bookkeeping) is warned on the 2nd attempt and denied from the
  3rd — taming model spin loops; plus per-turn conclusion checkpoints
- **Prompt-cache friendly**: the system prompt has a dynamic boundary separating
  the stable prefix (OS info / CLAUDE.md / skill list) from the dynamic tail,
  so cache hits are preserved

### Tools & Ecosystem

- **Built-in tools**: `bash` / `powershell` (Windows routes through Git Bash —
  clean UTF-8, no mojibake), `read_file` / `write_file` / `edit_file`
  (read-before-write + staleness check), `grep` / `glob` (pure Python, no
  shell), background tasks (`task_output` / `task_stop`), task list (`todo`),
  plan card (`present_plan`), web access (`web_fetch` / `web_search`)
- **Live browser testing**: `browser_navigate` / `browser_snapshot` /
  `browser_click` / `browser_type` / `browser_console` etc. (Playwright
  headless Chromium) — actually drive a web app to verify behavior
- **MCP client**: connect external MCP servers over `stdio` / `http` / `sse`;
  tools register as `mcp__<server>__<tool>`. The official SDK is asyncio-based
  while the tool loop is a synchronous thread model — each server gets a daemon
  thread owning its own event loop, bridged via `run_coroutine_threadsafe`. A
  failed connection only marks that server failed (warning, never blocks
  startup); unregistered external tools fall back to the conservative
  approval default. See [MCP Setup](#mcp-setup)
- **Skills**: Claude Code–compatible `SKILL.md` packages (YAML frontmatter +
  instructions + arbitrary helper files), user-level and project-level scopes;
  progressive disclosure — only name + description enter the system prompt, the
  body is read on demand via `skill_read`, so a dozen skills never bloat the
  context
- **Cross-session memory**: tell the model to remember things mid-conversation,
  or add manually with `/memory add`; structured JSON storage with
  capacity-based eviction (hits-weighted + recency, `source:user` entries are
  never auto-evicted, evicted entries are archived)

### Reliability & Observability

- **Three-level permissions**: `plan` (read-only) → `workspace-write` (writable
  inside the working directory) → `danger-full-access` (everything); violations
  trigger approval (CLI y/N panel / web approval card). **Sensitive paths**
  (`.git/`, `~/.aulos/`, `~/.ssh/`, shell config files) force human judgment in
  *every* mode including full-access — guarding against irreversible damage
  like `rm -rf .git` and model self-escape
- **Rate-limit retry**: exponential backoff for connection jitter plus a
  dedicated long-backoff curve for 429s, with live progress reporting in the UI
- **max_tokens self-heal**: on truncation, a resume prompt is injected and the
  loop continues
- **Long-turn latency governance**: automatic in-turn thinking downshift
  (request parameter only — user settings untouched), soft convergence nudges,
  and one JSON line per model call (duration / usage) under `~/.aulos/logs/`
  ("which turn got slow, and why" — just read the log)
- **Session persistence**: incremental JSONL (atomic writes), resume (`-c` /
  `--resume`), auto-naming, concurrent-session isolation

### Interface

- **CLI REPL**: slash commands, syntax highlighting, streaming rendering
- **Desktop app** (Tauri 2 primary shell, Electron fallback): custom title bar,
  plan cards, settings page, instant provider switching, bubble/flow reply styles
- **Music radio**: built-in online radio (NetEase Music + Bilibili video-to-audio,
  charts + streaming + lyrics)
- **Desktop pet**: standalone floating window that can also drive background sessions

## Architecture

```
┌─────────────┐   ┌──────────────────────────────────┐
│  CLI (main) │   │  Desktop: Tauri 2 shell + WebView│
└──────┬──────┘   │  (Electron fallback) static/ UI  │
       │          └──────────────┬───────────────────┘
       │            WebSocket/REST (token gate)
       │          ┌──────────────┴───────────────────┐
       └──────────►   server.py (FastAPI backend)     │
                  └──────────────┬───────────────────┘
                                 │
        ┌────────────────────────┴───────────────────────┐
        │ runtime.py  Agent tool loop (thread-pool exec)  │
        ├────────────────────────────────────────────────┤
        │ api_client  streaming+retry   tools  toolset    │
        │ mcp_client  MCP integration   skills skill pkgs │
        │ permissions permission/approval hooks lifecycle│
        │ multi_agent orchestration     compact compaction│
        │ memory      cross-session    call_log call log │
        │ config      layered config   storage sessions  │
        └────────────────────────────────────────────────┘
                    Data directory: ~/.aulos/
```

| Module | Responsibility |
|---|---|
| `main.py` | CLI entry: REPL, slash commands, headless, tool specs, assembly (shared by CLI & Web) |
| `server.py` | FastAPI backend: WebSocket streaming, permission approval bridge, session/settings/MCP/memory REST API |
| `runtime.py` | Agent main loop: event stream, parallel tool execution, interrupts, budgets, guards & checkpoints |
| `api_client.py` | Anthropic / OpenAI streaming clients, thinking levels, backoff retry |
| `tools.py` | Built-in tools & registry (background tasks, line-budget spill, cancel checkpoints) |
| `mcp_client.py` | MCP client: three transports, sync-async bridging, prefixed tool registration |
| `skills.py` | SKILL.md discovery & progressive-disclosure injection |
| `memory/` | Cross-session memory: storage, eviction, injection rendering, tool wiring |
| `permissions.py` | Permission modes, policy, sensitive-path enforcement, CLI/Web approvers |
| `multi_agent.py` / `agent_tools.py` | Multi-agent orchestration core / tool wiring |
| `compact.py` | Three-tier compaction: MicroCompact, Session Memory, LLM summary & continuation |
| `config.py` | Three-tier config discovery & merge, MCP/provider config |
| `storage.py` / `fsatomic.py` | Session store (JSONL) / atomic file writes on Windows |
| `call_log.py` | Per-call duration/usage log |
| `hooks.py` / `retry.py` / `prompt.py` | Pre/PostToolUse hooks / backoff curves / system prompt builder |
| `static/` | Web frontend (vanilla JS, no framework) |
| `src-tauri/` / `electron/` | Desktop shells: backend spawn, token gate, single instance, watchdog |

## Getting Started

### Requirements

- **Python ≥ 3.14**; [uv](https://docs.astral.sh/uv/) recommended
- **Git for Windows** (required on Windows) — the command executor relies on
  Git Bash (MSYS2 coreutils pass UTF-8 bytes through; PowerShell transcodes via
  GBK and garbles output). Startup refuses without it.
- Packaging the desktop app additionally requires the Rust toolchain (cargo)
  and Node.js

### Install

```bash
uv sync
```

### Configure a model provider

Create a `.env` in the project root (read by the CLI):

```ini
API_KEY=sk-xxx        # key used by the CLI
```

The web app does not read `.env`: first launch shows an initialization page
where you enter the API key, base URL, and model. Configuration is saved to
`~/.aulos/settings.json` with support for multiple providers.

### Run the CLI

```bash
uv run python main.py            # new session
uv run python main.py -c         # continue the most recent session
uv run python main.py --resume <id>   # resume a specific session
uv run python main.py --list     # list all sessions
```

Slash commands: `/help` `/status` `/compact` `/mode` `/thinking` `/rename`
`/skills` `/memory` `/exit`

### Headless / scripted use

```bash
uv run python main.py -p "Count top-level functions into count.txt" --output-format json
```

`--output-format json` emits structured output (exit code, final reply, usage);
`--model` and `--permission-mode` override config for one run. The eval harness
is built on this entry point.

### Run the web app

```bash
uv run python server.py          # default 127.0.0.1:8000
uv run python server.py --port 8020
```

The web app shares sessions and tools with the CLI; for the full GUI (custom
title bar, plan cards, settings, music radio, desktop pet) use the desktop build.

## MCP Setup

Add an `mcpServers` block at any config tier (see [Configuration](#configuration)):

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

- `type` accepts `stdio` (local subprocess) / `http` / `sse`; `stdio` accepts
  `args`, `env`, and `cwd`
- Tools register as `mcp__<server>__<tool>` and never collide with built-ins
- A single failing server is marked failed with a warning; startup proceeds and
  other servers work normally
- MCP tools reuse the built-in permission, hook, and truncation pipelines;
  tools absent from the permission table require approval as "arbitrary
  command" tier (the conservative default for unknown capabilities)
- The desktop settings page manages MCP servers visually

## Agent Evals (evals/)

An agent-level eval harness: runs task fixtures against the real
`main.py -p` entry, scores them with deterministic checks plus LLM judging, and
produces a comparable regression baseline. After changing a prompt, tuning
compaction parameters, or shipping a feature, run it once to see whether things
got better or worse overall.

```bash
uv run python evals/run_evals.py                        # full run, compares against baseline if present
uv run python evals/run_evals.py --only fix-failing-test  # run one task
uv run python evals/run_evals.py --save-baseline        # save this run as the baseline
uv run python evals/run_evals.py --list                 # list tasks without running
```

- Bundled tasks: `count-functions` / `fix-failing-test` / `implement-function` /
  `rename-across-files` / `review-buggy-code` / `delegate-subagent`
- Exit code 0 when all pass / 1 otherwise — usable directly as a CI gate; the
  baseline `evals/baseline.json` travels with the repo
- The agent under test runs as a subprocess (via the real entry point); the
  harness never imports the code under test — it measures what users actually
  get. `--agent-cmd` swaps in a stub agent so the framework can self-test
  without burning tokens
- Adding a task: create `evals/tasks/<name>/` with `task.txt` (the prompt) +
  `project/` (fixture project, copied to a fresh temp workspace each run) +
  optional `checks.py` (deterministic assertions) and `judge.txt` (LLM judging
  criteria)
- Real runs cost money (each task is a full agent session); use `--only` to
  pick tasks and start small

## Configuration

Configs deep-merge from low to high priority:

| Location | Scope |
|---|---|
| `~/.aulos/settings.json` (and `.claude.json`) | user global |
| `<project>/.claude/settings.json` (and `.claude.json`) | project |
| `<project>/.claude/settings.local.json` | local personal |

Configurable keys (Claude Code–compatible):

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

- `contextWindow` drives the auto-compact threshold (default 75% of the 1M
  window). If a third-party proxy truncates the window, lower it accordingly.
- Environment overrides: `CLAUDE_MODEL`, `CLAUDE_TIMEOUT`,
  `CLAUDE_MAX_ITERATIONS`, `CLAUDE_TOKEN_BUDGET`, `CLAUDE_TURN_TOKEN_BUDGET`,
  `CLAUDE_THINKING_LEVEL`, `CLAUDE_CONTEXT_WINDOW`

## Permission Modes

| Mode | Description |
|---|---|
| `plan` | Plan mode: read/search tools allowed; writes are hard-denied (with guidance to switch modes or approve the plan) |
| `workspace-write` | Writable inside the working directory; subagent spawning allowed; command execution still requires approval |
| `danger-full-access` | Everything allowed (including arbitrary command execution) |

Tools register their required tier ("read-only / local write / arbitrary
command"); violations trigger approval — a yellow y/N panel on the CLI
(Ctrl+C always refuses toward the safe side) and an approval card on the web.

**Sensitive-path enforcement**: writing/deleting `.git/`, `~/.aulos/`,
`~/.ssh/`, or shell config files forces human confirmation in *every* mode
(including `danger-full-access`). Command allowlists cannot bypass it —
preventing the model from editing its own permission config or causing
irreversible damage.

## Desktop Packaging

One-command packaging (PyInstaller freeze → cargo tauri build):

```cmd
build-exe.cmd
```

Output lands in `dist\` (NSIS installer, Tauri 2 + WebView2). See
[PACKAGING.md](PACKAGING.md) for details: automatic port avoidance (falls back
to 8010–8019 when 8000 is taken), parent-child process watchdog, token gate.

`build-mac.sh` and `scripts/build-linux-tauri.sh` cover macOS / Linux; the
`electron/` directory is a fallback desktop shell (Electron +
electron-builder, cross-platform dmg/NSIS/portable).

## Releases

All three platform artifacts are built and published automatically by GitHub
Actions on tag push (`.github/workflows/release.yml`):

```bash
git tag v4.2.0
git push origin v4.2.0
# Wait for the Release workflow (~15-25 min); artifacts attach to the GitHub Release
```

| Platform | Artifact | Auto-update |
|---|---|---|
| Windows | `aulos_<ver>_x64-setup.exe` | ✅ (NSIS + update signature) |
| macOS (Apple Silicon) | `aulos_<ver>_aarch64.dmg` + `.app.tar.gz` | ✅ (minisign-signed) |
| Linux | `aulos_<ver>_amd64.AppImage` | ✅ |

- `latest.json` carries all three update entries; installed users receive new
  versions via auto-update
- Manual trigger (Actions → Run workflow): builds artifacts without publishing
- Signing keys live in repo Secrets (`TAURI_SIGNING_PRIVATE_KEY` /
  `_PASSWORD`); when missing, builds succeed without `.sig` and cannot be
  auto-update targets
- macOS is not notarized: right-click → Open on first launch, or
  `xattr -cr /Applications/aulos.app`
- Linux runtime deps (without GStreamer plugins the window/tools work but web
  audio is silent):

  ```bash
  sudo apt install libwebkit2gtk-4.1-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav
  ```

  In AppImage form, bundled GStreamer plugins are absent — the radio probes the
  pipeline before playing and disables itself gracefully when unavailable.
- Wayland sessions (default on Ubuntu 22.04/24.04): the Wayland protocol
  forbids client-side always-on-top/programmatic moves, so the desktop pet gets
  occluded and cannot be dragged. The app detects Wayland + XWayland and sets
  `GDK_BACKEND=x11` automatically (decision recorded in `~/.aulos/boot.log`).
  To force native Wayland: `export XCODE_GDK_BACKEND=wayland` before launching,
  at the cost of the pet possibly being occluded.
- On VMs without 3D acceleration (e.g. VMware): the app sets
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` automatically to fall back to WebKitGTK's
  non-accelerated path — otherwise the window can stick to stale/blank frames.

## Testing

```bash
uv run pytest
```

70+ test files (800+ cases), CI runs on GitHub Actions (`ci.yml`). Coverage:
runtime tool loop, permission modes & sensitive paths, multi-agent, three-tier
compaction (MicroCompact / Session Memory / auto-compact), MCP client &
config, memory, skills, the eval harness (stub-agent end-to-end), rate-limit
retry, atomic persistence, concurrent sessions, background tasks, attachments,
context slimming, latency governance, Windows shell selection, and more.

## Further Reading

[guides/](guides/) contains 13 module-by-module implementation notes (models /
tools / api_client / config / permissions / hooks / retry / prompt / compact /
storage / multi_agent / runtime / main) — a good order for reading the source.
[docs/optimization-backlog.md](docs/optimization-backlog.md) tracks the
optimization backlog evaluated against the Claude Code reference design, with
landing status.

## Acknowledgments

This project is built on [Louisym/MiniCC](https://github.com/Louisym/MiniCC)
with substantial extensions, including MCP integration, the three-tier
compaction system, context slimming, the eval harness, the three-level
permission system, multi-agent orchestration, skills, cross-session memory,
multiple desktop shells, and the music radio.

Thanks to the original MiniCC author; contributions, discussions, and PRs are
welcome.

## Disclaimer

This project exists to explore agent architecture. In `danger-full-access`
mode the model can execute arbitrary commands — use it in a trusted
environment.

## License

[MIT](LICENSE)
