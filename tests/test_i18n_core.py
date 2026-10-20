"""aulos.i18n 核心契约: 双字典一致、回退、插值、语言状态。"""
import json

import pytest

import aulos.i18n as i18n


@pytest.fixture(autouse=True)
def _reset_lang(tmp_path, monkeypatch):
    # 隔离: 不让用例间的语言缓存串味; 同时挡住真实用户配置
    # (本机 settings.json 可能 language=en, current_language 懒读会串味)
    from aulos import config
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "none.json")
    yield
    i18n._current["lang"] = None


def test_zh_en_key_sets_identical():
    assert set(i18n.ZH_STRINGS.keys()) == set(i18n.EN_STRINGS.keys())


def test_default_language_is_zh():
    assert i18n.current_language() == i18n.DEFAULT_LANGUAGE == "zh"


def test_t_returns_zh_by_default_and_en_after_set_language():
    assert "未知语言" in i18n.t("settings.language.invalid", {"value": "fr"})
    i18n.set_language("en")
    assert "Unknown language" in i18n.t("settings.language.invalid", {"value": "fr"})


def test_t_falls_back_to_zh_with_warning(capfd):
    # 人为删掉 en 侧一个 key 模拟漏翻, 验证回退 + 告警
    # (capfd 而非 capsys: print(file=sys.stderr) 在本机走原生 fd,
    #  sys-level 捕获拿不到 —— 探针用例已验证)
    i18n.EN_STRINGS.pop("settings.language.invalid")
    try:
        i18n.set_language("en")
        text = i18n.t("settings.language.invalid", {"value": "fr"})
        assert "未知语言" in text          # 回退到 zh 文案
        assert "missing key" in capfd.readouterr().err
    finally:
        i18n.EN_STRINGS["settings.language.invalid"] = \
            "Unknown language: {value} (supported: zh | en)"


def test_t_interpolates_and_keeps_unknown_placeholder():
    i18n.set_language("zh")
    assert i18n.t("settings.language.invalid", {"value": "fr"}) == \
        "未知语言: fr（可选: zh | en）"
    # 未知占位符原样保留（不抛 KeyError）:
    assert "{nope}" in i18n._fmt("未知语言: {nope}", {})


def test_set_language_rejects_unknown():
    with pytest.raises(ValueError):
        i18n.set_language("fr")


def test_current_language_falls_back_when_settings_missing_or_corrupt(
        tmp_path, monkeypatch):
    from aulos import config
    # 文件不存在
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "none.json")
    assert i18n.current_language() == "zh"
    i18n._current["lang"] = None
    # 文件损坏
    (tmp_path / "bad.json").write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "bad.json")
    assert i18n.current_language() == "zh"
    i18n._current["lang"] = None
    # language 字段非法
    (tmp_path / "ok.json").write_text(
        json.dumps({"language": "fr"}), encoding="utf-8")
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "ok.json")
    assert i18n.current_language() == "zh"


def test_current_language_reads_settings_json(tmp_path, monkeypatch):
    from aulos import config
    (tmp_path / "s.json").write_text(
        json.dumps({"language": "en"}), encoding="utf-8")
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "s.json")
    i18n._current["lang"] = None   # conftest 的 _force_zh_language 已置 zh; 本用例要验证懒读
    assert i18n.current_language() == "en"


def test_language_directive():
    assert i18n.language_directive("en") == \
        "Always write your user-facing replies in English."
    assert i18n.language_directive("zh") is None
    i18n.set_language("en")
    assert i18n.language_directive() == \
        "Always write your user-facing replies in English."
