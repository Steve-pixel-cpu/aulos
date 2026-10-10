"""SessionStore.get_session_meta 单遍读盘 + mtime 缓存测试。

背景: GET /api/sessions 旧实现每会话连调 5 个 getter, 每个都整文件读盘
解析——会话库一大, 每次列表就是几十 MB 的读盘大户。get_session_meta
一次读盘取齐全部字段, 按 (mtime_ns, size) 缓存（与 _search_text_cache
同一失效哲学）。

验证三件事: 字段与旧 getter 逐一对齐（含旧数据归一/兜底文本）、
追加与外部修改后缓存正确失效、命中缓存时零读盘。
"""

import pytest
from fastapi.testclient import TestClient

from models import Message, TextContentBlock
from storage import (PermissionModeRecord, SessionStore, StorageEntry,
                     TitleRecord)


def add_msg(store: SessionStore, sid: str, role: str, text: str,
            parent: str = None) -> str:
    msg = Message(role=role,
                  content=[TextContentBlock(text=text)] if text else [])
    return store.save_message(sid, msg, parent)


def empty_meta() -> dict:
    return {"title": None, "count": 0, "workdir": None, "mode": None,
            "plan": False, "provider_id": None, "model_id": None,
            "first_user_text": None}


# ------------------------------------------------------------
# 字段语义: 与对应 getter 逐一对齐
# ------------------------------------------------------------

def test_meta_matches_getters(tmp_path):
    store = SessionStore(tmp_path)
    p1 = add_msg(store, "s1", "user", "帮我看看这个项目的整体结构")
    add_msg(store, "s1", "assistant", "好的", parent=p1)
    store.set_title("s1", "项目结构")
    store.set_workdir("s1", "D:/proj")
    store.set_permission_mode("s1", "prompt", plan=True)
    store.set_model("s1", "prov-a", "model-1")

    meta = store.get_session_meta("s1")
    assert meta["title"] == store.get_title("s1") == "项目结构"
    assert meta["count"] == store.count_messages("s1") == 2
    assert meta["workdir"] == store.get_workdir("s1") == "D:/proj"
    assert (meta["mode"], meta["plan"]) == store.get_permission_mode("s1")
    assert (meta["provider_id"], meta["model_id"]) == store.get_model("s1")
    assert meta["first_user_text"] == "帮我看看这个项目的整体结构"


def test_meta_defaults_missing_and_metadata_only(tmp_path):
    store = SessionStore(tmp_path)
    # 未落盘的会话（pending）: 全默认值
    assert store.get_session_meta("nope") == empty_meta()
    # 只有元数据记录、没有消息: count 0, 其余按记录
    store.set_title("s2", "只有标题")
    store.set_workdir("s2", "D:/x")
    meta = store.get_session_meta("s2")
    assert meta["title"] == "只有标题"
    assert meta["count"] == 0
    assert meta["workdir"] == "D:/x"
    assert meta["first_user_text"] is None


def test_meta_legacy_mode_normalization(tmp_path):
    """plan/read-only 旧记录归一必须与 get_permission_mode 同规则。"""
    store = SessionStore(tmp_path)
    store._append_entry(store._session_path("s"), PermissionModeRecord(
        mode="read-only", plan=False,
        timestamp="2026-01-01T00:00:00+00:00"))
    meta = store.get_session_meta("s")
    assert (meta["mode"], meta["plan"]) == ("prompt", True)
    assert store.get_permission_mode("s") == ("prompt", True)


def test_meta_first_user_text_guards(tmp_path):
    store = SessionStore(tmp_path)
    # 首条不是用户消息 → 不做兜底命名素材
    p = add_msg(store, "s", "assistant", "我先说话")
    add_msg(store, "s", "user", "文本", parent=p)
    assert store.get_session_meta("s")["first_user_text"] is None
    # 首条用户消息无文本（纯图/空）→ 同样不用
    add_msg(store, "s2", "user", "")
    assert store.get_session_meta("s2")["first_user_text"] is None


# ------------------------------------------------------------
# 缓存: 失效正确、命中零读盘
# ------------------------------------------------------------

def test_meta_cache_invalidates_on_append(tmp_path):
    store = SessionStore(tmp_path)
    p1 = add_msg(store, "s", "user", "第一条")
    assert store.get_session_meta("s")["count"] == 1
    add_msg(store, "s", "assistant", "第二条", parent=p1)
    assert store.get_session_meta("s")["count"] == 2
    store.set_title("s", "新名字")
    assert store.get_session_meta("s")["title"] == "新名字"


def test_meta_cache_hits_no_reread(tmp_path, monkeypatch):
    store = SessionStore(tmp_path)
    add_msg(store, "s", "user", "hi")
    store.get_session_meta("s")   # 预热
    calls = {"n": 0}
    real = store._read_entries
    def counting(path):
        calls["n"] += 1
        return real(path)
    monkeypatch.setattr(store, "_read_entries", counting)
    assert store.get_session_meta("s")["count"] == 1
    assert store.get_session_meta("s")["title"] is None
    assert calls["n"] == 0, "缓存命中时不得再读盘"


def test_meta_external_write_visible(tmp_path):
    """跨进程语义: 另一进程的追加（改 mtime/size）必须被本进程看到。"""
    store_a = SessionStore(tmp_path)
    store_b = SessionStore(tmp_path)
    add_msg(store_a, "s", "user", "hi")
    assert store_b.get_session_meta("s")["count"] == 1
    store_b.set_title("s", "B 进程命名")
    assert store_a.get_session_meta("s")["title"] == "B 进程命名"


def test_delete_session_clears_meta(tmp_path):
    store = SessionStore(tmp_path)
    add_msg(store, "s", "user", "hi")
    store.get_session_meta("s")
    store.delete_session("s")
    assert store.get_session_meta("s") == empty_meta()


def test_meta_returns_copy(tmp_path):
    """调用方改返回值不得污染缓存。"""
    store = SessionStore(tmp_path)
    add_msg(store, "s", "user", "hi")
    meta = store.get_session_meta("s")
    meta["count"] = 999
    assert store.get_session_meta("s")["count"] == 1


# ------------------------------------------------------------
# 端点装配: GET /api/sessions 用 meta 取齐字段, 兜底命名照旧落盘
# ------------------------------------------------------------

@pytest.fixture()
def meta_client(tmp_path, monkeypatch):
    import server
    store = SessionStore(tmp_path)
    monkeypatch.setattr(server, "store", store)
    monkeypatch.setattr(server, "_pending_sessions", set())
    return TestClient(server.app), store


def test_list_endpoint_wiring(meta_client):
    client, store = meta_client
    add_msg(store, "s1", "user", "第一个会话的消息")
    store.set_workdir("s1", "D:/proj")
    r = client.get("/api/sessions")
    assert r.status_code == 200
    item = next(i for i in r.json()["sessions"] if i["id"] == "s1")
    assert item["title"] == "第一个会话的消息", "未命名会话按首条消息截断兜底"
    assert item["message_count"] == 1
    assert item["workdir"] == "D:/proj"
    # 兜底命名已照旧落盘（一次性回填语义不变）
    assert store.get_title("s1") == "第一个会话的消息"


def test_list_endpoint_pending_session(meta_client):
    client, store = meta_client
    import server
    server._pending_sessions.add("pending-1")
    r = client.get("/api/sessions")
    item = next(i for i in r.json()["sessions"] if i["id"] == "pending-1")
    assert item["title"] == "(未命名)"
    assert item["message_count"] == 0
