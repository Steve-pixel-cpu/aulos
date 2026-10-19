import json
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from textwrap import dedent
from typing import Optional, Callable

from dotenv import load_dotenv
from pydantic import BaseModel

from aulos.api_client import (ClaudeApiClient, make_api_client,
                              WireTextDelta, WireThinkingStart,
                              WireThinkingDelta, WireThinkingEnd,
                              WireToolStart, WireToolEnd)
from aulos.fsatomic import atomic_write_text, read_text_with_retry
from aulos.models import Session, TextContentBlock
from aulos.permissions import ALLOW_MODE, PermissionPolicy
from aulos.runtime import ConversationRuntime
from aulos.tools import (ToolRegistry, bash_tool, read_tool, write_tool,
                         powershell_tool, grep_tool, glob_tool,
                         web_search_tool, web_fetch_tool)

TOOL_WHITELIST: dict[str, set[str]] = {
    # explore/plan: 调查三件套（read_file + grep + glob）——派出去的
    # 调查员得能自己搜代码, 否则"派不如自己查", 委派永远不会发生。
    # 保持纯只读: plan 模式放行 explore 委派（permissions 层）以此为前提。
    "explore": {"read_file", "grep", "glob"},
    "plan": {"read_file", "grep", "glob"},
    "verification": {"bash", "read_file",
                     "browser_navigate", "browser_snapshot",
                     "browser_console"},
    "general": {"bash", "read_file", "write_file", "web_search", "web_fetch",
                "browser_navigate", "browser_snapshot", "browser_click",
                "browser_type", "browser_press", "browser_select",
                "browser_screenshot", "browser_console", "browser_close"},
    "explore_web": {"web_search", "web_fetch"},
}

def pid_alive(pid: Optional[int]) -> bool:
    """探活一个进程 ID（跨平台, 零依赖）。

    Windows: os.kill(pid, 0) 在 CPython 3.14 实测分不清死活（已退出进程
    的句柄还被本进程持有时不抛异常）, 故走 ctypes OpenProcess +
    WaitForSingleObject(handle, 0): WAIT_TIMEOUT = 还在运行;
    打不开句柄 = 进程对象已消失 = 死。PROCESS_QUERY_LIMITED_INFORMATION
    权限足够且不触发 UAC。
    POSIX: 信号 0 只做存在性检查, ESRCH = 死, EPERM = 活（无权限发信号）。
    """
    if not pid or pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        WAIT_TIMEOUT = 0x00000102
        STILL_ACTIVE = 259
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False   # 打不开: 进程对象已不存在
        try:
            code = ctypes.c_ulong()
            if k32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            # GetExitCodeProcess 失败: 用超时探测兜底
            return k32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True    # 进程存在但无权发信号 → 活
    except OSError:
        return False


class AgentStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"

class AgentManifest(BaseModel):
    agent_id: str
    name: Optional[str]
    description: str
    subagent_type: str
    status: str  # "pending" / "running" / "completed" / "failed"
    output_file: str
    created_at: str
    started_at: Optional[str]
    completed_at: Optional[str]
    error: Optional[str]
    result: Optional[str] = None   # 终态结果文本（completed 时 = worker 汇报原文）
    # True = 结果已注入 Leader 对话（收割过）。与 status 解耦: completed 只说明
    # worker 跑完, delivered 才说明结果进了对话——两者之间可能隔着 Leader 忘轮询。
    delivered: bool = False
    # 派生该 worker 的进程 PID。agent 存储目录全局共享（CLI/Web 多进程共写）,
    # 启动对账靠它验尸: 只有 owner 进程已死的 running 才是上次进程的孤儿。
    # None = 旧版本写的 manifest（无法验尸, 对账按孤儿保守处理）。
    owner_pid: Optional[int] = None

class AgentJob(BaseModel):
    manifest: AgentManifest
    prompt: str
    allowed_tools: set[str]
    # worker 的工具工作目录（bash cwd / 相对路径解析基点）: 从 Leader 会话继承,
    # 让子任务与主对话操作同一个项目。缺省 = 跟随进程 cwd（CLI 旧行为）。
    workdir: Optional[str] = None
    # worker 的 API 连接信息 (api_key, base_url, model, protocol): 从派生它的
    # 会话继承——会话专属模型/供应商对子代理同样生效。None = 跟随全局
    # _api_config_provider（CLI 旧行为）。
    api_config: Optional[tuple[str, Optional[str], str, str]] = None
    # 前端事件镜像 sink（Web 端注入）: 存在时 worker 的线级事件（思考/
    # 正文/工具调用/结果）会翻译后推送, 供"子智能体卡片 + 可展开对话流"
    # 渲染。None = 完全静默（CLI 行为, 也是历史行为）。由宿主在 spawn
    # 同步路径（Leader turn 线程上）捕获好塞进来——worker 线程没有
    # dispatch 绑定, 取不到 contextvar, 必须显式传。
    event_sink: Optional[Callable[[dict], None]] = None


