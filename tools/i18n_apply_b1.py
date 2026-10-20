#!/usr/bin/env python3
# 落盘 B1 (index/sidebar/stats) 与 B3 (music/pet/petpg/loadpg/settings_extras/settings_page) 的译文表。
# 值里的引号直接用 Python 字符串写法; json.dumps 序列化保证 JS 语法正确。
import json
import re
from pathlib import Path

Q = '"'  # 英文双引号

T = {}

# ---- sidebar (82) ----
T.update({
"sidebar.001":"Just now","sidebar.002":" minutes ago","sidebar.003":" hours ago",
"sidebar.004":"1 day ago","sidebar.005":" days ago","sidebar.006":"Today",
"sidebar.007":"Yesterday","sidebar.008":"Last 7 days","sidebar.009":"Earlier",
"sidebar.010":"Untitled task","sidebar.011":"(untitled)","sidebar.012":"Archived",
"sidebar.013":"Restored","sidebar.014":"Archive failed: ","sidebar.015":"Restore failed: ",
"sidebar.016":"Archived {p0} sessions","sidebar.017":", skipped {p0} conversations in progress",
"sidebar.018":"No sessions to archive","sidebar.019":"Bulk archive failed: ",
"sidebar.020":"No archived tasks",
"sidebar.021":"This will permanently delete {p0} archived sessions and all their messages. This cannot be undone.",
"sidebar.022":"Delete all archived tasks","sidebar.023":"Delete all",
"sidebar.024":"Deleted {p0} archived sessions",
"sidebar.025":", skipped {p0} conversations in progress",
"sidebar.026":"No archived sessions to delete",
"sidebar.027":"Delete failed: ","sidebar.028":"Rename failed: ","sidebar.029":"(untitled)",
"sidebar.030":'<span class="s-plan">Plan pending approval</span>',
"sidebar.031":'<button class="s-arc" data-tip="Archive">',
"sidebar.032":'<button class="s-ren" data-tip="Rename">',
"sidebar.033":"Body",
"sidebar.034":'<button class="s-unarc" data-tip="Restore">',
"sidebar.035":'<button class="s-del" data-tip="Delete session">',
"sidebar.036":"This session is mid-conversation and can't be deleted yet",
"sidebar.037":'Delete session "{p0}"? This cannot be undone.',
"sidebar.038":"Delete session","sidebar.039":"Delete","sidebar.040":"Session deleted",
"sidebar.041":"Delete failed: ","sidebar.042":"No sessions match in title or body",
"sidebar.043":'<span class="list-label">Archive</span>',
"sidebar.044":"Sort: ","sidebar.045":"Updated","sidebar.046":"Created",
"sidebar.047":"Updated","sidebar.048":"Created",
"sidebar.049":"Bulk-archive sessions older than N days","sidebar.050":"More actions",
"sidebar.051":" archived tasks","sidebar.052":"Delete all archived tasks",
"sidebar.053":"No matching archived sessions","sidebar.054":"No archived sessions yet",
"sidebar.055":"No matching sessions","sidebar.056":"No sessions yet",
"sidebar.057":'<span class="list-label">Projects</span>',
"sidebar.058":"Add project","sidebar.059":"No matching sessions",
"sidebar.060":"No projects yet — click + above to add one",
"sidebar.061":'<button class="p-add" data-tip="New task in this project">',
"sidebar.062":'<button class="p-del" data-tip="Remove project">',
"sidebar.063":"Collapse/Expand",
"sidebar.064":'<span class="list-label">Tasks</span>',
"sidebar.065":"New task","sidebar.066":"No tasks yet","sidebar.067":" tasks",
"sidebar.068":'<div class="dd-opt dd-head plain">Archive sessions older than how many days?</div>',
"sidebar.069":" days ago","sidebar.070":"Custom days…","sidebar.071":"Days",
"sidebar.072":"Projects added: ",
"sidebar.073":'Remove project "{p0}"? Its {p1} sessions will be kept as standalone tasks (not deleted); files on disk are unaffected.',
"sidebar.074":"Remove project","sidebar.075":"Remove",
"sidebar.076":'Remove project "{p0}"? This only removes it from the sidebar; files on disk are unaffected.',
"sidebar.077":"Remove project","sidebar.078":"Remove",
"sidebar.079":"{p0} sessions could not be unbound (possibly mid-conversation); project kept",
"sidebar.080":"Projects removed: ","sidebar.081":"Failed to open folder: ","sidebar.082":"No project set",
})

