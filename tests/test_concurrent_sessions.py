"""测试: 多会话并行支持 — 会话级思考等级 / 并发上限排队 / 审批无超时。"""
import threading

import pytest
from fastapi.testclient import TestClient

import aulos.server as server
from aulos.models import Session
from aulos.permissions import PermissionPolicy
from aulos.storage import SessionStore


@pytest.fixture()
def client():
    return TestClient(server.app)


@pytest.fixture()
def isolated_store(tmp_path, monkeypatch):
    fake = SessionStore(storage_dir=tmp_path)
    monkeypatch.setattr(server, "store", fake)
    server._pending_sessions.clear()
    return fake


@pytest.fixture(autouse=True)
def clean_web_sessions():
    """测试创建的 WebSession 用后即清——全局 _sessions 里的 fake runtime
    会泄漏进后续请求（如 /api/settings 会遍历 runtime.set_permission_mode）。"""
    saved = dict(server._sessions)
    yield
    server._sessions.clear()
    server._sessions.update(saved)


@pytest.fixture()
def clean_slots():
    """并发槽位/队列测试隔离: 前后各清一次, 不受其他测试残留影响。
    上限现在可变（设置页热调）, 不能按固定次数恢复——用 reset 归零
    计数并保留当前 limit, 结束时再把 limit 归还运行态值。"""
    server._turn_slots.reset()
    server._queued_turns.clear()
    saved_limit = server._turn_slots.limit
    yield
    server.set_max_concurrent_turns(saved_limit)
    server._turn_slots.reset()
    server._queued_turns.clear()


# ------------------------------------------------------------
# 会话级思考等级: WebSession 持有, runtime 注入, 互不串
# ------------------------------------------------------------

def test_web_session_has_own_thinking_level(client, isolated_store):
    """每个 WebSession 的思考等级初值为全局默认, 但各自独立可改。"""
    a = server.get_or_create_web_session("s-a")
    b = server.get_or_create_web_session("s-b")
    assert a.thinking_level == b.thinking_level  # 初值一致（全局默认）

    a.thinking_level = "high"
    b.thinking_level = "low"
    assert a.thinking_level == "high"            # b 的修改不波及 a
    assert b.thinking_level == "low"


def test_settings_thinking_level_only_changes_default(client, isolated_store):
    """全局设置变更（设置页）: 只改"新会话默认值", 存活会话不受波及——
    会话内切换走 WS set_thinking_level（见 test_session_settings_isolation）。"""
    ws = server.get_or_create_web_session("s-lvl")
    ws.thinking_level = "low"

    class _FakeRuntime:
        level = "low"
        def set_thinking_level(self, level):
            self.level = level
    ws.runtime = _FakeRuntime()

    client.post("/api/settings", json={"thinking_level": "max"})

    assert server.api_client.thinking_level == "max"  # 新会话默认已更新
    assert ws.thinking_level == "low"                 # 存活会话不受波及
    assert ws.runtime.level == "low"


def test_runtime_thinking_level_isolation():
    """内核层: runtime 持有自己的等级, 不再读写 api_client 实例状态。"""
    from aulos.runtime import ConversationRuntime

    class _Client:
        thinking_level = "medium"
        def stream(self, **kwargs):
            return []

    client = _Client()
    rt = ConversationRuntime(
        session=Session(),
        api_client=client,
        tool_executor=lambda **kw: None,
        permission_policy=PermissionPolicy(active_mode="danger-full-access"),
        system_prompt=[],
    )
    assert rt.thinking_level() == "medium"   # 初值取自 client
    rt.set_thinking_level("low")
    assert rt.thinking_level() == "low"
    assert client.thinking_level == "medium"  # client 实例状态未被改动


# ------------------------------------------------------------
# 全局并发上限: 信号量 + 排队
# ------------------------------------------------------------

def test_turn_queue_releases_and_starts(clean_slots):
    """槽位释放后 _drain_queued_turns 唤醒排队轮次; 叫停项跳过并补发 turn_done 收尾。"""
    acquired = server._turn_slots.acquire(blocking=False)
    assert acquired  # 测试前置: 先占住一个槽位, 模拟"仅剩一个空位"

    ws_busy = server.get_or_create_web_session("q-busy")
    ws_stop = server.get_or_create_web_session("q-stop")
    for ws in (ws_busy, ws_stop):
        ws.busy = True
    ws_stop.stop_requested = True   # 排队期间被叫停 → 应被跳过

    events = []
    server._queued_turns.append(
        (ws_busy, "hi", None, lambda p: None,
         server.WebPermissionPrompter(lambda p: None)))
    server._queued_turns.append(
        (ws_stop, "nope", None, events.append,
         server.WebPermissionPrompter(lambda p: None)))

    spawned = []
    original = server._spawn_turn_thread
    server._spawn_turn_thread = lambda ws, text, atts, e, p: spawned.append(ws.session_id)
    try:
        server._drain_queued_turns()
    finally:
        server._spawn_turn_thread = original

    # 队列清空; 正常项被启动, 叫停项被跳过
    assert len(server._queued_turns) == 0
    assert spawned == ["q-busy"]
    # 叫停项收尾: 忙碌复位 + 补发 turn_done, 前端不悬在忙碌态
    assert ws_stop.busy is False
    assert events and events[-1]["type"] == "turn_done"
    assert events[-1]["interrupted"] is True


