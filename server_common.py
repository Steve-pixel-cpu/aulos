# server_common.py — Web 服务共享基座（server 包拆分的第 1 步）
#
# 承载所有功能域模块都依赖的全局单例与基础设施, 让 server.py 的主体
# （turn 循环/WS/设置/供应商）与各功能域路由可以各自独立演进:
#
#   store / api_client / _utility_client   与 CLI 同源的装配单例
#   app / API_TOKEN / STATIC_DIR           FastAPI 实例 + 连接门禁 + 静态挂载
#   dispatch / _mirror_on_event            按线程路由事件 + 浏览器镜像
#   _TurnBinding / TurnDispatch            contextvars 绑定四件套
#
# 约束: 本模块禁止 import server / server_*（依赖方向只允许别人依赖它,
# 单向无环）。server.py 从这里 re-export 全部名字, 既有调用点/测试的
# `import server` + `server.app_state` 不受影响。
"""Aulos web — 共享基座: 装配单例 / FastAPI 实例 / 事件路由。"""
from __future__ import annotations

import platform
import secrets
import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from api_client import (ClaudeApiClient, WireEvent, WireTextDelta,
                        WireToolStart, WireToolEnd, WireThinkingStart,
                        WireThinkingEnd, WireObserver, make_api_client,
                        normalize_protocol)
from config import USER_DIR, ConfigLoader, RuntimeConfig
from main import TOOLS, setup_console
from prompt import SystemPromptBuilder
from storage import SessionStore

setup_console()  # Windows 控制台 UTF-8 兜底（服务器日志不乱码，与 CLI 同一入口）

# --- 与 CLI 同源的装配: 同一份存储、同一套工具、同一个默认模型 ---
STORAGE_DIR = USER_DIR / "sessions"
store = SessionStore(storage_dir=STORAGE_DIR)

# 已创建但尚未落盘的会话 id: POST /api/sessions 只生成 id，首条消息落盘才建
# 文件（与 CLI 一致）。列表/历史接口必须认得它们，否则"新建会话"在侧栏
# 不出现、历史接口 404，前端渲染成空白。
_pending_sessions: set[str] = set()

runtime_config: RuntimeConfig = ConfigLoader(
    cwd=Path.cwd(), config_home=USER_DIR   # aulos 自己的用户配置目录
).load()

system_prompt = (
    SystemPromptBuilder()
    .with_os(platform.system(), platform.release())
    .build()
)


def _mirror_rate_limit_retry(attempt: int, max_retries: int,
                             delay_s: float, error) -> None:
    """限流退避镜像: 长退避期间告知前端"还活着、正在重试", 不再静默卡住。
    dispatch 在本模块内已定义; 回调运行于 turn 工作线程, 取到时必然已就绪;
    取不到出口（CLI/无连接）静默。仅 429 触发——其余错误的短退避
    （<1s）不值得打扰界面。"""
    if getattr(error, "status_code", None) != 429:
        return
    sink = dispatch.current()
    if sink is not None:
        sink({"type": "rate_limited_retry", "attempt": attempt,
              "max_retries": max_retries, "delay_s": round(delay_s, 1)})


def _should_stop_now() -> bool:
    """打断检查点: 取本轮绑定的 should_stop 并真正调用它。
    注意必须调用返回的可调用对象——直接把可调用对象当布尔值用,
    恒为真, 每次建连都会被误判成"已打断"。"""
    check = dispatch.current_should_stop()
    return bool(check and check())


api_client = ClaudeApiClient(
    api_key="",   # 未配置时为空串: 服务照常起, 由初始化页引导填写
    model=runtime_config.model() or "",   # 不设默认模型: 由用户显式添加
    tools=TOOLS,
    emit_output=False,  # Web 模式不打印终端，事件改推给浏览器
    thinking_level=runtime_config.thinking_level(),
    on_retry=_mirror_rate_limit_retry,
    # 打断检查点: 重试退避/建连静默窗口内轮询, 点停止立即生效
    # （dispatch 在本模块内定义, 函数运行时才解析, 无先后问题）
    should_stop_provider=_should_stop_now,
    # 浏览器镜像: 开流时按轮解析 contextvars 绑定的 sink（取代旧的
    # _LiveClientProxy 客户端包装, 协议知识不再进 server）
    on_event_provider=lambda: _mirror_on_event(dispatch.current_sink()),
)

# side-call 专用 client（utilityProvider 小模型）: 自动命名/压缩摘要等
# "整理型"调用走它, 主循环不动。None = 未配置, 回落主模型。
# 由 _apply_provider_config 统一构建/重建（见 server._rebuild_utility_client）。
_utility_client: Optional[object] = None

app = FastAPI(title="Aulos web")


STATIC_DIR = Path(__file__).parent / "static"
# 静态资源 (app.css / app.js): index.html 拆分后由这里托管
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ============================================================================
# 按线程路由事件: 内核挂点 → 当前会话的 emit
# ============================================================================

@dataclass
class _TurnBinding:
    """一轮对话挂在工作线程上的绑定四件套。"""
    emit: Callable
    workdir: Optional[str] = None
    should_stop: Optional[Callable[[], bool]] = None
    session_id: Optional[str] = None


_binding_var: ContextVar[Optional[_TurnBinding]] = ContextVar(
    "aulos_turn_binding", default=None)


