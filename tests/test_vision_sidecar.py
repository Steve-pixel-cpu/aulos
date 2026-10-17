"""视觉副驾（vision sidecar）: 主模型拒图时 utility 视觉模型转述重试。

背景: GLM Coding 端点上 glm-5.3 是纯文本部署, 用户消息带图片块返回
400 code 1210 "messages.content.type 参数非法, 取值范围 ['text']",
整轮炸掉。同端点 glm-5.3-flash 是多模态部署, 已作为 utilityProvider
接入 side-call 通道。修复:
1. retry.is_image_content_rejected_error: 400 且 message 匹配
   content.type/图片拒绝类措辞（宽松匹配, 宁可漏判不错抓普通 400）;
2. 撞 1210 → 置位 _main_rejects_images + 视图里的图换成转述 → 重试
   恰好一次; 转述只走 _utility_client, 失败原样上抛（无重试风暴）;
3. 会话内记忆: 后续轮次发请求前主动替换（按图缓存, 全命中零 side-call）;
4. view-only: session.messages 永不被修改——转述只发生在发给 API 的
   视图上, 与压缩视图同一哲学。

运行: uv run pytest tests/test_vision_sidecar.py -v
"""

import base64
import hashlib

import pytest

from aulos.api_client import TextDeltaEvent
from aulos.models import ImageContentBlock, Message, Session
from aulos.permissions import ALLOW_MODE, PermissionPolicy
from aulos.retry import HttpApiError, is_image_content_rejected_error
from aulos.runtime import ConversationRuntime
from test_auto_compact_signal import (
    NoopExecutor, make_events)

# 真实 1x1 PNG（合法 base64, 够测试用）
_PNG_B64 = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000d4944415478da63f8ffff3f0300050201f34a2e6d"
    "0000000049454e44ae426082")).decode()

_REJECT_MSG = ("messages.content.type 参数非法，取值范围 ['text']")
_REJECT_ERR = HttpApiError(400, _REJECT_MSG)


def _img_attachment() -> dict:
    return {"kind": "image", "media_type": "image/png", "data": _PNG_B64}


def _caption_key() -> str:
    return hashlib.sha256(_PNG_B64.encode("utf-8")).hexdigest()


def _msg_has_image(msg: Message) -> bool:
    return any(getattr(b, "type", None) == "image" for b in msg.content)


def _msg_texts(msg: Message) -> str:
    return "\n".join(b.text for b in msg.content
                     if getattr(b, "type", None) == "text")


class RaisingScriptedClient:
    """按脚本逐次抛错/返回: HttpApiError 项抛出, list 项返回 events。
    include_tools=False 的 side-call 不消费主脚本——但转述测试需要控制
    转述内容, 因此 utility 用独立的 CapturingUtilityClient。"""
    def __init__(self, script: list):
        self.script = list(script)
        self.calls = 0
        self.seen: list[list] = []
        self.thinking_level = "medium"

    def stream(self, system_prompt, messages, thinking_level=None, *, model=None, include_tools=True, emit_output=None, on_event=None) -> list:
        if not include_tools:
            raise TypeError("side-calls unsupported")
        self.seen.append(list(messages))
        item = self.script[self.calls] if self.calls < len(self.script) else self.script[-1]
        self.calls += 1
        if isinstance(item, Exception):
            raise item
        return item


class CapturingUtilityClient:
    """utility fake: 每次转述 side-call 返回固定文本并计数。"""
    def __init__(self, reply: str = "截图显示: AssertionError: boom"):
        self.reply = reply
        self.calls = 0
        self.seen: list[list] = []
        self.thinking_level = "low"

    def stream(self, system_prompt, messages, thinking_level=None, *, model=None, include_tools=True, emit_output=None, on_event=None) -> list:
        if include_tools or emit_output is None:
            raise TypeError("utility client only serves side-calls")
        self.seen.append(list(messages))
        self.calls += 1
        return [TextDeltaEvent(text=self.reply)]


def make_runtime(session, client,
                 utility: object = None) -> ConversationRuntime:
    rt = ConversationRuntime(
        session=session,
        api_client=client,
        tool_executor=NoopExecutor(),
        permission_policy=PermissionPolicy(active_mode=ALLOW_MODE),
        system_prompt=["助手"],
    )
    if utility is not None:
        rt.set_utility_client(utility)
    return rt


# --- 分诊矩阵 ---

def test_拒图分诊矩阵():
    # 真实 1210 措辞（含 HTTP 400 前缀形态）→ True
    assert is_image_content_rejected_error(_REJECT_ERR) is True
    assert is_image_content_rejected_error(HttpApiError(
        400, "…请求体: {'error': {'code': '1210', 'message': "
             "\"messages.content.type 参数非法，取值范围 ['text']\"}}")) is True
    # 英文同义措辞 → True
    assert is_image_content_rejected_error(HttpApiError(
        400, "unsupported content type: image")) is True
    assert is_image_content_rejected_error(HttpApiError(
        400, "image input is not supported by this model")) is True
    assert is_image_content_rejected_error(HttpApiError(
        400, "不支持图片输入")) is True
    # 宁可漏判不错抓: 普通 400 / 其他状态码 / 非 HttpApiError
    assert is_image_content_rejected_error(HttpApiError(
        400, "invalid tool_use block")) is False
    assert is_image_content_rejected_error(HttpApiError(413, "too large")) is False
    assert is_image_content_rejected_error(HttpApiError(401, "bad key")) is False
    assert is_image_content_rejected_error(ValueError("boom")) is False