def allowed_tools_for_subagent(subagent_type: str) -> set[str]:
    default_set = TOOL_WHITELIST["general"]
    return TOOL_WHITELIST.get(subagent_type, default_set)


def _resolve_owner_pid(explicit: Optional[int]) -> Optional[int]:
    """spawn 时决定 manifest 的 owner PID: 显式指定优先（测试造孤儿用）,
    否则记当前进程——测试进程自己 spawn 的 worker 归测试进程所有。"""
    return explicit if explicit is not None else os.getpid()


# --- 第 12 课: worker 的 runtime 组装 ---

# 工具名 → 处理函数。worker 只注册 job.allowed_tools 里出现的名字，
# 没注册的工具在 ToolRegistry 层直接抛 ToolError（白名单的执行层兜底）。
SUBAGENT_TOOL_HANDLERS: dict[str, Callable] = {
    "bash": bash_tool,
    "powershell": powershell_tool,
    "read_file": read_tool,
    "write_file": write_tool,
    # grep/glob 在 explore/plan 白名单里且规格会随请求发给 worker 模型
    # （_tool_specs_for 从 TOOLS 取）——handler 缺席时 registry 静默跳过
    # 注册, 模型调到未注册工具才吃 ToolError：2026-10 实锤, explore
    # worker 只能 read_file 直读做不了内容搜索（跨会话多份调查报告
    # 自报 grep/glob 不可用）。web_search/web_fetch 同型问题：general/
    # explore_web 白名单包含它们但同样无 handler——注意这组修复让
    # general 子代理"声明的能力"真正生效（此前名存实亡, 调到即报错）。
    "grep": grep_tool,
    "glob": glob_tool,
    "web_search": web_search_tool,
    "web_fetch": web_fetch_tool,
}

# 浏览器工具 handler: 懒加载（browser_tools 导入不触发 playwright 依赖),
# 白名单里出现的名字在 worker 组装 registry 时才解析。
def _browser_handler(name: str) -> Callable:
    from aulos.browser_tools import BROWSER_TOOL_SPECS  # noqa: F401  (依赖自检)
    import aulos.browser_tools as bt
    return getattr(bt, f"{name}_tool")


for _name in ("browser_navigate", "browser_snapshot", "browser_click",
              "browser_type", "browser_press", "browser_select",
              "browser_screenshot", "browser_console", "browser_close"):
    SUBAGENT_TOOL_HANDLERS[_name] = _browser_handler(_name)


class SilentToolExecutor:
    """worker 用的安静执行器 — 实现 runtime 的 ToolExecutor Protocol，
    但不像 Leader 的 CliToolExecutor 那样往终端打印（终端是 Leader 的）。

    workdir 来自构造时绑定（job.workdir），执行时注入 registry ——
    bash 的 cwd、读写文件的相对路径解析基点都由它决定。"""

    def __init__(self, registry: ToolRegistry, workdir: Optional[str] = None):
        self.registry = registry
        self.workdir = workdir

    def execute(self, tool_name: str, input: str, tool_use_id: str | None = None) -> str:
        return self.registry.execute(tool_name, input, workdir=self.workdir)


# --- 前端事件镜像（Web 端"子智能体卡片 + 可展开对话流"的数据源） ---

def _subagent_event_envelope(event: dict, agent_id: str) -> dict:
    """子代理内部事件 → 前端信封。type 用 subagent_event 与主对话事件
    区分开, 前端按 agent_id 路由进对应卡片的嵌套对话流, 绝不混入 Leader
    自己的流式状态。"""
    return {"type": "subagent_event", "agent_id": agent_id, "event": event}


class SubagentEventMirror:
    """把 worker 的线级事件（WireEvent）翻译成前端同构事件并推给 sink。

    与 server_common._wire_to_frontend 同一套翻译语义（协议中立: 新增
    OpenAI 协议时这里零改动），差异只有一点——工具结果的 id 由 wire 事件
    天然携带（runtime 直传 tool_use_id）, 无需 TurnEmitter 式的 FIFO 补齐。
    sink 自身的异常一律吞掉: 镜像是装饰品, 绝不能炸掉 worker 的任务线程。
    """

    def __init__(self, sink: Callable[[dict], None], agent_id: str):
        self._sink = sink
        self._agent_id = agent_id

    def __call__(self, event) -> None:
        try:
            self._observe(event)
        except Exception:
            pass

    def _observe(self, event) -> None:
        agent_id = self._agent_id
        sink = self._sink
        etype = type(event)
        if etype is WireTextDelta:
            sink(_subagent_event_envelope(
                {"type": "text_delta", "text": event.text}, agent_id))
        elif etype is WireToolStart:
            sink(_subagent_event_envelope(
                {"type": "tool_use_started", "id": event.id, "name": event.name},
                agent_id))
        elif etype is WireToolEnd:
            sink(_subagent_event_envelope(
                {"type": "tool_use", "id": event.id, "name": event.name,
                 "input": event.input_json}, agent_id))
        elif etype is WireThinkingStart:
            sink(_subagent_event_envelope({"type": "thinking_start"}, agent_id))
        elif etype is WireThinkingDelta:
            sink(_subagent_event_envelope(
                {"type": "thinking_delta", "text": event.text}, agent_id))
        elif etype is WireThinkingEnd:
            sink(_subagent_event_envelope({"type": "thinking_end"}, agent_id))
        # WireUsage / WireStop 不镜像: 前端卡片不消费, 省带宽


