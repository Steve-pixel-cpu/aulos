"""会话归档: 存储层 + REST API 测试。

归档 = 追加一条 ArchiveRecord（与 title/workdir 同一套追加式哲学）,
不挪文件、不动消息链; 取最新一条记录为准。验证:
- 存储层: 记录往返、取最新、meta 默认值与缓存失效
- REST: /api/sessions 列表带 archived 字段; 单会话归档/恢复;
  404/409 边界; 批量归档按天数计数（busy 跳过）; WS 发消息自动取消归档
"""

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from aulos.storage import ArchiveRecord, SessionStore


def add_msg(store: SessionStore, sid: str, role: str, text: str,
            parent: str = None) -> str:
    from aulos.models import Message, TextContentBlock
    msg = Message(role=role,
                  content=[TextContentBlock(text=text)] if text else [])
    return store.save_message(sid, msg, parent)


def empty_meta() -> dict:
    return {"title": None, "count": 0, "workdir": None, "mode": None,
            "plan": False, "provider_id": None, "model_id": None,
            "first_user_text": None, "archived": False}


# ============================================================
# 存储层
# ============================================================

class TestArchiveStorage:
    def test_default_not_archived(self, tmp_path):
        """没有归档记录的会话 meta.archived 必须是 False（全量旧会话零迁移）。"""
        store = SessionStore(tmp_path)
        add_msg(store, "s1", "user", "hi")
        assert store.get_session_meta("s1")["archived"] is False
        # 未落盘（pending）同样 False
        assert store.get_session_meta("ghost")["archived"] is False

    def test_archive_roundtrip_and_latest_wins(self, tmp_path):
        """归档/恢复 = 追加记录; 展示永远取最新一条。"""
        store = SessionStore(tmp_path)
        add_msg(store, "s1", "user", "hi")
        store.archive_session("s1", True)
        assert store.get_session_meta("s1")["archived"] is True
        store.archive_session("s1", False)
        assert store.get_session_meta("s1")["archived"] is False
        # 再归档: 记录共存, 最新生效
        store.archive_session("s1", True)
        assert store.get_session_meta("s1")["archived"] is True

    def test_archive_record_only_no_messages(self, tmp_path):
        """只有归档记录没有消息的会话（先归档后落盘的极端序）也能取到。"""
        store = SessionStore(tmp_path)
        store.archive_session("s0", True)
        assert store.get_session_meta("s0")["archived"] is True
        assert store.get_session_meta("s0")["count"] == 0

    def test_archive_keeps_messages_untouched(self, tmp_path):
        """归档不动消息链: load_session 结果与归档前一致。"""
        store = SessionStore(tmp_path)
        p = add_msg(store, "s1", "user", "问题")
        add_msg(store, "s1", "assistant", "回答", parent=p)
        before = store.load_session("s1")[0]
        store.archive_session("s1", True)
        after = store.load_session("s1")[0]
        assert len(after) == len(before) == 2
        assert [m.model_dump() for m in after] == [m.model_dump() for m in before]

    def test_archive_cache_invalidates(self, tmp_path):
        """归档记录追加必改 mtime/size → meta 缓存自然失效。"""
        store = SessionStore(tmp_path)
        add_msg(store, "s1", "user", "hi")
        assert store.get_session_meta("s1")["archived"] is False   # 预热缓存
        store.archive_session("s1", True)
        assert store.get_session_meta("s1")["archived"] is True

    def test_archive_record_persists_across_instances(self, tmp_path):
        """跨进程语义: 另一个 SessionStore 实例读到同一份归档状态。"""
        store_a = SessionStore(tmp_path)
        add_msg(store_a, "s1", "user", "hi")
        store_a.archive_session("s1", True)
        store_b = SessionStore(tmp_path)
        assert store_b.get_session_meta("s1")["archived"] is True

    def test_read_entries_dispatches_archive(self, tmp_path):
        """_read_entries 按 type 分流, 不误判为消息条目。"""
        store = SessionStore(tmp_path)
        add_msg(store, "s1", "user", "hi")
        store.archive_session("s1", True)
        entries = store._read_entries(store._session_path("s1"))
        archives = [e for e in entries if isinstance(e, ArchiveRecord)]
        msgs = [e for e in entries if not isinstance(e, ArchiveRecord)]
        assert len(archives) == 1 and archives[0].archived is True
        assert len(msgs) == 1   # 消息条目不受影响

    def test_session_mtime(self, tmp_path):
        """mtime: 落盘会话返回文件 mtime epoch 秒, 未落盘返回 0。"""
        import os
        store = SessionStore(tmp_path)
        assert store.session_mtime("ghost") == 0
        add_msg(store, "s1", "user", "hi")
        mt = store.session_mtime("s1")
        assert mt > 0
        expect = os.stat(store._session_path("s1")).st_mtime
        assert abs(mt - expect) < 1e-6

    def test_last_activity_immune_to_archive_write(self, tmp_path):
        """回归: 归档动作写文件后, meta.last_activity 仍是最后一条消息的
        时间——「更新时间」排序不能被归档动作污染。"""
        import time
        store = SessionStore(tmp_path)
        add_msg(store, "s1", "user", "hi")
        before = store.get_session_meta("s1")["last_activity"]
        assert before > 0
        time.sleep(0.05)   # 保证 mtime 必变
        store.archive_session("s1", True)
        after = store.get_session_meta("s1")["last_activity"]
        assert after == before, "归档记录不应改变最后活动时间"
        mt = store.session_mtime("s1")
        assert mt > before, "mtime 确实被归档刷新了（证明旧方案失真）"


