# --- aulos Web UI 后端 (FastAPI) ---
# 复用现有 agent 内核（runtime / api_client / permissions / storage），这里只做"皮":
# 把同步阻塞的 run_turn 丢进工作线程，内核事件经事件循环推回 WebSocket。
#
# 线程模型:
#   事件循环线程 —— WS 收发、REST、把队列里的 JSON 发给浏览器
#   工作线程     —— runtime.run_turn（同步阻塞），内部跑完整工具循环
# 跨线程通道:
#   emit(payload) 用 loop.call_soon_threadsafe 把事件塞进该连接的 asyncio.Queue，
#   sender 协程专职消费队列发送；权限审批回传走 queue.Queue（decide 阻塞等待）。
# 内核零改动挂点（三个代理，全部在事件发生处镜像一份给浏览器）:
#   _LiveClientProxy  — 包住 anthropic 客户端，SSE 流逐事件镜像（真流式正文）
#   EmittingToolRegistry — 工具执行完镜像 tool_result
#   WebPermissionPrompter — 权限询问转发成弹窗，阻塞等浏览器审批

import sys

if __name__ == "__main__":
    # 入口防双执行自举: 本文件作为 PyInstaller 入口 / `python server.py`
    # 以 __main__ 执行时, 下方功能域模块 (server_settings 等) 回投
    # `import server` 会把本文件再完整执行一遍——两份模块副本状态分裂,
    # 第二份在 re-export 处撞上半初始化的 server_settings 直接
    # ImportError (v5.1.0 打包版启动即崩, 2026-10-11)。这里先把真正的
    # 模块副本初始化出来, 入口副本只当跳板: main() 在模块副本的命名
    # 空间里拿 app/全局单例, 全程只有一份状态。
    import os as _os_boot

    sys.path.insert(0, _os_boot.path.dirname(_os_boot.path.abspath(__file__)))
    from server import main

    sys.exit(main())

import asyncio
# --- AppImage 环境清洗: 必须早于其它导入与任何子进程派生 ---
# Tauri 壳已在启动前剥掉 AppImage/linuxdeploy 注入的污染, 但 onefile
# bootloader 会把 /tmp/_MEIxxx 重新塞回本进程的 LD_LIBRARY_PATH —— 在这里
# 再清洗一次, 工具子进程 (bash 等) 继承干净环境, 不再出现 gst-inspect
# 崩溃于 _gst_value_unique_list_type、音频管线假死 (Ubuntu 24.04 实测)。
# 只删环境变量与过滤路径条目, 无新依赖; 非 AppImage 场景全是无害空跑。
import os as _os_env

_ld_path = _os_env.environ.get("LD_LIBRARY_PATH", "")
_kept = [p for p in _ld_path.split(":")
         if p and ".mount_" not in p and "_MEI" not in p]
if _kept != _ld_path.split(":"):
    _os_env.environ["LD_LIBRARY_PATH"] = ":".join(_kept)
for _gst_var in ("GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0",
                 "GI_TYPELIB_PATH"):
    _os_env.environ.pop(_gst_var, None)

import base64
import json
import os
import platform
import queue
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
from contextlib import suppress
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import anthropic

from api_client import (
    ClaudeApiClient,
    OpenAIApiClient,
    make_api_client,
    normalize_protocol,
    KNOWN_PROTOCOLS,
    THINKING_LEVELS,
    StreamInterrupted,
    WireEvent,
    WireTextDelta,
    WireThinkingStart,
    WireThinkingDelta,
    WireThinkingEnd,
    WireToolStart,
    WireToolEnd,
    WireUsage,
    WireStop,
)
from config import (USER_DIR, SETTINGS_FILE, ConfigLoader, McpServerConfig,
                    RuntimeConfig, load_providers, save_providers,
                    load_utility_provider, load_utility_provider_setting,
                    save_utility_provider_setting,
                    load_command_allowlist, save_command_allowlist,
                    load_additional_directories, save_additional_directories,
                    load_command_denylist, save_command_denylist,
                    load_sensitive_paths, save_sensitive_paths)
from main import (
    AUTO_TITLE_LEN,
    TOOLS,
    _attach_mcp_tools,
    build_registry,
    build_runtime,
    repair_interrupted_turn,
    resolve_permission_mode,
    setup_console,
)
from mcp_client import MCP_TOOL_PREFIX, get_mcp_manager
from models import (
    Message,
    Session,
    TextContentBlock,
    ToolContentBlock,
    ToolResultContentBlock,
    ImageContentBlock,
    FileContentBlock,
)
from permissions import (
    ALLOW_MODE,
    MODE_TO_NAME,
    NAME_TO_MODE,
    PermissionDecision,
    PermissionMode,
    PermissionRequest,
    PermissionResult,
)
from prompt import ProjectContext, SystemPromptBuilder
from storage import SessionStore
from tools import ToolRegistry, git_bash_unavailable_reason, TOOL_CANCEL_CHECK
from runtime import result_meta
from runtime import TurnInterrupted
from skills import (SkillError, delete_user_skill, discover_skills,
                    expand_skill_command, install_from_repo,
                    match_skill_command, register_skill_tools,
                    render_skills_section, skill_info, sync_skill_tools)
from multi_agent import set_api_config_provider
from agent_tools import get_orchestrator
import music as _music
import bilibili as _bili

setup_console()  # Windows 控制台 UTF-8 兜底（服务器日志不乱码，与 CLI 同一入口）

# --- 配置来源: 只有 ~/.aulos/settings.json 的 providers/activeProvider
#     （设置页/初始化页写入, 读写逻辑在 config.py）。
#     没有 .env 兜底——未配置时 api_key 为空串照常起服务,
#     前端检测到(/api/settings.configured=false)会弹初始化页引导填写 ---
# --- 装配与共享基座（store/api_client/app/dispatch/镜像）已上移 server_common.py;
# --- 功能域路由（music/bili/pets）拆分至 server_music/_bilibili/_pets。此处
# --- re-export 全部共享名, 既有 `import server` 调用点与测试零改动 ---
from server_common import (  # noqa: E402,F401  re-export
    STORAGE_DIR, store, _pending_sessions, runtime_config,
    API_TOKEN, system_prompt, _mirror_rate_limit_retry, _should_stop_now,
    api_client, _utility_client, app, STATIC_DIR,
    dispatch, _wire_to_frontend, _mirror_on_event,
    _TurnBinding, TurnDispatch,
)


@app.middleware("http")
async def _token_gate(request: Request, call_next):
    """连接门禁: 缺少有效令牌的请求一律 403（API_TOKEN 为空 = 门禁关闭, 供测试）。
    刻意读本模块命名空间的 API_TOKEN 而非 server_common 的——测试以
    monkeypatch.setattr(server, "API_TOKEN", "") 关门禁, patch 的是这里。"""
    if API_TOKEN:
        provided = (request.headers.get("x-aulos-token")
                    or request.cookies.get("aulos_token")
                    or request.query_params.get("token"))
        if provided != API_TOKEN:
            return JSONResponse(
                status_code=403,
                content={"detail": "请通过 Aulos 桌面应用打开"},
            )
    return await call_next(request)


@app.middleware("http")
async def no_cache_shell(request: Request, call_next):
    """页面壳与静态资源禁缓存: 前端迭代频繁, 保证刷新即最新（ETag 未变时仍 304）。"""
    response = await call_next(request)
    p = request.url.path
    if p == "/" or p == "/pet.html" or p.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response

# ============================================================================
# 模型供应商配置: 读写归口 config.py（~/.aulos/settings.json 的
# providers / activeProvider 两个 key）, 这里只保留运行态副本
# ============================================================================

# base_url 规范化已上移 api_client.normalize_base_url（CLI 装配 utilityProvider
# 也要用）; 这里留兼容别名, 既有调用点/测试不动。
from api_client import normalize_base_url as _normalize_base_url  # noqa: E402



def _provider_ready(cfg: dict) -> bool:
    """active 指向的供应商是否可用（启用 + 有接口地址 + 有 key）, 即是否已初始化。
    模型不作为就绪条件: 由用户在「设置 → 模型」里显式添加, 不设默认值。"""
    active = cfg.get("active") or {}
    prov = next((p for p in cfg.get("providers", [])
                 if p.get("id") == active.get("provider")), None)
    return bool(prov and prov.get("enabled") and prov.get("api_key")
                and str(prov.get("base_url") or "").strip())


def _protocol_of(prov: dict) -> str:
    """供应商条目的协议标识（缺失/空 = anthropic, 向后兼容旧配置）。"""
    try:
        return normalize_protocol(prov.get("protocol"))
    except ValueError:
        return normalize_protocol(None)


def _apply_provider_config(cfg: dict) -> None:
    """把 active 指向的启用供应商应用到 api_client, 并重挂浏览器镜像观察者。

    active 缺失/指向不存在或被禁用的供应商时: 保持未配置空 key（初始化页接管）。
    active 无 model: 只应用连接信息, 模型留待用户显式添加。
    协议与当前单例不同（如 anthropic → openai）时经工厂重建实例; 同协议
    走 configure() 原地换连接信息, 保留 cache 降级等实例内运行态。"""
    global api_client
    if _provider_ready(cfg):
        active = cfg.get("active") or {}
        prov = next((p for p in cfg.get("providers", [])
                     if p.get("id") == active.get("provider")), None)
        protocol = _protocol_of(prov)
        base_url = _normalize_base_url(prov.get("base_url"), protocol=protocol) or None
        api_key = prov.get("api_key")
        model = active.get("model")   # None/缺失 = 保持当前模型
        if protocol != api_client.protocol:
            # 跨协议切换: 线格式完全不同, 必须换实现（重试/打断/镜像钩子原样平移）。
            # 思考等级保留当前运行值——runtime_config 是启动快照, 用它会把
            # 设置页在运行期改过的全局默认打回旧档。
            api_client = make_api_client(
                protocol, api_key=api_key, model=model or "", base_url=base_url,
                tools=TOOLS, emit_output=False,
                thinking_level=api_client.thinking_level,
                on_retry=_mirror_rate_limit_retry,
                should_stop_provider=_should_stop_now,
                on_event_provider=lambda: _mirror_on_event(dispatch.current_sink()),
            )
        else:
            api_client.configure(
                base_url=base_url,
                api_key=api_key,
                model=model,
            )
    else:
        api_client.reset_to(api_key="", model="", base_url=None)
    _rebuild_utility_client()
    # subagent worker 跟随同一份供应商配置: 每次 spawn 时实时读 api_client
    # 的连接信息（apply 在运行期可反复发生, 工厂闭包引用而非快照）
    set_api_config_provider(_subagent_api_config)


