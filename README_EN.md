# Aulos

[中文](README.md) | **English**

> Note: the Chinese README is the canonical, most up-to-date version; this translation may lag slightly behind.

<div align="center">

<img src="static/icon-default.png" alt="Aulos" width="128" />

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-%E2%89%A53.14-blue?logo=python&logoColor=white)](https://www.python.org/)
[![Release](https://img.shields.io/github/v/release/Steve-pixel-cpu/aulos)](https://github.com/Steve-pixel-cpu/aulos/releases)
[![CI](https://github.com/Steve-pixel-cpu/aulos/actions/workflows/ci.yml/badge.svg)](https://github.com/Steve-pixel-cpu/aulos/actions/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#acknowledgements)

A local-first AI coding agent, fully open source. You describe a
task in natural language; it reads files, edits code, runs commands and
looks things up on its own until the job is done. Two frontends (terminal +
desktop app), with a built-in permission system, automatic compaction of
long conversations, external tool integration via MCP, multi-agent
parallelism, automated evals, and session save/resume.

</div>

<details>
<summary><b>Table of contents</b></summary>

- [Features](#features)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [MCP configuration](#mcp-configuration)
- [Agent evals (evals/)](#agent-evals-evals)
- [Configuration & permissions](#configuration--permissions)
- [Desktop build & release](#desktop-build--release)
- [Tests](#tests)
- [Further reading](#further-reading)
- [Easter egg mini-game: Aulos Dig](#easter-egg-mini-game-aulos-dig)
- [Acknowledgements](#acknowledgements)
- [Disclaimer](#disclaimer)
- [License](#license)

</details>

> Python 3.14 + FastAPI + Tauri 2. Not tied to any official API: works with
> any Anthropic / OpenAI-compatible model service (base URL, key and model
> are all configurable).
>
> Based on [MiniCC](https://github.com/Louisym/MiniCC), extended on its
> agent architecture — see [Acknowledgements](#acknowledgements).

<table>
  <tr>
    <td width="50%"><img src=".screenshots/light.png" alt="Aulos desktop (light theme)"></td>
    <td width="50%"><img src=".screenshots/dark.png" alt="Aulos desktop (dark theme)"></td>
  </tr>
  <tr>
    <td align="center">Light theme</td>
    <td align="center">Dark theme</td>
  </tr>
</table>

## Features

**Agent core**

- Tool loop: the model decides which tools to call (read files, edit code,
  run commands…); results are fed back so it keeps working until the task
  is done. Replies stream token by token, and the model's reasoning
  (thinking blocks) is shown live. Each run has token and iteration
  budgets; when close to the limit the model is nudged to wrap up and
  deliver a result instead of burning budget
- Headless mode: `main.py -p "task" --output-format json` runs one task
  non-interactively and prints JSON — handy for scripts, and the foundation
  of the eval framework
- Multi-agent orchestration: the main agent (Leader) can spawn subagents to
  work in parallel, ideal for independent sub-tasks. Subagents cannot spawn
  further subagents (whitelist-controlled, no infinite nesting), and on
  restart any subagents left "running" by a dead process are reconciled to
  failed — no ghost agents

**Long conversations without blowing the context window**

The longer the conversation, the more content goes to the model — eventually
exceeding its context window. Three layers of compaction slim it down
automatically:

1. **MicroCompact**: replaces old, bulky tool output with a placeholder
   ("200 lines of file content were here") — pure string surgery, no model
   call, zero cost
2. **Session Memory**: a background thread continuously rolls the
   conversation into a running summary
3. **Full Compact**: when the above isn't enough, one dedicated model call
   compresses the whole conversation into a structured summary (with a
   rule-based truncation fallback, so compaction can never fail)

Plus context-slimming details: oversized tool output keeps only its head,
with the full text spilled to disk for on-demand retrieval; re-reads of
unchanged files are deduped; pasted screenshots are downsampled; broad
research is nudged toward subagent delegation so only conclusions come
back; a read-only call repeated a 3rd time is rejected outright — stopping
"read the same file forever" loops.

Prompts are laid out cache-friendly: static parts (system prompt, tool
definitions) stay at the front, changing conversation at the tail, so the
provider's prompt cache hits as often as possible — saving money and time.

**Tools & ecosystem**

- Built-in tools: `bash`/`powershell` (run commands), `read_file`/
  `write_file`/`edit_file` (file access), `grep`/`glob` (search),
  background tasks, `todo` (task checklist), `web_search`/`web_fetch`
  (web search & page fetching); plus a Playwright browser tool group that
  drives a real headless browser — click, type, and verify web flows
- MCP client: MCP is the standard protocol for plugging external tools into
  AI agents. `stdio` (local subprocess), `http` and `sse` transports are
  supported; tools register as `mcp__<server>__<tool>` — see
  [MCP configuration](#mcp-configuration)
- Skills: Claude Code–compatible `SKILL.md` packages. The model normally
  sees only a one-line description per skill and reads the full text on
  demand (progressive disclosure) — dozens of skills won't bloat the context
- Cross-session memory: ask the model to remember something, or use
  `/memory add`; memories carry into new sessions automatically. When full,
  old entries are evicted by usage frequency and recency

**Reliability & observability**

- Three permission levels, strictest to loosest: `plan` (read-only) →
  `workspace-write` (writable inside the working dir) →
  `danger-full-access` (everything). Operations beyond the current level
  pop an approval prompt first; writes/deletes to sensitive paths (`.git/`,
  `~/.ssh/`, …) **require human confirmation in every mode**, preventing
  irreversible damage and the model tampering with its own permissions
- Automatic retry on API rate limits with doubling wait times (exponential
  backoff); replies truncated by the length cap are auto-continued;
  latency and token usage of every call are logged
- Session persistence: the conversation is appended to a JSONL file
  incrementally as it happens (atomic writes — a crash can't corrupt it).
  Resume with `-c`, restore a specific session with `--resume <id>`, list
  history with `--list`; concurrent processes don't interfere

**UI**

- Terminal REPL (slash commands, syntax highlighting, streaming) and a
  Tauri 2 desktop app (settings page, multi-provider switching, plan
  cards); bonus built-in internet radio (NetEase Music / Bilibili) and
  desktop pets

## Architecture

```
CLI (main.py)                          # terminal REPL / headless mode
Desktop shell (src-tauri)              # talks WebSocket / REST
  |
  +-> aulos/server.py                  # FastAPI backend facade
  |     +-> aulos/web/                 #   REST endpoints per feature domain
  |     +-> aulos/radio/               #   music sources (NetEase / Bilibili)
  |
  +-> aulos/runtime.py                 # agent tool loop (core)
        +-> api_client / tools         #   model client / built-in tools
        +-> permissions / compact      #   approval / three-layer compaction
        +-> multi_agent / skills       #   subagents / SKILL.md packages
        +-> memory / mcp_client        #   cross-session memory / MCP
        +-> config / storage           #   config merge / session store
                                       # data dir: ~/.aulos/
```

All Python implementation lives in the **`aulos/`** package; the repo root
keeps only two launch entries, `main.py` / `server.py` (a few lines each,
forwarding into the package; evals, the desktop shells and packaging
scripts hardcode these paths — do not delete).

| Location | Responsibility |
|---|---|
| `main.py` / `server.py` (root) | Launch entries forwarding to `aulos.main` / `aulos.server` |
| `aulos/main.py` / `aulos/server.py` | CLI entry / web backend facade (re-exports each module's public API) |
| `aulos/runtime.py` | Agent main loop: event stream, parallel tool execution, interruption, budgets, anti-loop guards |
| `aulos/api_client.py` `tools.py` `permissions.py` `compact.py` … | Model client + auto-retry / built-in tools / permission approval / three-layer compaction (core modules) |
| `aulos/web/` | Backend feature domains: shared base + REST for radio/pets/telemetry/settings/permission policy |
| `aulos/radio/` | Internet-radio library: NetEase Music & Bilibili fetching/parsing |
| `aulos/memory/` `skills.py` `mcp_client.py` `multi_agent.py` | Cross-session memory / skills / MCP / multi-agent |
| `aulos/config.py` `storage.py` | Three-tier config discovery & merge / JSONL session store |
| `static/` `src-tauri/` | Web frontend (vanilla JS, split by feature domain) / Tauri 2 desktop shell (Electron shell deprecated) |

## Quick start

### Requirements

- **Python ≥ 3.14**, [uv](https://docs.astral.sh/uv/) recommended for
  dependency management
- **Git for Windows** (required on Windows) — command execution relies on
  Git Bash: it passes UTF-8 output through untouched, while PowerShell
  transcodes as GBK and garbles it. The app refuses to start without
  Git Bash
- The Rust toolchain (cargo) and Node.js are needed only to build the
  desktop app

### Install & configure

```bash
uv sync
```

The CLI reads `.env` at the repo root — one line: `API_KEY=sk-xxx`.
The web/desktop side does not read `.env`: first launch shows an init page
where you fill in the API key, base URL and model; settings go to
`~/.aulos/settings.json`, with multi-provider switching supported.

### Run

```bash
uv run python main.py                    # new CLI session (-c resume last / --resume <id> / --list)
uv run python main.py -p "task" --output-format json   # headless one-shot
uv run python server.py                  # web backend, default http://127.0.0.1:8000
```

CLI slash commands: `/help` `/status` `/compact` `/mode` `/thinking`
`/rename` `/skills` `/memory` `/exit`. The web UI shares sessions and the
tool registry with the CLI; for the full graphical experience (custom
titlebar, plan cards, radio, pets) use the packaged desktop app.

## MCP configuration

Add `mcpServers` to any config tier (see
[Configuration & permissions](#configuration--permissions)):

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

- `type` supports `stdio` (spawns the MCP server as a local subprocess,
  with `args`/`env`/`cwd`), `http` and `sse` (connect to remote servers)
- Tools register as `mcp__<server>__<tool>`, never colliding with built-ins;
  an unreachable server only warns and doesn't block startup
- External tools go through the same permission approval, hooks and output
  truncation pipeline as built-ins; tools without explicit permission
  config default to conservative — you're asked before every use
- The desktop settings page manages MCP servers visually

## Agent evals (evals/)

Gives the real agent (not a mock) preset tasks and scores it automatically,
catching capability regressions after changes. Each task ships with a small
sample project (fixture); the agent runs it via `main.py -p`, then scripted
checks verify mechanically ("did the test pass?") and a second model scores
against written criteria. Results are saved as a baseline and compared
automatically on the next run.

```bash
uv run python evals/run_evals.py                    # all tasks; compares to baseline if present
uv run python evals/run_evals.py --only fix-failing-test --save-baseline
```

- Built-in tasks: count functions / fix a failing test / implement a
  function / rename across files / review buggy code / delegate to a
  subagent (count-functions, fix-failing-test, implement-function,
  rename-across-files, review-buggy-code, delegate-subagent)
- Add a task: put `task.txt` (the prompt) + `project/` (the fixture) +
  optional `checks.py` (mechanical checks) / `judge.txt` (scoring criteria
  for the judge model) under `evals/tasks/<name>/`. Real runs cost tokens —
  start with `--only` on a small task
- CI: nightly full run + a stub agent (no real model calls) smoke test on
  every push (`.github/workflows/evals.yml`)

## Configuration & permissions

Configs live in three tiers, deep-merged by increasing precedence (later
tiers override same-named keys): `~/.aulos/settings.json` (user-global) →
`<project>/.claude/settings.json` (project-level, committable and shareable
with the team) → `.claude/settings.local.json` (personal, not committed).

Keys are Claude Code compatible: `model` / `thinkingLevel` /
`permissionMode` / `timeout` / `maxIterations` / `tokenBudget` /
`turnTokenBudget` / `contextWindow` / `mcpServers` / `hooks`; env vars like
`CLAUDE_MODEL` override file config.

> Heads-up: third-party API proxies often offer a smaller real context
> window than the official one — lower `contextWindow` accordingly.
> Compaction thresholds derive from it (default: 75% of a 1M window);
> leaving it wrong leads to over-limit errors.

| Permission mode | Behavior |
|---|---|
| `plan` | Read-only: reads and searches allowed; any write is hard-rejected (guides you to switch mode or approve a plan first) |
| `workspace-write` | Writable inside the working dir, may spawn subagents; executing commands still needs per-command approval |
| `danger-full-access` | Everything allowed, including arbitrary commands |

Operations beyond the current mode pop an approval (y/N panel in the CLI,
approval card on the web) — you can allow them one at a time. Writes and
deletes to sensitive paths (`.git/`, `~/.ssh/`, …) force human confirmation
in **every mode**, full access included — preventing irreversible damage
and the model editing its own permission config to "self-escalate".

Telemetry: latency and usage of every model call are logged to
`~/.aulos/logs/runtime-YYYYMMDD.log`; open `/stats.html` in a browser for
the panel — which round was slow, where tokens went, cache hit rate.

## Desktop build & release

```cmd
build-exe.cmd          :: Windows one-click: freeze the Python backend into an exe, then cargo tauri build
```

macOS/Linux: `build-mac.sh` / `scripts/build-linux-tauri.sh`. Releasing is
just a tag: `git tag vX.Y.Z && git push origin vX.Y.Z` — GitHub Actions
builds and publishes installers for all three platforms (Windows `.exe` /
macOS `.dmg` / Linux `.AppImage`), all with auto-update. See
[PACKAGING.md](PACKAGING.md) and
[docs/desktop-release-notes.md](docs/desktop-release-notes.md) (Linux
dependencies, Wayland/VMware display troubleshooting, signing keys).

## Tests

```bash
uv run pytest          # 1070+ cases; CI: .github/workflows/ci.yml
```

Covers the agent main loop, permissions & sensitive paths, multi-agent,
three-layer compaction, MCP, memory, skills, the eval harness, auto-retry,
atomic writes, concurrent sessions, context slimming, and more. Frontend
regression: `npm run test:web` (jsdom) + `tests/web/e2e.py` (Playwright,
real browser).

## Further reading

- [guides/](guides/): 13 implementation notes, one per module (a
  source-reading companion)

## Easter egg mini-game: Aulos Dig

The promo site (`website/`, fully static) hides a 2D pixel-art mining
mini-game: open `website/index.html#egg-run` to jump straight in, or
double-click the Phoebe desktop pet on the page. It runs on a locally
vendored Phaser 3 (MIT, `website/js/vendor/phaser.min.js`); all game code
lives in `website/js/game2.js` with zero network dependencies — playable
offline. Dig for crystals, survive day/night cycles and blood moons, fight
underground monsters that get more eldritch with depth, loot chests and
upgrade weapons, double-jump; the ⚙ button in the title bar opens a
13-parameter config panel (max HP / crystal goal / day length / blood-moon
chance …), ⛶ toggles fullscreen.

### Art assets & attribution

- **Tile atlas** `assets/mc/tiles.png`: hand-drawn shapes kept from CC0
  source packs, colors remapped to a Terraria-style palette by
  `website/tools/build_terraria_tiles.py` (global LUT + per-tile
  overrides); torch/chest/lava/gravel/bedrock/wall tiles are drawn
  procedurally. The CC0 source zips (`assets/mc/src/blocks_2021.zip` /
  `blocks_2023.zip`) carry no author metadata — original authors
  untraceable; the art itself is public domain
- **Phoebe** `assets/feibi/`: fan-made chibi desktop-pet art of the
  character Phoebe from *Wuthering Waves*; no original author/license is
  recorded in-repo — shown as a non-commercial Easter egg only
- **Large monsters** `assets/big/`: bevouliin "Land Monster" (CC0) and
  Redshrike "Ars Notoria" (CC-BY 3.0, attribution required); source
  archives kept in `assets/big/src/` as license provenance
- **Parallax backdrops** `assets/scenery/bg/`: parallax background packs
  by Admurin (snowy mountains / plains / caves …, **CC-BY 4.0, attribution
  required**), recolored to a Terraria daylight palette; source archive
  kept in `assets/scenery/adm.zip`
- **Small monsters** `assets/tiny/`: "Tiny Creatures" by Clint Bellanger
  (CC0, an expansion of Kenney's Tiny Dungeon / Tiny Town),
  opengameart.org/content/tiny-creatures; source archive in
  `assets/tiny/src/`
- **Misc sprites** (top level of `assets/scenery/`: bug / bat / flag …):
  slime is by Kenney (CC0); the rest have no recorded provenance

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