# ============================================================
# REST API
# ============================================================

@pytest.fixture()
def archive_client(tmp_path, monkeypatch):
    import aulos.server as server
    store = SessionStore(tmp_path)
    monkeypatch.setattr(server, "store", store)
    monkeypatch.setattr(server, "_pending_sessions", set())
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "API_TOKEN", "")   # 关 WS 门禁（同既有测试）
    return TestClient(server.app), store


def _sid_days_ago(days: int, taken: set) -> str:
    """生成 N 天前的会话 id（避开已占用的秒位）。"""
    ts = datetime.now(timezone.utc) - timedelta(days=days)
    sid = ts.strftime("%Y%m%d-%H%M%S")
    while sid in taken:
        ts += timedelta(seconds=1)
        sid = ts.strftime("%Y%m%d-%H%M%S")
    taken.add(sid)
    return sid


class TestListArchivedField:
    def test_list_includes_archived_flag(self, archive_client):
        client, store = archive_client
        add_msg(store, "s1", "user", "普通会话")
        store.archive_session("s2", True)
        add_msg(store, "s2", "user", "归档会话")
        r = client.get("/api/sessions")
        assert r.status_code == 200
        items = {i["id"]: i for i in r.json()["sessions"]}
        assert items["s1"]["archived"] is False
        assert items["s2"]["archived"] is True

    def test_pending_session_archived_false(self, archive_client):
        client, store = archive_client
        import aulos.server as server
        server._pending_sessions.add("pending-1")
        r = client.get("/api/sessions")
        item = next(i for i in r.json()["sessions"] if i["id"] == "pending-1")
        assert item["archived"] is False


class TestArchiveEndpoint:
    def test_archive_and_unarchive(self, archive_client):
        client, store = archive_client
        add_msg(store, "s1", "user", "hi")
        r = client.post("/api/sessions/s1/archive", json={"archived": True})
        assert r.status_code == 200
        assert r.json() == {"ok": True, "archived": True}
        assert store.get_session_meta("s1")["archived"] is True
        r = client.post("/api/sessions/s1/archive", json={"archived": False})
        assert r.status_code == 200
        assert store.get_session_meta("s1")["archived"] is False

    def test_archive_missing_session_404(self, archive_client):
        client, store = archive_client
        r = client.post("/api/sessions/nope/archive", json={"archived": True})
        assert r.status_code == 404

    def test_archive_busy_session_409(self, archive_client):
        client, store = archive_client
        add_msg(store, "s1", "user", "hi")
        import aulos.server as server
        busy = type("BusyStub", (), {"busy": True})()
        server._sessions["s1"] = busy
        r = client.post("/api/sessions/s1/archive", json={"archived": True})
        assert r.status_code == 409
        assert store.get_session_meta("s1")["archived"] is False


