"""D1: 溢出错误反应式恢复——捕获→强制压缩→单次重试。

背景: 默认阈值 750K 绑定 1M 窗口模型, 靠用户手动配 contextWindow。
配错时（200K 模型没改配置）, 413/context-length 错误直接掀翻整轮——
retry.py 只重试 429/529/连接错误。修复:
1. retry.is_context_overflow_error: 413, 或 400 且 message 含
   context/maximum length 类关键词（宽松匹配, 宁可漏判不错抓）;
2. run_turn 包住 stream 调用: 命中溢出且本轮未恢复过 → 强制激活
   压缩视图, 重试恰好一次（硬上限, 不进循环）;
3. 仍溢出 → 抛可读错误提示调 contextWindow, 无第三次请求;
4. 熔断器打开时走规则摘要同样能救场, 不复位熔断器。

运行: uv run pytest tests/test_context_overflow_recovery.py -v
"""

import pytest

from aulos.api_client import MessageStopEvent, TextDeltaEvent, UsageInfo
from aulos.models import Message, Session
from aulos.permissions import ALLOW_MODE, PermissionPolicy
from aulos.retry import HttpApiError, is_context_overflow_error
from aulos.runtime import ConversationRuntime
from test_auto_compact_signal import (
    NoopExecutor, ScriptedClient, make_events)


class RaisingScriptedClient:
    """按脚本逐次抛错/返回: HttpApiError 项抛出, list 项返回 events。"""
    def __init__(self, script: list):
        self.script = list(script)
        self.calls = 0
        self.seen: list[list] = []
        self.thinking_level = "medium"

    def stream(self, system_prompt, messages, thinking_level=None, *, model=None, include_tools=True, emit_output=None, on_event=None) -> list:
        if not include_tools:
            # side-call（摘要器等）: 不消费主脚本, 直接返回一段文本
            return make_events("summary side-call", out_tokens=1, in_tokens=1)
        self.seen.append(list(messages))
        item = self.script[self.calls] if self.calls < len(self.script) else self.script[-1]
        self.calls += 1
        if isinstance(item, Exception):
            raise item
        return item


def make_runtime(session, client) -> ConversationRuntime:
    return ConversationRuntime(
        session=session,
        api_client=client,
        tool_executor=NoopExecutor(),
        permission_policy=PermissionPolicy(active_mode=ALLOW_MODE),
        system_prompt=["助手"],
    ).with_auto_compact_threshold(10**9)      # 预估口径永远不触发, 只能靠反应式


def test_is_context_overflow_error_判定矩阵():
    assert is_context_overflow_error(HttpApiError(413, "")) is True
    assert is_context_overflow_error(HttpApiError(400, "maximum context length exceeded")) is True
    assert is_context_overflow_error(HttpApiError(400, "This model's maximum context length is 200000 tokens")) is True
    assert is_context_overflow_error(HttpApiError(400, "prompt is too long: 250000 tokens > 200000 maximum")) is True
    # 宁可漏判不错抓: 普通 400 不是溢出
    assert is_context_overflow_error(HttpApiError(400, "invalid tool_use block")) is False
    assert is_context_overflow_error(HttpApiError(401, "bad key")) is False
    assert is_context_overflow_error(HttpApiError(429, "rate limited")) is False


def test_首次溢出_强制压缩视图_恰好重试一次_轮次正常收束():
    # 16 条旧消息 + user: 预估口径不触发（阈值 1e9）, 但服务端报 413
    session = Session(messages=[Message.user_text(f"旧消息{i} " + "x" * 200)
                                for i in range(16)])
    client = RaisingScriptedClient([
        HttpApiError(413, "request too large"),
        make_events("recovered", out_tokens=1, in_tokens=1),
    ])
    rt = make_runtime(session, client)

    summary = rt.run_turn("hi")

    assert client.calls == 2                       # 恰好重试一次
    assert len(client.seen[1]) < len(client.seen[0])   # 第二次请求视图被压缩
    assert any("continued from a previous conversation"
               in b.text for m in client.seen[1]
               for b in m.content if hasattr(b, "text"))
    assert rt._compact_active is True              # 粘性标记置位
    assert any("recovered" in b.text
               for m in summary.assistant_messages
               for b in m.content if hasattr(b, "text"))   # 轮次正常收束
    # 历史不被改写
    assert len(rt.session().messages) == 18


def test_两次溢出_抛可读错误_无第三次请求():
    session = Session(messages=[Message.user_text(f"旧消息{i} " + "x" * 200)
                                for i in range(16)])
    client = RaisingScriptedClient([
        HttpApiError(413, "too large"),
        HttpApiError(413, "still too large"),
    ])
    rt = make_runtime(session, client)

    with pytest.raises(Exception) as ei:
        rt.run_turn("hi")
    msg = str(ei.value)
    assert "contextWindow" in msg or "上下文窗口" in msg
    assert client.calls == 2                       # 无第三次请求


def test_非溢出错误不触发恢复路径():
    session = Session(messages=[Message.user_text("hi")])
    client = RaisingScriptedClient([
        HttpApiError(400, "invalid tool_use block"),
    ])
    rt = make_runtime(session, client)

    with pytest.raises(HttpApiError):
        rt.run_turn("hi")
    assert client.calls == 1                       # 原样上抛, 无重试
