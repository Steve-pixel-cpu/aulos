# -*- coding: utf-8 -*-
"""子代理「无消息内容!」故障复现与修复验证。

现场: general 子代理连续工作 12 分钟(GLM-5.3-flash, anthropic 兼容层),
最终 assistant 消息只含 thinking(兼容层把 thinking delta 吞掉, 见
api_client 流处理)/或纯 tool_use, build_assistant_message 收到空事件
列表抛 RuntimeError("无消息内容!"), _worker 的 except 把整个工作打成
{"status":"failed","result":null}——4 个脚本文件全丢。

修复分层:
  L1 续写兜底  — 注入 user 总结指令, 关工具再跑一轮(最多 1 次)
  L2 部分结果  — 兜底也失败时, 从会话历史提取产物清单回传(COMPLETED)
  L3 thinking  — 空 blocks 时用 thinking 文本降级为 text 块(带标记)

运行方式（在 x-code 目录下）:
    uv run pytest tests/test_agent_empty_final.py -v
"""
import json
import time

import pytest

import multi_agent
from multi_agent import AgentJob, AgentManifest, AgentOrchestrator
from runtime import build_assistant_message


def _wait_terminal(orch: AgentOrchestrator, agent_id: str,
                   timeout: float = 10.0) -> AgentManifest:
    """_default_spawn_fn 起线程即返回; 轮询等终态文件落盘。"""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            m = orch.get_status(agent_id)
            if m.status in ("completed", "failed"):
                return m
            last = m
        except FileNotFoundError:
            pass
        time.sleep(0.02)
    raise AssertionError(f"worker 未在 {timeout}s 内收束: {last}")


# ------------------------------------------------------------
# runtime 层: 空 events → "无消息内容!"(抛错点本身, 修复后行为不变)
# ------------------------------------------------------------

def test_build_assistant_message_stop但无内容块_raises():
    """thinking-only 响应被兼容层吞掉后: 有 MessageStop(收束)但零内容块
    → 抛「无消息内容!」——正是 worker 线程里炸掉的那个点。"""
    from api_client import MessageStopEvent

    with pytest.raises(RuntimeError, match="无消息内容"):
        build_assistant_message([MessageStopEvent(usage=None)])


# ------------------------------------------------------------
# worker 层: 最后消息无 text → 现状 failed/null(RED), 修复后三层兜底
# ------------------------------------------------------------

class FlakyRuntime:
    """stub: 前 N 次 run_turn 抛「无消息内容!」, 之后返回带文本的 summary。

    模拟 GLM 兼容层: 子代理干完活, 最后一次响应 thinking-only 被吞 →
    build_assistant_message 抛错。修复后 L1 总结轮应拿到文本。"""

    def __init__(self, fail_times: int = 1):
        self.fail_times = fail_times
        self.calls: list[str] = []
        # L2 从这里挖部分结果: 模拟子代理干过活的会话历史
        self.session = type("S", (), {"messages": []})()

    def run_turn(self, prompt: str):
        self.calls.append(prompt)
        if len(self.calls) <= self.fail_times:
            raise RuntimeError("无消息内容!")
        from models import Message, TextContentBlock

        class _Summary:
            # 用真实 TextContentBlock: final_text_of 按 isinstance 过滤文本块
            assistant_messages = [Message(role="assistant", content=[
                TextContentBlock(text="任务完成: 已写出 greeting.txt")])]

        return _Summary()

    # L1 的预算限幅链式调用(修复后 _worker 会调 with_max_iterations)
    def with_max_iterations(self, n):
        return self

    # L1 的工具禁用链式调用
    def without_tools(self):
        return self


def _make_job(tmp_path):
    manifest = AgentManifest(
        agent_id="cafe1234abcd",
        name="",
        description="写个问好脚本",
        subagent_type="general",
        status="running",
        output_file=str(tmp_path / "a.md"),
        started_at="2026-10-07T00:00:00+00:00",
        created_at="2026-10-07T00:00:00+00:00",
        completed_at=None,
        error=None,
    )
    return AgentJob(manifest=manifest, description="写个问好脚本",
                    prompt="写 greeting.txt", allowed_tools={"bash"})


def _seed_manifest(orch: AgentOrchestrator, job: AgentJob):
    """直接点火线程时绕过了 spawn_agent, 终态写需要 manifest JSON 已在盘上
    (complete_agent → get_status 按 id 读)。生产路径由 spawn_agent 写,
    这里对齐生产前置条件。"""
    (orch._store_dir / f"{job.manifest.agent_id}.json").write_text(
        job.manifest.model_dump_json(), encoding="utf-8")


