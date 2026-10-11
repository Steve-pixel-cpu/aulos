"""WebPermissionPrompter 决议广播测试。

背景: 服务端此前从不广播 permission_resolved——别处（桌宠/第二窗口/
REST）批复、或打断（plan 接力/「立即」插队）自动拒绝后, 主窗的审批卡
永远停在"待确认", 按钮点击全部落空。现在决议落地即广播, 前端
onPermissionResolved 统一定格所有连接的审批卡。
"""

import json
import threading
import time

from permissions import PermissionDecision, PermissionMode, PermissionRequest
from server import WebPermissionPrompter


def _bash_request() -> PermissionRequest:
    return PermissionRequest(
        tool_name="bash",
        input=json.dumps({"command": "git push origin main"}),
        current_mode=PermissionMode.WORKSPACE_WRITE,
        required_mode=PermissionMode.DANGER_FULL_ACCESS)


def _wait_event(events: list, type_: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for e in events:
            if e.get("type") == type_:
                return e
        time.sleep(0.01)
    raise AssertionError(f"事件未到达: {type_}, 实际: {[e.get('type') for e in events]}")


def test_resolve_broadcasts_permission_resolved():
    events: list = []
    prompter = WebPermissionPrompter(emit=events.append)
    out: dict = {}

    def worker():
        out["result"] = prompter.decide(_bash_request())

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    req = _wait_event(events, "permission_request")
    assert req["request_id"] == "perm-1"
    prompter.resolve("perm-1", True)
    t.join(timeout=5)
    assert out["result"].decision == PermissionDecision.ALLOW
    resolved = _wait_event(events, "permission_resolved")
    assert resolved["request_id"] == "perm-1"
    assert resolved["approved"] is True


def test_cancel_during_wait_broadcasts_denied():
    """打断（plan 接力/「立即」插队/停止）自动拒绝: 主窗的待确认卡必须
    立刻收到 resolution 定格, 而不是等 turn_done 才收口。"""
    events: list = []
    prompter = WebPermissionPrompter(emit=events.append)
    out: dict = {}

    def worker():
        out["result"] = prompter.decide(_bash_request())

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    _wait_event(events, "permission_request")
    prompter.cancel()
    t.join(timeout=5)
    assert out["result"].decision == PermissionDecision.DENY
    resolved = _wait_event(events, "permission_resolved")
    assert resolved["request_id"] == "perm-1"
    assert resolved["approved"] is False


def test_decide_after_cancel_denies_without_events():
    """cancel 先于请求到达: 请求从未弹过卡（无 permission_request）,
    静默朝安全侧拒绝即可, 无 resolution 可广播。"""
    events: list = []
    prompter = WebPermissionPrompter(emit=events.append)
    prompter.cancel()
    result = prompter.decide(_bash_request())
    assert result.decision == PermissionDecision.DENY
    assert [e["type"] for e in events] == []


def test_stale_response_ignored_single_resolution():
    events: list = []
    prompter = WebPermissionPrompter(emit=events.append)
    out: dict = {}

    def worker():
        out["result"] = prompter.decide(_bash_request())

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    _wait_event(events, "permission_request")
    prompter.resolve("perm-wrong", True)   # stale/重放: 必须被忽略
    prompter.resolve("perm-1", True)
    t.join(timeout=5)
    assert out["result"].decision == PermissionDecision.ALLOW
    resolved = [e for e in events if e.get("type") == "permission_resolved"]
    assert len(resolved) == 1
    assert resolved[0]["request_id"] == "perm-1"
