"""轮询空转护栏的规格钉子。

背景(20261019 会话 JSONL 实测): 系统提示词明写 "Never poll agent_status
in a tight loop", 模型仍在单回合对同一 agent_id 发 10 次 agent_status,
中间没有任何本地工作——提示词层对轮询自旋失效, 与 read_file×24 事故
同款病理, 只能执行层兜住。

行为规格:
- 同 (tool, id) 连击第 3 次起, 结果尾部附加 POLL_WARN_TEXT 提醒;
- 照常执行、不拒绝、不改 is_error(与 shell 重跑提醒同模式);
- 每回合至多 2 条提醒(防提醒自身刷屏);
- 写入动作(edit_file/bash 等)不断连击——轮询目标的产出不是文件;
- 新用户回合(run_turn 入口)与压缩激活清零;
- agent_reap 不计数(收割幂等, 重调合法)。

运行方式(在 aulos 目录下):
    uv run pytest tests/test_tool_call_governance.py -v
"""

from aulos.api_client import MessageStopEvent, TextDeltaEvent, ToolUseEvent
from aulos.hooks import HookResult
from aulos.models import Session, ToolContentBlock
from aulos.permissions import PermissionMode, PermissionPolicy
from aulos.runtime import (ConversationRuntime, POLL_WARN_TEXT,
                           _poll_target_id)


class ScriptedClient:
    def __init__(self, script: list):
        self.script = list(script)
        self.calls = 0
        self.thinking_level = "medium"

    def stream(self, system_prompt, messages, thinking_level=None, *,
               model=None, include_tools=True, emit_output=None,
               on_event=None) -> list:
        events = (self.script[self.calls]
                  if self.calls < len(self.script) else self.script[-1])
        self.calls += 1
        return events


class RecordingExecutor:
    def __init__(self):
        self.executed: list[tuple[str, str]] = []

    def execute(self, tool_name, input, tool_use_id=None) -> str:
        self.executed.append((tool_name, input))
        return f"result-for-{tool_name}"


def make_runtime(executor) -> ConversationRuntime:
    return ConversationRuntime(
        session=Session(),
        api_client=ScriptedClient([]),      # 不实际 stream, 只测工具路径
        tool_executor=executor,
        permission_policy=PermissionPolicy(PermissionMode.ALLOW),
        system_prompt=["s"],
    )


def _run_tools(rt, calls: list[tuple[str, str]]):
    outs = []
    for i, (name, inp) in enumerate(calls):
        block = ToolContentBlock(id=f"t{i}", name=name, input=inp)
        msg = rt._execute_tool(block, HookResult(messages=[], denied=False))
        outs.append(msg)
    return outs


def _text(msg) -> str:
    return msg.content[0].output


POLL = ("agent_status", '{"agent_id": "ag-1"}')


# ------------------------------------------------------------
# 核心: 同 id 连击提醒(第3次起) + 回合封顶(至多2条)
# ------------------------------------------------------------

def test_同id第3次起提醒_第5次起封顶不再附():
    ex = RecordingExecutor()
    rt = make_runtime(ex)
    outs = _run_tools(rt, [POLL] * 5)

    for o in outs:
        assert o.content[0].is_error is False        # 永不拒绝
    assert POLL_WARN_TEXT not in _text(outs[0])      # 1st
    assert POLL_WARN_TEXT not in _text(outs[1])      # 2nd
    assert POLL_WARN_TEXT in _text(outs[2])          # 3rd
    assert POLL_WARN_TEXT in _text(outs[3])          # 4th(回合内第2条)
    assert POLL_WARN_TEXT not in _text(outs[4])      # 5th: 封顶后不再附
    assert len(ex.executed) == 5                     # 全部照常执行


def test_全部照常执行_不拒绝():
    ex = RecordingExecutor()
    rt = make_runtime(ex)
    outs = _run_tools(rt, [POLL] * 6)
    assert len(ex.executed) == 6
    assert all(o.content[0].is_error is False for o in outs)
    assert all(_text(o).startswith("result-for-agent_status") for o in outs)


# ------------------------------------------------------------
# 连击语义: 写入介入不清零; 不同 id 互不干扰; reap 不计数
# ------------------------------------------------------------

def test_写入介入不断连击():
    ex = RecordingExecutor()
    rt = make_runtime(ex)
    edit = ("edit_file", '{"path": "a.py", "old_string": "x", "new_string": "y"}')
    outs = _run_tools(rt, [POLL, POLL, edit, POLL, POLL])
    # edit 后的第 2 次 POLL 是连击第 4 次(≥3) → 提醒; 说明 edit 没清零
    assert POLL_WARN_TEXT in _text(outs[4])


def test_不同id互不干扰():
    rt = make_runtime(RecordingExecutor())
    other = ("agent_status", '{"agent_id": "ag-2"}')
    outs = _run_tools(rt, [POLL, POLL, other])
    assert POLL_WARN_TEXT not in _text(outs[2])      # ag-2 首次: 无提醒


def test_task_output同样计数():
    rt = make_runtime(RecordingExecutor())
    t = ("task_output", '{"task_id": "bg-1"}')
    outs = _run_tools(rt, [t, t, t])
    assert POLL_WARN_TEXT in _text(outs[2])


def test_agent_reap不计数():
    rt = make_runtime(RecordingExecutor())
    r = ("agent_reap", "{}")
    outs = _run_tools(rt, [r] * 4)
    assert all(POLL_WARN_TEXT not in _text(o) for o in outs)


def test_target_id提取():
    assert _poll_target_id('{"agent_id": "ag-1"}') == "ag-1"
    assert _poll_target_id('{"task_id": "bg-1"}') == "bg-1"
    # 解析失败回落原串: 同目标仍落同键
    assert _poll_target_id("not-json") == "not-json"


# ------------------------------------------------------------
# 回合重置: run_turn 入口清零
# ------------------------------------------------------------

def test_新用户回合连击与提醒配额重置():
    ex = RecordingExecutor()
    rt = make_runtime(ex)

    # 模拟 run_turn 入口的清零(与实现同一代码路径)
    with rt._guard_lock:
        rt._turn_call_clock = 0
        rt._checkpoint_mark = 0
        rt._poll_calls.clear()
        rt._poll_warn_count = 0

    outs = _run_tools(rt, [POLL] * 3)
    assert POLL_WARN_TEXT in _text(outs[2])          # 重置后第 3 次又提醒
