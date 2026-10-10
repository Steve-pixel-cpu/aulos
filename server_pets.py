# server_pets.py — REST: 桌宠（server 包拆分的第 4 步）
#
# 兼容 Codex 宠物格式: <pets>/<pet-id>/pet.json + spritesheet 图集。
# 含图集扫描/校验、精灵图服务、周期点评 side-call。从 server.py 原样搬移。
"""Aulos web — 桌宠 API。"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from contextlib import suppress
from pathlib import Path
from typing import Optional

from fastapi import Body, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from api_client import make_api_client, normalize_base_url as _normalize_base_url, \
    normalize_protocol
from config import USER_DIR
from main import TOOLS
from server_common import api_client, app

# Codex 图集契约: 固定 1536 宽、8 列; v1 高 1872(9 行), v2 高 2288(11 行,
# 末两行是环视——本次也接受, 前端只播 0-8 行)。单格 192×208。
_PET_SHEET_WIDTH = 1536
_PET_ROW_HEIGHT = 208
_PET_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_PET_SHEET_FALLBACKS = ("spritesheet.webp", "spritesheet.png", "spritesheet.gif")
_PET_SHEET_MEDIA = {".webp": "image/webp", ".png": "image/png", ".gif": "image/gif"}

# id → 精灵图绝对路径, 每次 /api/pets 重扫时整体重建（事件循环内串行, 无锁）
_pet_sheets: dict[str, Path] = {}


def _pets_dirs() -> list[tuple[Path, str]]:
    """宠物目录候选（按优先级, id 冲突靠前者胜）: 用户目录 → 安装目录 → Codex。
    用户目录 ~/.aulos/pets 是唯一可写目录, 「打开目录」开的就是它——
    用户宠物不能往安装目录里放: 冻结态装在 Program Files 下不可写,
    升级换目录还会被清掉; 源码态写仓库会污染源码树。
    安装目录候选是安装包自带的只读样例（冻结态后端在 <安装>/resources/server/
    下, 向上两级是安装根, Tauri 布局 pets 装在 <安装>/pets; Electron 布局
    资源落在 resources/pets 一并兼容）; 源码态附带回仓库 pets/ 里的开发样例。
    Codex 目录支持 CODEX_HOME 覆盖, 只读。
    返回 (目录, 来源标签) 对, 来源供前端区分 install/codex。"""
    codex_home = os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
    codex = (Path(codex_home) / "pets", "codex")
    user = (USER_DIR / "pets", "user")
    if getattr(sys, "frozen", False):
        server_dir = Path(sys.executable).resolve().parent
        return [user,
                (server_dir.parent.parent / "pets", "install"),   # Tauri: <安装>/pets
                (server_dir.parent / "pets", "install"),          # Electron: resources/pets
                codex]
    return [user,
            (Path(__file__).resolve().parent / "pets", "install"),  # 开发样例
            codex]


def _image_size(path: Path) -> Optional[tuple[int, int]]:
    """读文件头取宽高（宠物图集只可能是 PNG/WebP/GIF 三种）。失败返回 None。"""
    try:
        head = path.read_bytes()[:32]
    except OSError:
        return None
    if head.startswith(b"\x89PNG\r\n\x1a\n") and len(head) >= 24:
        return (int.from_bytes(head[16:20], "big"),
                int.from_bytes(head[20:24], "big"))
    if head[:6] in (b"GIF87a", b"GIF89a") and len(head) >= 10:
        return (int.from_bytes(head[6:8], "little"),
                int.from_bytes(head[8:10], "little"))
    if len(head) >= 30 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        if head[12:16] == b"VP8X":   # 扩展头: canvas 尺寸存 1 偏移的 3 字节
            return (int.from_bytes(head[24:27], "little") + 1,
                    int.from_bytes(head[27:30], "little") + 1)
        if head[12:16] == b"VP8 ":   # 有损: 关键帧起始码后跟 14bit 宽高
            return (int.from_bytes(head[26:28], "little") & 0x3FFF,
                    int.from_bytes(head[28:30], "little") & 0x3FFF)
        if head[12:16] == b"VP8L" and len(head) >= 25:   # 无损: 宽高拆位存 4 字节
            b = head[21:25]
            return (1 + (((b[1] & 0x3F) << 8) | b[0]),
                    1 + (((b[3] & 0x0F) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6)))
    return None


def _pet_persona(raw: dict) -> dict:
    """pet.json persona 字段白名单清洗: 人设只有 name/style 两个自由文本槽,
    lines 是事件台词包(分组名 → 句子数组)。超长截断, 空段丢弃。"""
    out: dict = {}
    name = raw.get("name")
    if isinstance(name, str) and name.strip():
        out["name"] = name.strip()[:40]
    style = raw.get("style")
    if isinstance(style, str) and style.strip():
        out["style"] = " ".join(style.split())[:300]
    lines = raw.get("lines")
    if isinstance(lines, dict):
        clean: dict[str, list[str]] = {}
        for group, arr in lines.items():
            if not isinstance(arr, list):
                continue
            ls = [s.strip() for s in arr if isinstance(s, str) and s.strip()]
            if ls:
                clean[str(group)[:20]] = ls[:12]
        if clean:
            out["lines"] = clean
    return out


def _scan_pet_folder(folder: Path, source: str) -> Optional[tuple[dict, Path]]:
    """解析一个宠物文件夹: manifest 缺字段回退, 找到合规精灵图才算宠物。
    manifest 的 spritesheetPath 必须仍解析在文件夹内——Codex 生态的防穿越
    约定。返回 (信息, 精灵图路径) 或 None。"""
    manifest: dict = {}
    try:
        loaded = json.loads((folder / "pet.json").read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            manifest = loaded
    except (OSError, ValueError):
        pass
    sheet: Optional[Path] = None
    rel = manifest.get("spritesheetPath")
    if isinstance(rel, str) and rel:
        cand = (folder / rel).resolve()
        try:
            cand.relative_to(folder.resolve())
        except ValueError:
            cand = None
        if cand and cand.is_file():
            sheet = cand
    if sheet is None:
        for name in _PET_SHEET_FALLBACKS:
            if (folder / name).is_file():
                sheet = folder / name
                break
    if sheet is None:
        return None
    size = _image_size(sheet)
    # 图集契约硬校验: 宽 1536、高是 208 的整数倍且行数只认 9(v1)/11(v2)
    if (not size or size[0] != _PET_SHEET_WIDTH
            or size[1] % _PET_ROW_HEIGHT
            or size[1] // _PET_ROW_HEIGHT not in (9, 11)):
        return None
    pid = folder.name
    name = manifest.get("displayName")
    desc = manifest.get("description")
    info = {"id": pid,
            "displayName": name.strip() if isinstance(name, str) and name.strip() else pid,
            "description": desc.strip() if isinstance(desc, str) else "",
            "source": source,
            "rows": size[1] // _PET_ROW_HEIGHT}
    persona = manifest.get("persona")
    if isinstance(persona, dict):
        cleaned = _pet_persona(persona)
        if cleaned:
            info["persona"] = cleaned
    return (info, sheet)


def _list_pets() -> dict:
    """扫描全部宠物目录。首个候选(用户目录)顺手建出来——用户要往里放宠物;
    其余目录(内置样例/ Codex 的)只读, 不存在就跳过。"""
    dirs = _pets_dirs()
    with suppress(OSError):
        dirs[0][0].mkdir(parents=True, exist_ok=True)
    pets: list[dict] = []
    sheets: dict[str, Path] = {}
    seen: set[str] = set()
    for d, source in dirs:
        try:
            entries = sorted(d.iterdir())
        except OSError:
            continue
        for folder in entries:
            pid = folder.name
            if (pid in seen or not folder.is_dir()
                    or not _PET_ID_RE.match(pid)):
                continue
            found = _scan_pet_folder(folder, source)
            if found:
                info, sheet = found
                seen.add(pid)
                sheets[pid] = sheet
                pets.append(info)
    _pet_sheets.clear()
    _pet_sheets.update(sheets)
    return {"petsDir": str(dirs[0][0]), "pets": pets}


@app.get("/api/pets")
async def api_pets():
    """桌宠列表: 安装目录 + ~/.codex/pets 里所有符合图集契约的宠物。"""
    # no-store: 列表必须每次回源。WebView2 的启发式缓存会把无缓存头的响应
    # 存下来——悬浮窗启动拉旧列表, 刷新进来的新宠物"不存在", 选它唤醒白屏,
    # 得重启应用才恢复(实测)。
    return JSONResponse(_list_pets(), headers={"Cache-Control": "no-store"})


@app.get("/api/pets/{pid}/sheet")
async def api_pet_sheet(pid: str):
    """宠物精灵图。id 只认白名单字符, 杜绝路径穿越; 命中不了缓存就重扫一次
    （进程启动后才放进目录的宠物不必重启）。"""
    if not _PET_ID_RE.match(pid):
        raise HTTPException(status_code=404, detail="宠物不存在")
    sheet = _pet_sheets.get(pid)
    if sheet is None:
        _list_pets()
        sheet = _pet_sheets.get(pid)
    if sheet is None or not sheet.is_file():
        raise HTTPException(status_code=404, detail="宠物不存在")
    # no-cache: 图集允许缓存但要回源验证, 替换图集后各窗口能拿到新图
    return FileResponse(
        sheet,
        media_type=_PET_SHEET_MEDIA.get(sheet.suffix.lower(), "application/octet-stream"),
        headers={"Cache-Control": "no-cache"},
    )


@app.post("/api/pets/open-dir")
async def api_pets_open_dir():
    """设置页「打开目录」: 在系统文件管理器里打开宠物目录,
    用户把宠物文件夹直接丢进去即可(与 /api/open-config 同一套打法)。"""
    d = _pets_dirs()[0][0]
    d.mkdir(parents=True, exist_ok=True)
    try:
        if sys.platform == "win32":
            os.startfile(str(d))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(d)])
        else:
            subprocess.Popen(["xdg-open", str(d)])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"打开失败: {e}")
    return {"ok": True}


# ============================================================================
# 桌宠周期点评（现场统计 + pet.json 人设 → 一句应景台词; 悬浮输入框
# 的任务/点歌走完整 agent 会话, 不经过这里）
# ============================================================================

_PET_DEFAULT_STYLE = ("摸鱼搭子: 住在主人屏幕上的电子小同事, 会吐槽会捧场, "
                      "陪摸鱼也催干活, 对点歌点单来者不拒")


def _pet_system_prompt(persona: dict) -> str:
    """桌宠 system prompt: 人设来自 pet.json(前端透传), 交互规则留在代码里。
    规则收紧到"一句话 + JSON 输出", 让便宜小模型也能稳定被解析。"""
    name = str(persona.get("name") or "").strip() or "桌宠"
    style = str(persona.get("style") or "").strip() or _PET_DEFAULT_STYLE
    return "\n".join([
        f"你是桌面宠物「{name}」, 住在主人的电脑屏幕上。",
        f"人设: {style}",
        "说话规则: 每次只说一句话, 最多 20 个字; 口语化、有趣; 不用引号、"
        "换行、序号和 emoji; 不复述代码或命令内容。",
        '输出格式: 只输出一个 JSON 对象: {"say": "你要说的话"}。',
    ])


def _pet_quip_prompt(state: dict) -> str:
    """点评/事件台词的现场上下文: 只有工具名与计数, 永不携带代码/命令内容。
    event 存在 = 事件驱动台词(针对刚发生的事说), 否则是兜底随机点评。"""
    parts: list[str] = []
    event = str(state.get("event") or "").strip()
    if event:
        parts.append("刚刚发生: " + event[:100])
    base = str(state.get("base") or "idle")
    parts.append("当前状态: " + ("正在打工" if base.startswith("running") else "空闲摸鱼"))
    minutes = state.get("run_minutes")
    if isinstance(minutes, (int, float)) and minutes >= 1:
        parts.append(f"这一轮已经跑了 {int(minutes)} 分钟")
    top = str(state.get("top_tools") or "").strip()
    if top:
        parts.append("用得最多的工具: " + top[:60])
    errs = state.get("errors")
    if isinstance(errs, int) and errs > 0:
        parts.append(f"出错 {errs} 次")
    hour = state.get("hour")
    if isinstance(hour, int) and 0 <= hour <= 23:
        parts.append(f"现在 {hour} 点")
    busy = state.get("busy_sessions")
    if isinstance(busy, int) and busy > 0:
        parts.append(f"有 {busy} 个会话在干活")
    tail = ("针对刚发生的这件事, 说一句应景的吐槽"
            if event else "结合人设和现场说一句应景的点评")
    return "\n".join(parts) + "\n" + tail


def _pet_parse_reply(text: str) -> dict:
    """宽松解析 LLM 回复: 取首个平衡 {...} 块认 JSON。没有花括号 → 整段
    当 say(模型无视格式的兜底); 有花括号但认不出/截断 → 空 say——
    半截 JSON 不当人话, 前端有内置台词兜底。"""
    t = (text or "").strip().strip("`")
    start = t.find("{")
    if start < 0:
        return {"say": " ".join(t.split())[:80] if t else ""}
    depth = 0
    for i in range(start, len(t)):
        if t[i] == "{":
            depth += 1
        elif t[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(t[start:i + 1])
                except ValueError:
                    return {"say": ""}
                if isinstance(obj, dict) and isinstance(obj.get("say"), str):
                    return {"say": " ".join(obj["say"].split())[:80]}
                return {"say": ""}
    return {"say": ""}


# 桌宠专属 client 单槽缓存: (provider_id, api_key, base_url, protocol, model, cli)。
# 桌宠同一时刻只用一个模型, 任何连接要素变化即重建——构建很轻(SDK 客户端初始化)。
_pet_client: Optional[tuple] = None


def _pet_api_client(provider_id: Optional[str], model_id: Optional[str]):
    """桌宠请求所用 client: 未指定模型 → 全局单例(跟随全局模型);
    指定 provider|model → 按该供应商配置构建专属 client(用户选的便宜小模型)。
    供应商被删/禁用回落全局。不挂镜像/打断钩子——generate_text 是直连
    SDK 的一次性调用, 不进轮次循环, 也不该被"点停止"打断。"""
    global _pet_client
    # 延迟 import: 供应商运行态归 server 主模块所有（_apply_provider_config
    # 维护 _provider_cfg）, common 不能反向依赖它
    from server import _provider_cfg   # noqa: PLC0415
    active = _provider_cfg.get("active") or {}
    if not provider_id or provider_id == active.get("provider"):
        return api_client
    prov = next((p for p in _provider_cfg.get("providers", [])
                 if p.get("id") == provider_id), None)
    if not prov or not prov.get("enabled"):
        return api_client
    protocol = _protocol_of(prov)
    base_url = _normalize_base_url(prov.get("base_url"), protocol=protocol) or None
    api_key = prov.get("api_key") or ""
    cached = _pet_client
    if (cached is not None and cached[0] == provider_id and cached[1] == api_key
            and cached[2] == base_url and cached[3] == protocol
            and cached[4] == (model_id or "")):
        return cached[5]
    cli = make_api_client(
        protocol, api_key=api_key, model=model_id or "", base_url=base_url,
        tools=TOOLS, emit_output=False,
    )
    _pet_client = (provider_id, api_key, base_url, protocol, model_id or "", cli)
    return cli


def _protocol_of(prov: dict) -> str:
    """供应商条目的协议标识（缺失/空 = anthropic, 向后兼容旧配置）。"""
    try:
        return normalize_protocol(prov.get("protocol"))
    except ValueError:
        return normalize_protocol(None)


@app.post("/api/pet/chat")
def api_pet_chat(payload: Optional[dict] = Body(None)):
    """桌宠周期点评: 现场统计(事件/工具直方图/时长, 全是数字) + pet.json
    人设 → 一句应景台词。同 _ai_title 的 side-call 打法: 一次性生成,
    无工具、不进会话历史。隐私红线: 入参只收工具名/计数, 不收代码内容。
    任何失败返回 {"say": ""}, 前端回退内置台词, 桌宠永不因 AI 失败而沉默。"""
    data = payload if isinstance(payload, dict) else {}
    persona = data.get("persona") if isinstance(data.get("persona"), dict) else {}
    cli = _pet_api_client(str(data.get("provider_id") or "").strip() or None,
                          str(data.get("model_id") or "").strip() or None)
    state = data.get("state") if isinstance(data.get("state"), dict) else {}
    try:
        raw = cli.generate_text(
            [_pet_system_prompt(persona)], _pet_quip_prompt(state), 64)
    except Exception:
        return {"say": ""}
    return _pet_parse_reply(raw)


@app.get("/api/ping")
async def api_ping():
    """探测端点: 桌面壳用它确认"这是 aulos 后端"。
    8000 端口可能被 C-Lodop 打印服务等程序抢占, 不能只看 200 就当作就绪。"""
    return {"app": "aulos"}