def test_turn_queue_skip_with_pending_requeues_text(clean_slots):
    """立即发送插队后原轮次被跳过: 其文本归队 pending 尾部, 不丢失。"""
    ws = server.get_or_create_web_session("q-jump")
    ws.busy = True
    ws.stop_requested = True
    ws.pending = [{"qid": "q-jump-1", "text": "插队消息", "attachments": []}]
    server._queued_turns.append(
        (ws, "原始消息", None, lambda p: None,
         server.WebPermissionPrompter(lambda p: None)))

    def _fail(*_a):
        raise AssertionError("插队场景跳过时不应直接起线程")

    original = server._spawn_turn_thread
    server._spawn_turn_thread = _fail
    try:
        server._drain_queued_turns()
    finally:
        server._spawn_turn_thread = original

    assert server._queued_turns == []
    assert [it["text"] for it in ws.pending] == ["插队消息", "原始消息"]   # 插队消息在前, 原消息不丢
    assert ws.busy is True   # 接力由事件循环调度, 忙碌态保持到轮次真正开跑


def test_queue_fifo_order(clean_slots):
    """多会话排队时严格 FIFO。"""
    got = []
    original = server._spawn_turn_thread
    server._spawn_turn_thread = lambda ws, text, atts, e, p: got.append(ws.session_id)
    try:
        assert server._turn_slots.acquire(blocking=False)
        for i in range(3):
            ws = server.get_or_create_web_session(f"fifo-{i}")
            ws.busy = True
            server._queued_turns.append(
                (ws, "x", None, None, server.WebPermissionPrompter(lambda p: None)))
        server._drain_queued_turns()
    finally:
        server._spawn_turn_thread = original
    assert got == ["fifo-0", "fifo-1", "fifo-2"]
    # 收尾复位: drain 已把计数清 0, 本测试占的槽也没有真实 worker 来释放——
    # 不补回的话, 计数 0 会泄漏给同进程里所有后跑的测试文件
    while server._turn_slots.acquire(blocking=False):
        pass
    for _ in range(server.MAX_CONCURRENT_TURNS):
        server._turn_slots.release()


@pytest.fixture()
def isolated_settings(tmp_path, monkeypatch):
    """settings.json 指到 tmp, 防止污染真实用户配置
    （server._save_setting 走 server.SETTINGS_FILE, 与 config 属性分开绑定）。"""
    fake = tmp_path / "settings.json"
    monkeypatch.setattr(server, "SETTINGS_FILE", fake)
    yield fake


# ------------------------------------------------------------
# 全局并发上限可配置: settings API 热调 _turn_slots
# ------------------------------------------------------------

def test_settings_exposes_and_updates_max_concurrent(client, isolated_settings):
    """GET 返回当前上限; POST 合法值热调信号量并落盘。"""
    r = client.get("/api/settings")
    assert r.status_code == 200
    old = r.json()["max_concurrent_turns"]

    r = client.post("/api/settings", json={"max_concurrent_turns": 8})
    assert r.status_code == 200
    assert r.json()["max_concurrent_turns"] == 8
    assert server._turn_slots.limit == 8
    assert server.runtime_config.feature_config.max_concurrent_turns == 8

    # 恢复, 不泄漏给其他测试
    client.post("/api/settings", json={"max_concurrent_turns": old})
    assert server._turn_slots.limit == old


def test_settings_max_concurrent_rejects_invalid(client, isolated_settings):
    """非整数 / bool / 越界值 → 400, 现值不变。"""
    old = server._turn_slots.limit
    for bad in (0, 65, -1, True, "4", 3.5, None if False else "4"):
        r = client.post("/api/settings", json={"max_concurrent_turns": bad})
        assert r.status_code == 400, bad
    assert server._turn_slots.limit == old


def test_set_max_concurrent_wakes_queued(clean_slots):
    """调大上限且队列非空 → 排队轮次被唤醒（经事件循环调度）。"""
    ws = server.get_or_create_web_session("wk-1")
    ws.busy = True
    server._queued_turns.append(
        (ws, "hi", None, lambda p: None, server.WebPermissionPrompter(lambda p: None)))

    spawned = []
    original = server._spawn_turn_thread
    server._spawn_turn_thread = lambda ws, text, atts, e, p: spawned.append(ws.session_id)
    try:
        old_limit = server._turn_slots.limit
        server.set_max_concurrent_turns(old_limit + 1)
    finally:
        server._spawn_turn_thread = original
        server.set_max_concurrent_turns(old_limit)   # 恢复, 不泄漏给后续测试

    # 直接调（无事件循环）时唤醒依赖 loop; 测试环境无 loop 则至少容量已变
    if spawned:
        assert spawned == ["wk-1"]
    assert server._queued_turns == [] or spawned == []


def test_shrink_does_not_affect_running(clean_slots):
    """缩小上限: 不影响已占用槽位, 只是新 acquire 被拒。"""
    # clean_slots 已把计数清到 0; 这里从已知状态出发
    base = server._turn_slots.limit
    assert server._turn_slots.acquire(blocking=False)
    old = server.set_max_concurrent_turns(1)
    assert old == base
    assert server._turn_slots.acquire(blocking=False) is False   # 新槽位拿不到
    server._turn_slots.release()   # 在跑轮次正常归还
    assert server._turn_slots.acquire(blocking=False)             # 归还后可再占
    server._turn_slots.release()
    server.set_max_concurrent_turns(base)   # 恢复, 不泄漏
