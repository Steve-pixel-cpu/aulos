"""测试: 529 overloaded 分诊（与 429 同曲线）+ 连续超限换模型指引。

背景（源自 Claude Code 参考设计 01 章「重试按错误码分诊」）:
- Anthropic 529 = 服务端 overloaded, 与 429 同属"账户/容量级瞬态故障",
  连接抖动短曲线(全程 <1s)对它形同虚设——服务端过载窗口同样是秒~分钟级。
  529 归入限流族: 走 2s 起步翻倍(上限 30s)的长曲线 + 专属重试上限。
- 连续多次 429/529 耗尽重试后, 错误消息必须给出可操作的换模型指引
  （rate limit 是供应商侧容量问题, 换供应商/模型是唯一出路）, 而不是让
  模型拿到一句干巴巴的 "failed after N attempts" 猜半天。
"""
import time

import pytest

import retry
from retry import HttpApiError, RetriesExhausted, send_with_retry


@pytest.fixture
def sleeps(monkeypatch):
    record: list[float] = []
    monkeypatch.setattr(time, "sleep", lambda s: record.append(s))
    return record


def _always(exc):
    def _raise():
        raise exc
    return _raise


def test_overloaded_529_is_treated_as_rate_limit(sleeps, monkeypatch):
    """529 走限流长曲线: 重试次数同 429（1 原始 + 4 重试）,
    累计退避同 429 名义曲线（2+4+8+16=30s）。"""
    monkeypatch.setattr(retry.random, "uniform", lambda a, b: 1.0)  # 消抖动
    with pytest.raises(RetriesExhausted) as ei:
        send_with_retry(_always(HttpApiError(529, "overloaded")))
    assert ei.value.attempts == 5
    assert sum(sleeps) == pytest.approx(30.0, abs=1e-6)


def test_529_retries_more_than_generic_5xx(sleeps):
    """分诊生效的直接对照: 500 三次就放弃, 529 撑到五次。"""
    with pytest.raises(RetriesExhausted) as ei500:
        send_with_retry(_always(HttpApiError(500, "boom")))
    assert ei500.value.attempts == 3

    with pytest.raises(RetriesExhausted) as ei529:
        send_with_retry(_always(HttpApiError(529, "overloaded")))
    assert ei529.value.attempts == 5


def test_529_recovers_midway(sleeps):
    calls = {"n": 0}
    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise HttpApiError(529, "overloaded")
        return "ok"
    assert send_with_retry(flaky) == "ok"
    assert calls["n"] == 3


def test_exhausted_429_message_carries_model_switch_hint():
    """429 耗尽: 消息带"换模型/供应商"指引, 指向原始 429。"""
    with pytest.raises(RetriesExhausted) as ei:
        send_with_retry(_always(HttpApiError(429, "rate limited")), max_retries=0)
    msg = str(ei.value)
    assert "429" in msg
    assert "model" in msg.lower()


def test_exhausted_529_message_carries_model_switch_hint():
    with pytest.raises(RetriesExhausted) as ei:
        send_with_retry(_always(HttpApiError(529, "overloaded")), max_retries=0)
    msg = str(ei.value)
    assert "529" in msg
    assert "model" in msg.lower()


def test_exhausted_generic_error_message_unchanged():
    """非超限错误耗尽的消息不带换模型指引（那是限流族专属建议）。"""
    with pytest.raises(RetriesExhausted) as ei:
        send_with_retry(_always(HttpApiError(500, "boom")), max_retries=0)
    msg = str(ei.value)
    assert "500" in msg
    assert "model" not in msg.lower()
