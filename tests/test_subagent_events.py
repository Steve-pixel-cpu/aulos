"""子代理事件镜像的单元测试。

覆盖三件事:
1. SubagentEventMirror: wire → 前端同构事件的翻译 + 信封封装
2. MirrorToolExecutor: tool_result 镜像（正常/异常路径）
3. spawn_agent_tool 全链路: bridge 捕获 sink → started/done 事件顺序;
   无 bridge 时（CLI 形态）零额外事件且行为不变。
"""
import threading

import pytest

from aulos.multi_agent import (AgentJob, AgentManifest, MirrorToolExecutor,
                               SubagentEventMirror, WireTextDelta,
                               WireThinkingEnd, WireThinkingStart,
                               WireToolEnd, WireToolStart,
                               SubagentEventMirror as _M)  # noqa: F401
from aulos.tools import ToolRegistry
from aulos.agent_tools import (spawn_agent_tool, set_subagent_event_bridge)


# ---------------------------------------------------------------------------
# 1. SubagentEventMirror
# ---------------------------------------------------------------------------

def _manifest(agent_id="a123"):
    return AgentManifest(
        agent_id=agent_id, name="", description="d", subagent_type="explore",
        status="running", output_file="x.md", created_at="t", started_at="t",
        completed_at=None, error=None)


def test_mirror_text_delta_enveloped():
    events = []
    m = SubagentEventMirror(events.append, "a1")
    m(WireTextDelta(text="你好"))
    assert events == [{"type": "subagent_event", "agent_id": "a1",
                       "event": {"type": "text_delta", "text": "你好"}}]


def test_mirror_tool_start_end():
    events = []
    m = SubagentEventMirror(events.append, "a1")
    m(WireToolStart(id="t1", name="grep"))
    m(WireToolEnd(id="t1", name="grep", input_json='{"pattern":"x"}'))
    types = [e["event"]["type"] for e in events]
    assert types == ["tool_use_started", "tool_use"]
    assert events[1]["event"]["input"] == '{"pattern":"x"}'


def test_mirror_thinking_roundtrip():
    events = []
    m = SubagentEventMirror(events.append, "a1")
    m(WireThinkingStart())
    m(WireThinkingEnd())
    types = [e["event"]["type"] for e in events]
    assert types == ["thinking_start", "thinking_end"]


def test_mirror_swallows_sink_errors():
    def bad_sink(_):
        raise RuntimeError("sink exploded")
    m = SubagentEventMirror(bad_sink, "a1")
    m(WireTextDelta(text="x"))  # 不抛 = 通过


def test_mirror_ignores_usage_and_stop():
    from aulos.api_client import WireStop, WireUsage
    events = []
    m = SubagentEventMirror(events.append, "a1")
    m(WireUsage(input_tokens=1))
    m(WireStop(stop_reason="end_turn"))
    assert events == []


# ---------------------------------------------------------------------------
# 2. MirrorToolExecutor
# ---------------------------------------------------------------------------

def test_mirror_executor_emits_result():
    reg = ToolRegistry()
    reg.register(name="echo", handler=lambda params, workdir=None: "hi")
    events = []
    ex = MirrorToolExecutor(registry=reg, event_sink=events.append, agent_id="a1")
    out = ex.execute("echo", "{}", tool_use_id="tu1")
    assert out == "hi"
    assert len(events) == 1
    env = events[0]
    assert env["type"] == "subagent_event" and env["agent_id"] == "a1"
    ev = env["event"]
    assert ev["type"] == "tool_result" and ev["id"] == "tu1"
    assert ev["is_error"] is False and ev["output"] == "hi"


def test_mirror_executor_error_then_raise():
    from aulos.runtime import ToolError
    reg = ToolRegistry()

    def boom(params, workdir=None):
        raise ValueError("炸了")
    reg.register(name="boom", handler=boom)
    events = []
    ex = MirrorToolExecutor(registry=reg, event_sink=events.append, agent_id="a1")
    with pytest.raises(ToolError):   # registry 把 handler 异常包成 ToolError
        ex.execute("boom", "{}", tool_use_id="tu2")
    ev = events[0]["event"]
    assert ev["type"] == "tool_result" and ev["is_error"] is True
    assert "炸了" in ev["output"]


def test_mirror_executor_no_sink_is_silent():
    reg = ToolRegistry()
    reg.register(name="echo", handler=lambda params, workdir=None: "ok")
    ex = MirrorToolExecutor(registry=reg, event_sink=None, agent_id="a1")
    assert ex.execute("echo", "{}", tool_use_id="t") == "ok"


# ---------------------------------------------------------------------------
# 3. spawn_agent_tool 全链路（bridge + started/done 事件）
# ---------------------------------------------------------------------------

@pytest.fixture()
def fake_worker(monkeypatch):
    """把 build_subagent_runtime/run_turn 替换成发射假 wire 事件的 stub。"""
    import aulos.multi_agent as ma

    started = threading.Event()

    def fake_build(job):
        class _Runtime:
            def run_turn(self, prompt):
                started.set()
                sink = job.event_sink
                sink({"type": "subagent_event", "agent_id": job.manifest.agent_id,
                      "event": {"type": "text_delta", "text": "worker 说你好"}})
                from aulos.models import Session as _S
                return type("S", (), {"assistant_messages": [], "iterations": 1,
                                      "budget_exhausted": False,
                                      "iterations_exhausted": False})()

            def without_tools(self):
                return self

            def with_max_iterations(self, n):
                return self

            def with_turn_output_budget(self, n):
                return self

            def with_auto_compact_threshold(self, n):
                return self

            def set_cancel_check(self, fn):
                return self
        return _Runtime()

    monkeypatch.setattr(ma, "build_subagent_runtime", fake_build)
    return started


def test_spawn_emits_started_and_done(tmp_path, fake_worker):
    events = []
    set_subagent_event_bridge(lambda sid: events.append)
    try:
        # get_orchestrator 是模块级单例: 临时换到 tmp_path
        import aulos.agent_tools as at
        orch = at.get_orchestrator()
        old_dir = orch._store_dir
        orch._store_dir = tmp_path
        try:
            out = spawn_agent_tool({"description": "d", "prompt": "p",
                                    "subagent_type": "explore"})
        finally:
            orch._store_dir = old_dir
        assert "agent_id:" in out
        fake_worker.wait(timeout=5)
        import time as _t
        deadline = _t.time() + 5
        while _t.time() < deadline and not any(
                e.get("type") == "subagent_done" for e in events):
            _t.sleep(0.05)
        types = [e.get("type") for e in events]
        assert types[0] == "subagent_started"
        assert events[0]["subagent_type"] == "explore"
        assert "subagent_event" in types     # worker 的镜像事件
        assert types[-1] == "subagent_done"  # 终态收口
        done = events[-1]
        assert done["status"] == "completed"
        assert isinstance(done["duration_s"], float)
    finally:
        set_subagent_event_bridge(None)


def test_no_bridge_is_silent(tmp_path, fake_worker):
    set_subagent_event_bridge(None)
    import aulos.agent_tools as at
    orch = at.get_orchestrator()
    old_dir = orch._store_dir
    orch._store_dir = tmp_path
    try:
        out = spawn_agent_tool({"description": "d", "prompt": "p",
                                "subagent_type": "explore"})
        assert "agent_id:" in out
        fake_worker.wait(timeout=5)
    finally:
        orch._store_dir = old_dir


def test_job_event_sink_none_by_default():
    job = AgentJob(manifest=_manifest(), prompt="p", allowed_tools={"read_file"})
    assert job.event_sink is None