# --- 端到端: 撞 1210 → 转述 → 重试一次 ---

def test_首次拒图_转述重试一次_轮次正常收束_历史不被改写():
    session = Session()
    utility = CapturingUtilityClient()
    client = RaisingScriptedClient([
        HttpApiError(400, _REJECT_MSG),
        make_events("recovered", out_tokens=1, in_tokens=1),
    ])
    rt = make_runtime(session, client, utility=utility)

    summary = rt.run_turn("看看这张图", attachments=[_img_attachment()])

    assert client.calls == 2                       # 恰好重试一次
    assert any("recovered" in _msg_texts(m)
               for m in summary.assistant_messages)
    # 第二次请求: 无图片块, 含转述包裹文本
    second = client.seen[1]
    assert not any(_msg_has_image(m) for m in second)
    assert any("[Image transcribed by vision model]" in _msg_texts(m)
               and "截图显示" in _msg_texts(m)
               and "[End of image transcription]" in _msg_texts(m)
               for m in second)
    # 转述 side-call: 图片块 + 指令文本, 走了 utility
    assert utility.calls == 1
    assert any(getattr(b, "type", None) == "image"
               for m in utility.seen[0] for b in m.content)
    # view-only: session.messages 仍含原图片块
    assert sum(_msg_has_image(m) for m in rt.session().messages) == 1
    assert rt._main_rejects_images is True         # 标志置位


# --- 会话内记忆: 第二轮 proactive 替换, 缓存命中零 side-call ---

def test_同runtime第二轮_首请求即转述视图_转述调用不再增加():
    utility = CapturingUtilityClient()
    client = RaisingScriptedClient([
        HttpApiError(400, _REJECT_MSG),
        make_events("ok1", out_tokens=1, in_tokens=1),
        make_events("ok2", out_tokens=1, in_tokens=1),   # 第二轮直接成功
    ])
    rt = make_runtime(Session(), client, utility=utility)

    rt.run_turn("看看这张图", attachments=[_img_attachment()])
    assert client.calls == 2 and utility.calls == 1   # 基线: 一次转述

    rt.run_turn("再看这张图", attachments=[_img_attachment()])
    # 第二轮第一次尝试就应是转述视图（主 client 只 1 次调用, 无第二次 400）
    assert client.calls == 3
    first_of_turn2 = client.seen[2]
    assert not any(_msg_has_image(m) for m in first_of_turn2)
    assert any("截图显示" in _msg_texts(m) for m in first_of_turn2)
    # 缓存命中: utility 转述调用次数不增
    assert utility.calls == 1


# --- 降级: 无 utility client / utility 抛错 → 原样上抛, 无重试风暴 ---

def test_未设utility_client_原始错误上抛_主client仅一次():
    session = Session()
    client = RaisingScriptedClient([HttpApiError(400, _REJECT_MSG)])
    rt = make_runtime(session, client)             # 不绑 utility

    with pytest.raises(HttpApiError) as ei:
        rt.run_turn("看看这张图", attachments=[_img_attachment()])
    assert ei.value is client.script[0]            # 原始错误对象原样上抛
    assert client.calls == 1
    # 规格顺序: 命中拒图即置位 → 尝试转述（此处无 utility, 直接 None）
    # → 上抛。置位先于转述, "主模型拒图"是实锤事实, 与转述是否可用无关
    assert rt._main_rejects_images is True


def test_utility转述失败_原始错误上抛_主client仅一次():
    session = Session()
    utility = CapturingUtilityClient()
    utility.fail = True
    client = RaisingScriptedClient([HttpApiError(400, _REJECT_MSG)])
    rt = make_runtime(session, client, utility=utility)

    def boom(*a, **k):
        raise RuntimeError("utility endpoint down")
    utility.stream = boom                          # fake 改为抛错

    with pytest.raises(HttpApiError):
        rt.run_turn("看看这张图", attachments=[_img_attachment()])
    assert client.calls == 1                       # 无重试风暴
    assert rt._main_rejects_images is True         # 实锤仍被记录
    assert rt._image_captions == {}                # 失败不缓存


def test_无图片块的普通400_不走恢复路径():
    session = Session(messages=[Message.user_text("hi")])
    client = RaisingScriptedClient([HttpApiError(400, _REJECT_MSG)])
    rt = make_runtime(session, client,
                      utility=CapturingUtilityClient())

    with pytest.raises(HttpApiError):
        rt.run_turn("hi")
    assert client.calls == 1                       # 转述返回 None → 上抛
    assert utility_calls(rt) == 0


def utility_calls(rt) -> int:
    return len(getattr(rt._utility_client, "seen", [])) if rt._utility_client else 0


# --- 热换复位 ---

def test_set_api_client复位拒图标志_set_utility_client不复位():
    session = Session()
    utility = CapturingUtilityClient()
    client = RaisingScriptedClient([
        HttpApiError(400, _REJECT_MSG),
        make_events("ok", out_tokens=1, in_tokens=1),
    ])
    rt = make_runtime(session, client, utility=utility)
    rt.run_turn("看看这张图", attachments=[_img_attachment()])
    assert rt._main_rejects_images is True

    # utility 热换: 标志说的是主模型, 不复位
    rt.set_utility_client(CapturingUtilityClient())
    assert rt._main_rejects_images is True

    # api_client 热换: 端点已换, 旧结论作废
    rt.set_api_client(RaisingScriptedClient([
        make_events("ok2", out_tokens=1, in_tokens=1)]))
    assert rt._main_rejects_images is False
