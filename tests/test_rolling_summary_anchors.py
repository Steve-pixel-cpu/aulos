"""R1: 滚动摘要多代漂移——零调用路径加机械式逐字锚点。

背景: 滚动合并 merged = LLM(prev_summary + chunk) 整体替换, 长会话 6+
代接力误差单调累积（传话游戏）。零调用路径（digested >= keep_from,
runtime.py:1175）下整个归档区的唯一表示就是这个多代摘要, findings 逐字
机制没有传导到 L2; 摘要持久化到会话 JSONL, 漂移跨重启存续。

修复（方案 A, 消费端派生）: session.messages 从不被截断, 归档区原文始终
可得——零调用分支把 mem.summary 与机械抽取的 "Assistant conclusions
(verbatim)" 拼接后再返回。findings 抽取逻辑从 summarize_messages 抽出
为 extract_assistant_findings（不复制粘贴）, 作用于 msgs[:keep_from],
配额沿用 _MAX_FINDINGS=30 / _MAX_FINDING_CHARS=1500。纯 CPU、零调用、
零持久化格式改动。

明确禁止（规格原文）: 不许把逐字段交给 LLM 维护——锚点必须由代码维护、
永不经过模型。

运行: uv run pytest tests/test_rolling_summary_anchors.py -v
"""

import pytest

from aulos.compact import extract_assistant_findings
from aulos.models import Message, Session, TextContentBlock


def _assistant(text: str) -> Message:
    return Message(role="assistant", content=[TextContentBlock(text=text)])

from aulos.permissions import ALLOW_MODE, PermissionPolicy
from aulos.runtime import ConversationRuntime
from test_auto_compact_signal import NoopExecutor, make_events


class CountingClient:
    """主调用计数; side-call（摘要器）一律抛错——证明零调用路径真的
    没发摘要调用。"""
    def __init__(self):
        self.calls = 0
        self.side_calls = 0
        self.thinking_level = "medium"

    def stream(self, system_prompt, messages, thinking_level=None, *,
               model=None, include_tools=True, emit_output=None,
               on_event=None) -> list:
        if not include_tools:
            self.side_calls += 1
            raise RuntimeError("zero-call path must not summarize!")
        self.calls += 1
        return make_events("ok", out_tokens=1, in_tokens=1)


def make_runtime(session) -> ConversationRuntime:
    return ConversationRuntime(
        session=session,
        api_client=CountingClient(),
        tool_executor=NoopExecutor(),
        permission_policy=PermissionPolicy(active_mode=ALLOW_MODE),
        system_prompt=["助手"],
    )


VERBATIM = "实锤了——空指针出在 parser.py 第 42 行的 _walk 分支"


def test_extract_assistant_findings_只收助手文本_限条数限长度():
    msgs = [
        Message.user_text("查一下"),
        _assistant(VERBATIM),
        Message.tool_result(id="t", name="bash", output="...", is_error=False),
        _assistant("第二条结论"),
    ]
    f = extract_assistant_findings(msgs)
    assert f == [VERBATIM, "第二条结论"]          # 只收助手 Text 块, 逐字

    many = [_assistant(f"c{i}") for i in range(35)]
    f = extract_assistant_findings(many)
    assert len(f) == 30 and f[0] == "c5"          # 取最新的 30 条

    long = [_assistant("长" * 2000)]
    assert extract_assistant_findings(long)[0] == "长" * 1500   # 单条截 1500


def test_零调用路径_摘要带逐字锚点_且不发摘要sidecall():
    # 归档区(前10条)里有助手结论, 保留区(后2条)之外; 滚动摘要已覆盖
    # 全部归档区（digested >= keep_from）
    early = "锚点结论甲——写在会话早期"
    late = "锚点结论乙——写在归档区末尾"
    msgs = [
        Message.user_text("问题一"),
        _assistant(early),
        Message.user_text("问题二"),
        _assistant(late),
    ] + [Message.user_text(f"填充{i}") for i in range(8)]
    session = Session(messages=msgs)
    rt = make_runtime(session)
    rt.load_session_memory("滚动摘要正文（可能漂移）", 12)

    summary = rt._build_compact_summary(rt.session().messages, keep_from=10)

    assert "滚动摘要正文（可能漂移）" in summary      # 原摘要在
    assert "Assistant conclusions" in summary        # 锚点段落标题在
    assert early in summary and late in summary      # 归档区结论逐字活着
    # 零调用: 一次摘要 side-call 都没发
    assert rt._api_client.side_calls == 0


def test_锚点配额_30条1500字_不随摘要增长():
    msgs = [Message.user_text(f"u{i}") for i in range(12)]
    # 归档区塞 40 条超长结论
    for i in range(40):
        msgs.insert(1, _assistant(f"结论{i} " + "z" * 2000))
    session = Session(messages=msgs)
    rt = make_runtime(session)
    rt.load_session_memory("滚动摘要", 60)

    summary = rt._build_compact_summary(rt.session().messages, keep_from=10)

    assert summary.count("z" * 2000) == 0            # 单条被截 1500
    assert "结论39" in summary                       # 取最新
    assert "结论0 " not in summary                   # 老的被挤出 30 条配额
