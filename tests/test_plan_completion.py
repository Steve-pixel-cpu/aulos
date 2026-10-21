# -*- coding: utf-8 -*-
"""计划实施完成终态: turn 正常收口时回写 completed + 广播 plan_completed。

背景(2026-10-21 用户实测): 计划批准并实施完成后, 前端计划卡停在
"运行中"不动。前端实时路径已修(ws-handlers 的镜像卡收口/pr-hint 隐藏);
本文件钉住后端缺口——plans 记录此前只有 pending→approved/rejected,
turn_done 对计划零操作, "实施完成"这一状态在协议与持久层都不存在。

链路: prompter 批准计划时记下 plan_record_id → 本轮正常结束(非打断)
→ worker 收口处 set_plan_status(completed) + 广播 plan_completed
→ 前端把计划卡/历史面板推进到"已完成"。

钉住的设计决定:
- "completed" 只在正常收口路径回写; 打断/异常轮次保留 approved——
  实施确实没跑完, 语义上不算完成。
- pending(待批)/rejected 不受影响; approved 语义细化为"已批准·(实施中)"。
- 广播失败不影响收口(set_plan_status 内部吞异常, 广播包 try)。
"""
import json

import pytest

from aulos import plans as plans_mod


@pytest.fixture()
def plans_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(plans_mod, "PLANS_DIR", tmp_path, raising=False)
    return tmp_path


def test_completed_status_roundtrip(plans_dir):
    """set_plan_status 接受 completed 并可读回——终态写入的存储层基础。"""
    plan_id = plans_mod.save_plan("s1", "# 计划")
    plans_mod.set_plan_status(plan_id, "approved")
    plans_mod.set_plan_status(plan_id, "completed")
    rec = plans_mod.load_plan(plan_id)
    assert rec["status"] == "completed"
    # 摘要列表同步暴露终态: 历史面板据此区分"实施中"与"已完成"
    items = plans_mod.list_plans()
    assert items[0]["status"] == "completed"


def test_list_plans_preview_keeps_working(plans_dir):
    """既有摘要契约不回归: completed 记录仍带 preview 且不含全文。"""
    plan_id = plans_mod.save_plan("s1", "# P\n" + "x" * 300)
    plans_mod.set_plan_status(plan_id, "completed")
    items = plans_mod.list_plans()
    assert items[0]["preview"].startswith("# P")
    assert "plan_markdown" not in items[0]


# ------------------------------------------------------------
# 集成: 计划批准 → 实施完成 → 回写 + 广播
# ------------------------------------------------------------

@pytest.fixture()
def server_env(monkeypatch, tmp_path):
    """TestClient + 隔离存储 + 协议中立打桩(复用 repro 脚本的桩思路)。

    所有模块级状态一律走 monkeypatch(测试后自动还原)——直接赋值会
    泄漏给同进程后续测试文件(现场: test_providers 被污染后全量挂)。"""
    import aulos.server as server
    from aulos.storage import SessionStore
    from fastapi.testclient import TestClient
    TestClient(server.app)   # 实例化即可(同 conftest 基架), 具体连接用例内建

    monkeypatch.setattr(server, "API_TOKEN", "", raising=False)
    st = SessionStore(storage_dir=tmp_path)
    monkeypatch.setattr(server, "store", st, raising=False)
    server._pending_sessions.clear()
    monkeypatch.setattr(plans_mod, "PLANS_DIR", tmp_path / "plans", raising=False)

    from aulos.api_client import (ApiClient, MessageStopEvent,
                                  TextDeltaEvent, ToolUseEvent)
    from aulos.models import Message
    from aulos.permissions import PermissionMode
    from aulos.tools import ToolRegistry

    class _Scripted(ApiClient):
        """首次调用回 present_plan; 历史里已有该块(批准过)再调回正文。"""
        protocol = "test"

        def __init__(self, *a, **kw):
            self.thinking_level = "medium"
            self.calls = []
            self._api_key = ""   # conftest._no_real_api 的防真实调用桩检查
            self._base_url = ""
            self.model = "test-model"

        def reset_to(self, *a, **kw):   # conftest teardown 会调: no-op
            pass

        def reset_to(self, *a, **kw):
            pass

        def stream(self, system_prompt, messages, thinking_level=None, *,
                   model=None, include_tools=True, emit_output=None,
                   on_event=None):
            self.calls.append(messages)
            asks_plan = False
            for m in messages:
                content = m.content if isinstance(m, Message) else m.get("content")
                role = m.role if isinstance(m, Message) else m.get("role")
                if role == "assistant" and isinstance(content, list):
                    for b in content:
                        name = getattr(b, "name", None) or (
                            b.get("name") if isinstance(b, dict) else None)
                        asks_plan = asks_plan or name == "present_plan"
            if not asks_plan:
                return [ToolUseEvent(
                    id="plan-1", name="present_plan",
                    input=json.dumps({"plan": "# 计算器\n1. 建文件"})),
                    MessageStopEvent()]
            return [TextDeltaEvent(text="实施完成"), MessageStopEvent()]

    monkeypatch.setattr(server, "api_client", _Scripted())
    inner = ToolRegistry()
    inner.register("present_plan", lambda p, wd: "计划已批准")
    monkeypatch.setattr(server, "registry", server.EmittingToolRegistry(inner))
    monkeypatch.setattr(server.app_state, "_mode", PermissionMode.PROMPT, raising=False)
    monkeypatch.setattr(server.app_state, "plan_active", True, raising=False)
    return server