def _rebuild_utility_client() -> None:
    """side-call 专用 client: 主供应商配置变化时一并重建。未配置/无效 =
    None, side-call 回落主模型（与未配置前一致）。既有会话 runtime 持有
    的旧引用随下次 load_runtime_for 刷新——热更新分钟级生效, 不追即时。"""
    global _utility_client
    uprov = load_utility_provider()
    if not uprov:
        _utility_client = None
        return
    protocol = _protocol_of(uprov)
    _utility_client = make_api_client(
        protocol, api_key=uprov.get("api_key") or "",
        model=uprov.get("model") or api_client.model or "",
        base_url=_normalize_base_url(uprov.get("base_url"), protocol=protocol) or None,
        tools=TOOLS, emit_output=False,
        thinking_level="low",
    )


def _subagent_api_config() -> tuple[str, Optional[str], str, str]:
    """multi_agent worker 工厂: 直接镜像 Leader 的 api_client 连接信息
    （key/base_url/model/protocol）。"""
    return (api_client.api_key, api_client.base_url, api_client.model,
            api_client.protocol)


def _api_client_for(web_session):
    """会话请求所用的 api_client: 模型跟随全局（含同 provider 内换模型,
    per-call model 参数覆盖）→ 共享全局单例; 指向其他 provider → 按该
    供应商配置构建会话专属 client（钩子与全局一致, 浏览器镜像/限流退避/
    打断）。会话专属实例缓存复用, provider 配置变化时重建。"""
    cfg_provider = web_session.model_provider
    active = _provider_cfg.get("active") or {}
    if not cfg_provider or cfg_provider == active.get("provider"):
        web_session.api_client = None
        return api_client
    prov = next((p for p in _provider_cfg.get("providers", [])
                 if p.get("id") == cfg_provider), None)
    if not prov or not prov.get("enabled"):
        # 供应商被删/禁用: 回落全局 client, 清掉无效覆盖
        web_session.model_provider = None
        web_session.model_id = None
        web_session.api_client = None
        return api_client
    protocol = _protocol_of(prov)
    base_url = _normalize_base_url(prov.get("base_url"), protocol=protocol) or None
    cached = web_session.api_client
    if (cached is not None and cached.protocol == protocol
            and cached.api_key == (prov.get("api_key") or "")
            and (cached.base_url or None) == base_url):
        return cached
    web_session.api_client = make_api_client(
        protocol, api_key=prov.get("api_key") or "",
        model=web_session.model_id or "", base_url=base_url,
        tools=TOOLS, emit_output=False,
        thinking_level=runtime_config.thinking_level(),
        on_retry=_mirror_rate_limit_retry,
        should_stop_provider=_should_stop_now,
        on_event_provider=lambda: _mirror_on_event(dispatch.current_sink()),
    )
    return web_session.api_client


# --- 会话级系统提示（拆分时从装配段归位到此: 仅 server 主流程使用）---
def _session_system_prompt(workdir: Optional[str]) -> list:
    """按会话工作目录构建系统提示: 注入真实的 cwd/日期/CLAUDE.md 指令
    文件。没有 workdir 时回落全局默认（与旧行为一致）。环境段位于缓存
    边界之后, 会话间不同不影响静态前缀的 prompt 缓存。没有这一步, 模型
    看到的 Working directory 是 unknown——正是它开局跑 pwd && ls 探路、
    用散弹枪 glob 乱扫的直接原因。"""
    if not workdir:
        base = list(system_prompt)
    else:
        ctx = ProjectContext.discover(
            Path(workdir), datetime.now().strftime("%Y-%m-%d"))
        base = (
            SystemPromptBuilder()
            .with_os(platform.system(), platform.release())
            .with_project_context(ctx)
            .build()
        )
    # 技能清单挂在尾部追加段: name+description 而已, 量级小且不碰静态前缀
    skills_section = render_skills_section(
        discover_skills(Path(workdir) if workdir else Path.cwd(), USER_DIR))
    if skills_section:
        base.append(skills_section)
    return base

MAX_CONCURRENT_TURNS = 4  # 全局并发上限: 同时跑的轮次超过这个数就排队
UNTITLED = "(未命名)"
_CANCEL_SENTINEL = "__cancelled__"


def _api_config_for_session(session_id: Optional[str]
                            ) -> tuple[str, Optional[str], str, str]:
    """会话的 API 连接四元组（供 multi_agent worker 跟随会话模型）。

    从会话解析连接信息, 不构建新 client: 存活会话 → 其专属 client（跨
    provider 模型）或全局 client; 未知/无绑定 → 全局 client。模型取会话
    覆盖值（同 provider 的覆盖只存在于 per-call 参数, 不在 client.model
    上, 必须显式带上）, 无覆盖则跟随 client 默认。子代理由此与 Leader
    用同一份连接信息与模型。"""
    web_session = _sessions.get(session_id) if session_id else None
    if web_session is not None:
        client = _api_client_for(web_session)
        model = web_session.model_id or client.model
    else:
        client = api_client
        model = client.model
    return (client.api_key, client.base_url, model, client.protocol)


_provider_cfg = load_providers()
_apply_provider_config(_provider_cfg)


def _reconcile_orphan_agents() -> None:
    """启动对账: 上次进程死亡遗留的 running 孤儿标记为 failed。

    挂 startup 事件而非 import 时执行: 测试的 TestClient 不进 lifespan,
    跑测试不会动真实的 agents 目录。"""
    n = get_orchestrator().reconcile_orphans()
    if n:
        print(f"[aulos] 启动对账: {n} 个上次进程遗留的 running agent 已标记为 failed")


app.router.add_event_handler("startup", _reconcile_orphan_agents)


class EmittingToolRegistry(ToolRegistry):
    """委托真实 registry 执行；执行完把 tool_result 推给浏览器。

    被权限拒绝的工具到不了这里（runtime 直接生成 error result），不会产生假结果。
    执行时从 dispatch 取本轮绑定的会话工作目录注入工具（bash 的 cwd、
    读写文件的相对路径解析基点）。并行执行时本方法跑在池线程上, 依靠
    runtime 提交任务时的 contextvars 快照拿到本轮绑定。
    """

    def __init__(self, inner: ToolRegistry):
        super().__init__()
        self._inner = inner

    def execute(self, name: str, tool_input_json: str,
                tool_use_id: Optional[str] = None) -> str:
        emit = dispatch.current()
        try:
            result = self._inner.execute(
                name, tool_input_json, workdir=dispatch.current_workdir())
        except Exception as e:
            if emit:
                emit({"type": "tool_result", "id": tool_use_id, "name": name,
                      "input": tool_input_json, "output": str(e), "is_error": True})
            raise
        if emit:
            payload = {"type": "tool_result", "id": tool_use_id, "name": name,
                       "input": tool_input_json, "output": str(result),
                       "is_error": False}
            meta = result_meta(result)   # ToolOutput._meta（write_file 的 diff 等）
            if meta:
                payload["result_meta"] = meta
            emit(payload)
        return result


registry = EmittingToolRegistry(build_registry(
    runtime_config.mcp_servers(),
    discover_skills(Path.cwd(), USER_DIR)))


# ============================================================================
# 事件出口包装 + 权限桥接
# ============================================================================

class TurnEmitter:
    """每轮事件出口: 线程安全转发 + 补齐 tool_use/tool_result 的配对 id。

    runtime 直传 tool_use_id 时（并行执行后结果按完成序到达, FIFO 不可靠）
    按显式 id 配对并从待配队列摘除; 旧式无 id 的事件（权限拒绝路径）退回
    FIFO——弹出最老的一个补进去, 前端按 id 精确配对卡片。
    """

    def __init__(self, sink: Callable):
        self._sink = sink
        self._pending_tool_ids: list[str] = []

    def __call__(self, payload: dict) -> None:
        ptype = payload.get("type")
        if ptype == "tool_use":
            if payload.get("id"):
                self._pending_tool_ids.append(payload["id"])
        elif ptype == "tool_result":
            if payload.get("id"):
                # 并行下结果乱序到达: 按真实 id 摘除, 不按到达序猜
                if payload["id"] in self._pending_tool_ids:
                    self._pending_tool_ids.remove(payload["id"])
            else:
                payload["id"] = (
                    self._pending_tool_ids.pop(0) if self._pending_tool_ids else None
                )
        self._sink(payload)


def _deny(tool_name: str, reason: str) -> PermissionResult:
    return PermissionResult(decision=PermissionDecision.DENY, reason=reason)


class WebPermissionPrompter:
    """阻塞式 prompter: decide() 在工作线程挂起等待，浏览器审批结果经 resolve() 送达。

    超时 / stale 响应 / 被打断（stop、断连）一律朝安全侧 DENY。
    每轮对话新建一个实例，同一时刻只有一个 decide 在等（runtime 串行处理 tool_use）。
    """

    def __init__(self, emit: Callable,
                 on_plan_approved: Optional[Callable[[], None]] = None):
        self._emit = emit
        self._on_plan_approved = on_plan_approved
        self._responses: "queue.Queue[tuple[str, bool]]" = queue.Queue()
        self._seq = 0
        self._cancelled = False
        self._pending_plan_id: Optional[str] = None   # 挂起中的 present_plan 请求 id

    def decide(self, request: PermissionRequest) -> PermissionResult:
        if self._cancelled:
            return self._finish_deny(request, "(用户已打断本轮，自动拒绝)")
        self._seq += 1
        request_id = f"perm-{self._seq}"
        if request.tool_name == "present_plan":
            self._pending_plan_id = request_id
        try:
            return self._decide_inner(request, request_id)
        finally:
            if request.tool_name == "present_plan":
                self._pending_plan_id = None

    def _decide_inner(self, request: PermissionRequest,
                      request_id: str) -> PermissionResult:
        # 先推弹窗再阻塞等待——顺序反了浏览器永远收不到弹窗
        self._emit({
            "type": "permission_request",
            "request_id": request_id,
            "tool_name": request.tool_name,
            "input": request.input,
            "current_mode": request.current_mode.as_str(),
            "required_mode": request.required_mode.as_str(),
            "detail": request.detail,
            "escalation": request.escalation,
        })
        # 不设超时地等待审批（用户明确要求取消 120s 自动拒绝）:
        # 只被 resolve() / cancel()（stop、断连）解除, 弹窗可见就一直等。
        while True:
            try:
                got_id, approved = self._responses.get()
            except queue.Empty:
                continue
            if got_id == _CANCEL_SENTINEL:
                # cancel 打断（stop/断连/计划追加接力）: 与手动拒绝走同一
                # 理由回流（"修订后再弹"）, 但 stop_requested 已置位, 内核
                # 在下一个流事件即抛 TurnInterrupted, 模型不会真的修订。
                return self._finish_deny(
                    request,
                    "Plan rejected by the user. Revise the plan per the "
                    "feedback and present it again with present_plan.")
            if got_id != request_id:
                continue  # stale/重放的响应，忽略
            if approved:
                # 计划批准 = 模式升级的触发点: plan → workspace-write,
                # 升级回调在 _start_turn 注入（拿得到 web_session）。
                # 先升级再回事件, 前端收卡时 mode_changed 已在路上。
                if (request.tool_name == "present_plan"
                        and self._on_plan_approved is not None):
                    try:
                        self._on_plan_approved()
                    except Exception:
                        pass
                    return PermissionResult(
                        decision=PermissionDecision.ALLOW,
                        reason="Plan approved. Implement it now.")
                return PermissionResult(
                    decision=PermissionDecision.ALLOW, reason="user said yes!")
            if request.tool_name == "present_plan":
                # 计划被拒: 不产生 tool_result 卡, 理由回流让模型修订计划
                return self._finish_deny(
                    request,
                    "Plan rejected by the user. Revise the plan per the "
                    "feedback and present it again with present_plan.")
            return self._finish_deny(
                request, f"User denied permission to run {request.tool_name}!")

    def resolve(self, request_id: str, approved: bool) -> None:
        """事件循环侧: 浏览器的审批结果送达。"""
        self._responses.put((request_id, approved))

    def pending_plan_request_id(self) -> Optional[str]:
        """事件循环侧: 当前挂起的 present_plan 请求 id（无则 None）。

        decide() 在工作线程阻塞等待, _pending_request_id 由它写入;
        事件循环线程只读, 供"继续聊天隐性否决计划"判断用。"""
        return self._pending_plan_id

    def cancel(self) -> None:
        """打断等待（stop / 断连）: 立即解除 decide 阻塞并朝安全侧拒绝。"""
        self._cancelled = True
        self._responses.put((_CANCEL_SENTINEL, False))

    def _finish_deny(self, request: PermissionRequest, reason: str) -> PermissionResult:
        # 拒绝结果的 tool_result 镜像不再从这里发: 终局结果统一由
        # runtime 的 on_tool_finalized 回调发射（带显式 tool_use_id,
        # 多工具批次下 FIFO 补 id 会错位配对）。present_plan 的
        # plan_rejected 标记同样移到回调侧（见 _emit_finalized_tool_result）。
        return _deny(request.tool_name, reason)