class MirrorToolExecutor(SilentToolExecutor):
    """SilentToolExecutor + 事件镜像: 每次工具执行完把 tool_result 推给
    sink（事件形状与 server.EmittingToolRegistry 一致）。工具抛异常时
    先镜像 is_error 事件再原样上抛——worker 的 L1/L2 兜底照常工作。
    注意与 multi_agent 无关的宿主（CLI）不传 sink, 走 SilentToolExecutor
    原路径, 行为不变。"""

    def __init__(self, registry: ToolRegistry, workdir: Optional[str] = None,
                 event_sink: Optional[Callable[[dict], None]] = None,
                 agent_id: str = ""):
        super().__init__(registry=registry, workdir=workdir)
        self._event_sink = event_sink
        self._agent_id = agent_id

    def execute(self, tool_name: str, input: str, tool_use_id: str | None = None) -> str:
        try:
            result = self.registry.execute(tool_name, input, workdir=self.workdir)
        except Exception as e:
            if self._event_sink is not None:
                self._event_sink(_subagent_event_envelope(
                    {"type": "tool_result", "id": tool_use_id, "name": tool_name,
                     "input": input, "output": str(e), "is_error": True},
                    self._agent_id))
            raise
        if self._event_sink is not None:
            self._event_sink(_subagent_event_envelope(
                {"type": "tool_result", "id": tool_use_id, "name": tool_name,
                 "input": input, "output": str(result), "is_error": False},
                self._agent_id))
        return result


# worker 的 API 客户端工厂: 返回 (api_key, base_url, model)。
# 可被宿主（Web 端）注入以跟随其运行期供应商配置; 缺省回落 .env +
# main.DEFAULT_MODEL（CLI 的连接方式）。可插拔是为了不让 multi_agent
# 反向依赖任何特定宿主的配置来源。
ApiConfigProvider = Callable[[], tuple[str, Optional[str], str]]


def _default_api_config() -> tuple[str, Optional[str], str]:
    load_dotenv()
    api_key = os.getenv("API_KEY")
    if api_key is None:
        raise RuntimeError("API_KEY not set!")
    # 默认模型定义在 main.py（组装点）。延迟导入: main 接线 multi_agent
    # 后模块级 import 会成环，函数内 import 不会。
    from aulos.main import DEFAULT_MODEL
    return api_key, None, os.getenv("CLAUDE_MODEL") or DEFAULT_MODEL


_api_config_provider: ApiConfigProvider = _default_api_config


def set_api_config_provider(provider: ApiConfigProvider) -> None:
    """宿主注入 worker 连接配置（如 Web 端跟随 UI 选的供应商/模型）。"""
    global _api_config_provider
    _api_config_provider = provider


def _tool_specs_for(allowed_tools: set[str]) -> list[dict]:
    """白名单 → API 请求的 tools 数组。只把白名单内的规格发给模型:
    执行层拦截（registry 未注册抛 ToolError）是兜底，把不可用的工具
    从请求里剔除才是让模型不误调的根本手段。"""
    from aulos.main import TOOLS
    by_name = {spec["name"]: spec for spec in TOOLS}
    return [by_name[n] for n in sorted(allowed_tools) if n in by_name]