# ---- stats (31) ----
T.update({
"stats.t001":"Call Telemetry · Aulos","stats.t002":"Call Telemetry · Aulos","stats.t003":"Call Telemetry",
"stats.t004":"Model call durations and token usage (source ~/.aulos/logs/runtime-*.log, read-only)",
"stats.t005":"Daily overview","stats.t006":"days","stats.t007":"Refresh","stats.t008":"Date",
"stats.t009":"Calls","stats.t010":"Sessions","stats.t011":"Total (s)","stats.t012":"Avg (s)",
"stats.t013":"Cache hits","stats.t014":"Session ranking","stats.t015":"entries","stats.t016":"Refresh",
"stats.t017":"Session","stats.t018":"Calls","stats.t019":"Total (s)","stats.t020":"Avg (s)",
"stats.t021":"Max (s)","stats.t022":"First call","stats.t023":"Last call","stats.t024":"Call log",
"stats.t025":"Entry limit","stats.t026":"Load","stats.t027":"Time","stats.t028":"Session",
"stats.t029":"Iteration","stats.t030":"Thinking","stats.t031":"Duration (s)",
})

# ---- index.attr (26) ----
T.update({
"index.attr001":"Show sidebar","index.attr002":"Minimize","index.attr003":"Maximize","index.attr004":"Close",
"index.attr005":"Archive","index.attr006":"Search title / project / body…","index.attr007":"Clear search",
"index.attr008":"Playback progress","index.attr009":"Describe your task; attachments welcome…",
"index.attr010":"e.g. glm-5.3-flash","index.attr011":"Wallpaper brightness","index.attr012":"Pet size",
"index.attr013":"Rescan pet directory","index.attr014":"Auxiliary model provider",
"index.attr015":"Follow main model","index.attr016":"Subagent model provider",
"index.attr017":"Follow main conversation model","index.attr018":"e.g. uv run pytest",
"index.attr019":"e.g. git push --force","index.attr020":"e.g. secrets or .env.production",
"index.attr021":"GitHub repo, e.g. anthropics/skills or a full URL","index.attr022":"Subdirectory (optional)",
"index.attr023":"Add a memory, e.g. prefer concise replies (Enter to send, Shift+Enter for newline)",
"index.attr024":"Search song / artist, press Enter","index.attr025":"Clear search",
"index.attr026":"Enter a directory path, press Enter to go",
})

