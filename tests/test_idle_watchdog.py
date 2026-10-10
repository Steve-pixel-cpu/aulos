"""测试: 流式 idle watchdog——SSE 流两条事件之间的最大等待间隔。

背景: 此前 read 超时 300s, 一条 stalled 连接最坏把 run_turn 挂死 5 分钟
且无任何反馈。参照 Claude Code 的 90s idle watchdog 收紧: 连接建立后,
任意两条流式事件之间超过 idle 上限即 httpx.ReadTimeout → 快速失败落入
建连重试/错误路径, 而不是干等。env CLAUDE_STREAM_IDLE_TIMEOUT_S 可覆盖
（个别慢供应商深度思考期间长期不吐事件, 调大即解）。"""
import pytest

import api_client


def test_default_idle_timeout_is_90s(monkeypatch):
    monkeypatch.delenv("CLAUDE_STREAM_IDLE_TIMEOUT_S", raising=False)
    assert api_client._api_idle_timeout_s() == 90.0


def test_env_overrides_idle_timeout(monkeypatch):
    monkeypatch.setenv("CLAUDE_STREAM_IDLE_TIMEOUT_S", "180")
    assert api_client._api_idle_timeout_s() == 180.0


@pytest.mark.parametrize("raw", ["abc", "-5", "0", ""])
def test_env_garbage_falls_back_to_default(monkeypatch, raw):
    monkeypatch.setenv("CLAUDE_STREAM_IDLE_TIMEOUT_S", raw)
    assert api_client._api_idle_timeout_s() == 90.0


def test_stream_timeout_uses_watchdog_as_read():
    t = api_client._api_stream_timeout()
    assert t.read == 90.0
    assert t.connect == api_client.API_CONNECT_TIMEOUT_S


def test_watchdog_much_shorter_than_legacy_300s():
    """钉住收紧的语义: watchdog 必须显著小于旧值 300s, 否则挂死治理无效。"""
    assert api_client.API_IDLE_WATCHDOG_S < 300.0