def build_subagent_runtime(job: AgentJob) -> ConversationRuntime:
    """给 worker 组装一个完全独立的 runtime。

    - 空会话: subagent 看不到 Leader 的对话历史（上下文隔离的根基）
    - 安静的 api_client: emit_output=False，流式输出不刷 Leader 的终端
    - 白名单工具: 只注册 allowed_tools，白名单之外的工具调不到
    - ALLOW 权限: 子 agent 的边界是白名单而不是权限模式——没有人类
      可以被询问，权限模式在这里没有意义
    - 递归防护: 工具规格经 _tool_specs_for 过滤，agent 工具永远不在
      worker 的请求里（TOOL_WHITELIST 亦不含, 双保险）
    - 事件镜像: job.event_sink 存在时（Web 端）worker 的线级事件经
      SubagentEventMirror 推给前端（子智能体卡片）; None 时完全静默
      （CLI 行为不变）
    """
    # 连接信息: 会话自带（Web 多会话各选各的模型）优先, 否则全局工厂（CLI）
    api_key, base_url, model, protocol = job.api_config or _api_config_provider()

    registry = ToolRegistry()
    for tool_name in sorted(job.allowed_tools):
        handler = SUBAGENT_TOOL_HANDLERS.get(tool_name)
        if handler is None:
            # 静默跳过 = 无声退化：规格照发、调用报错、worker 半盲跑完
            # 才被发现（2026-10 grep/glob/web 事故）。组装期直接炸,
            # 让配错在 spawn 当场失败进 FAILED, 而不是无声降级跑完全程。
            raise ValueError(
                f"subagent tool '{tool_name}' 在 SUBAGENT_TOOL_HANDLERS 里没有"
                f" handler——白名单与 handler 表脱钩, 拒绝静默组装半盲 worker")
        registry.register(name=tool_name, handler=handler)

    event_sink = getattr(job, "event_sink", None)
    mirror = SubagentEventMirror(event_sink, job.manifest.agent_id) if event_sink else None
    return ConversationRuntime(
        session=Session(),
        api_client=make_api_client(
            protocol,
            api_key=api_key,
            model=model,
            base_url=base_url,
            tools=_tool_specs_for(job.allowed_tools),
            emit_output=False,
            # 有 sink 才挂观察者（每次开流时调用 mirror 拿观察者）; 无
            # sink 传 None = 完全静默（CLI/测试旧行为, 零额外开销）
            on_event_provider=(lambda: mirror) if mirror else None,
        ),
        tool_executor=MirrorToolExecutor(
            registry=registry, workdir=job.workdir,
            event_sink=event_sink, agent_id=job.manifest.agent_id),
        permission_policy=PermissionPolicy(active_mode=ALLOW_MODE),
        system_prompt=[
            "You are a focused subagent worker. Complete exactly the task "
            "you were given, then report the result as text. Do nothing "
            "beyond the task.",
        ],
    )


def final_text_of(summary) -> str:
    """从 TurnSummary 提取最后一条带文本的 assistant 消息，作为 agent 的结果。"""
    for msg in reversed(summary.assistant_messages):
        texts = [b.text for b in msg.content if isinstance(b, TextContentBlock)]
        if texts:
            return "\n".join(texts)
    return "(无文本输出)"


def _partial_result_digest(session) -> str:
    """L2: 从子代理会话历史提取"它做了什么、产物在哪"的降级摘要。

    只读 assistant 消息里的 tool_use 块: write_file/edit_file 取 path,
    bash 取 command; 另附最后 3 条工具调用的输入(产物证据)。解析失败
    的块跳过——这里是最后防线, 任何二次异常都不能再往外抛。
    """
    if session is None:
        return ""
    files: list[str] = []
    cmds: list[str] = []
    try:
        for msg in session.messages:
            for block in getattr(msg, "content", []) or []:
                # ToolContentBlock 自带 .name/.input; 旧数据/异构块跳过
                name = getattr(block, "name", "")
                if not name:
                    continue
                raw = getattr(block, "input", "")
                try:
                    inp = json.loads(raw) if isinstance(raw, str) and raw else (raw or {})
                except Exception:
                    inp = {}
                if name in ("write_file", "edit_file") and inp.get("path"):
                    if inp["path"] not in files:
                        files.append(str(inp["path"]))
                elif name == "bash" and inp.get("command"):
                    cmds.append(str(inp["command"]))
        if not (files or cmds):
            return ""
        parts = []
        if files:
            parts.append("写过的文件: " + ", ".join(files))
        if cmds:
            shown = cmds if len(cmds) <= 5 else cmds[:5] + [f"...(共 {len(cmds)} 条)"]
            parts.append("跑过的命令: " + "; ".join(shown))
        return "\n".join(parts)
    except Exception:
        return ""


