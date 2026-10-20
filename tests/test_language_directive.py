"""回复语言不注入提示词: AI 跟随用户输入语言, 语言设置只管 UI 文案。"""
import pytest

import aulos.i18n as i18n
import aulos.server as server
from aulos.web.server_pets import _pet_system_prompt


@pytest.fixture(autouse=True)
def _reset_lang():
    yield
    i18n._current["lang"] = None


def test_session_prompt_has_no_language_directive():
    for lang in ("zh", "en"):
        i18n.set_language(lang)
        sections = server._session_system_prompt(None)
        assert all(
            "Always write your user-facing replies" not in s for s in sections)


def test_pet_prompt_has_no_language_directive():
    persona = {"name": "小猫", "style": ""}
    for lang in ("zh", "en"):
        i18n.set_language(lang)
        assert "Always write" not in _pet_system_prompt(persona)
