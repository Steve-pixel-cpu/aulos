# -*- coding: utf-8 -*-
"""测试: 浏览器可见性设置（设置页「行为」分区）的 REST 读写。

POST /api/settings 接受 browser_headless(布尔) / browser_slow_mo(非负整数,
0–10000), 写进 feature_config 并持久化到 settings.json 的 browserHeadless /
browserSlowMo 键; GET /api/settings 回显。非法值 400。
语义与 max_iterations 对齐: 改的是全局默认, 已在跑的浏览器实例不受影响,
browser_close 后下一次调用按新值重开。
"""

import json

import pytest
from fastapi.testclient import TestClient

import aulos.server as server
import aulos.web.server_settings as server_settings


@pytest.fixture()
def client():
    return TestClient(server.app)


@pytest.fixture()
def isolated_settings(tmp_path, monkeypatch):
    """settings.json 指到 tmp, 防止污染真实用户配置。"""
    fake = tmp_path / "settings.json"
    monkeypatch.setattr(server, "SETTINGS_FILE", fake)
    monkeypatch.setattr(server_settings, "SETTINGS_FILE", fake)
    yield fake


class TestGet:
    def test_get_returns_browser_fields(self, client, isolated_settings):
        s = client.get("/api/settings").json()
        assert "browser_headless" in s and "browser_slow_mo" in s
        assert isinstance(s["browser_headless"], bool)
        assert isinstance(s["browser_slow_mo"], int)


class TestPost:
    def test_post_headless_false_roundtrip(self, client, isolated_settings):
        r = client.post("/api/settings", json={"browser_headless": False})
        assert r.status_code == 200
        assert r.json()["browser_headless"] is False
        # feature_config 内存即时生效
        assert server.runtime_config.feature_config.browser_headless is False
        # 持久化键为 camelCase
        assert json.loads(isolated_settings.read_text("utf-8"))["browserHeadless"] is False

    def test_post_slow_mo_roundtrip(self, client, isolated_settings):
        r = client.post("/api/settings", json={"browser_slow_mo": 300})
        assert r.status_code == 200
        assert r.json()["browser_slow_mo"] == 300
        assert server.runtime_config.feature_config.browser_slow_mo == 300
        assert json.loads(isolated_settings.read_text("utf-8"))["browserSlowMo"] == 300

    def test_post_slow_mo_zero_disables(self, client, isolated_settings):
        r = client.post("/api/settings", json={"browser_slow_mo": 0})
        assert r.status_code == 200
        assert r.json()["browser_slow_mo"] == 0

    def test_post_headless_not_bool_400(self, client, isolated_settings):
        # None = 不修改该键（与 max_iterations 语义一致）, 不在非法之列
        for bad in ("no", 1):
            assert client.post("/api/settings",
                               json={"browser_headless": bad}).status_code == 400, bad

    def test_post_slow_mo_not_int_400(self, client, isolated_settings):
        assert client.post("/api/settings",
                           json={"browser_slow_mo": "300"}).status_code == 400
        assert client.post("/api/settings",
                           json={"browser_slow_mo": True}).status_code == 400

    def test_post_slow_mo_negative_400(self, client, isolated_settings):
        assert client.post("/api/settings",
                           json={"browser_slow_mo": -5}).status_code == 400

    def test_post_slow_mo_over_cap_400(self, client, isolated_settings):
        assert client.post("/api/settings",
                           json={"browser_slow_mo": 10001}).status_code == 400

    def test_post_no_browser_keys_leaves_untouched(self, client, isolated_settings):
        """不带 browser 键的普通设置请求不能顺手动浏览器配置。"""
        before = server.runtime_config.feature_config.browser_headless
        client.post("/api/settings", json={"thinking_level": "low"})
        assert server.runtime_config.feature_config.browser_headless == before