class AgentOrchestrator:
    def __init__(self, store_dir: Path, spawn_fn: Optional[Callable] = None,
                 workdir: Optional[str] = None):
        self._store_dir = store_dir
        self._workdir = workdir   # 派生的 worker 工具共用的工作目录（Leader 会话的项目）
        self._spawn_fn = spawn_fn if spawn_fn else self._default_spawn_fn
        # 完成通知: agent_id → Event。spawn 时登记, 终态写入时 set——
        # wait_agents 据此阻塞等待, 替代 Leader 逐轮 agent_status 轮询
        # （每轮轮询 = 一整次 LLM 推理; 等待应发生在 Python 阻塞层）。
        # 跨进程/重启后 Event 不在内存里, wait_agents 回落读盘兜底轮询。
        self._events: dict[str, threading.Event] = {}
        self._events_lock = threading.Lock()

    def _event_for(self, agent_id: str) -> threading.Event:
        """取（或补建）agent 的 Event。补建只为兜底路径的读侧安全:
        spawn 必经登记, 缺口只出现在跨进程 manifest 上。"""
        with self._events_lock:
            ev = self._events.get(agent_id)
            if ev is None:
                ev = threading.Event()
                self._events[agent_id] = ev
            return ev

    def _signal_terminal(self, agent_id: str) -> None:
        """终态写入后唤醒所有等待者。Event 补建安全: 即使 wait 侧先建了
        Event、本进程从未 spawn, set 一样送达。"""
        self._event_for(agent_id).set()

    # 等待切片: Event.wait 的单次上限（秒）。切片而 sleep 不是一次等满:
    # 兜底读盘路径靠切片周期性检查磁盘终态; Event 路径切片只增加可忽略
    # 的唤醒延迟（≤0.2s）。
    _WAIT_SLICE_S = 0.2
    # 无 Event（跨进程 manifest）时的读盘兜底周期（秒）。
    _WAIT_DISK_POLL_S = 0.3

    def wait_agents(self, agent_ids: list[str], timeout_s: float = 180.0,
                    mode: str = "all") -> list["AgentManifest"]:
        """阻塞等待一批 agent 到终态（completed/failed）, 返回最新 manifest 快照。

        - 有内存 Event（本进程 spawn 的）: Event.wait 切片阻塞, 零轮询
        - 无 Event（跨进程/重启后的 manifest）: 按 _WAIT_DISK_POLL_S 读盘兜底
        - mode="all"（缺省）: 全部到终态才返回; mode="any": 任一到终态即返回
        - 到时未满足条件: 返回当前状态快照（running 也是合法返回, 不抛错）
        - 未知 id: 与 get_status 同口径抛 FileNotFoundError
        """
        if mode not in ("all", "any"):
            raise ValueError(f"mode 必须是 all/any, 收到: {mode!r}")
        deadline = time.monotonic() + max(0.0, float(timeout_s))
        events = [self._event_for(a) for a in agent_ids]

        def _snapshot() -> list[AgentManifest]:
            return [self.get_status(a) for a in agent_ids]

        def _terminal(ids_done: list[bool]) -> bool:
            if mode == "any":
                return any(ids_done)
            return all(ids_done)

        def _done_flags(manus: list[AgentManifest]) -> list[bool]:
            terminal = (AgentStatus.COMPLETED.value, AgentStatus.FAILED.value)
            return [m.status in terminal for m in manus]

        manus = _snapshot()   # 先查一遍: 已终态的立即满足, 不进等待循环
        while not _terminal(_done_flags(manus)):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return manus   # 到时: 返回快照, 不抛错
            # 同进程 Event + 跨进程读盘双通道: Event.wait 切片醒来的间隙
            # 顺带查一次盘——兜底覆盖"Event 永不来"的场景（worker 在别的
            # 进程跑/上次进程崩溃）, 也让混合批次（部分本进程部分外部）
            # 用同一个循环工作。Event 缺席时 wait(slice) 纯当 sleep 用。
            for ev in events:
                ev.wait(min(self._WAIT_SLICE_S, remaining))
            manus = _snapshot()
        return manus

    def _default_spawn_fn(self, job: AgentJob):
        def _emit_done(status: str, error: Optional[str] = None) -> None:
            # 终态信封: 前端据此翻转卡片状态（转圈→✓/✗ + 耗时）。
            # 镜像装饰品原则: sink 异常绝不影响 worker 收尾。
            sink = getattr(job, "event_sink", None)
            if sink is None:
                return
            try:
                sink({"type": "subagent_done", "agent_id": job.manifest.agent_id,
                      "status": status,
                      "duration_s": round(time.monotonic() - _t0, 1),
                      "error": error})
            except Exception:
                pass

        def _worker():  # ← 内层：线程的身体
            # 第 12 课: worker 本体 = 建 runtime → 跑一轮 → complete_agent
            runtime = None  # L2 要在 except 里读会话历史, 先占位防 NameError
            try:
                # 任务输入镜像: 子代理的对话流以"用户气泡"开头——前端把
                # user_message 渲染成它收到的任务全文, 展开的会话才读得懂
                # （否则第一眼看到的就是子代理自顾自的思考/工具调用）。
                # 镜像装饰品原则: 失败不影响任务执行。
                try:
                    sink = getattr(job, "event_sink", None)
                    if sink is not None:
                        # 必须走 subagent_event 信封: 前端只分派这个类型,
                        # 事件本体在 event 字段里（与其他镜像事件同构）
                        sink({"type": "subagent_event",
                              "agent_id": job.manifest.agent_id,
                              "event": {"type": "user_message",
                                        "text": job.prompt}})
                except Exception:
                    pass
                runtime = build_subagent_runtime(job)
                try:
                    summary = runtime.run_turn(job.prompt)
                except RuntimeError as exc:
                    # L1 续写兜底: 子代理最后一条消息只含 thinking/tool_use 而
                    # 无 text 时(GLM 兼容层会吞掉 thinking 事件, 见
                    # build_assistant_message), build_assistant_message 抛
                    # 「无消息内容!」——十几分钟的工作会整场打成 failed/null。
                    # 此时给模型"最后一轮总结"的机会: 同一会话注入 user 指令、
                    # 关掉工具(防它继续调工具再次无文本/死循环)、限 2 次迭代。
                    # 选择"新一轮 run_turn"而非改主循环: iterations 是 run_turn
                    # 的局部变量, 新调用天然重置, 完全不触碰预算语义; 代价只是
                    # 一次额外 API 调用。最多兜底 1 次。
                    if "无消息内容" not in str(exc):
                        raise
                    summary = (runtime.without_tools()
                               .with_max_iterations(2)
                               .run_turn(
                                   "你刚才的最终回复没有可提取的文本内容。"
                                   "请忽略工具, 用一段话总结你的最终结论与产出"
                                   "(做了什么、写了哪些文件、结果如何)。"
                                   "这是最后一轮, 直接给文本, 不要再调用任何工具。"))
                self.complete_agent(job.manifest.agent_id, final_text_of(summary))
                _emit_done("completed")
            except Exception as exc:
                # L2 部分结果回传: L1 总结轮也失败(或压根不是"无消息内容"类
                # 异常, 如 API 中断)时, 不把工作打成 null——从会话历史提取
                # 产物证据(写过的文件/跑过的命令/最近的工具输出), 以
                # COMPLETED + 降级标注交付给 Leader。走 COMPLETED 而非 FAILED:
                # reap_ready 只交付 completed, FAILED 的 result Leader 拿不到,
                # "告诉用户产物在哪"就无从谈起。历史里连工具调用都没有时
                # (任务还没开始就炸了), 维持 FAILED, 不伪造结果。
                digest = _partial_result_digest(getattr(runtime, "session", None))
                if digest:
                    try:
                        self.complete_agent(
                            job.manifest.agent_id,
                            "[部分结果·子代理异常终止] " + str(exc) + "\n" + digest)
                        _emit_done("completed", str(exc))
                        return
                    except Exception:
                        pass
                try:
                    self._persist_terminal_state(job.manifest, status=AgentStatus.FAILED.value, result=None, error=str(exc))
                except Exception:
                    pass
                _emit_done("failed", str(exc))

        # 计时起点: spawn 点火时刻（worker 真正开跑可能有线程调度延迟,
        # 按用户感知的"派出去多久"口径计时）
        _t0 = time.monotonic()
        thread = threading.Thread(target=_worker, name=f"agent-{job.manifest.agent_id}", daemon=True)  # ← 外层：target=_worker（注意没有括号！）
        thread.start()  # ← 点火，立刻返回

    def spawn_agent(self, description: str, prompt: str, name: Optional[str] = None, subagent_type: str = "general",
                    workdir: Optional[str] = None,
                    api_config: Optional[tuple[str, Optional[str], str, str]] = None,
                    event_sink: Optional[Callable[[dict], None]] = None,
                    _owner_pid: Optional[int] = None) -> AgentManifest:
        if description.strip() == "" or prompt.strip() == "":
            raise ValueError("description or prompt are null")
        self._store_dir.mkdir(parents=True, exist_ok=True)
        agent_id = uuid.uuid4().hex[0:12]
        md_path = self._store_dir / f"{agent_id}.md"
        json_path = self._store_dir / f"{agent_id}.json"

        subagent_type = subagent_type.strip().lower()
        white_tools = allowed_tools_for_subagent(subagent_type)

        now = datetime.now(timezone.utc).isoformat()
        name = name if name else ""
        manifest = AgentManifest(
            agent_id=agent_id,
            name=name,
            description=description,
            subagent_type=subagent_type,
            status=AgentStatus.RUNNING.value,
            output_file=str(md_path),
            started_at=now,
            created_at=now,
            completed_at=None,
            error=None,
            owner_pid=_resolve_owner_pid(_owner_pid),
        )
        md_content = dedent(f"""\
            # Agent Task

            - id: {agent_id}
            - name: {name}
            - subagent_type: {subagent_type}
            - created_at: {now}

            ## Prompt

            {prompt}
        """)
        with open(md_path, "w", encoding= "utf-8") as f:
            f.write(md_content)

        manifest_content = manifest.model_dump_json()
        # 原子写: 其他会话的 reap/list 可能此刻正 glob *.json, 直写会让
        # 读者看到半截 JSON（解析失败被吞, agent 凭空消失）
        atomic_write_text(json_path, manifest_content)
        # 登记 Event 供 wait_agents 阻塞等待。必须在 spawn_fn 之前:
        # worker 可能瞬间跑完（_persist_terminal_state 会 set 一个尚不
        # 存在的 Event, 虽然补建安全, 但先登记让 wait 一开始就拿到正主）。
        self._event_for(agent_id)

        # workdir / api_config: 调用方显式传入优先（Web 按会话传）, 否则用
        # 编排器默认（workdir）/ 全局工厂（api_config → CLI 行为）
        job = AgentJob(
            manifest=manifest.model_copy(),
            prompt=prompt,
            allowed_tools=white_tools.copy(),
            workdir=workdir or self._workdir,
            api_config=api_config,
            event_sink=event_sink,
        )
        # 卡片创建事件必须在点火之前发: worker 线程可能瞬间跑完（stub/
        # 极快任务）, 点火后才发的话镜像事件会跑到 started 前面, 前端按
        # agent_id 路由时卡片还不存在。有 sink（Web）才发, CLI 静默。
        if job.event_sink is not None:
            try:
                job.event_sink({"type": "subagent_started",
                                "agent_id": agent_id,
                                "subagent_type": subagent_type,
                                "name": name,
                                "description": description})
            except Exception:
                pass
        try:
            self._spawn_fn(job)
        except Exception as e:
            self._persist_terminal_state(manifest=manifest, status=AgentStatus.FAILED.value, result="", error=str(e))
            raise RuntimeError(f"Spawn failed: {e}") from e
        return manifest


    def set_workdir(self, workdir: Optional[str]) -> None:
        """更新后续派生的 worker 的工作目录（Web 端按会话解析后注入）。"""
        self._workdir = workdir or None

    def get_status(self,agent_id: str) -> AgentManifest:
        json_path = self._store_dir / f"{agent_id}.json"
        if not json_path.exists():
            raise FileNotFoundError(f"Agent {agent_id} not found")
        # 读走重试: replace 过渡窗口里新开读句柄在 Windows 上会瞬时被拒
        manifest = AgentManifest.model_validate(
            json.loads(read_text_with_retry(json_path)))

        return manifest

    def list_agents(self) -> list[AgentManifest]:
        result: list[AgentManifest] = []
        for manifest in self._store_dir.glob("*.json"):
            try:
                result.append(AgentManifest.model_validate(
                    json.loads(read_text_with_retry(manifest))))
            except Exception as e:
                continue

        return result

    def _persist_terminal_state(self, manifest: AgentManifest, status: str, result: Optional[str], error:Optional[str]):
        """写终态。

        .md 追加结果；manifest JSON 用原子覆盖写（唯一临时文件 + 原子替换）。
        worker 线程写终态的同时，Leader 可能正在轮询 get_status() 读
        同一个文件——直接 open("w") 会先截断再写，读者会撞见半截 JSON。
        原子替换保证读者要么看到完整旧文件、要么看到完整新文件；与
        mark_delivered 并发时唯一临时名互不踩踏（固定名会互相截断对方的
        临时文件，把半截内容发布出去），Windows 上目标被读者占住时的
        瞬时 PermissionError 由重试兜住。
        """
        md_path = self._store_dir / f"{manifest.agent_id}.md"
        now = datetime.now(timezone.utc).isoformat()
        md_content = dedent(f"""\
                   ## Result
                   
                   status: {status}
                   result: {result}
                   error: {error}
               """)
        with open(md_path, "a", encoding= "utf-8") as f:
            f.write(md_content)
        new_manifest = manifest.model_copy(update={
            "status": status,
            "completed_at": now,
            "error": error,
            "result": result,
        })
        json_path = self._store_dir / f"{manifest.agent_id}.json"
        atomic_write_text(json_path, new_manifest.model_dump_json())
        # 终态落盘后唤醒等待者（wait_agents）。放在原子替换之后: 等待者
        # 醒来读到的必然是完整的新 manifest。成功/失败/部分结果三条收尾
        # 路径都经此处, 单点覆盖。
        self._signal_terminal(manifest.agent_id)


    def complete_agent(self, agent_id: str, result:str):
        manifest = self.get_status(agent_id)
        # 终态保护: 已是终态（如被启动对账标记的 failed, 或重复收尾）就不
        # 覆盖——与 fail_agent 同一条"先到先得"规则, 防状态翻转。
        if manifest.status in (AgentStatus.COMPLETED.value, AgentStatus.FAILED.value):
            return
        self._persist_terminal_state(manifest=manifest, status=AgentStatus.COMPLETED.value,result=result, error=None)


    # --- 收割: 把"跑完了但结果没进对话"的 worker 交给 Leader ---

    def reap_ready(self) -> list[AgentManifest]:
        """completed 且未 delivered 的 worker 列表（只读快照, 不改状态）。"""
        ready = []
        for m in self.list_agents():
            if m.status == AgentStatus.COMPLETED.value and not m.delivered:
                ready.append(m)
        return ready

    def mark_delivered(self, agent_ids: list[str]) -> int:
        """把结果标记为已交付（原子覆盖写回）。返回成功数。

        与 worker 线程的终态写并发时两侧都走唯一临时名 + 原子替换,
        读者不会撞见半截文件, 写者互不踩踏; 极端交错下最坏是多标一次
        delivered, 幂等无害。"""
        ok = 0
        for agent_id in agent_ids:
            try:
                manifest = self.get_status(agent_id)
            except FileNotFoundError:
                continue
            new_manifest = manifest.model_copy(update={"delivered": True})
            json_path = self._store_dir / f"{agent_id}.json"
            atomic_write_text(json_path, new_manifest.model_dump_json())
            ok += 1
        return ok

    def reconcile_orphans(self) -> int:
        """启动对账: 进程死亡时 daemon worker 随之消失, manifest 永远停在
        running——把 owner 进程已死的 running 标记为 failed。

        agent 存储目录全局共享（CLI / Web / 多个会话进程共写）, "running"
        不等于孤儿: 别的活进程可能正在跑这个 worker。所以验尸后再定罪——
        manifest 带 owner_pid 时用 pid_alive() 查 owner 是否还活着, 活着
        的跳过; 没有 owner_pid 的旧版 manifest 无法验尸, 按孤儿保守处理。

        简化假设: 对账只在进程启动时调用一次, 此刻本进程的 _default_spawn_fn
        还没跑过。运行期绝不能调用。

        收尾顺带跑一次过期清理（cleanup_expired）: 终态记录永久累积会
        拖慢 list_agents 的 glob+逐文件解析。只删超期终态, running 一律不动。"""
        orphans = [m for m in self.list_agents()
                   if m.status == AgentStatus.RUNNING.value
                   and not (m.owner_pid and pid_alive(m.owner_pid))]
        for m in orphans:
            self.fail_agent(m.agent_id,
                            "进程重启时该 worker 仍在运行, 已标记为失败（结果未产出）")
        try:
            self.cleanup_expired()
        except Exception:
            pass   # 清理是锦上添花, 失败不阻断对账
        return len(orphans)

    # 默认保留期（天）: 终态记录超期即清理。7 天覆盖"上次会话忘了收割,
    # 过几天回来看结果"的场景; 再旧的结果即使想看, 项目状态也早变了,
    # 记录本身失去参考价值。
    DEFAULT_RETENTION_DAYS = 7

    def cleanup_expired(self, retention_days: int = DEFAULT_RETENTION_DAYS) -> int:
        """删除超过保留期的终态（completed/failed）记录, 返回删除数。

        只动终态: running/pending 的记录哪怕再旧也不删——worker 线程可能
        正在写终态（先 .md 后 .json）, 删掉会造成 .md/.json 分裂; 孤儿
        running 由 reconcile_orphans 在启动时先定罪成 failed, 下次启动
        的清理自然回收。pending 状态 spawn 立即转 running, 实际不会出现。

        .md 与 .json 一起删（成对存在, 单留一个会误导）。删除失败不抛:
        文件被读者占用（Windows）时跳过, 下次启动再试。"""
        cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
        removed = 0
        for m in self.list_agents():
            if m.status not in (AgentStatus.COMPLETED.value, AgentStatus.FAILED.value):
                continue
            try:
                created = datetime.fromisoformat(m.created_at)
            except (TypeError, ValueError):
                continue   # 时间戳坏了的不敢删, 留给人工处理
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if created >= cutoff:
                continue
            for suffix in (".json", ".md"):
                try:
                    (self._store_dir / f"{m.agent_id}{suffix}").unlink(missing_ok=True)
                except OSError:
                    pass   # 被占用等瞬时错误: 留到下次启动再试
            removed += 1
        return removed


    def fail_agent(self, agent_id: str, error: str) :
        manifest = self.get_status(agent_id)
        # 终态保护: 已是终态就不翻转（先到先得）。真实事故: worker 被另一
        # 进程的启动对账误标 failed, 82 秒后 worker 正常跑完, complete_agent
        # 无条件覆盖 → 状态翻转, .md 里留下两段矛盾 Result。终态一旦写入,
        # 迟到的一方必须让步。
        if manifest.status in (AgentStatus.COMPLETED.value, AgentStatus.FAILED.value):
            return
        self._persist_terminal_state(manifest=manifest, status=AgentStatus.FAILED.value, result=None, error=error)
