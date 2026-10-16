"""workerProvider（子代理执行层模型分层）的验收测试。

配置: settings.json 的 workerProvider = {"provider": <id>, "model": <名>}。
配置后子代理（subagent worker）走该供应商+模型——"强模型 Leader 做诊断/
规划, 便宜模型 worker 做执行"; 未配置/无效配置回落会话继承（原行为）。
生效时机: 每次 spawn 现读设置, 保存即对下一次派发生效（无需重启/重建）。

与 utilityProvider 的口径差异: model 留空视为未配置（worker 的意义就在
换便宜模型, 不存在"换供应商不换模型"档）。

运行: uv run pytest tests/test_worker_provider.py -v
"""

import asyncio
import json
from types import SimpleNamespace

import pytest

import aulos.agent_tools as agent_tools
import aulos.config as config
from aulos.config import load_worker_provider


# ------------------------------------------------------------
# 配置解析: 校验失败一律回落 None（调用方回落会话继承）
# ------------------------------------------------------------

def _write_settings(tmp_path, data):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def _providers():
    return [{
        "id": "budget", "enabled": True, "api_key": "uk-123",
        "base_url": "https://budget.example.com", "protocol": "anthropic",
    }]


def test_no_settings_file(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "absent.json")
    assert load_worker_provider() is None


def test_valid_worker_provider(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "SETTINGS_FILE", _write_settings(tmp_path, {
        "providers": _providers(),
        "workerProvider": {"provider": "budget", "model": "glm-4.5-air"},
    }))
    cfg = load_worker_provider()
    assert cfg == {"api_key": "uk-123",
                   "base_url": "https://budget.example.com",
                   "protocol": "anthropic",
                   "model": "glm-4.5-air"}


@pytest.mark.parametrize("mutate", [
    lambda d: d.pop("workerProvider"),                              # 未配置
    lambda d: d["workerProvider"].update({"provider": "ghost"}),    # 指向不存在
    lambda d: d["providers"][0].update({"enabled": False}),         # 被禁用
    lambda d: d["providers"][0].pop("api_key"),                     # 缺 key
    lambda d: d["providers"][0].update({"base_url": ""}),           # 缺地址
    lambda d: d["workerProvider"].update({"model": "  "}),          # 模型留空
])
def test_invalid_config_falls_back_to_none(monkeypatch, tmp_path, mutate):
    data = {"providers": _providers(),
            "workerProvider": {"provider": "budget", "model": "glm-4.5-air"}}
    mutate(data)
    monkeypatch.setattr(config, "SETTINGS_FILE",
                        _write_settings(tmp_path, data))
    assert load_worker_provider() is None


# ------------------------------------------------------------
# spawn 接线: worker_api_config 优先于会话继承
# ------------------------------------------------------------

SESSION_CONFIG = ("session-key", "https://session.example.com",
                  "glm-5.3", "anthropic")


def _capture_orchestrator(captured):
    """假编排器: spawn 只记录调用参数（含 api_config）不起线程。"""
    def fake_spawn(**kwargs):
        captured.append(kwargs)
        return SimpleNamespace(agent_id="test000000001", subagent_type="general",
                               status="running")
    return SimpleNamespace(spawn_agent=fake_spawn)


def _spawn(params=None, monkeypatch=None, settings=None):
    captured = []
    monkeypatch.setattr(agent_tools, "get_orchestrator",
                        lambda: _capture_orchestrator(captured))
    if settings is None:
        monkeypatch.setattr(config, "SETTINGS_FILE",
                            config.SETTINGS_FILE.with_name("absent.json"))
    else:
        monkeypatch.setattr(config, "SETTINGS_FILE", settings)
    out = agent_tools.spawn_agent_tool(params or {
        "description": "d", "prompt": "p"}, workdir=None)
    assert not out.startswith("ERROR"), out
    return captured[0]


def test_spawn_prefers_worker_provider(monkeypatch, tmp_path):
    """配置了 workerProvider: worker 连接走便宜模型, 不再继承会话配置。"""
    monkeypatch.setattr(agent_tools, "current_session_api_config",
                        lambda: SESSION_CONFIG)
    job = _spawn(monkeypatch=monkeypatch, settings=_write_settings(tmp_path, {
        "providers": _providers(),
        "workerProvider": {"provider": "budget", "model": "glm-4.5-air"},
    }))
    api_key, base_url, model, protocol = job["api_config"]
    assert (api_key, base_url, model, protocol) == (
        "uk-123", "https://budget.example.com", "glm-4.5-air", "anthropic")


