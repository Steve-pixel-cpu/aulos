# Aulos

[中文](README.md) | **English**

> Note: the Chinese README is the canonical, most up-to-date version; this translation may lag slightly behind.

A Claude Code–style AI coding agent, fully open source and built from
scratch: terminal REPL + desktop app, with a built-in tool loop, three-tier
context compaction, MCP integration, a three-level permission system,
multi-agent orchestration, an agent-level eval framework, and session
persistence.

> Python 3.14 + FastAPI + Tauri 2, compatible with any Anthropic /
> OpenAI API–shaped model service (base URL, key, and model all configurable).
>
> Based on [MiniCC](https://github.com/Louisym/MiniCC), extended on its agent
> architecture — see [Acknowledgements](#acknowledgements).

## Features

**Agent core**

- Tool loop: the model calls tools → executes → feeds results back, with
  SSE/WS streaming, thinking blocks, token & iteration budgets, soft
  convergence when over budget
- Headless mode: `main.py -p "task" --output-format json` — the base for
  the eval framework and scripted calls
- Multi-agent orchestration: a Leader spawns subagents to work in parallel;
  whitelist prevents recursion, orphan agents reconciled at startup

**Context engineering**

- Three-layer compaction: MicroCompact (placeholder swap, zero LLM calls) →
  Session Memory (background rolling summary) → Full Compact (side-call
  structured summary with rule-based fallback)
- Main-context slimming: tool-output line budgets spilled to disk, re-read
  dedup of unchanged files, screenshot downsampling, wide-research nudged
  toward subagent delegation; repeated read-only calls rejected on the 3rd
- Prompt-cache friendly: stable prefix separated from dynamic tail

**Tools & ecosystem**

- Built-ins: `bash`/`powershell`/`read_file`/`write_file`/`edit_file`/`grep`/
  `glob`/background tasks/`todo`/`web_search`/`web_fetch`; a Playwright
  headless-Chromium browser tool group for real web testing
- MCP client: `stdio`/`http`/`sse` transports, tools registered as
  `mcp__<server>__<tool>` — see [MCP configuration](#mcp-configuration)
- Skills: Claude Code–compatible `SKILL.md` packages with progressive
  disclosure — ten skills don't blow up the context
- Cross-session memory: ask the model to remember or use `/memory add`;
  capacity-triggered eviction with hits/recency weighting

**Reliability & observability**

- Three permission levels `plan` → `workspace-write` → `danger-full-access`;
  overreach triggers approval. Sensitive paths (`.git/`, `~/.ssh/`, …) force
  a human decision **in every mode including full access**
- Exponential-backoff retry for rate limits, max_tokens truncation
  self-healing, per-call latency/usage logged to disk
- Session persistence: atomic incremental JSONL, resume (`-c`/`--resume`),
  concurrent session isolation

**UI**

- CLI REPL (slash commands, syntax highlighting, streaming) and Tauri 2
  desktop app (settings page, multi-provider switching, plan cards);
  built-in internet radio (NetEase Music / Bilibili) and desktop pets

## Architecture

```
CLI (main.py) ──┐
                ├─► aulos/server.py (FastAPI facade) ─► aulos/web/ package
Desktop shell (src-tauri) ─► WebSocket/REST              (server_common base +
                │                             music/bilibili/pets/stats/
                │     aulos/radio/ package    settings/policy REST domains)
                ▼
        aulos/runtime.py agent tool loop ─► aulos/api_client / tools /
        permissions / compact / multi_agent / skills / memory /
        mcp_client / config / storage …    data dir: ~/.aulos/
```

All Python implementation lives in the **`aulos/`** package; the repo root
keeps only two launch shims, `main.py` / `server.py` (paths hardcoded by
evals, the Tauri/Electron shells and packaging scripts — do not delete).

| Location | Responsibility |
|---|---|
| `main.py` / `server.py` (root) | Launch shims forwarding to `aulos.main` / `aulos.server` |
| `aulos/main.py` / `aulos/server.py` | CLI entry / web backend facade (re-exports domain names) |
| `aulos/runtime.py` | Agent main loop: event stream, parallel tool execution, interruption, budgets, guards |
| `aulos/api_client.py` `tools.py` `permissions.py` `compact.py` … | Streaming client+retry / built-in tools / permissions / three-layer compaction (core modules) |
| `aulos/web/` | Backend domain package: `server_common` base + radio/pets/telemetry/settings/policy REST |
| `aulos/radio/` | Internet-radio library: NetEase Music & Bilibili fetching/parsing |
| `aulos/memory/` `skills.py` `mcp_client.py` `multi_agent.py` | Cross-session memory / skills / MCP / multi-agent |
| `aulos/config.py` `storage.py` | Three-tier config merge / JSONL session store |
| `static/` `src-tauri/` | Web frontend (vanilla JS, split by domain) / Tauri 2 shell (Electron shell deprecated) |

## Quick start

### Requirements

- **Python ≥ 3.14**, [uv](https://docs.astral.sh/uv/) recommended
- **Git for Windows** (required on Windows) — the command runner relies on
  Git Bash (MSYS2 passes UTF-8 through; PowerShell transcodes as GBK and
  garbles output). Refuses to start if not detected
- Rust toolchain (cargo) and Node.js are additionally needed to build the
  desktop app

### Install & configure

```bash
uv sync
```

The CLI reads `API_KEY=sk-xxx` from `.env` at the repo root. The web backend
does not read `.env`: on first launch it shows an init page — fill in API
key, base URL and model there; saved to `~/.aulos/settings.json`, with
multi-provider switching supported.

### Run

```bash
uv run python main.py                    # new CLI session (-c resume last / --resume <id> / --list)
uv run python main.py -p "task" --output-format json   # headless one-shot
uv run python server.py                  # web backend, default http://127.0.0.1:8000
```

CLI slash commands: `/help` `/status` `/compact` `/mode` `/thinking`
`/rename` `/skills` `/memory` `/exit`. The web UI shares sessions and the
tool registry with the CLI; for a graphical experience (custom titlebar,
plan cards, radio, pets) use the packaged desktop app.

## MCP configuration

Add `mcpServers` to any config tier:

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

- `type` supports `stdio` (local subprocess, with `args`/`env`/`cwd`),
  `http`, `sse`
- Tools register as `mcp__<server>__<tool>`, never colliding with built-ins;
  one failed server only warns and doesn't block startup
- Permissions, hooks and output truncation reuse the built-in pipeline;
  unregistered external tools fall back to conservative approval
- The desktop settings page manages MCP servers visually

## Agent evals (evals/)

Runs real `main.py -p` against task fixtures with deterministic assertions +
LLM judging, producing a comparable regression baseline:

```bash
uv run python evals/run_evals.py                    # all; compares to baseline if present
uv run python evals/run_evals.py --only fix-failing-test --save-baseline
```

- Built-in tasks: count-functions / fix-failing-test / implement-function /
  rename-across-files / review-buggy-code / delegate-subagent
- Add a task: put `task.txt` + `project/` (fixture) + optional `checks.py` /
  `judge.txt` under `evals/tasks/<name>/`; real runs cost tokens — start with
  `--only`
- CI: nightly full run + stub-agent smoke
  (`.github/workflows/evals.yml`)

## Configuration & permissions

Configs deep-merge by increasing precedence: `~/.aulos/settings.json`
(user-global) → `<project>/.claude/settings.json` (project) →
`.claude/settings.local.json` (local). Keys are Claude Code compatible:
`model` / `thinkingLevel` / `permissionMode` / `timeout` / `maxIterations` /
`tokenBudget` / `turnTokenBudget` / `contextWindow` / `mcpServers` / `hooks`;
overridable via `CLAUDE_MODEL` etc. env vars. If a proxy trims the window,
lower `contextWindow` (compaction thresholds derive from it).

| Permission mode | Behavior |
|---|---|
| `plan` | Read-only: reads/searches allowed, writes hard-rejected (guides toward approval or mode switch) |
| `workspace-write` | Writable inside the working dir, may spawn subagents; executing commands still requires approval |
| `danger-full-access` | Everything allowed (incl. arbitrary commands) |

Overreach triggers approval (CLI y/N panel / web approval card); writes or
deletes to sensitive paths force a human decision in **every mode** —
preventing irreversible damage and the model tampering with its own
permission config.

Telemetry: every model call is logged to `~/.aulos/logs/runtime-YYYYMMDD.log`;
open `/stats.html` for the panel (which round was slow, where tokens went,
cache hit rate).

## Desktop build & release

```cmd
build-exe.cmd          :: Windows one-click: PyInstaller freeze → cargo tauri build
```

macOS/Linux: `build-mac.sh` / `scripts/build-linux-tauri.sh`. Release:
`git tag v5.1.6 && git push origin v5.1.6` — GitHub Actions builds and
publishes all three platforms (Windows `.exe` / macOS `.dmg` /
Linux `.AppImage`), all with auto-update. See [PACKAGING.md](PACKAGING.md)
and [docs/desktop-release-notes.md](docs/desktop-release-notes.md) (Linux
dependencies, Wayland/VMware workarounds, signing keys).

## Tests

```bash
uv run pytest          # 1070 cases; CI: .github/workflows/ci.yml
```

Covers the runtime tool loop, permissions & sensitive paths, multi-agent,
three-layer compaction, MCP, memory, skills, the eval harness, retry, atomic
writes, concurrent sessions, context slimming, etc. Frontend regression:
`npm run test:web` (jsdom) + `tests/web/e2e.py` (Playwright).

## Further reading

- [guides/](guides/): 13 implementation notes, one per module (source-reading companion)
- [docs/refactoring-roadmap.md](docs/refactoring-roadmap.md): module-splitting roadmap (backend/frontend)
- [docs/naming-history.md](docs/naming-history.md): display-name vs identifier conventions, rename history
- [docs/optimization-backlog.md](docs/optimization-backlog.md): backlog vs Claude Code reference design

## Acknowledgements

Built on [Louisym/MiniCC](https://github.com/Louisym/MiniCC), extended with
MCP integration, three-layer compaction, context slimming, the eval
framework, three-level permissions, multi-agent orchestration, skills,
cross-session memory, the desktop app and the built-in radio. Thanks to the
original author; feedback and PRs welcome.

## Disclaimer

This project exists for learning agent architecture design. In
`danger-full-access` mode the model can execute arbitrary commands — use it
in trusted environments only.

## License

[MIT](LICENSE)
