"""session_recall 工具: 压缩后按需取回压缩前的原始消息。

两种模式: query=关键词搜索（大小写不敏感, 返回带序号的命中列表）;
index=N [around=K]=按序号读附近区间。两者都不给 → 用法 + 合法范围。
tool_result 只给首行 + 字符数（体积大且可重新调用工具获取）。
纯内存读当前会话, 无副作用, 权限档位 READ_ONLY_MODE。

数据源 SESSION_MESSAGES 由 runtime._model_view 写入; 这里直接 set,
专测工具本身的契约。

运行: uv run pytest tests/test_session_recall.py -v
"""

import pytest

from aulos import main as main_module
from aulos.agent_tools import session_recall_tool
from aulos.models import (Message, Session, ToolContentBlock,
                          ToolResultContentBlock)
from aulos.permissions import READ_ONLY_MODE
from aulos.runtime import SESSION_MESSAGES


def _msg(role, text):
    return Message(role=role, content=[{"type": "text", "text": text}])


def _tool_use_msg(name, inp):
    # ToolContentBlock.input 是 str（API 侧 JSON 序列化后的原文）
    return Message(role="assistant", content=[
        {"type": "tool_use", "id": "t1", "name": name,
         "input": '{"path": "config.py"}'}])


def _tool_result_msg(name, output):
    # ToolResultContentBlock: id 必填, 无 tool_use_id 字段
    return Message(role="tool", content=[
        {"type": "tool_result", "id": "t1", "name": name, "output": output}])


@pytest.fixture
def history():
    msgs = [
        _msg("user", "帮我把 config.py 里的超时改成 30"),
        _msg("assistant", "好的, 先读一下文件"),
        _tool_use_msg("read_file", {"path": "config.py"}),
        _tool_result_msg("read_file", "first line of output\n" + "x" * 5000),
        _msg("user", "把它改成 60 吧"),
        _msg("assistant", "已更新 config.py"),
    ]
    token = SESSION_MESSAGES.set(msgs)
    yield msgs
    SESSION_MESSAGES.reset(token)


def test_registered_as_read_only_tool():
    names = [s["name"] for s in main_module.TOOLS]
    assert "session_recall" in names
    assert main_module.TOOL_REQUIREMENTS["session_recall"] == READ_ONLY_MODE
    # 注册表里有 handler
    registry = main_module.build_registry()
    assert "session_recall" in registry._handlers


def test_no_history_returns_hint():
    SESSION_MESSAGES.set(None)
    out = session_recall_tool({})
    assert "No session history" in out


def test_no_params_returns_usage_and_range(history):
    out = session_recall_tool({})
    assert "query=" in out and "index=" in out
    assert "0..5" in out


def test_query_and_index_mutually_exclusive(history):
    out = session_recall_tool({"query": "config", "index": 0})
    assert out.startswith("ERROR")


def test_query_returns_indexed_hits_case_insensitive(history):
    out = session_recall_tool({"query": "CONFIG.PY"})
    # 第 0 条与第 5 条命中, 带序号, 方便接着用 index 读全文
    assert "[0] user:" in out and "config.py" in out
    assert "[5] assistant:" in out and "config.py" in out
    # tool_result 里也含 config.py 的话才命中; 这里 read_file 输出不含, 不应出现
    assert "[3] tool:" not in out


def test_query_no_match(history):
    out = session_recall_tool({"query": "不存在的关键词"})
    assert out.startswith("No messages match")


def test_query_hit_snippet_is_bounded(history):
    long_msg = _msg("user", "a" * 1000 + " 针 " + "b" * 1000)
    token = SESSION_MESSAGES.set([long_msg])
    try:
        out = session_recall_tool({"query": "针"})
        # 命中前后各约 200 字符, 不是整条 2005 字符; 前缀 "[0] user: " 之后才是省略号
        assert len(out) < 600
        assert out.startswith("[0] user: …")
    finally:
        SESSION_MESSAGES.reset(token)


def test_query_caps_hits(history):
    msgs = [_msg("user", f"重复 keyword {i}") for i in range(30)]
    token = SESSION_MESSAGES.set(msgs)
    try:
        out = session_recall_tool({"query": "keyword"})
        assert out.count("] user:") == 20
        assert "Showing up to 20 hits" in out
    finally:
        SESSION_MESSAGES.reset(token)


def test_index_reads_window_with_around(history):
    out = session_recall_tool({"index": 1, "around": 1})
    assert out.startswith("[0] user:")
    assert "[1] assistant:" in out
    assert "[2] assistant:" in out
    assert "[3] tool:" not in out
    assert "Message range shown: 0..2 of 0..5" in out


def test_index_default_around_is_3(history):
    out = session_recall_tool({"index": 2})
    assert "[0] user:" in out and "[5] assistant:" in out
    assert "Message range shown" not in out      # 覆盖全量时不加范围提示


def test_index_clamps_around_and_bounds(history):
    out = session_recall_tool({"index": 0, "around": 999})
    assert "[5] assistant:" in out               # around 钳制到 20, 但区间被 0..5 截住
    assert session_recall_tool({"index": -1}).startswith("ERROR")
    assert session_recall_tool({"index": 6}).startswith("ERROR")
    assert "0..5" in session_recall_tool({"index": 6})
    assert session_recall_tool({"index": "abc"}).startswith("ERROR")
    assert session_recall_tool({"index": 0, "around": "abc"}).startswith("ERROR")


def test_tool_result_rendered_as_first_line_plus_char_count(history):
    out = session_recall_tool({"index": 3, "around": 0})
    assert "first line of output" in out
    assert "chars)" in out
    assert "x" * 100 not in out                 # 正文不进回看结果


def test_tool_use_rendered_with_input(history):
    out = session_recall_tool({"index": 2, "around": 0})
    assert "[tool_use read_file" in out
    assert "config.py" in out


def test_output_truncation_notice(history):
    msgs = [_msg("user", "长文 " + "y" * 3000) for _ in range(4)]
    token = SESSION_MESSAGES.set(msgs)
    try:
        out = session_recall_tool({"index": 1, "around": 3})
        assert len(out) < 4200
        assert "Truncated at 4000 chars" in out
    finally:
        SESSION_MESSAGES.reset(token)