def test_spawn_falls_back_to_session_without_config(monkeypatch, tmp_path):
    """未配置: 回落会话继承（原行为）, 连接信息逐字段一致。"""
    monkeypatch.setattr(agent_tools, "current_session_api_config",
                        lambda: SESSION_CONFIG)
    job = _spawn(monkeypatch=monkeypatch, settings=_write_settings(tmp_path, {
        "providers": _providers()}))
    assert job["api_config"] == SESSION_CONFIG


def test_spawn_invalid_worker_config_falls_back(monkeypatch, tmp_path):
    """配了但无效（供应商被禁用）: 静默回落会话继承, 不阻断 spawn。"""
    monkeypatch.setattr(agent_tools, "current_session_api_config",
                        lambda: SESSION_CONFIG)
    providers = _providers()
    providers[0]["enabled"] = False
    job = _spawn(monkeypatch=monkeypatch, settings=_write_settings(tmp_path, {
        "providers": providers,
        "workerProvider": {"provider": "budget", "model": "glm-4.5-air"},
    }))
    assert job["api_config"] == SESSION_CONFIG


# ------------------------------------------------------------
# 设置页 UI 的读写对与 API
# ------------------------------------------------------------

from aulos.config import (load_worker_provider_setting,  # noqa: E402
                    save_worker_provider_setting)


def test_setting_roundtrip_and_clear(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    assert load_worker_provider_setting() == {"provider": None, "model": None}

    saved = save_worker_provider_setting({"provider": " budget ", "model": " air "})
    assert saved == {"provider": "budget", "model": "air"}     # 清洗空白
    assert load_worker_provider_setting() == saved

    save_worker_provider_setting({"provider": "", "model": "air"})
    assert load_worker_provider_setting() == {"provider": None, "model": None}


def test_save_preserves_other_settings_keys(monkeypatch, tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({
        "providers": _providers(), "activeProvider": {"provider": "budget"},
        "utilityProvider": {"provider": "budget", "model": "air"},
        "commandAllowlist": ["git push"],
    }, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(config, "SETTINGS_FILE", path)

    save_worker_provider_setting({"provider": "budget", "model": "flash"})

    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["providers"] == _providers()                   # 其他 key 原样
    assert data["utilityProvider"] == {"provider": "budget", "model": "air"}
    assert data["commandAllowlist"] == ["git push"]
    assert data["workerProvider"] == {"provider": "budget", "model": "flash"}


def test_api_roundtrip_no_client_rebuild(monkeypatch, tmp_path):
    """保存 → 对下一次派生即生效（无 client 重建语义）: 返回有效性与
    将生效的模型名; 清除 → 回落。"""
    import aulos.server as server
    from aulos.web.server_settings import (api_get_worker_provider,
                                     api_save_worker_provider)
    monkeypatch.setattr(config, "SETTINGS_FILE", _write_settings(tmp_path, {
        "providers": _providers()}))
    monkeypatch.setattr(server, "_provider_cfg", {
        "providers": _providers(), "active": {}})

    saved = asyncio.run(api_save_worker_provider(
        {"provider": "budget", "model": "glm-4.5-air"}))
    assert saved == {"provider": "budget", "model": "glm-4.5-air",
                     "valid": True, "effective_model": "glm-4.5-air"}
    # 保存即落盘: worker 下一次 spawn 现读即生效
    assert load_worker_provider()["model"] == "glm-4.5-air"

    view = asyncio.run(api_get_worker_provider())
    assert view["provider"] == "budget" and view["valid"] is True
    assert "api_key" not in view                            # 原始设置不含 key

    cleared = asyncio.run(api_save_worker_provider(
        {"provider": "", "model": ""}))
    assert cleared["provider"] is None and cleared["valid"] is False


def test_api_rejects_unknown_provider(monkeypatch, tmp_path):
    from fastapi import HTTPException
    import aulos.server as server
    from aulos.web.server_settings import api_save_worker_provider
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(server, "_provider_cfg", {
        "providers": _providers(), "active": {}})
    with pytest.raises(HTTPException) as ei:
        asyncio.run(api_save_worker_provider(
            {"provider": "ghost", "model": "x"}))
    assert "ghost" in ei.value.detail
    assert load_worker_provider_setting()["provider"] is None   # 拒绝时不落盘