class TestBatchArchiveEndpoint:
    def test_batch_delete_all_archived(self, archive_client):
        """全部删除: 只删已归档会话; busy 的归档会话跳过并计数, 未归档不碰。"""
        client, store = archive_client
        taken: set = set()
        keep = _sid_days_ago(1, taken)
        del1 = _sid_days_ago(5, taken)
        del2 = _sid_days_ago(6, taken)
        busy_arch = _sid_days_ago(7, taken)
        for sid in (keep, del1, del2, busy_arch):
            add_msg(store, sid, "user", "hi")
        store.archive_session(del1, True)
        store.archive_session(del2, True)
        store.archive_session(busy_arch, True)
        import aulos.server as server
        # busy 的未归档会话: 不该出现在删除候选里; busy 的归档会话: 跳过计数
        server._sessions[keep] = type("BusyStub", (), {"busy": True})()
        server._sessions[busy_arch] = type("BusyStub", (), {"busy": True})()
        r = client.post("/api/sessions/batch-delete-archived")
        assert r.status_code == 200
        body = r.json()
        assert sorted(body["deleted"]) == sorted([del1, del2])
        assert body["skipped_busy"] == 1, "busy 的归档会话跳过并计数"
        assert store.get_session_meta(keep)["count"] == 1, "未归档的不能误删"
        assert store.get_session_meta(busy_arch)["count"] == 1, "busy 归档会话保留"

    def test_batch_delete_archived_empty(self, archive_client):
        client, store = archive_client
        r = client.post("/api/sessions/batch-delete-archived")
        assert r.status_code == 200
        assert r.json() == {"deleted": [], "skipped_busy": 0}

    def test_batch_by_days(self, archive_client):
        client, store = archive_client
        taken: set = set()
        old1 = _sid_days_ago(10, taken)
        old2 = _sid_days_ago(40, taken)
        new = _sid_days_ago(2, taken)
        for sid in (old1, old2, new):
            add_msg(store, sid, "user", "hi")
        r = client.post("/api/sessions/batch-archive", json={"days": 7})
        assert r.status_code == 200
        body = r.json()
        assert body["archived"] == 2
        assert body["skipped_busy"] == 0
        assert store.get_session_meta(old1)["archived"] is True
        assert store.get_session_meta(old2)["archived"] is True
        assert store.get_session_meta(new)["archived"] is False

    def test_batch_skips_already_archived(self, archive_client):
        client, store = archive_client
        taken: set = set()
        old = _sid_days_ago(10, taken)
        add_msg(store, old, "user", "hi")
        store.archive_session(old, True)
        r = client.post("/api/sessions/batch-archive", json={"days": 7})
        assert r.status_code == 200
        assert r.json()["archived"] == 0, "已归档的不重复计数"

    def test_batch_skips_busy(self, archive_client):
        client, store = archive_client
        taken: set = set()
        old = _sid_days_ago(10, taken)
        add_msg(store, old, "user", "hi")
        import aulos.server as server
        server._sessions[old] = type("BusyStub", (), {"busy": True})()
        r = client.post("/api/sessions/batch-archive", json={"days": 7})
        assert r.status_code == 200
        body = r.json()
        assert body["archived"] == 0
        assert body["skipped_busy"] == 1
        assert store.get_session_meta(old)["archived"] is False

    def test_batch_invalid_days_422(self, archive_client):
        client, store = archive_client
        r = client.post("/api/sessions/batch-archive", json={"days": 0})
        assert r.status_code == 422
        r = client.post("/api/sessions/batch-archive", json={"days": "x"})
        assert r.status_code == 422


# ============================================================
# WS: 给归档会话发消息自动取消归档
# ============================================================

class TestWsAutoUnarchive:
    def test_send_message_unarchives(self, archive_client, monkeypatch):
        client, store = archive_client
        add_msg(store, "s1", "user", "hi")
        store.archive_session("s1", True)

        import aulos.server as server
        web_session = server.get_or_create_web_session("s1")
        web_session.busy = False
        web_session.workdir = None
        monkeypatch.setitem(server._sessions, "s1", web_session)
        # runtime 组装拦住: 不真的跑 turn, 只验证归档状态翻转
        monkeypatch.setattr(server, "load_runtime_for", lambda ws: None)
        monkeypatch.setattr(server, "_pin_session_model", lambda ws: None)
        monkeypatch.setattr(server, "_start_turn", lambda *a, **k: None)

        with client.websocket_connect("/ws/s1") as ws:
            ws.send_json({"type": "user", "text": "还在吗"})
            # _start_turn 已被 stub: user 分支同步处理完即归档状态翻转。
            # session_unarchived 广播走 add_emit 的连接级出口（out_queue 管道）,
            # 排在 busy_sync + llm_status 快照之后; 读三条即拿到, 顺便验证
            # 广播真的发出去了
            first = ws.receive_json()
            assert first["type"] == "busy_sync"
            assert ws.receive_json()["type"] == "llm_status"
            second = ws.receive_json()
            assert second["type"] == "session_unarchived", \
                f"应广播 session_unarchived, 实际 {second}"
        assert store.get_session_meta("s1")["archived"] is False