def _drain(ws, pred, limit=400):
    for _ in range(limit):
        m = json.loads(ws.receive_text())
        if pred(m):
            return m
    raise AssertionError("事件窗口内未等到目标事件")


def test_approved_plan_completes_and_broadcasts(server_env):
    """批准 → 实施完成 → 落盘 completed + 广播 plan_completed。"""
    from fastapi.testclient import TestClient
    with TestClient(server_env.app).websocket_connect("/ws/plan-impl") as ws:
        ws.send_json({"type": "user", "text": "做个计算器"})
        req = _drain(ws, lambda m: m["type"] == "permission_request")
        assert req["tool_name"] == "present_plan"
        ws.send_json({"type": "permission_response",
                      "request_id": req["request_id"], "approved": True})
        done = _drain(ws, lambda m: m["type"] == "turn_done")
        assert done.get("interrupted") is False
        # plan_completed 广播: 前端据此把计划卡推进到"已完成"
        pc = _drain(ws, lambda m: m["type"] == "plan_completed")
        assert pc.get("plan_id"), "plan_completed 必须带 plan_id"
        assert pc.get("session_id") == "plan-impl"
        # 落盘同步终态
        items = plans_mod.list_plans()
        assert items and items[0]["status"] == "completed"


def test_interrupted_plan_stays_approved(server_env, monkeypatch):
    """打断轮次: 计划实施未完成, 状态保留 approved(不算 completed)。"""
    # 让批准后的续跑抛打断: runtime 层 TurnInterrupted → interrupted=True
    from aulos.api_client import MessageStopEvent, ToolUseEvent
    from aulos.models import Message
    from aulos.runtime import TurnInterrupted

    base = server_env.api_client            # _Scripted（ABC 已具体化）

    class _Cut(base):
        def stream(self, system_prompt, messages, **kw):
            asks_plan = any(
                (m.role if isinstance(m, Message) else m.get("role")) == "assistant"
                and isinstance((m.content if isinstance(m, Message)
                                else m.get("content")), list)
                and any(getattr(b, "name", None) == "present_plan"
                        for b in (m.content if isinstance(m, Message)
                                  else m.get("content")))
                for m in messages)
            if asks_plan:
                raise TurnInterrupted()
            return [ToolUseEvent(id="plan-1", name="present_plan",
                                 input=json.dumps({"plan": "# 计算器"})),
                    MessageStopEvent()]

    monkeypatch.setattr(server_env, "api_client", _Cut)
    from fastapi.testclient import TestClient
    with TestClient(server_env.app).websocket_connect("/ws/plan-cut") as ws:
        ws.send_json({"type": "user", "text": "做个计算器"})
        req = _drain(ws, lambda m: m["type"] == "permission_request")
        ws.send_json({"type": "permission_response",
                      "request_id": req["request_id"], "approved": True})
        _drain(ws, lambda m: m["type"] == "turn_done")
        items = plans_mod.list_plans()
        assert items and items[0]["status"] == "approved"
