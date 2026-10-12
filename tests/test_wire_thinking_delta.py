"""浏览器镜像层: WireThinkingDelta → 前端 thinking_delta 事件透传。

思考增量此前在 _wire_to_frontend 里被静默丢弃（只透传 start/end），前端
"思考中…"胶囊因此只能显示静态文案。本文件钉住透传契约: 内容原样带出、
顺序保持、不产生多余事件。
"""
from server_common import _wire_to_frontend
from api_client import (WireThinkingStart, WireThinkingDelta, WireThinkingEnd,
                        WireTextDelta)


def _drain(events):
    """把 wire 事件按序喂进镜像, 收集 sink 收到的前端事件。"""
    sink_events = []
    state = {}
    for ev in events:
        _wire_to_frontend(ev, sink_events.append, state)
    return sink_events


def test_thinking_delta_transparently_mirrored():
    out = _drain([
        WireThinkingStart(),
        WireThinkingDelta(text="先看看"),
        WireThinkingDelta(text="目录结构"),
        WireThinkingEnd(),
    ])
    assert out == [
        {"type": "thinking_start"},
        {"type": "thinking_delta", "text": "先看看"},
        {"type": "thinking_delta", "text": "目录结构"},
        {"type": "thinking_end", "duration_ms": out[3]["duration_ms"]},
    ]
    assert out[3]["duration_ms"] >= 0


def test_thinking_delta_between_other_blocks_keeps_order():
    """文本 → 思考 → 文本混排: 镜像按线上顺序透传, 不打乱。"""
    out = _drain([
        WireTextDelta(text="正文A"),
        WireThinkingStart(),
        WireThinkingDelta(text="想想"),
        WireThinkingEnd(),
        WireTextDelta(text="正文B"),
    ])
    types = [e["type"] for e in out]
    assert types == ["text_delta", "thinking_start", "thinking_delta",
                     "thinking_end", "text_delta"]


def test_thinking_end_without_start_is_swallowed():
    """缺 start（异常线序）: delta 照常透传, end 因无 t0 不发收口事件——
    行由前端轮次兜底（turn_done/settleBackgroundTurnEnd）收口。"""
    out = _drain([WireThinkingDelta(text="x"), WireThinkingEnd()])
    assert out == [{"type": "thinking_delta", "text": "x"}]
