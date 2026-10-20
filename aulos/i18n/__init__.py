"""aulos.i18n — 轻量双语字典运行时（zh/en）。

设计: docs/superpowers/specs/2026-10-20-i18n-bilingual-design.md §3。
规则: 默认/回退语言 zh; 缺 key 回退 zh 并向 stderr 告警; key 点分式;
语言值域 SUPPORTED_LANGUAGES; 注释与日志不走 t()。
"""
from __future__ import annotations

import json
import sys

from aulos.i18n.en import STRINGS as EN_STRINGS
from aulos.i18n.zh import STRINGS as ZH_STRINGS

SUPPORTED_LANGUAGES = ("zh", "en")
DEFAULT_LANGUAGE = "zh"

# AI 回复语言指令（spec §5.2）: en → 英文指令追加在系统提示词末尾;
# zh 不追加（现状即中文, 零行为漂移）。指令本身用英文写, 模型遵循最稳。
AI_LANGUAGE_DIRECTIVES = {
    "en": "Always write your user-facing replies in English.",
}

_DICTS = {"zh": ZH_STRINGS, "en": EN_STRINGS}
_current: dict = {"lang": None}


class _SafeParams(dict):
    """未知占位符原样保留 {key}, 不抛 KeyError。"""

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def set_language(lang: str) -> None:
    normalized = str(lang).strip().lower()
    if normalized not in SUPPORTED_LANGUAGES:
        raise ValueError(f"unsupported language: {lang!r}")
    _current["lang"] = normalized


def current_language() -> str:
    """内存缓存优先; 未设过则懒读 settings.json 一次并缓存。

    读盘走 call-time 的 config.SETTINGS_FILE（与 server_settings._
    save_setting 的 monkeypatch 口径一致）, 文件缺失/损坏/字段非法
    一律静默回落 zh —— i18n 永不因配置损坏打断业务。
    """
    if _current["lang"] is not None:
        return _current["lang"]
    from aulos import config   # call-time 解析, 测试可 monkeypatch
    try:
        data = json.loads(config.SETTINGS_FILE.read_text(encoding="utf-8"))
        lang = str(data.get("language", DEFAULT_LANGUAGE)).strip().lower()
    except (OSError, ValueError, AttributeError):
        lang = DEFAULT_LANGUAGE
    _current["lang"] = lang if lang in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE
    return _current["lang"]


def _fmt(template: str, params: dict | None) -> str:
    if not params:
        return template
    return template.format_map(_SafeParams(params))


def t(key: str, params: dict | None = None, lang: str | None = None) -> str:
    lang = lang or current_language()
    # 注意: 不能用 `_DICTS.get(lang) or zh` —— 空字典是 falsy, 会把
    # "字典存在但为空"误判成"无该语言"而绕过缺 key 告警（测试抓出）。
    table = _DICTS.get(lang, _DICTS[DEFAULT_LANGUAGE])
    if key in table:
        return _fmt(table[key], params)
    if key in _DICTS[DEFAULT_LANGUAGE]:
        print(f"[i18n] missing key {key!r} in {lang!r}, fallback to zh",
              file=sys.stderr)
        return _fmt(_DICTS[DEFAULT_LANGUAGE][key], params)
    print(f"[i18n] missing key {key!r} in all dictionaries", file=sys.stderr)
    return key


def language_directive(lang: str | None = None) -> str | None:
    """追加到系统提示词末尾的回复语言指令; zh/未知 → None（不追加）。"""
    return AI_LANGUAGE_DIRECTIVES.get(lang or current_language())
