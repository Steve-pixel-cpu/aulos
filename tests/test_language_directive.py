"""语言指令注入: en 追加到系统提示词末尾, zh 不追加（现状零漂移）。"""
import pytest

import aulos.i18n as i18n
import aulos.server as server
from aulos.web.server_pets import _pet_system_prompt


@pytest.fixture(autouse=True)
def _reset_lang():
    yield
    i18n._current["lang"] = None


def test_session_prompt_zh_has_no_directive():
    i18n.set_language("zh")
    sections = server._session_system_prompt(None)
    assert all(
        "Always write your user-facing replies" not in s for s in sections)


def test_session_prompt_en_appends_directive_last():
    i18n.set_language("en")
    sections = server._session_system_prompt(None)
    assert sections[-1] == i18n.AI_LANGUAGE_DIRECTIVES["en"]


def test_pet_prompt_follows_language():
    persona = {"name": "小猫", "style": ""}
    i18n.set_language("zh")
    assert "Always write" not in _pet_system_prompt(persona)
    i18n.set_language("en")
    assert _pet_system_prompt(persona).endswith(
        i18n.AI_LANGUAGE_DIRECTIVES["en"])
