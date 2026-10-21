# tests/test_subagent_stream_store.py — 子代理流持久化存储层
#
# 契约:
#   1. append_subagent_stream 追加记录, get_subagent_streams 按
#      agent_id 聚合(多条续接, ok/duration 取最后非空值);
#   2. 字节预算: 超限时从最老的整条流开始丢弃, 消息链与其余记录
#      类型原样保留; 流总量未超限时不重写;
#   3. prune_subagent_streams: 保留期内不动; 超期剔除该会话全部
#      流记录(消息链保留);
#   4. 旧会话(无流记录)读写均为空, 不抛错。
import json
from datetime import datetime, timedelta, timezone

import pytest

from aulos.storage import SessionStore, SubagentStreamRecord


@pytest.fixture()
def store(tmp_path):
    return SessionStore(tmp_path)


def _append_ok_session(store, sid="s1"):
    """造一条非流记录(权限模式), 验证清理不动它。"""
    store.set_permission_mode(sid, "prompt", False)


def test_append_and_aggregate(store):
    _append_ok_session(store, "s1")
    store.append_subagent_stream("s1", "ag1",
                                 [{"type": "user_message", "text": "查"}],
                                 ok=None)
    store.append_subagent_stream(
        "s1", "ag1",
        [{"type": "text_delta", "text": "结论…"}, {"type": "tool_use"}],
        ok=True, duration_s=12.5)
    store.append_subagent_stream("s1", "ag2",
                                 [{"type": "user_message", "text": "另查"}],
                                 ok=False, duration_s=3.0)

    streams = store.get_subagent_streams("s1")
    assert set(streams) == {"ag1", "ag2"}
    # ag1: 两批续接, 终态取最后一批
    assert [e["type"] for e in streams["ag1"]["events"]] == \
        ["user_message", "text_delta", "tool_use"]
    assert streams["ag1"]["ok"] is True
    assert streams["ag1"]["duration_s"] == 12.5
    # ag2: 失败终态
    assert streams["ag2"]["ok"] is False

    # 非流记录不受影响
    assert store.get_permission_mode("s1") == ("prompt", False)


def test_byte_budget_drops_oldest_stream_first(store, monkeypatch):
    _append_ok_session(store, "s2")
    # 预算压到 1MB: ag1(老) 1 批 800KB + ag2(新) 2 批各 700KB
    # → 总 2.2MB 超限, 丢 ag1 整批后 1.4MB 仍略超 → 再丢 ag2#1
    # → 剩 ag2#2 700KB 达标。断言只验"老流先走、新流终态保留"。
    monkeypatch.setattr(store, "SUBAGENT_STREAM_BUDGET", 1024 * 1024)
    big1 = "x" * 800_000
    big2 = "y" * 700_000
    store.append_subagent_stream("s2", "ag1", [{"type": "text_delta",
                                                "text": big1}], ok=True)
    store.append_subagent_stream("s2", "ag2", [{"type": "text_delta",
                                                "text": big2}])
    store.append_subagent_stream("s2", "ag2", [{"type": "text_delta",
                                                "text": big2}], ok=True,
                                 duration_s=5.0)

    streams = store.get_subagent_streams("s2")
    assert "ag1" not in streams, "最老的流先被整条丢弃"
    assert "ag2" in streams, "新流保留"
    assert streams["ag2"]["ok"] is True, "保留的流终态完好"
    assert streams["ag2"]["duration_s"] == 5.0
    # 非流记录仍在
    assert store.get_permission_mode("s2") == ("prompt", False)


def test_budget_no_rewrite_when_only_messages_exceed(store):
    """流总量未超限(超的是消息本体)时不做无谓重写。"""
    _append_ok_session(store, "s3")
    store.append_subagent_stream("s3", "ag1",
                                 [{"type": "user_message", "text": "小流"}],
                                 ok=True)
    # 不直接造 2MB 消息(慢); 直接调内部方法验证"流未超限不重写"
    path = store._session_path("s3")
    before = path.read_text(encoding="utf-8")
    store._enforce_stream_budget("s3")
    assert path.read_text(encoding="utf-8") == before


def test_prune_by_retention(store):
    _append_ok_session(store, "s4")
    # 老记录: 手写一条 8 天前的流
    path = store._session_path("s4")
    old_ts = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(SubagentStreamRecord(
            agent_id="old1",
            events=[{"type": "user_message", "text": "老流"}],
            ok=True, duration_s=1.0,
            timestamp=old_ts).model_dump()) + "\n")
    store.append_subagent_stream("s4", "new1",
                                 [{"type": "user_message", "text": "新流"}],
                                 ok=True)

    # 保留期内(有 8 天前的记录 → 整会话剔除) 7 天保留期 → 剔除
    assert store.prune_subagent_streams("s4", retention_days=7) is True
    assert store.get_subagent_streams("s4") == {}
    # 消息/权限记录保留
    assert store.get_permission_mode("s4") == ("prompt", False)
    # 再跑一遍: 无流记录 → False
    assert store.prune_subagent_streams("s4", retention_days=7) is False


def test_prune_fresh_stream_kept(store):
    _append_ok_session(store, "s5")
    store.append_subagent_stream("s5", "ag1",
                                 [{"type": "user_message", "text": "今晨"}],
                                 ok=True)
    assert store.prune_subagent_streams("s5", retention_days=7) is False
    assert "ag1" in store.get_subagent_streams("s5")


def test_legacy_session_without_streams(store):
    """旧会话: 只有消息/权限记录, 流读取为空、prune 为 False。"""
    _append_ok_session(store, "s6")
    assert store.get_subagent_streams("s6") == {}
    assert store.prune_subagent_streams("s6", retention_days=7) is False
