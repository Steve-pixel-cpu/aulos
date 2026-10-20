#!/usr/bin/env python3
# 补齐 index.t095-t153 + B3 段(music/pet/petpg/loadpg/settings_extras/settings_page) 残余翻译。
# 值由主线对照 zh 原文人工定稿。
import json
import re
from pathlib import Path

T = {
# index 补段(截断处之后)
"index.t095":"Refresh","index.t096":"Open directory",
"index.t098":"Manage API providers and model lists; changes auto-save after a pause and are immediately available in sessions",
"index.t099":"＋ Add provider",
"index.t100":"Auxiliary model (auto-naming, summaries, image reading and other background tasks)",
"index.t101":"Session auto-naming, long-conversation summarization, cross-session memory upkeep, and image description run on your main chat model by default. Assign a cheaper model here to handle these background jobs — saves money without affecting conversations; leave unset to follow the main model. Pick a vision-capable model for image description",
"index.t102":"Not used (follows the main model)",
"index.t103":"Subagent model (execution tier)",
"index.t104":"Dispatched subagents use the same model as the main conversation by default. Assign a cheaper model here for execution — the main conversation keeps a strong model for diagnosis and planning while subagents do the work cheaply, cutting execution cost without sacrificing decision quality; leave unset to follow the main chat model. Changes auto-save after a pause and apply to the next dispatched subagent",
"index.t105":"Not used (follows the main chat model)",
"index.t106":"Behavior","index.t107":"Runtime parameters and command permissions for the task loop",
"index.t108":"Max iterations per turn",
"index.t109":"Upper bound on consecutive tool calls per task turn; the turn wraps up early when reached. 1–10000, default 128; applies to new sessions",
"index.t110":"Browser visibility",
"index.t111":'Whether to show a real browser window while the AI tests pages with the built-in browser, plus the delay between actions (ms). Visible + delay suits demos and screen recordings — you can see where the AI clicks; for daily use keep it off with 0 ms for speed. Applies to newly opened browsers (say "close the browser" and retry)',
"index.t112":"Show browser window",
"index.t113":"Off = run invisibly in the background (default); On = open a real Chromium window",
"index.t114":"Action delay (ms)",
"index.t115":"Pause between clicks/keystrokes, 0–10000; 200–500 recommended for demos",
"index.t116":"Command allowlist",
"index.t117":'Shell commands matching a rule run without a permission prompt. Rules match by word-order prefix (e.g. "git push" matches "git push origin main"); in a compound command, every segment must match a rule or be a read-only probe to pass; segments with command substitution or file-write redirects never match. Applies to all sessions immediately after saving',
"index.t118":"Add rule","index.t119":"Command denylist",
"index.t120":'Any command segment matching a prefix here is rejected outright, taking priority over the allowlist and every other path — for expressing exceptions: while the allowlist lets "git push" through, add "git push --force" here to block forced pushes. Applies to all sessions immediately after saving',
"index.t121":"Add rule","index.t122":"Sensitive paths",
"index.t123":"Writes to these paths (or commands like rm/mv naming them) always force a confirmation in every permission mode; the allowlist cannot exempt them. Built-in coverage includes .git, ~/.ssh, shell configs and this app's config; add project items like secrets/ or .env.production here. Relative paths resolve against the session working directory. Applies to all sessions immediately after saving",
"index.t124":"Add path","index.t125":"MCP servers",
"index.t126":"Configure MCP (Model Context Protocol) servers; external tools plug into conversations as mcp__server__tool. Changes auto-save after a pause and hot-reload — no restart needed",
"index.t127":"＋ Add server","index.t128":"Reconnect all",
"index.t129":"A skill pack is a SKILL.md (with bundled scripts/templates) the model reads and follows automatically when a task matches. Project-level skills live in &lt;project&gt;/.claude/skills/&lt;name&gt;/ and travel with the repo; what's installed here are user-level skills (~/.aulos/skills/), effective immediately — no restart needed",
"index.t130":"Overwrite existing","index.t131":"Install","index.t132":"Memory",
"index.t133":'User profile and long-term facts the Agent accumulates in conversations, injected into the system prompt across sessions — it makes the Agent understand you better. Entries added here are tagged with the "user" source and never auto-pruned; the rest are maintained by the Agent (visible in the conversation as they are written)',
"index.t134":"Fact","index.t135":"Add","index.t136":"Config file",
"index.t137":"All user-level settings live in this one file (including model providers); manual edits require a service restart to take effect",
"index.t138":"Path ~/.aulos/settings.json","index.t139":"Open file","index.t140":"About",
"index.t141":"The Aulos desktop app supports in-app auto-updates: when a new version is found it can download in the background without interrupting your work; once downloaded, confirm to install and it restarts automatically",
"index.t142":"Current version","index.t143":"Check for updates","index.t144":"Update status","index.t145":"Not checked",
"index.t146":"Favorites","index.t147":"My playlists","index.t148":"Search","index.t149":"Playlist",
"index.t150":"NetEase","index.t151":"Bilibili","index.t152":"Select working directory","index.t153":"Use this directory",
# 卫星页
"petpg.t001":"Aulos Desktop Pet","petpg.t002":"Aulos Desktop Pet","petpg.t003":"Drag to move · click to toggle music",
"petpg.t004":"Assign a task · request a song · chat, press Enter to send","petpg.t005":"Slacking off",
"loadpg.t001":"Starting…","loadpg.t002":"Aulos","loadpg.t003":"Loading, please wait…",
}

f = Path('static/i18n/en.js')
lines = f.read_text(encoding='utf-8').split('\n')
hits = 0
for i, line in enumerate(lines):
    m = re.match(r'^(\s*)"([a-z_.0-9]+)":\s*(.*?),?\s*$', line)
    if not m:
        continue
    key = m.group(2)
    if key not in T:
        continue
    lines[i] = f'{m.group(1)}"{key}": {json.dumps(T[key], ensure_ascii=False)},'
    hits += 1
f.write_text('\n'.join(lines), encoding='utf-8', newline='')
print(f'替换 {hits} 行')
