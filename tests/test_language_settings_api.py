"""language 设置项 REST 契约: 读写、落盘、归一化、热生效。"""
import json

import pytest
from fastapi.testclient import TestClient

import aulos.i18n as i18n
import aulos.server as server
import aulos.web.server_settings as server_settings


@pytest.fixture(autouse=True)
def _isolated_settings(tmp_path, monkeypatch):
    # _save_setting 写 server.SETTINGS_FILE; i18n 懒读 config.SETTINGS_FILE
    # —— 两个名字同一目标: 都指到 tmp, 用例间互不污染真实用户配置。
    fake = tmp_path / "settings.json"
    monkeypatch.setattr(server, "SETTINGS_FILE", fake)
    from aulos import config
    monkeypatch.setattr(config, "SETTINGS_FILE", fake)
    i18n._current["lang"] = None
    yield
    i18n._current["lang"] = None


@pytest.fixture()
def client():
    return TestClient(server.app)


def test_get_settings_returns_language_default_zh(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json()["language"] == "zh"


def test_post_language_persists_and_echoes(client, tmp_path):
    r = client.post("/api/settings", json={"language": "en"})
    assert r.status_code == 200
    assert r.json()["language"] == "en"
    data = json.loads((tmp_path / "settings.json").read_text(encoding="utf-8"))
    assert data["language"] == "en"


def test_post_language_normalizes_and_rejects(client):
    assert client.post("/api/settings", json={"language": " EN "}) \
        .json()["language"] == "en"                      # 归一化接受
    resp = client.post("/api/settings", json={"language": "fr"})
    assert resp.status_code == 400
    assert "Unknown language" in resp.json()["detail"]   # detail 走 t()
    resp = client.post("/api/settings", json={"language": ""})
    assert resp.status_code == 400


def test_post_language_resyncs_session_prompts(client, monkeypatch):
    calls = []
    monkeypatch.setattr(
        server_settings, "_resync_session_prompts",
        lambda: calls.append(1))
    client.post("/api/settings", json={"language": "en"})
    assert calls, "改语言必须重挂活跃会话的系统提示词"