# ============================================================================
# 每连接会话状态 + runtime 装配
# ============================================================================

class WebSession:
    """一个会话的运行态。字段各归各线程读写，无需加锁:

    - 事件循环侧: prompter 登记、busy/stop 标记
    - 工作线程侧: runtime、persisted_count（本轮落盘起点）、last_uuid（落盘链尾）
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.runtime = None            # 懒构建: 首条消息时才组装（恢复历史）
        self.last_uuid: Optional[str] = None
        self.persisted_count = 0       # 已落盘的消息条数（本轮从这之后保存）
        self.busy = False              # 并发守卫: 一轮对话进行中
        self.stop_requested = False
        self.titled = store.get_title(session_id) is not None  # 自动命名一次
        self.workdir = store.get_workdir(session_id)  # 会话工作目录（项目）
        # 会话级思考等级: 初值取"运行中的全局默认"（api_client; POST
        # /api/settings 维护的那份）。runtime_config 持有的是启动时的
        # 磁盘快照——设置页在运行期改档后, 快照不会跟着变, 用它会让
        # 新会话静默回落旧档位。切换只影响本会话（runtime 注入）。
        self.thinking_level = api_client.thinking_level
        # 会话级权限模式: 基础模式 + 计划开关, 双状态独立叠加。持久值优先
        # （重启不丢）, 没有记录回落全局默认; 下拉框切换只影响本会话,
        # 全局设置页改的是"新会话的默认值"。旧记录里的 "plan"/"read-only"
        # （只读模式时代）已在存储层归一为基础模式 + 计划开。
        persisted_mode_name, persisted_plan = store.get_permission_mode(session_id)
        persisted_mode = NAME_TO_MODE.get(persisted_mode_name or "")
        self.permission_mode = persisted_mode or app_state.permission_mode
        self.plan_active = (persisted_plan if persisted_mode is not None
                            else app_state.plan_active)
        # 会话级模型: 持久值优先（重启不丢）; 无记录的会话在首轮开跑时把
        # 当时的全局 active 固化为自己的模型并落盘（见 _pin_session_model）
        # ——不再"跟随全局", 全局切换只影响之后新建的会话
        self.model_provider, self.model_id = store.get_model(session_id)
        self.api_client = None          # 会话专属 client（跨 provider 模型时构建）
        self.prompter: Optional[WebPermissionPrompter] = None
        # 排队区: 本轮进行中用户追加的后续消息（事件循环线程读写）,
        # 当前轮结束后由 _start_pending_turn 接力开跑。
        # 项为 {qid, text, attachments}——qid 由前端生成、随消息透传,
        # 排队操作（立即/删除/接力开跑）都按 qid 配对, 不再按文本匹配
        self.pending: list[dict] = []
        # 事件出口集合: 同一会话可能被多个窗口/标签打开, 事件广播给所有连接,
        # 连接断开时自动移除（key 为连接序号）
        self.emits: dict[int, Callable] = {}
        self._conn_seq = 0
        self.loop = None                       # 事件循环（worker 用它调度接力）

    def add_emit(self, emit: Callable) -> int:
        self._conn_seq += 1
        self.emits[self._conn_seq] = emit
        return self._conn_seq

    def remove_emit(self, token: int) -> None:
        self.emits.pop(token, None)

    def broadcast(self, payload: dict) -> None:
        for em in list(self.emits.values()):
            try:
                em(payload)
            except Exception:
                pass


_sessions: dict[str, WebSession] = {}


class AppState:
    """全局生效的设置（Web 顶栏）: 思考等级在 api_client 上，权限模式在这里。
    权限 = 基础模式 + 计划开关双状态——设置页是"新会话的默认值"。"""

    def __init__(self, mode: PermissionMode, plan: bool = False):
        self._mode = mode
        self.plan_active = plan

    @property
    def permission_mode(self) -> PermissionMode:
        return self._mode

    def set_permission_mode(self, mode: PermissionMode) -> None:
        self._mode = mode


app_state = AppState(*resolve_permission_mode(runtime_config))


def get_or_create_web_session(session_id: str) -> WebSession:
    if session_id not in _sessions:
        _sessions[session_id] = WebSession(session_id)
    return _sessions[session_id]


def _emit_finalized_tool_result(tool_block, result_msg) -> None:
    """runtime 终局回调: 拒绝/拦截的 tool_result 镜像（带显式 id 精确配对）。

    工作线程内调用, dispatch.current() 拿到本轮 TurnEmitter; CLI/无绑定时
    静默。present_plan 被拒保留 plan_rejected 标记——前端计划卡自渲染拒绝态,
    收到该标记不再补失败工具卡。"""
    emit = dispatch.current()
    if emit is None:
        return
    outputs = [b.output for b in result_msg.content
               if isinstance(b, ToolResultContentBlock)]
    payload = {
        "type": "tool_result",
        "id": tool_block.id,
        "name": tool_block.name,
        "input": tool_block.input,
        "output": "\n".join(outputs),
        "is_error": True,
        "denied": True,
    }
    if tool_block.name == "present_plan":
        payload["plan_rejected"] = True
    emit(payload)


def _pin_session_model(web_session: WebSession) -> None:
    """无显式模型记录的会话: 把当前全局 active 固化为该会话的模型并落盘。

    全局 active 的改动（草稿态下拉 / 设置页）只应影响之后新建的会话; 此前
    无记录的会话持续"跟随全局", 改一次全局会把所有存量会话的模型一起掀翻
    （显示与执行同时变）。在首轮 runtime 组装前调用, 组装取的就是固化值。
    已有显式记录的会话不动; 全局未配置或指向无效供应商/模型时不落垃圾
    记录, 维持跟随语义。"""
    if web_session.model_id is not None:
        return
    active = _provider_cfg.get("active") or {}
    prov = next((p for p in _provider_cfg.get("providers", [])
                 if p.get("id") == active.get("provider") and p.get("enabled")), None)
    if prov is None or not any(m.get("id") == active.get("model")
                               for m in (prov.get("models") or [])):
        return
    web_session.model_provider = str(active["provider"])
    web_session.model_id = str(active["model"])
    store.set_model(web_session.session_id,
                    web_session.model_provider, web_session.model_id)


def load_runtime_for(web_session: WebSession) -> None:
    """组装 runtime: 有历史则先恢复（与 CLI 共享同一份存储）。"""
    if web_session.runtime is not None:
        return
    msgs, last_uuid = store.load_session(web_session.session_id)
    web_session.runtime = build_runtime(
        session=Session(messages=msgs),
        api_client=_api_client_for(web_session),
        registry=registry,
        system_prompt=_session_system_prompt(web_session.workdir),
        hooks_config=runtime_config,
        permission_mode=web_session.permission_mode,
    )
    # 计划开关: 与基础模式独立, 组装后立即恢复（plan 开 → 生效档位
    # READ_ONLY + 系统提示词注入计划段）
    web_session.runtime.set_plan_mode(web_session.plan_active)
    web_session.runtime.set_thinking_level(web_session.thinking_level)
    web_session.runtime.set_model(web_session.model_id)
    # 调用耗时日志带上会话 id——多会话共用一个日志文件时分得清谁是谁
    web_session.runtime.set_log_tag(web_session.session_id)
    # workspace 根: 会话工作目录 + 全局附加目录（写路径分级/敏感扫描基准）
    web_session.runtime.set_workspace_roots(
        _workspace_roots_for(web_session.workdir))
    # deny 规则与用户敏感路径: 与 CLI 同源 settings.json, 组装即生效
    web_session.runtime.set_command_denylist(load_command_denylist())
    web_session.runtime.set_sensitive_paths(load_sensitive_paths())
    # side-call（压缩摘要/记忆摘要）走 utilityProvider 小模型（未配置回落主模型）
    web_session.runtime.set_utility_client(_utility_client)
    # Session Memory 持久化: 恢复 + 消化即追加落盘（与 CLI 同一套 storage 方法;
    # storage 层做消息链对齐校验, 错位弃用回落现场摘要）
    restored = store.load_session_memory(
        web_session.session_id, web_session.runtime.session().messages)
    if restored:
        web_session.runtime.load_session_memory(*restored)
    web_session.runtime.set_on_session_memory(
        lambda summary, digested: store.save_session_memory(
            web_session.session_id, summary, digested,
            web_session.runtime.session().messages))
    # 未经执行就被终局的工具（权限拒绝 / hook 拦截 / prompter 拒绝）:
    # 补发 tool_result 镜像, 前端工具卡才能闭合——否则永远"运行中"。
    # executed 路径不经此处（EmittingToolRegistry 已发）, 不会双发。
    web_session.runtime.set_on_tool_finalized(_emit_finalized_tool_result)
    web_session.last_uuid = last_uuid
    # 增量落盘: 历史一致点即写盘, 输出中强杀/崩溃最多丢最后一次一致点
    # 之后的内容, 不再是整轮。存储永远只追加——压缩只是给模型的请求期
    # 视图, 历史不被改写, persisted_count 永不失准。
    web_session.runtime.set_on_iterate(lambda: persist_turn(web_session))
    # 压缩视图激活: 纯通知——前端当场插一张"已自动压缩"提示卡
    # （历史照常显示, 摘要只给模型）; 不再重写会话文件。
    web_session.runtime.set_on_compacted(
        lambda: web_session.broadcast({"type": "context_compacted"}))


# ============================================================================
# 落盘: 与 run_repl 一致 — 每轮结束后按 parent_uuid 链保存新增消息
# ============================================================================

def persist_turn(web_session: WebSession) -> None:
    messages = web_session.runtime.session().messages
    for msg in messages[web_session.persisted_count:]:
        web_session.last_uuid = store.save_message(
            session_id=web_session.session_id,
            message=msg,
            parent_uuid=web_session.last_uuid,
        )
    web_session.persisted_count = len(messages)


def _ai_title(first_text: str) -> Optional[str]:
    """让模型为对话起标题。失败/空结果返回 None，由调用方回退截断。"""
    prompt = (
        "请为下面这段用户与编程助手的对话拟一个简洁标题："
        "不超过 16 个字，概括主题，只输出标题本身，"
        "不要引号、句号或任何解释。\n\n用户消息：" + first_text[:500]
    )
    title_text = (_utility_client or api_client).generate_text(
        system=[], user=prompt, max_tokens=512)
    title = " ".join(title_text.split()).strip("　\"'“”「」『』。.!！?？，,；;：:")
    return title[:30] or None


def _truncated_title(messages: list[Message]) -> Optional[str]:
    """首条用户消息的文本截断标题；无文本（纯图片等）返回 None。"""
    if not messages or messages[0].role != "user":
        return None
    first_text = " ".join(
        b.text for b in messages[0].content if isinstance(b, TextContentBlock)
    ).strip()
    return first_text[:AUTO_TITLE_LEN] or None


def backfill_title(session_id: str, meta: Optional[dict] = None) -> str:
    """兜底回填: 已落盘但从未命名的会话 → 截断首条用户消息命名（一次性的）。

    覆盖所有漏网路径：打断/异常分支只落盘不命名、排队跳过、历史遗留。
    返回最终展示标题；无消息或首条无文本则维持 UNTITLED。
    meta 可传 store.get_session_meta 的结果（列表接口每会话只读一次盘,
    首条消息文本已在其中）, 缺省现场取。
    """
    if meta is None:
        meta = store.get_session_meta(session_id)
    if meta["title"] is not None:
        return meta["title"]
    title = (meta["first_user_text"] or "")[:AUTO_TITLE_LEN] or None
    if not title:
        return UNTITLED
    store.set_title(session_id, title)
    return title


def maybe_auto_title(web_session: WebSession) -> bool:
    """首轮对话成功后自动命名: AI 总结标题，失败回退前 30 字符截断。

    返回是否设置了标题（供工作线程决定是否广播 session_renamed）。
    调用点在工作线程、turn_done 已发出之后——多花几秒不阻塞前端收尾。
    """
    if web_session.titled:
        return False
    messages = web_session.runtime.session().messages
    fallback = _truncated_title(messages)
    if not fallback:
        return False
    title = None
    try:
        first_text = " ".join(
            b.text for b in messages[0].content if isinstance(b, TextContentBlock)
        ).strip()
        title = _ai_title(first_text)
    except Exception as e:
        print(f"⚠ AI 命名失败，回退截断标题: {e}")
    if not title:
        title = fallback
    store.set_title(web_session.session_id, title)
    web_session.titled = True
    return True


def fallback_title_on_interrupt(web_session: WebSession, emitter: TurnEmitter) -> None:
    """打断/异常路径的兜底命名: 截断首条消息命名, 不发 AI 请求。

    停止语义下再挂 LLM 调用违背直觉且可能撞限流; 正常完成路径仍走 AI 命名。
    若这里跳过（首条无文本等）, 列表接口的 backfill_title 仍会在下次刷新兜底。
    """
    if web_session.titled:
        return
    title = _truncated_title(web_session.runtime.session().messages)
    if not title:
        return
    store.set_title(web_session.session_id, title)
    web_session.titled = True
    emitter({
        "type": "session_renamed",
        "session_id": web_session.session_id,
        "title": title,
    })


# ============================================================================
# 附件（图片 / 文本文件）校验
# ============================================================================

# 图片: 白名单 media_type + 张数/单张/总量上限; 文本附件: 个数/单内容上限
ATTACH_IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")
MAX_IMAGES = 8
MAX_IMAGE_B64_BYTES = 5 * 1024 * 1024      # 单张 base64 ≤5MB
MAX_TOTAL_ATTACH_BYTES = 20 * 1024 * 1024  # 全部附件总量 ≤20MB
MAX_FILES = 8
MAX_FILE_TEXT_BYTES = 512 * 1024           # 单个文本附件内容 ≤512KB


def _parse_attachments(raw) -> tuple[Optional[list[dict]], Optional[str]]:
    """校验 WS user 消息里的 attachments 数组, 规整成可入库的形状。

    返回 (attachments, None) = 合法（可能是空列表）; (None, 错误信息) = 超限,
    错误信息经现有 error 事件发给前端。只做形状与限额校验, 不解压图片、
    不识别内容——传输信任前端压缩结果, 视觉理解归服务端模型。
    """
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return None, "attachments 必须是数组"
    images: list[dict] = []
    files: list[dict] = []
    total_bytes = 0
    for att in raw:
        if not isinstance(att, dict):
            return None, "attachments 项必须是对象"
        kind = att.get("kind")
        if kind == "image":
            name = str(att.get("name") or "").strip()
            media_type = str(att.get("media_type") or "").strip().lower()
            data = att.get("data")
            if media_type not in ATTACH_IMAGE_TYPES:
                return None, f"不支持的图片类型: {media_type or '(缺失)'}（仅支持 png/jpeg/webp/gif）"
            if not isinstance(data, str) or not data:
                return None, f"图片 {name or media_type} 缺少 data"
            b64_len = len(data)
            total_bytes += b64_len
            if b64_len > MAX_IMAGE_B64_BYTES:
                return None, f"图片 {name or media_type} 过大（base64 超 5MB）"
            images.append({"kind": "image", "name": name,
                           "media_type": media_type, "data": data})
            if len(images) > MAX_IMAGES:
                return None, f"图片最多 {MAX_IMAGES} 张"
        elif kind == "file":
            name = str(att.get("name") or "").strip()
            text = att.get("text")
            if not isinstance(text, str):
                return None, f"文本附件 {name or '(未命名)'} 缺少 text"
            total_bytes += len(text.encode("utf-8", "replace"))
            if len(text) > MAX_FILE_TEXT_BYTES:
                return None, f"文本附件 {name or '(未命名)'} 过大（内容超 512KB）"
            files.append({"kind": "file", "name": name, "text": text})
            if len(files) > MAX_FILES:
                return None, f"文本附件最多 {MAX_FILES} 个"
        else:
            return None, f"未知附件类型: {kind!r}"
    if total_bytes > MAX_TOTAL_ATTACH_BYTES:
        return None, "附件总量超过 20MB"
    return images + files, None


# ============================================================================
# 工作线程: 同步 run_turn + 事件桥接
# ============================================================================

_turn_slots = threading.BoundedSemaphore(MAX_CONCURRENT_TURNS)


def _upgrade_after_plan_impl(web_session: WebSession) -> None:
    """计划批准的落盘+内存回退（闭包与测试复用）。只动状态, 不广播——
    广播归调用方（需要 emitter）。落盘与 set_permission_mode 消息处理
    同口径: 不写 store 的话刷新页面后会话列表读回 plan=true, 下拉框
    假显示计划档而服务端实际已退出（"再进计划不出计划"的脱节源）。"""
    web_session.plan_active = False
    store.set_permission_mode(
        web_session.session_id,
        MODE_TO_NAME[web_session.permission_mode], False)
    if web_session.runtime is not None:
        web_session.runtime.set_plan_mode(False)


def _start_turn(web_session: WebSession, text: str, emit: Callable,
                attachments: Optional[list[dict]] = None) -> None:
    """开一轮对话: 占坑、准备事件出口、起工作线程。调用方已确认 !busy。

    并发上限: 信号量在事件循环线程 try_acquire——拿不到就把本轮标记为
    queued 后直接 return, 由一个专职协程等槽位再真正起线程。busy 在排队
    期就置位（会话仍不允许并发第二轮）, 队列等价于"每个会话自己的等待室"。
    """
    web_session.busy = True
    web_session.stop_requested = False
    web_session.persisted_count = len(web_session.runtime.session().messages)
    # 斜杠技能命令: /<技能名> [请求…] 在进 runtime 前确定性展开成
    # skill_read 提示词（气泡仍显示用户原始输入）。唯一咽喉点——普通发送、
    # 排队、插队、合并接力全经此处, 且此刻 workdir 已绑定, 项目级技能同样命中。
    skill = match_skill_command(text, discover_skills(
        Path(web_session.workdir) if web_session.workdir else Path.cwd(),
        USER_DIR))
    if skill is not None:
        text = expand_skill_command(skill, text)
    emitter = TurnEmitter(emit)

    def _upgrade_after_plan() -> None:
        """计划批准: 关闭本会话的计划开关, 生效档位回落基础模式（本轮立即
        生效, 持久到会话）。落盘逻辑在 _upgrade_after_plan_impl（与测试
        共用）; 这里补 mode_changed 广播让前端下拉框跟随。
        不写全局设置（会话级隔离）。"""
        _upgrade_after_plan_impl(web_session)
        web_session.broadcast({
            "type": "mode_changed",
            "session_id": web_session.session_id,
            "permission_mode": MODE_TO_NAME[web_session.permission_mode],
            "plan_active": False,
        })

    prompter = WebPermissionPrompter(emitter, on_plan_approved=_upgrade_after_plan)
    web_session.prompter = prompter

    if not _turn_slots.acquire(blocking=False):
        # 全局槽位已满: 前端显示排队中, 等有轮结束释放槽位后再起线程
        emit({"type": "turn_queued", "max_concurrent": MAX_CONCURRENT_TURNS})
        _queued_turns.append((web_session, text, attachments, emitter, prompter))
        return

    _spawn_turn_thread(web_session, text, attachments, emitter, prompter)


# (web_session, text, attachments, emitter, prompter) 五元组队列;
# 事件循环线程独占读写
_queued_turns: list = []


def _spawn_turn_thread(web_session: WebSession, text: str,
                       attachments: Optional[list[dict]],
                       emitter: TurnEmitter, prompter: WebPermissionPrompter) -> None:
    """真正起工作线程跑一轮。槽位已由调用方持有。"""

    def worker():
        # 必须在工作线程内绑定（按线程号路由）; should_stop 让流式代理逐事件检查打断;
        # session_id 给 agent 工具做收割的会话隔离（A 会话不收 B 会话的结果）
        dispatch.bind(emitter, web_session.workdir,
                      lambda: web_session.stop_requested,
                      session_id=web_session.session_id)
        # 打断进工具执行: runtime 在一致点（迭代顶/工具批次前）检查,
        # 长命令在等待循环里轮询 contextvar——工具池线程经 copy_context()
        # 快照读到同一份 should_stop。命令跑一半点停止 → 杀树即刻收束。
        if web_session.runtime is not None:
            web_session.runtime.set_cancel_check(
                lambda: web_session.stop_requested)
        TOOL_CANCEL_CHECK.set(lambda: web_session.stop_requested)
        try:
            summary = web_session.runtime.run_turn(text, prompter,
                                                   attachments=attachments)
        except (TurnInterrupted, StreamInterrupted):
            # 用户主动打断: 修补悬空 tool_use 后照常落盘（朝安全侧, 与 CLI Ctrl+C 同路径）
            # StreamInterrupted = 打断落在重试退避/建连静默窗口（retry 轮询点抛出）
            repair_interrupted_turn(web_session.runtime.session())
            persist_turn(web_session)
            fallback_title_on_interrupt(web_session, emitter)
            # 插队与手动停止同语义: 被打断的任务就地收束, 不自动续跑
            # （被打断的进度留在历史里, 是否继续由用户下一次消息决定）
            emitter({"type": "turn_done", "interrupted": True, "iterations": 0,
                     "budget_exhausted": False, "iterations_exhausted": False})
        except Exception as e:
            # 异常中断（网络断 / API 报错）: 修补悬空 tool_use 后照常落盘
            # （朝安全侧，与 CLI Ctrl+C 同路径）
            repair_interrupted_turn(web_session.runtime.session())
            persist_turn(web_session)
            fallback_title_on_interrupt(web_session, emitter)
            emitter({"type": "error", "message": str(e)})
            emitter({"type": "turn_done", "interrupted": True, "iterations": 0,
                     "budget_exhausted": False, "iterations_exhausted": False})
        else:
            persist_turn(web_session)
            needs_title = not web_session.titled
            u = summary.usage
            emitter({
                "type": "turn_done",
                "interrupted": web_session.stop_requested,
                "iterations": summary.iterations,
                "budget_exhausted": summary.budget_exhausted,
                "iterations_exhausted": summary.iterations_exhausted,
                # 本轮 token 用量（前端展示"本轮消耗"）: input/output +
                # 缓存读写四项原样下发, 聚合口径由前端决定
                "usage": {
                    "input_tokens": u.input_tokens,
                    "output_tokens": u.output_tokens,
                    "cache_creation_input_tokens": u.cache_creation_input_tokens,
                    "cache_read_input_tokens": u.cache_read_input_tokens,
                },
            })
            # AI 命名放在 turn_done 之后: 前端先收尾，标题好了再单独广播。
            # 排队区非空 = 用户正在连续驱动: 跳过命名请求, 避免与接力的下一轮
            # 撞同一账户限流窗口（本次拿不到 AI 标题, 截断回退仍在, UI 无感）
            if needs_title and not web_session.pending and maybe_auto_title(web_session):
                emitter({
                    "type": "session_renamed",
                    "session_id": web_session.session_id,
                    "title": store.get_title(web_session.session_id),
                })
        finally:
            dispatch.unbind()
            web_session.busy = False
            web_session.prompter = None
            # 释放槽位并唤醒排队的会话（FIFO; 断连/停止的排队项被跳过）
            _turn_slots.release()
            _drain_queued_turns()
            # 本会话还有排队的后续消息: 回事件循环线程接力开跑下一轮
            if (web_session.pending and web_session.emits
                    and web_session.loop is not None):
                web_session.loop.call_soon_threadsafe(_start_pending_turn, web_session)

    threading.Thread(target=worker, name=f"turn-{web_session.session_id}", daemon=True).start()


def _drain_queued_turns() -> None:
    """槽位释放后按 FIFO 唤醒排队轮次。事件循环线程独占调用。

    排队期间被叫停（request_stop / 立即发送插队）或已断连的会话直接跳过:
    prompter.cancel 已经把它的等待权限请求全部 DENY, 轮次起了也会立刻
    收束, 不如不起。跳过时给会话收尾——排队区还有消息（如插队消息）就归队
    被跳过的轮次文本并调度接力开跑; 否则复位忙碌并补发 turn_done,
    不然前端永远停在忙碌态。
    """
    while _queued_turns and _turn_slots.acquire(blocking=False):
        web_session, text, attachments, emitter, prompter = _queued_turns.pop(0)
        if web_session.stop_requested or not web_session.busy:
            if web_session.busy:
                if web_session.pending:
                    # 被跳过的轮次归队, 不丢失
                    web_session.pending.append(
                        {"qid": str(uuid.uuid4()), "text": text,
                         "attachments": attachments})
                    if web_session.emits and web_session.loop is not None:
                        web_session.loop.call_soon_threadsafe(
                            _start_pending_turn, web_session)
                else:
                    web_session.busy = False
                    emitter({"type": "turn_done", "interrupted": True, "iterations": 0,
                             "budget_exhausted": False, "iterations_exhausted": False})
            continue
        _spawn_turn_thread(web_session, text, attachments, emitter, prompter)


def _start_pending_turn(web_session: WebSession) -> None:
    """事件循环线程: 取出该会话待发送区的全部后续消息, 合并成一次新请求接力开跑。

    由上一轮工作线程在 finally 里经 call_soon_threadsafe 调度——
    此时槽位已释放, _start_turn 拿不到槽位会自行进入全局排队。
    合并语义: 「立即」插队或自然回落时, 待发送区里攒下的多条消息不再
    逐条各开一轮（先答插队的那条、再补其余的）, 而是合成一条 user 输入
    （文本以空行连接、附件顺序拼接）, 一次响应同时覆盖全部消息。
    """
    if not web_session.pending:
        return
    items, web_session.pending = web_session.pending, []
    if not web_session.emits:
        return
    text = "\n\n".join(t for t in (str(it.get("text") or "").strip()
                                   for it in items) if t)
    attachments = [a for it in items for a in (it.get("attachments") or [])]
    # 前端把"已排队"气泡转正（按 qid 配对去重, 多窗口同步补气泡）,
    # 并重新进入忙碌态
    web_session.broadcast({
        "type": "turn_started",
        "qid": items[0].get("qid"),
        "text": text,
        "attachments": attachments,
        "items": [{"qid": it.get("qid"), "text": it.get("text") or "",
                   "attachments": it.get("attachments") or []} for it in items],
    })
    _start_turn(web_session, text, web_session.broadcast, attachments=attachments)


def request_stop(web_session: WebSession) -> None:
    """stop / 断连: 朝安全侧叫停——解除权限等待，后续工具调用全部自动拒绝。

    打断生效点（按当前轮所处阶段）:
    - 重试退避/建连静默: retry 分片轮询 should_stop, 立即抛 StreamInterrupted;
      建连 stalled 由 connect 超时（15s）兜底进重试轮询
    - 正文/思考/工具参数流式: api_client 消费循环逐事件检查, 下一个事件即
      break 并返回带 stop_reason="interrupted" 的部分结果（已流出内容保留）
    - 工具执行: bash 等待循环轮询 contextvar, 触发即杀整棵进程树
    - 权限等待: prompter.cancel 立即 DENY 解除
    - 摘要 side-call: 进入前查一次, 已在跑的由流内打断收束
    同时清空排队区: 用户叫停的意图是整轮停下, 排队的后续消息一并撤回。
    """
    if not web_session.busy:
        return
    web_session.stop_requested = True
    # 即时反馈: 打断请求已受理。静默窗口（退避/建连/工具执行）内不会立刻
    # 收尾, 不告诉用户"正在中断"就会被当成没点上而连点多次
    web_session.broadcast({"type": "turn_interrupting"})
    if web_session.pending:
        web_session.pending.clear()
        web_session.broadcast({"type": "turn_queue_cleared"})
    if web_session.prompter is not None:
        web_session.prompter.cancel()


def promote_pending(web_session: WebSession, qid: str) -> bool:
    """「立即」插队: 把待发送区里的这条提到最前并叫停当前轮。

    回落后待发送区的全部消息合并成一次新请求接力开跑（朝安全侧,
    同 request_stop 但不清空待发送区）。qid 不在待发送区时静默忽略
    （返回 False）——它可能已经开跑, 此刻叫停只会误杀当前轮。
    与手动停止一致: 被打断的任务就地收束不自动续跑, 是否继续由用户
    下一次消息决定。
    """
    if not (qid and web_session.busy):
        return False
    idx = next((i for i, it in enumerate(web_session.pending)
                if it.get("qid") == qid), -1)
    if idx < 0:
        return False
    web_session.pending.insert(0, web_session.pending.pop(idx))
    web_session.stop_requested = True
    # 受理反馈与 request_stop 对齐: 工具收束(杀树/泵排干)有秒级延迟,
    # 不广播 turn_interrupting 前端就静默无反馈, 用户以为没点上而连点
    web_session.broadcast({"type": "turn_interrupting"})
    if web_session.prompter is not None:
        web_session.prompter.cancel()
    return True


# ============================================================================
# REST: 会话列表 / 新建 / 历史回放
# ============================================================================

def _message_to_dict(msg: Message, ts: Optional[str] = None) -> dict:
    """历史回放: 按块类型摊平成前端易消费的形状。

    image 输出 {type, media_type, data}: 前端拼 data URI 渲染缩略图;
    file 输出 {type, name, text}: 前端渲染成文件 chip。
    ts 为该条消息的落盘时间(ISO 字符串), 供前端 minimap 显示相对时间。"""
    blocks = []
    for b in msg.content:
        if isinstance(b, TextContentBlock):
            blocks.append({"type": "text", "text": b.text})
        elif isinstance(b, ImageContentBlock):
            source = b.source or {}
            blocks.append({
                "type": "image",
                "media_type": source.get("media_type"),
                "data": source.get("data"),
            })
        elif isinstance(b, FileContentBlock):
            blocks.append({"type": "file", "name": b.name, "text": b.text})
        elif isinstance(b, ToolContentBlock):
            blocks.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
        elif isinstance(b, ToolResultContentBlock):
            entry = {
                "type": "tool_result",
                "id": b.id,
                "name": b.name,
                "output": b.output,
                "is_error": bool(b.is_error),
            }
            if msg.result_meta:
                entry["result_meta"] = msg.result_meta   # 历史回放重建 diff 卡
            blocks.append(entry)
    ret = {"role": msg.role, "blocks": blocks}
    if ts:
        ret["ts"] = ts
    return ret


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/pet.html", include_in_schema=False)
async def pet_page():
    # 桌宠悬浮窗页面（Tauri pet 窗口加载）; 与 index 同一令牌门禁,
    # 页面自己用 ?token= 种 cookie, 不跑 app.js 因此不经过桌面壳守卫
    return FileResponse(STATIC_DIR / "pet.html")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    # 浏览器/工具的默认图标请求路径兜底（页面里已用 <link> 指到 /api/icon）
    if _ICON_LIVE.exists():
        return FileResponse(_ICON_LIVE)
    return FileResponse(_ICON_DEFAULT)


# --- 外观资产（应用图标/壁纸）: 用户上传件一律落在 APPEARANCE_DIR
#     (~/.aulos/appearance/)。绝对不能写进 STATIC_DIR——PyInstaller
#     onefile 模式下那是 _MEIxxxx 临时解包目录, 进程退出即焚, 用户上传
#     的壁纸/头像重启全丢（实测 4 个历史 _MEI 目录里全是残骸）。
#     icon-default.png 是打包进来的出厂副本, 只读。 ---
APPEARANCE_DIR = USER_DIR / "appearance"
_ICON_LIVE = APPEARANCE_DIR / "icon.png"
_BG_LIVE = APPEARANCE_DIR / "bg-user.png"
_ICON_DEFAULT = STATIC_DIR / "icon-default.png"
_ICON_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,(.+)$", re.S)


def _migrate_legacy_appearance() -> None:
    """升级迁移: 旧版把用户上传件写在 STATIC_DIR。源码态运行时那里有
    真实残留, 一次性搬进用户目录; 冻结态 _MEI 每次全新解包不会有旧文件,
    本函数自然跳过。图标与出厂副本逐字节相同时无需迁移。失败静默——
    迁移失败只影响旧文件延续, 不影响新写入。"""
    try:
        legacy_icon = STATIC_DIR / "icon.png"
        legacy_bg = STATIC_DIR / "bg-user.png"
        if legacy_bg.exists() and not _BG_LIVE.exists():
            APPEARANCE_DIR.mkdir(parents=True, exist_ok=True)
            shutil.move(str(legacy_bg), str(_BG_LIVE))
        if (legacy_icon.exists() and _ICON_DEFAULT.exists()
                and legacy_icon.read_bytes() != _ICON_DEFAULT.read_bytes()
                and not _ICON_LIVE.exists()):
            APPEARANCE_DIR.mkdir(parents=True, exist_ok=True)
            shutil.move(str(legacy_icon), str(_ICON_LIVE))
    except OSError:
        pass


_migrate_legacy_appearance()


def _icon_ver() -> int:
    """图标文件 mtime 当版本号: 前端拿它做缓存穿透 (?v=ver)。0 = 出厂图标。"""
    try:
        return int(_ICON_LIVE.stat().st_mtime)
    except OSError:
        return 0


_APP_VERSION: Optional[str] = None   # None = 尚未读取; "" = 两处来源都失败(前端隐藏徽标)


def _app_version() -> str:
    """应用版本号: 优先读源码旁的 pyproject.toml(开发/源码运行),
    退包元数据(pip 安装); 打包壳里两者皆无则返回空串, 前端不显示徽标。
    结果缓存——版本在进程生命周期内不变。"""
    global _APP_VERSION
    if _APP_VERSION is None:
        ver = ""
        try:
            m = re.search(r'^version\s*=\s*"([^"]+)"',
                          (Path(__file__).parent / "pyproject.toml").read_text(encoding="utf-8"),
                          re.M)
            if m:
                ver = m.group(1)
        except OSError:
            pass
        if not ver:
            with suppress(Exception):
                from importlib.metadata import version as _pkgver
                ver = _pkgver("aulos")
        _APP_VERSION = ver
    return _APP_VERSION


@app.get("/api/icon", include_in_schema=False)
async def api_get_icon():
    """应用图标: 有用户上传件给上传件, 否则出厂兜底。"""
    if _ICON_LIVE.exists():
        return FileResponse(_ICON_LIVE, headers={"Cache-Control": "no-cache"})
    return FileResponse(_ICON_DEFAULT, headers={"Cache-Control": "no-cache"})


@app.post("/api/icon")
async def api_post_icon(request: dict):
    """data 为 dataURL 时覆盖应用图标, null 恢复出厂; 返回新版本号。
    恢复出厂 = 删除用户副本, 读取端自动回落出厂件。"""
    data = request.get("data")
    if data is None:
        _ICON_LIVE.unlink(missing_ok=True)
    else:
        m = _ICON_RE.match(str(data))
        if not m:
            raise HTTPException(status_code=400, detail="图标必须是 PNG/JPEG/WebP 的 dataURL")
        raw = base64.b64decode(m.group(2))
        if len(raw) > 512 * 1024:
            raise HTTPException(status_code=400, detail="图标过大（解码后限 512KB）")
        APPEARANCE_DIR.mkdir(parents=True, exist_ok=True)
        _ICON_LIVE.write_bytes(raw)
    return {"ok": True, "ver": _icon_ver()}


# --- 背景图片: 设置 → 外观 可上传; 存用户目录, 经 GET /api/bg 读取 ---
_BG_MAX = 20 * 1024 * 1024


def _bg_ver() -> int:
    try:
        return int(_BG_LIVE.stat().st_mtime)
    except OSError:
        return 0


@app.get("/api/bg", include_in_schema=False)
async def api_get_bg():
    """壁纸: 未设置时 404（前端以 bg_ver=0 为"无壁纸"口径, 不会盲拉）。"""
    if not _BG_LIVE.exists():
        raise HTTPException(status_code=404, detail="未设置背景图片")
    return FileResponse(_BG_LIVE, headers={"Cache-Control": "no-cache"})


@app.post("/api/bg")
async def api_post_bg(request: dict):
    """data 为 dataURL 时写入背景图, null 删除; 返回新版本号。"""
    data = request.get("data")
    if data is None:
        # Windows: 若恰好有 GET /api/bg 的 FileResponse 尚在发送, unlink 会
        # 撞 WinError 32（文件被占用）。短暂重试几轮, 覆盖响应写完的间隙
        for _ in range(4):
            try:
                _BG_LIVE.unlink(missing_ok=True)
                break
            except PermissionError:
                time.sleep(0.05)
        else:
            raise HTTPException(status_code=409, detail="背景图正被读取, 请稍后重试")
    else:
        m = _ICON_RE.match(str(data))
        if not m:
            raise HTTPException(status_code=400, detail="背景图必须是 PNG/JPEG/WebP 的 dataURL")
        raw = base64.b64decode(m.group(2))
        if len(raw) > _BG_MAX:
            raise HTTPException(status_code=400, detail="背景图过大（解码后限 20MB）")
        APPEARANCE_DIR.mkdir(parents=True, exist_ok=True)
        _BG_LIVE.write_bytes(raw)
    return {"ok": True, "ver": _bg_ver()}


@app.get("/api/sessions")
async def api_list_sessions():
    active = _provider_cfg.get("active") or {}

    def _mode_name_for(sid: str, meta: dict) -> str:
        """列表回显的会话权限模式: 存活会话取运行值, 否则取持久值,
        再否则全局默认——前端下拉框据此跟随各会话, 不再停留在上一个会话的值。"""
        live = _sessions.get(sid)
        if live is not None:
            return MODE_TO_NAME[live.permission_mode]
        persisted = NAME_TO_MODE.get(meta["mode"] or "")
        return MODE_TO_NAME[persisted or app_state.permission_mode]

    def _session_plan(sid: str, meta: dict) -> bool:
        """列表回显的会话计划开关: 存活取运行值, 否则持久值/全局默认。"""
        live = _sessions.get(sid)
        if live is not None:
            return live.plan_active
        return bool(meta["plan"]) \
            if NAME_TO_MODE.get(meta["mode"] or "") is not None \
            else app_state.plan_active

    def _session_thinking(sid: str) -> str:
        """列表回显的会话思考等级: 存活取运行值, 否则全局默认（新会话语义）。"""
        live = _sessions.get(sid)
        if live is not None:
            return live.thinking_level
        return api_client.thinking_level

    def _session_model(sid: str, meta: dict) -> tuple[Optional[str], Optional[str]]:
        """列表回显的会话模型 (provider_id, model_id): 存活取运行值,
        否则持久值; (None, None) = 跟随全局 active。"""
        live = _sessions.get(sid)
        if live is not None:
            return (live.model_provider, live.model_id)
        return (meta["provider_id"], meta["model_id"])

    on_disk = set(store.list_sessions())
    # 已落盘的会话由 store 覆盖，pending 里不再需要；未落盘的保持 pending
    _pending_sessions.difference_update(on_disk)
    items = []
    for sid in on_disk:
        # 单遍读盘: 命名/消息数/工作目录/持久模式/模型一次取齐, 不再逐
        # 字段整文件解析（会话库一大, 旧写法每次列表读几十 MB）
        meta = store.get_session_meta(sid)
        items.append({
            "id": sid,
            # 兜底回填: 打断/异常/排队跳过等路径漏掉的命名, 在列表读取时
            # 一次性补齐（截断首条用户消息; 无文本则维持 UNTITLED）
            "title": backfill_title(sid, meta),
            "message_count": meta["count"],
            # 项目归属: 会话的工作目录(WorkdirRecord, 取最新一条); 未设置时 None
            "workdir": meta["workdir"],
            "permission_mode": _mode_name_for(sid, meta),
            "plan_active": _session_plan(sid, meta),
            "thinking_level": _session_thinking(sid),
            "model_provider": _session_model(sid, meta)[0],
            "model_id": _session_model(sid, meta)[1],
        })
    for sid in _pending_sessions:
        meta = store.get_session_meta(sid)   # 未落盘: 全默认值, 仅一次 stat
        items.append({"id": sid, "title": UNTITLED, "message_count": 0,
                      "workdir": None,
                      "permission_mode": _mode_name_for(sid, meta),
                      "plan_active": _session_plan(sid, meta),
                      "thinking_level": _session_thinking(sid),
                      "model_provider": _session_model(sid, meta)[0],
                      "model_id": _session_model(sid, meta)[1]})
    items.sort(key=lambda item: item["id"], reverse=True)  # 时间戳字典序即时间序，最新在前
    return {"sessions": items}


@app.post("/api/sessions")
async def api_create_session(payload: Optional[dict] = Body(None)):
    """新建会话: 与 CLI 相同的 %Y%m%d-%H%M%S 时间戳 id（UTC）。

    文件在首条消息落盘时才创建，与 CLI 行为一致；id 记入 _pending_sessions，
    让列表/历史接口在落盘前就能认出它。可选携带 workdir: 侧栏项目行"新建任务"
    进入时预选的目录，创建即绑定，列表立刻归组（WS 首条消息的绑定仍是兜底）。
    """
    existing = set(store.list_sessions()) | _pending_sessions
    sid = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    while sid in existing:  # 同秒重建撞 id → 追加后缀区分
        sid += "w"
    workdir = None
    raw_wd = str((payload or {}).get("workdir") or "").strip()
    if raw_wd:
        wd = Path(raw_wd)
        if not wd.is_dir():
            raise HTTPException(status_code=400, detail=f"工作目录不存在: {raw_wd}")
        workdir = str(wd.resolve())
        store.set_workdir(sid, workdir)
    # 桌宠会话: 固化 danger-full-access + 关计划开关并立即持久化。
    # 桌宠是无人值守的摸鱼挂件（点歌/闲聊/悬浮输入）, 权限弹卡没人批
    # 就是死锁; 不落盘的话 WebSession 会回落全局默认（可能是 prompt+plan）,
    # 播放音乐都要审批。用户仍可在会话里手动降档（记录追加式, 后写覆盖）。
    if (payload or {}).get("pet"):
        store.set_permission_mode(sid, "danger-full-access", plan=False)
    _pending_sessions.add(sid)
    return {"id": sid, "workdir": workdir}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str):
    """删除会话: 删磁盘 JSONL + 清内存态。对话进行中的会话拒删。"""
    web_session = _sessions.get(session_id)
    if web_session is not None and web_session.busy:
        raise HTTPException(status_code=409, detail="会话正在对话中，暂不能删除")
    _pending_sessions.discard(session_id)
    _sessions.pop(session_id, None)
    try:
        store.delete_session(session_id)
    except KeyError:
        # 本就不存在（旧 pending 未落盘等）: 按幂等成功处理，内存态已清
        pass
    return {"ok": True}


@app.post("/api/sessions/{session_id}/rename")
async def api_rename_session(session_id: str, request: dict):
    """手动重命名: 追加一条 title 记录（展示取最新）。未落盘的会话不可重命名。"""
    title = str(request.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="标题不能为空")
    title = title[:60]
    if session_id not in set(store.list_sessions()):
        raise HTTPException(status_code=404, detail="会话不存在（还没有消息，无法命名）")
    store.set_title(session_id, title)
    # 手动命名优先: 标记已命名，首轮 AI 命名不再覆盖它
    web_session = _sessions.get(session_id)
    if web_session is not None:
        web_session.titled = True
    return {"ok": True, "title": title}


@app.post("/api/sessions/{session_id}/workdir")
async def api_set_session_workdir(session_id: str, request: dict):
    """改绑/解绑会话的项目目录: 追加一条 workdir 记录（展示取最新一条）。

    workdir 传目录路径 = 改绑（校验存在并 resolve）; 传 null/空串 = 解绑,
    会话退为"任务"。解除绑定常由"移除项目"批量调用——不删会话, 磁盘文件不动。
    未落盘的会话（pending）同样允许解绑: 记录落盘, 与首条消息共处一个 JSONL。
    """
    web_session = _sessions.get(session_id)
    if web_session is not None and web_session.busy:
        raise HTTPException(status_code=409, detail="会话正在对话中，暂不能修改项目")
    exists = session_id in set(store.list_sessions()) or session_id in _pending_sessions
    if not exists:
        raise HTTPException(status_code=404, detail="会话不存在")

    raw_wd = str(request.get("workdir") or "").strip()
    if raw_wd:
        wd = Path(raw_wd)
        if not wd.is_dir():
            raise HTTPException(status_code=400, detail=f"工作目录不存在: {raw_wd}")
        workdir: Optional[str] = str(wd.resolve())
    else:
        workdir = None
    store.set_workdir(session_id, workdir)
    if web_session is not None:
        web_session.workdir = workdir   # 运行态同步, 恢复对话时不再绑回旧目录
        # workspace 根跟着改绑走（runtime 未组装时下次组装会带上新值）
        if web_session.runtime is not None:
            web_session.runtime.set_workspace_roots(_workspace_roots_for(workdir))
    return {"ok": True, "workdir": workdir}


@app.get("/api/dirs")
async def api_list_dirs(path: str = ""):
    """列出某目录下的子目录（前端工作目录选择器浏览用）。path 缺省为服务进程 cwd。"""
    target = Path(path) if path.strip() else Path.cwd()
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"目录不存在: {target}")
    try:
        target = target.resolve()
        dirs = sorted(
            (p.name for p in target.iterdir() if p.is_dir() and not p.name.startswith(".")),
            key=str.lower,
        )
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"无法读取目录: {e}")
    return {"path": str(target), "dirs": dirs}


@app.get("/api/sessions/search")
async def api_search_sessions(q: str = ""):
    """会话全文搜索: 扫消息正文, 返回 {会话id: [摘录...]}。
    空查询返回空对象, 前端回落标题过滤。文件 IO 阻塞, 丢线程池跑
    不卡事件循环（量级: 几十 MB 全扫百来毫秒, 有 mtime 缓存兜底）。"""
    import anyio
    return await anyio.to_thread.run_sync(store.search_sessions, q)


@app.get("/api/sessions/{session_id}/messages")
async def api_get_messages(session_id: str):
    if session_id not in set(store.list_sessions()):
        # 新建后尚未落盘的会话: 返回空历史而不是 404——否则前端"新建会话"
        # 会走加载失败分支，渲染成空白
        return {"session_id": session_id, "messages": [],
                "workdir": store.get_workdir(session_id)}
    detail, _ = store.load_session_detail(session_id)
    return {"session_id": session_id,
            "messages": [_message_to_dict(m, ts) for m, ts in detail],
            "workdir": store.get_workdir(session_id)}


# ============================================================================
# REST: 设置（思考等级 + 权限模式 + 激活模型）
# ============================================================================

# ============================================================================
# 功能域路由: 摸鱼电台(网易云+B站)与桌宠, 拆分至独立模块（挂同一 app）。
# import 即注册; 兼容别名供既有测试/调用点使用。
# ============================================================================

from server_music import (  # noqa: E402  _music_call/_library_call 测试引用
    _music_call,
    _library_call,
)
import server_bilibili  # noqa: E402,F401  import 即挂路由
import server_stats  # noqa: E402,F401  import 即挂路由
import server_settings  # noqa: E402,F401  import 即挂路由
import server_policy  # noqa: E402,F401  import 即挂路由

# --- re-export 拆分域的全部共享名: 既有 `from server import X` 调用点
# --- 与测试零改动（名字仍以本模块命名空间为准） ---
from server_settings import (  # noqa: E402,F401  re-export
    _resync_session_prompts, _rebind_skill_tools,
    api_get_skills, api_install_skills, api_delete_skill,
    api_get_memory, api_add_memory, api_update_memory, api_delete_memory,
    api_mcp_status, _mcp_servers_setting, api_get_mcp_servers,
    _validate_mcp_entry, api_save_mcp_servers, api_mcp_reload,
    api_get_settings, api_post_settings,
    _save_setting, _save_permission_mode,
    api_get_providers, api_get_utility_provider, api_save_utility_provider,
    api_save_providers, api_test_provider, api_open_config,
)
from server_policy import (  # noqa: E402,F401  re-export
    _apply_allowlist_to_runtimes, _workspace_roots_for,
    _apply_workspace_roots_to_runtimes, _apply_policy_list,
    api_get_allowlist, api_add_allowlist_rule, api_delete_allowlist_rule,
    api_add_session_allow_rule,
    api_get_denylist, api_add_denylist_rule, api_delete_denylist_rule,
    api_get_sensitive_paths, api_add_sensitive_path, api_delete_sensitive_path,
    api_get_additional_dirs, api_add_additional_dir, api_delete_additional_dir,
    api_permission_respond,
)
from server_pets import (  # noqa: E402,F401  测试引用内部函数
    _pets_dirs,
    _pet_sheets,
    _list_pets,
    _scan_pet_folder,
    _pet_persona,
    _image_size,
    _pet_api_client,
    _pet_system_prompt,
    _pet_quip_prompt,
    _pet_parse_reply,
    api_ping,
)


# ============================================================================
# WebSocket: 双向通道（服务端推事件 + 浏览器回审批/停止）
# ============================================================================

@app.websocket("/ws/{session_id}")
async def ws_endpoint(websocket: WebSocket, session_id: str):
    # WS 握手同样过门禁: 令牌可在 query 或 cookie（页面已种入）
    provided = (websocket.query_params.get("token")
                or websocket.cookies.get("aulos_token"))
    if API_TOKEN and provided != API_TOKEN:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    web_session = get_or_create_web_session(session_id)
    loop = asyncio.get_running_loop()
    out_queue: asyncio.Queue = asyncio.Queue()

    async def sender():
        # 专职发送协程: 收发分离，避免与 receive 循环交错写同一 socket
        while True:
            payload = await out_queue.get()
            await websocket.send_text(json.dumps(payload, ensure_ascii=False))

    sender_task = asyncio.create_task(sender())

    def emit(payload) -> None:
        """工作线程调用: 事件路由到本连接的发送队列（线程安全、非阻塞）。"""
        loop.call_soon_threadsafe(out_queue.put_nowait, payload)

    # 注册本连接的事件出口: 会话事件广播给所有连接（多窗口/标签同时打开同一会话）
    token = web_session.add_emit(emit)
    web_session.loop = loop

    # 连接即下发权威 busy 快照: 客户端 busy 的唯一清除途径是 turn_done/error,
    # 服务进程死亡丢掉收尾事件后, 重连客户端会带着过期的本地 busy 把死轮次
    # 的悬空工具卡永远保留"运行中"（历史回放的收口被 !busy 跳过）。快照只进
    # 本连接的队列（非广播）: false 而本地忙碌 → 按轮次终点收口; true → 跟上。
    out_queue.put_nowait({"type": "busy_sync", "busy": web_session.busy})

    def emit_error(message: str) -> None:
        emit({"type": "error", "message": message})

    try:
        while True:
            try:
                raw = await websocket.receive_json()
            except WebSocketDisconnect:
                raise
            except ValueError:  # JSON 解析失败（WebSocketDisconnect 不是 ValueError）
                emit_error("消息不是合法 JSON")
                continue
            msg_type = raw.get("type")

            if msg_type == "user":
                text = str(raw.get("text") or "").strip()
                attachments, att_err = _parse_attachments(raw.get("attachments"))
                if att_err:
                    emit_error(att_err)
                    continue
                # text 与 attachments 同时为空才丢弃（允许只发图不打字）
                if not text and not attachments:
                    continue
                if web_session.busy:
                    plan_rid = (web_session.prompter.pending_plan_request_id()
                                if web_session.prompter is not None else None)
                    if plan_rid is not None:
                        # 卡在计划审批上时用户继续发消息 = 隐性否决当前计划:
                        # 新消息置顶排队 + stop_requested + prompter.cancel——
                        # 与「立即」插队同款打断语义（cancel 使 decide 以 DENY
                        # 解除, 模型收到计划被拒后就地收束, 不会盲目修订）。
                        # 当前轮 turn_done 后 finally 经 _start_pending_turn
                        # 接力, 待发送区的全部消息合并成一次新请求开跑。
                        web_session.pending.insert(0, {
                            "qid": str(raw.get("qid") or uuid.uuid4()),
                            "text": text,
                            "attachments": attachments,
                        })
                        web_session.stop_requested = True
                        web_session.prompter.cancel()
                        emit({"type": "turn_interrupting"})
                        continue
                    # 本轮还在跑: 静默追加进会话级排队区, 当前轮结束后自动接力;
                    # 前端在待发送气泡上提供「立即」按钮, 需要插队时发 queue_promote。
                    # qid 由前端生成（本地排队卡片与后端排队区对齐）, 缺失时兜底生成
                    if len(web_session.pending) >= 10:
                        emit_error("待发送消息过多（上限 10 条），请等当前轮次结束")
                        continue
                    web_session.pending.append({
                        "qid": str(raw.get("qid") or uuid.uuid4()),
                        "text": text,
                        "attachments": attachments,
                    })
                    emit({"type": "turn_queued_user", "position": len(web_session.pending)})
                    continue
                # 首条消息可携带工作目录（项目的意义）: 只在未设置时落一次
                raw_wd = str(raw.get("workdir") or "").strip()
                if web_session.workdir is None and raw_wd:
                    wd = Path(raw_wd)
                    if not wd.is_dir():
                        emit_error(f"工作目录不存在: {raw_wd}")
                        continue
                    web_session.workdir = str(wd.resolve())
                    store.set_workdir(web_session.session_id, web_session.workdir)
                # 首轮固化会话模型（在 runtime 组装前: 组装即取固化值）
                _pin_session_model(web_session)
                try:
                    load_runtime_for(web_session)
                except Exception as e:
                    emit_error(f"会话加载失败: {e}")
                    continue
                _start_turn(web_session, text, web_session.broadcast,
                            attachments=attachments)

            elif msg_type == "queue_promote":
                # 「立即」: 把待发送区里的这条提到最前, 并叫停当前轮——
                # 回落后待发送区的全部消息合并成一次新请求接力开跑。
                # 被打断的当前任务就地收束, 不自动续跑（与手动停止一致）。按 qid 配对
                qid = str(raw.get("qid") or "").strip()
                promote_pending(web_session, qid)

            elif msg_type == "queue_remove":
                # 编辑/删除待发送卡片: 按 qid 从待发送区移除, 静默无回执
                qid = str(raw.get("qid") or "").strip()
                if qid:
                    web_session.pending = [
                        it for it in web_session.pending
                        if it.get("qid") != qid
                    ]

            elif msg_type == "set_permission_mode":
                # 会话内下拉框: 只切本会话（全局默认值走 REST /api/settings）。
                # 载荷: mode = 基础模式名（缺省 = 不变）; plan = 计划开关
                # （缺省 = 不变）。两者相互独立, 可单独或同时设置。
                # "plan"/"read-only" 是旧版并列模式时代的值——归一为
                # "计划开、基础模式不变"（兼容旧前端标签页）。
                raw_mode = str(raw.get("mode") or "").strip().lower()
                raw_plan = raw.get("plan")
                legacy_plan = raw_mode in ("plan", "read-only")
                mode = NAME_TO_MODE.get(raw_mode) if raw_mode else None
                if raw_mode and not legacy_plan \
                        and (mode is None or mode == ALLOW_MODE):
                    emit_error(f"未知或不可用的权限模式: {raw.get('mode')!r}")
                    continue
                if legacy_plan:
                    mode = None   # 基础模式不变（"plan"/"read-only" 只是开计划的旧写法）
                if mode is not None:
                    web_session.permission_mode = mode
                if isinstance(raw_plan, bool):
                    web_session.plan_active = raw_plan
                elif legacy_plan:
                    web_session.plan_active = True
                plan_now = web_session.plan_active
                # 持久化: 重启后该会话保持自己的模式与计划状态, 不回落全局默认
                store.set_permission_mode(
                    web_session.session_id,
                    MODE_TO_NAME[web_session.permission_mode], plan_now)
                if web_session.runtime is not None:
                    if mode is not None:
                        web_session.runtime.set_permission_mode(mode)
                    # set_plan 只在消息真动了计划状态时调（set_permission_mode
                    # 内部已联动 _rebuild_effective_prompt, 无需重复）
                    if isinstance(raw_plan, bool) or legacy_plan:
                        web_session.runtime.set_plan_mode(plan_now)
                web_session.broadcast({
                    "type": "mode_changed",
                    "session_id": web_session.session_id,
                    "permission_mode":
                        MODE_TO_NAME[web_session.permission_mode],
                    "plan_active": plan_now,
                })

            elif msg_type == "set_thinking_level":
                # 会话内下拉框: 只切本会话（全局默认值走 REST /api/settings）。
                # 下一轮迭代立即生效（stream 按轮携带, 与模式升级同步）。
                level = str(raw.get("level") or "").strip().lower()
                if level not in THINKING_LEVELS:
                    emit_error(f"未知思考等级: {raw.get('level')!r}")
                    continue
                web_session.thinking_level = level
                if web_session.runtime is not None:
                    web_session.runtime.set_thinking_level(level)
                web_session.broadcast({
                    "type": "thinking_changed",
                    "session_id": web_session.session_id,
                    "thinking_level": level,
                })

            elif msg_type == "set_model":
                # 会话内下拉框: 只切本会话。同 provider → per-call model 覆盖;
                # 跨 provider → 换绑会话专属 client。运行中下一迭代立即生效。
                provider_id = str(raw.get("provider_id") or "").strip()
                model_id = str(raw.get("model_id") or "").strip()
                if not provider_id or not model_id:
                    emit_error(f"模型选择不完整: {raw.get('provider_id')!r} | {raw.get('model_id')!r}")
                    continue
                prov = next((p for p in _provider_cfg.get("providers", [])
                             if p.get("id") == provider_id and p.get("enabled")), None)
                if prov is None or not any(
                        m.get("id") == model_id for m in (prov.get("models") or [])):
                    emit_error(f"未知模型: {provider_id} | {model_id}")
                    continue
                web_session.model_provider = provider_id
                web_session.model_id = model_id
                store.set_model(web_session.session_id, provider_id, model_id)
                if web_session.runtime is not None:
                    web_session.runtime.set_api_client(_api_client_for(web_session))
                    web_session.runtime.set_model(model_id)
                web_session.broadcast({
                    "type": "model_changed",
                    "session_id": web_session.session_id,
                    "provider_id": provider_id,
                    "model_id": model_id,
                })

            elif msg_type == "permission_response":
                prompter = web_session.prompter
                if prompter is None:
                    emit_error("当前没有待审批的请求")
                else:
                    prompter.resolve(str(raw.get("request_id")), bool(raw.get("approved")))

            elif msg_type == "stop":
                request_stop(web_session)

            else:
                emit_error(f"未知消息类型: {msg_type!r}（已知: user / queue_promote / queue_remove / set_permission_mode / set_thinking_level / set_model / permission_response / stop）")

    except WebSocketDisconnect:
        # 断连但一轮对话可能还在跑: 朝安全侧叫停；落盘由工作线程完成
        request_stop(web_session)
    finally:
        web_session.remove_emit(token)   # 本连接注销: 不再接收广播
        sender_task.cancel()
        with suppress(asyncio.CancelledError):
            await sender_task


def main() -> int:
    """启动入口: 参数解析 / 父进程看门狗 / 端口避让 / uvicorn 服务循环。

    只被文件头部的 __main__ 自举跳板调用（`from server import main`）,
    保证运行态永远在模块副本的命名空间里, 与测试/功能域模块看到的
    `import server` 是同一份状态。"""
    import socket
    import uvicorn

    # 命令执行器依赖 Git Bash: 没有就拒绝启动。原因落盘到 ~/.aulos/,
    # 桌面壳只显示通用的"后端未就绪", 具体原因以这里为准
    reason = git_bash_unavailable_reason()
    if reason:
        print(f"✗ {reason}")
        try:
            USER_DIR.mkdir(parents=True, exist_ok=True)
            (USER_DIR / "startup-error.log").write_text(reason, encoding="utf-8")
        except OSError:
            pass
        return 1

    args = sys.argv[1:]
    port = int(args[args.index("--port") + 1]) if "--port" in args \
        else int(os.getenv("AULOS_PORT") or 8000)
    # 端口文件: 壳由此得知避让后的实际端口。发布壳与开发态各用各的文件
    # （发布壳以 --port/--port-file 显式传入, 两种形态可同时存活互不抢占）
    port_file = USER_DIR / "port"
    if "--port-file" in args:
        port_file = Path(args[args.index("--port-file") + 1])

    # 父进程看门狗: 桌面壳拉起后端时把自己的 PID 传进来。壳无论怎么死
    # （正常退出/崩溃/被任务管理器强杀, RunEvent 清理都来不及跑）, OS 都会
    # 关闭它持有的内核句柄 → WaitForSingleObject 返回 → 后端立刻自杀,
    # 端口随之释放。没有它, 壳被强杀时后端孤儿化, 端口占用一直挂着。
    if "--parent-pid" in args:
        ppid = int(args[args.index("--parent-pid") + 1])

        def _watch_parent(pid: int) -> None:
            if os.name != "nt":
                return                      # 非 Windows 暂无对应实现, 行为同旧版
            import ctypes
            SYNCHRONIZE, INFINITE = 0x00100000, 0xFFFFFFFF
            handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
            if not handle:
                os._exit(0)                 # 父进程已不存在: 拉起即失联, 直接退出
            ctypes.windll.kernel32.WaitForSingleObject(handle, INFINITE)
            os._exit(0)                     # 父进程死亡: 立刻退出, 释放端口

        threading.Thread(target=_watch_parent, args=(ppid,), daemon=True).start()

    def _port_free(p: int) -> bool:
        # connect_ex 探测: 已有进程监听时返回 0
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(("127.0.0.1", p)) != 0

    # 端口被占则向后避让（基准+10 起的 10 个）: 开发态 8000 → 8010–8019
    # （与既有行为一致）, 发布版 18080 → 18090–18099。实际端口写 port 文件,
    # 桌面壳由此得知该访问哪个端口
    candidates = [port] + [q for q in range(port + 10, port + 20) if q != port]
    chosen = next((q for q in candidates if _port_free(q)), None)
    if chosen is None:
        print(f"✗ {port}–{port + 19} 端口全部被占用（如 C-Lodop 打印服务）, 请释放后重试")
        return 1
    USER_DIR.mkdir(parents=True, exist_ok=True)
    port_file.parent.mkdir(parents=True, exist_ok=True)
    port_file.write_text(str(chosen), encoding="utf-8")
    (USER_DIR / "startup-error.log").unlink(missing_ok=True)   # 启动成功: 旧原因作废
    print(f"✓ aulos 服务: http://127.0.0.1:{chosen}")
    uvicorn.run(app, host="127.0.0.1", port=chosen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