# ---- index.t (153) ----
T.update({
"index.t001":"New task","index.t002":"Search","index.t003":"Settings","index.t004":"Group",
"index.t005":"Projects","index.t006":"Not playing","index.t007":"Back to session","index.t008":"Settings",
"index.t009":"Appearance","index.t010":"Notifications","index.t011":"Desktop pet","index.t012":"Models",
"index.t013":"Behavior","index.t014":"Memory","index.t015":"Config","index.t016":"About",
"index.t017":"Connecting…","index.t018":"Untitled task","index.t019":"Ask every time","index.t020":"Medium",
"index.t021":"Implementation plan","index.t022":"Copy","index.t023":"Welcome to Aulos",
"index.t024":'First-time use requires configuring a model provider — it works as soon as you fill it in; adjust or add more anytime in "Settings → Models".',
"index.t025":"API protocol","index.t026":"Anthropic (Claude protocol)","index.t027":"OpenAI (Chat Completions)",
"index.t028":"API Base URL","index.t029":"Default model","index.t030":"Save and start",
"index.t031":"Settings","index.t032":"Appearance","index.t033":"Theme","index.t034":"Dark, light, or follow system",
"index.t035":"Follow system","index.t036":"Language","index.t037":"Language used by the UI and AI replies",
"index.t038":"Chinese","index.t039":"UI style",
"index.t040":"Default / Fluent · system Mica (on Win11 22H2+ shows the system Mica material; unsupported environments fall back to the default look automatically)",
"index.t041":"Default","index.t042":"Code highlighting",
"index.t043":"Color scheme for code blocks; follows the dark/light theme by default",
"index.t044":"Follow theme","index.t045":"Chat density",
"index.t046":"Message spacing and whitespace in the chat area: Compact / Comfortable (default) / Relaxed",
"index.t047":"Comfortable","index.t048":"Bubble style",
"index.t049":"Document flow (default; AI replies render flat without frames) / Bubble cards (AI replies wrap into cards; more readable with a wallpaper)",
"index.t050":"Document flow","index.t051":"Zen mode",
"index.t052":"Hide the sidebar to focus on the conversation; shortcut Ctrl+Alt+Z. When hidden, move the mouse to the left screen edge to bring it back temporarily",
"index.t053":"Off","index.t054":"Accent color from wallpaper",
"index.t055":"When on, the dominant color is extracted from the wallpaper as the accent color, ignoring manual color selection below (upload a wallpaper first)",
"index.t056":"Background image","index.t057":"Custom wallpaper (PNG/JPEG/WebP, up to 20MB)",
"index.t058":"Upload image","index.t059":"Clear","index.t060":"Wallpaper brightness",
"index.t061":"Dimming layer strength: 50 for the default look, higher for brighter, lower for darker (applies only when a wallpaper is enabled)",
"index.t062":"UI font size","index.t063":"Overall UI text size in pixels, 10–24; default 14; clear to restore",
"index.t064":"Chat content font size",
"index.t065":"Text size for chat messages (including code blocks) in pixels, 10–24; default 14; clear to restore; independent of UI font size",
"index.t066":"Accent color","index.t067":"Enter a hex color (e.g. #8b80f9); applies as you type",
"index.t068":"App icon",
"index.t069":"Replace the logo in the sidebar and message avatars; PNG/JPEG/WebP, 256×256 recommended (up to 384KB)",
"index.t070":"Upload image","index.t071":"Restore default","index.t072":"Notifications",
"index.t073":"Notifies you when a task round finishes; the chime is synthesized in the browser, and the desktop notification only pops when the window is minimized or you switched to another session",
"index.t074":"Completion chime",
"index.t075":"Play a short two-tone chime when a task finishes (silent on manual stop)",
"index.t076":"On","index.t077":"Desktop notifications",
"index.t078":"Show a system notification when a task finishes; click it to jump back to that session. First-time use requires granting browser notification permission",
"index.t079":"On","index.t080":"Test","index.t081":"Desktop pet",
"index.t082":"A floating desktop widget mirroring task status in real time; compatible with the Codex pet format (pet.json + spritesheet). Drop a pet folder into the directory below to detect it — no restart needed",
"index.t083":"Desktop pet toggle",
"index.t084":"Summon or dismiss the pet; hold to drag, click to greet",
"index.t085":"Summon pet","index.t086":"Pet size",
"index.t087":"Overall scale of the pet window, 50%–200%; applies immediately to a summoned pet and persists after reopening",
"index.t088":"AI interaction",
"index.t089":"While working, the model occasionally drops a playful comment (using the pet model below, saving tokens); tasks sent via the floating input or song requests run a full session (pet model + tools) and are unaffected by this toggle",
"index.t090":"Pet model",
"index.t091":"Model powering the pet's periodic comments and floating-input tasks; a cheap small model works. Leave empty to follow the global model",
"index.t092":"Follow global model","index.t093":"Pet list",
"index.t094":"Scan the install directory and ~/.codex/pets for pets",
})

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
print(f'B1 替换 {hits} 行 (表 {len(T)})')
content = '\n'.join(lines)
missing = [k for k in T if f'"{k}":' not in content]
print('未命中:', missing if missing else '无')