class TurnDispatch:
    """按上下文路由事件。

    工作线程开跑一轮前 bind(emit)，结束后 unbind()。内核侧三个挂点
    （SSE 流代理 / 工具注册表 / 权限桥）在事件发生时用 current() 拿到
    本轮绑定的 emit——多个会话各开各的线程，互不串线。
    同时绑定本轮的会话工作目录，工具执行时取 current_workdir()；
    绑定 should_stop 勾子，流式代理逐事件检查以支持即时打断。

    旧实现按线程号存 emit——runtime 串行执行工具时成立；工具并行执行
    进线程池后，挂点可能运行在池线程上, 线程号字典查不到绑定, tool_result
    会被静默吞掉。改用 contextvars：runtime 提交并行任务时带 copy_context()
    快照, 池内线程读到本轮的绑定; turn 工作线程各设各的上下文, 并发轮次
    依然互不串线。
    """

    def bind(self, emit: Callable, workdir: Optional[str] = None,
             should_stop: Optional[Callable[[], bool]] = None,
             session_id: Optional[str] = None) -> None:
        _binding_var.set(_TurnBinding(emit=emit, workdir=workdir,
                                      should_stop=should_stop,
                                      session_id=session_id))

    def unbind(self) -> None:
        _binding_var.set(None)

    def current(self) -> Optional[Callable]:
        binding = _binding_var.get()
        return binding.emit if binding else None

    def current_workdir(self) -> Optional[str]:
        binding = _binding_var.get()
        return binding.workdir if binding else None

    def current_should_stop(self) -> Optional[Callable[[], bool]]:
        binding = _binding_var.get()
        return binding.should_stop if binding else None

    def current_session_id(self) -> Optional[str]:
        binding = _binding_var.get()
        return binding.session_id if binding else None

    def current_sink(self) -> Optional[Callable[[dict], None]]:
        """本轮绑定的前端事件 sink（浏览器镜像观察者挂接点）。"""
        binding = _binding_var.get()
        return binding.emit if binding else None


dispatch = TurnDispatch()


# ============================================================================
# 浏览器镜像: 协议中立的线级事件（WireEvent）→ 前端事件
#
# 旧实现用 _LiveClientProxy/_LiveStreamProxy 包装 anthropic 客户端、逐个
# 解析 SDK 原生事件再转发——协议线格式因此在 server 被解析了两次。现在
# api_client.stream(on_event=...) 把线级事件按线上顺序回调出来, server 只
# 做一次"wire → 前端事件"的翻译（_wire_to_frontend）, 对 OpenAI 等新协议
# 零改动。用户打断不再在代理里掐（旧代理是唯一能从外部安全掐断流的
# 位置）, 改由 api_client 的 should_stop 检查点在建连/重试窗口轮询 +
# runtime 的历史一致点收束, 语义与 CLI 一致。
# ============================================================================

def _wire_to_frontend(event: WireEvent, sink: Callable[[dict], None],
                      state: dict) -> None:
    """单个 wire 事件 → 前端事件。state 为每次调用独立的镜像状态:
    thinking_t0 记录思考块起点（thinking_end 汇报耗时）。"""
    etype = type(event)
    if etype is WireTextDelta:
        sink({"type": "text_delta", "text": event.text})
    elif etype is WireToolStart:
        # 块开始即镜像: 大参数（write_file 整文件等）的工具 JSON 流式期
        # 可达几十秒, 等到块结束才发 tool_use 的话, 这段时间前端没有任何
        # 活动指示, 像卡死。前端收到 tool_use_started 提前建"运行中"工具卡。
        sink({"type": "tool_use_started", "id": event.id, "name": event.name})
    elif etype is WireToolEnd:
        sink({"type": "tool_use", "id": event.id, "name": event.name,
              "input": event.input_json})
    elif etype is WireThinkingStart:
        state["thinking_t0"] = time.monotonic()
        sink({"type": "thinking_start"})
    elif etype is WireThinkingEnd:
        t0 = state.pop("thinking_t0", None)
        if t0 is not None:
            sink({"type": "thinking_end",
                  "duration_ms": int((time.monotonic() - t0) * 1000)})


def _mirror_on_event(sink: Optional[Callable[[dict], None]]) -> Optional[WireObserver]:
    """把本轮绑定的前端 sink 包装成线级事件观察者（api_client 每次开流时
    调用 provider 取到本函数的返回值）。开流即广播一次 await_output: 工具
    跑完到下一个 token 之间有一段 prefill 空窗, 界面全静会像已经结束——
    前端据此显示等待转圈。sink 为 None（CLI/无绑定轮）返回 None = 不挂。"""
    if sink is None:
        return None
    sink({"type": "await_output"})
    state: dict = {}

    def _observe(event: WireEvent) -> None:
        _wire_to_frontend(event, sink, state)

    return _observe


# --- 连接门禁令牌: 桌面壳与后端共享 ~/.aulos/token 里的随机令牌 ---
# 所有请求必须携带 x-aulos-token 头 / cookie / query 之一, 否则 403 拒绝——
# 浏览器直接访问 127.0.0.1:8000 因此被挡在门外, 只有桌面壳能进来
_TOKEN_FILE = USER_DIR / "token"


def _ensure_api_token() -> str:
    _TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        t = _TOKEN_FILE.read_text(encoding="utf-8").strip()
        if t:
            return t
    except OSError:
        pass
    t = secrets.token_hex(32)
    _TOKEN_FILE.write_text(t, encoding="utf-8")
    return t


API_TOKEN = _ensure_api_token()