def test_worker_无文本异常_修复后走总结轮并交付结果(tmp_path, monkeypatch):
    """L1: run_turn 抛「无消息内容!」→ 注入总结轮 → complete 而非 failed。"""
    rt = FlakyRuntime(fail_times=1)
    monkeypatch.setattr(multi_agent, "build_subagent_runtime", lambda job: rt)
    orch = AgentOrchestrator(tmp_path / "agents")
    (tmp_path / "agents").mkdir(parents=True, exist_ok=True)  # persist 需要目录在
    job = _make_job(tmp_path)

    _seed_manifest(orch, job)
    orch._default_spawn_fn(job)
    manifest = _wait_terminal(orch, job.manifest.agent_id)

    assert manifest.status == "completed", f"error={manifest.error}"
    assert "greeting.txt" in (manifest.result or "")
    # 总结轮的注入指令真的发出去了, 且只有一次兜底
    assert len(rt.calls) == 2
    assert "总结" in rt.calls[1]


def test_worker_无文本且总结轮也失败_回传部分结果(tmp_path, monkeypatch):
    """L2: 总结轮仍抛错 → 从会话历史提取产物清单, COMPLETED 而非 null。"""
    rt = FlakyRuntime(fail_times=99)  # 怎么兜底都失败
    # 伪造会话历史: 子代理写过文件 + 跑过命令(用真 pydantic 模型, L2 解析走真代码)
    from models import Message, ToolContentBlock

    def _tool_use_msg(name, inp: dict, out: str):
        m = Message(role="assistant", content=[ToolContentBlock(
            id="t1", name=name, input=json.dumps(inp, ensure_ascii=False))])
        return [m]

    rt.session = type("S", (), {"messages": (
        _tool_use_msg("write_file", {"path": "greet.py", "content": "print(1)"}, "OK")
        + _tool_use_msg("bash", {"command": "python greet.py"}, "hello")
    )})()
    monkeypatch.setattr(multi_agent, "build_subagent_runtime", lambda job: rt)
    orch = AgentOrchestrator(tmp_path / "agents")
    (tmp_path / "agents").mkdir(parents=True, exist_ok=True)  # persist 需要目录在
    job = _make_job(tmp_path)

    _seed_manifest(orch, job)
    orch._default_spawn_fn(job)
    manifest = _wait_terminal(orch, job.manifest.agent_id)

    assert manifest.status == "completed", f"error={manifest.error}"
    result = manifest.result or ""
    assert "greet.py" in result           # 产物路径在
    assert "python greet.py" in result    # 跑过什么在
    assert "部分结果" in result           # 明确标注是降级回传


def test_worker_其他异常不触发总结轮_维持failed(tmp_path, monkeypatch):
    """非「无消息内容」异常(API 挂了等)不进 L1, 行为与现状一致。"""
    rt = FlakyRuntime(fail_times=0)

    def _boom(prompt):
        rt.calls.append(prompt)
        raise RuntimeError("APIConnectionError: network unreachable")

    rt.run_turn = _boom
    monkeypatch.setattr(multi_agent, "build_subagent_runtime", lambda job: rt)
    orch = AgentOrchestrator(tmp_path / "agents")
    (tmp_path / "agents").mkdir(parents=True, exist_ok=True)  # persist 需要目录在
    job = _make_job(tmp_path)

    _seed_manifest(orch, job)
    orch._default_spawn_fn(job)
    manifest = _wait_terminal(orch, job.manifest.agent_id)

    assert manifest.status == "failed"
    assert "APIConnectionError" in (manifest.error or "")
    assert len(rt.calls) == 1  # 没有总结轮


# ------------------------------------------------------------
# L3: thinking-only 响应在 build_assistant_message 降级为文本(带标记)
# ------------------------------------------------------------

def test_build_assistant_message_thinking_only_降级为文本():
    """L3: 有 stop 事件、唯一的 thinking 块 → 降级成 text 块而非抛错。
    GLM 兼容层会把 thinking delta 从 events 里吞掉(api_client 流处理),
    这里验证的是降级机制本身: thinking 文本在场时, 空结果变成有标记文本。"""
    from api_client import MessageStopEvent, ThinkingEvent

    msg, usage = build_assistant_message([
        ThinkingEvent(text="我先分析目录结构, 然后写脚本"),
        MessageStopEvent(usage=None),
    ])
    assert msg.role == "assistant"
    assert len(msg.content) == 1
    assert "我先分析目录结构" in msg.content[0].text
    assert "thinking 兜底" in msg.content[0].text  # 降级标记必须显式


def test_build_assistant_message_有正文时thinking不进历史():
    """正常路径: text/tool 块在场, thinking 不落历史(不污染上下文重放)。"""
    from api_client import MessageStopEvent, TextDeltaEvent, ThinkingEvent

    msg, _ = build_assistant_message([
        ThinkingEvent(text="内心独白"),
        TextDeltaEvent(text="正文回答"),
        MessageStopEvent(usage=None),
    ])
    texts = [b.text for b in msg.content if getattr(b, "text", None)]
    assert texts == ["正文回答"]
    assert not any("内心独白" in (getattr(b, "text", "") or "") for b in msg.content)
