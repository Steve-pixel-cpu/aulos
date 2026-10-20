# tests/test_session_pin.py — 会话置顶接口（镜像 tests/test_session_archive.py）
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from aulos.storage import SessionStore


def add_msg(store: SessionStore, sid: str, role: str, text: str,
            parent: str = None) -> str:
    from aulos.models import Message, TextContentBlock
    msg = Message(role=role,
                  content=[TextContentBlock(text=text)] if text else [])
    return store.save_message(sid, msg, parent)


@pytest.fixture()
def pin_client(tmp_path, monkeypatch):
    import aulos.server as server
    store = SessionStore(tmp_path)
    monkeypatch.setattr(server, "store", store)
    monkeypatch.setattr(server, "_pending_sessions", set())
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server, "API_TOKEN", "")
    return TestClient(server.app), store


class TestPinEndpoint:
    def test_pin_and_unpin(self, pin_client):
        client, store = pin_client
        add_msg(store, "s1", "user", "hi")
        r = client.post("/api/sessions/s1/pin", json={"pinned": True})
        assert r.status_code == 200
        assert r.json() == {"ok": True, "pinned": True}
        assert store.get_session_meta("s1")["pinned"] is True
        r = client.post("/api/sessions/s1/pin", json={"pinned": False})
        assert r.status_code == 200
        assert store.get_session_meta("s1")["pinned"] is False

    def test_pin_rejects_non_bool(self, pin_client):
        client, store = pin_client
        add_msg(store, "s1", "user", "hi")
        r = client.post("/api/sessions/s1/pin", json={"pinned": "yes"})
        assert r.status_code == 422
        assert store.get_session_meta("s1")["pinned"] is False

    def test_pin_missing_session_404(self, pin_client):
        client, store = pin_client
        r = client.post("/api/sessions/nope/pin", json={"pinned": True})
        assert r.status_code == 404

    def test_list_includes_pinned_flag(self, pin_client):
        client, store = pin_client
        add_msg(store, "s1", "user", "hi")
        add_msg(store, "s2", "user", "yo")
        client.post("/api/sessions/s1/pin", json={"pinned": True})
        items = {i["id"]: i for i in client.get("/api/sessions").json()["sessions"]}
        assert items["s1"]["pinned"] is True
        assert items["s2"]["pinned"] is False
