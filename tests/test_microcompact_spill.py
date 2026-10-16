"""D3: 微压缩清除前尽力落盘——1K~30K 区间的工具结果被清时不再"无址丢失"。

背景: 落盘线 bash=30K / 清除线 1K, 中间区间的结果被微压缩清掉后占位符
没有路径, 唯一恢复方式是重跑命令（长测试/构建成本高）。修复: 清理循环里
对无落盘标记的待清块先调 spill_tool_output, 成功则走带路径占位符分支。

运行: uv run pytest tests/test_microcompact_spill.py -v
"""

import re

import pytest

import aulos.tools as tools
from aulos.models import Message, Session
from aulos.permissions import ALLOW_MODE, PermissionPolicy
from aulos.runtime import ConversationRuntime, MICROCOMPACT_PLACEHOLDER
from test_microcompact import NoopExecutor, ScriptedClient


def make_runtime(session) -> ConversationRuntime:
    return ConversationRuntime(
        session=session,
        api_client=ScriptedClient(),
        tool_executor=NoopExecutor(),
        permission_policy=PermissionPolicy(active_mode=ALLOW_MODE),
        system_prompt=["s"],
    )


def spill_dir(tmp_path, monkeypatch):
    d = tmp_path / "tool-results"
    d.mkdir(parents=True)
    monkeypatch.setattr(tools, "TOOL_RESULTS_DIR", d)
    return d


def mid_result(i: int, name: str = "bash", chars: int = 5_000) -> Message:
    """5K 输出: 高于清除线 1K（会被清）, 低于落盘线 30K（原不落盘）。"""
    return Message.tool_result(id=f"t{i}", name=name, output=f"out{i} " + "x" * chars,
                               is_error=False)


def test_清除前落盘_占位符带路径可找回(tmp_path, monkeypatch):
    d = spill_dir(tmp_path, monkeypatch)
    msgs = [mid_result(i) for i in range(12)]     # 12 × 1.25k token ≈ 15k? 5k chars → >1.25k tok; 12条≈12.6k token
    # 确保超 60K 阈值: 每条 (len//4)+1 ≈ 1251 token, 12 条 ≈ 15k —— 不够
    msgs = [mid_result(i, chars=22_000) for i in range(12)]  # ≈5.5k tok/条 × 12 ≈ 66k > 60k
    rt = make_runtime(Session(messages=msgs))

    view = rt._model_view()

    cleared = [m for m in view[:4] if m.content[0].output != f"out{view.index(m)} " + "x" * 22_000]
    old = view[0].content[0].output
    assert old != "out0 " + "x" * 22_000                  # 确实被清了
    assert MICROCOMPACT_PLACEHOLDER in old                # 占位符在
    path = re.search(r"saved to `([^`]+)`", old)
    assert path is not None, "清除的 5K~30K 结果应带落盘路径"
    assert open(path.group(1), encoding="utf-8").read() == "out0 " + "x" * 22_000
    # 最近 8 条仍原文
    assert all(m.content[0].output.startswith("out") for m in view[-8:])


def test_落盘失败退化为纯占位符不抛异常(tmp_path, monkeypatch):
    spill_dir(tmp_path, monkeypatch)
    msgs = [mid_result(i, chars=22_000) for i in range(12)]
    rt = make_runtime(Session(messages=msgs))

    def boom(output):
        raise OSError("disk full")

    monkeypatch.setattr(tools, "spill_tool_output", boom)

    view = rt._model_view()                               # 不抛
    old = view[0].content[0].output
    assert MICROCOMPACT_PLACEHOLDER in old
    assert "saved to" not in old                          # 无路径分支


def test_已有落盘标记的不重复落盘(tmp_path, monkeypatch):
    d = spill_dir(tmp_path, monkeypatch)
    # 构造已带落盘标记的结果（入口层已落盘过）: 100K grep 输出走入口截断
    existing = d / "existing.txt"
    existing.write_text("y" * 120_000, encoding="utf-8")
    marker_output = ("HEAD\n" + "y" * 120_000 + "\nTAIL"
                     + tools._spill_marker(117_000, str(existing)))
    msgs = [Message.tool_result(id=f"t{i}", name="grep", output=marker_output,
                                is_error=False) for i in range(12)]
    rt = make_runtime(Session(messages=msgs))

    assert [p.name for p in d.glob("*.txt")] == ["existing.txt"]

    view = rt._model_view()

    old = view[0].content[0].output
    assert "existing.txt" in old                          # 复用已有路径
    assert len(list(d.glob("*.txt"))) == 1                # 没有新落盘文件
