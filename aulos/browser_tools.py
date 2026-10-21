"""浏览器自动化工具（Playwright headless Chromium）: 让 Agent 能实测 Web 系统。

场景: 打开被测页面 → 填表单/点按钮 → 读 aria snapshot 与 console 报错 →
截图存证。与 agent_tools.py 同构: spec（给模型的 JSON Schema）+ handler
（(params: dict, workdir) -> str）+ register_browser_tools（链式注册进
ToolRegistry）。CLI 与 Web 共用同一份——两者都走 main.build_registry()。

线程模型: Playwright 的 sync API 非线程安全，而 runtime 的工具池是多线程
（ThreadPoolExecutor），所以所有浏览器操作经单线程 executor 串行化——
外层 handler 只做参数整理与结果拼装，真正碰 playwright 对象的代码都在
_BROWSER_POOL 那一个线程里跑。

降级: playwright 未安装/未 download 浏览器时返回安装指引的 ERROR 文本，
不抛异常——模型看到文本能把指引转述给用户，异常只会变成裸 ToolError。
截图 PNG 落在用户目录（~/.aulos/screenshots/），不污染项目 git。
"""
import concurrent.futures
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

# 与 tools.py 相同的换行约定
NL = chr(10)

# 截图输出目录: 用户级, 与会话存储平级
def screenshots_dir() -> Path:
    from aulos.config import USER_DIR
    return USER_DIR / "screenshots"


# --- 启动选项: 配置 + 环境变量 → headless/slowMo/channel（纯函数, 可单测） ---

# AULOS_BROWSER_HEADED 的显式关闭值: 视同未设置（回退配置）; 其余非空值 =
# 强制可见。演示/录视频时不想改配置文件, 环境变量是临时覆盖的捷径。
_HEADED_FALSY = {"0", "false", "off", "no"}


def launch_options(feature_config, environ) -> dict:
    """解析浏览器启动选项。优先级: 环境变量 > feature_config > 默认。

    参数:
        feature_config: RuntimeFeatureConfig（读 browser_headless/browser_slow_mo）
        environ: os.environ 风格的映射（AULOS_BROWSER_HEADED/SLOWMO/CHANNEL）
    返回:
        {"headless": bool, "slow_mo": int, "channel": str | None}
    异常:
        配置层 slowMo 为负 → ValueError（配置错误, 应在启动时暴露）
        环境变量值非法 → 忽略该变量, 不让可见性配置问题卡死浏览器
    """
    headless = bool(getattr(feature_config, "browser_headless", True))
    slow_mo = int(getattr(feature_config, "browser_slow_mo", 0) or 0)
    if slow_mo < 0:
        raise ValueError(f"browserSlowMo: expected non-negative integer, got {slow_mo}")

    headed_raw = str(environ.get("AULOS_BROWSER_HEADED", "")).strip().lower()
    if headed_raw and headed_raw not in _HEADED_FALSY:
        headless = False

    slowmo_raw = str(environ.get("AULOS_BROWSER_SLOWMO", "")).strip()
    try:
        slow_mo = int(slowmo_raw)
    except ValueError:
        pass  # 非法值忽略; "0" 是合法显式关闭, 走正常赋值

    channel = str(environ.get("AULOS_BROWSER_CHANNEL", "")).strip() or None
    return {"headless": headless, "slow_mo": slow_mo, "channel": channel}


def _current_feature_config():
    """读当前生效的 feature_config; 加载失败回退默认（headless）——浏览器
    工具的可见性是锦上添花, 不该因配置系统故障变成不可用。"""
    try:
        from aulos.config import ConfigLoader
        from aulos.config import USER_DIR
        return ConfigLoader(Path.cwd(), USER_DIR).load().feature_config
    except Exception:
        from aulos.config import RuntimeFeatureConfig
        return RuntimeFeatureConfig()


# --- 浏览器单例状态（只在 _BROWSER_POOL 线程里触碰） ---

class _BrowserState:
    """懒初始化的 playwright/chromium/page 持有者。所有字段只在
    _BROWSER_POOL 线程里读写（goto/click 等调用与 _reset 都在那跑）。"""

    def __init__(self):
        self._pw = None            # playwright 实例（stop 时关闭）
        self._browser = None       # Browser（复用, 工具间不重启）
        self._page = None          # 当前活动 Page（单页面会话）
        self._channel_used = None  # 实际启动成功的渠道（诊断用）
        self._headless = True      # 实际启动模式（工具描述自述用）
        self.console: list[str] = []   # console 消息 + pageerror 累积
        self.max_console = 200     # 防长会话无限膨胀

    # -- 初始化 / 关闭 --

    def _import_playwright(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            raise RuntimeError(
                "playwright is not installed. Run: "
                "`uv add playwright` (or pip install playwright), "
                "then `playwright install chromium`") from e
        return sync_playwright

    def _launch(self):
        """起 playwright chromium（headless/slowMo 由配置+环境变量决定）。
        渠道顺序: 环境变量 AULOS_BROWSER_CHANNEL 指定 > chromium（playwright
        自带） > 本机 chrome > 本机 msedge（Windows 全机自带）。桌面端/冻结
        exe 没法跑 `playwright install`，靠后面的本机浏览器渠道兜底——
        Win10/11 必有 Edge，等效"零额外下载"。可见性与节奏解析见
        launch_options()；browser_close 后下次调用按新配置重开。"""
        sync_playwright = self._import_playwright()
        self._pw = sync_playwright().start()
        import os
        opts = launch_options(_current_feature_config(), os.environ)
        channels = [opts["channel"]] if opts["channel"] else [None, "chrome", "msedge"]
        last_err: Exception | None = None
        for channel in channels:
            try:
                self._browser = self._pw.chromium.launch(
                    headless=opts["headless"], slow_mo=opts["slow_mo"],
                    channel=channel)
                self._channel_used = channel or "chromium"
                self._headless = opts["headless"]
                break
            except Exception as e:
                last_err = e
                self._browser = None
        if self._browser is None:
            self._pw.stop()
            self._pw = None
            raise RuntimeError(
                f"failed to launch any Chromium channel ({last_err}). "
                f"Fix: run `playwright install chromium`, or install "
                f"Chrome/Edge, or set AULOS_BROWSER_CHANNEL to a specific "
                f"channel") from last_err
        self._page = None
        self.console = []

    def _ensure(self):
        """当前 thread 里保证 browser 可用。"""
        if self._browser is None:
            self._launch()
        return self._browser

    def _page_ctx(self):
        """当前页面; 没有则建一个并挂 console 收集器。"""
        self._ensure()
        if self._page is None:
            self._page = self._browser.new_page()
            page = self._page
            page.on("console", lambda m: self._push_console(
                    f"[{m.type}] {m.text}"))
            page.on("pageerror", lambda e: self._push_console(
                    f"[pageerror] {e}"))
            page.on("close", lambda _: setattr(self, "_page", None))
        return self._page

    def _push_console(self, line: str):
        self.console.append(line)
        if len(self.console) > self.max_console:
            self.console = self.console[-self.max_console:]

    def _reset(self):
        """全量关闭（_close_tool 与异常兜底共用; 只在 pool 线程跑）。"""
        for attr in ("_page", "_browser", "_pw"):
            obj = getattr(self, attr, None)
            try:
                if obj is not None:
                    obj.close() if attr != "_pw" else obj.stop()
            except Exception:
                pass
            setattr(self, attr, None)
        self.console = []

    # -- 供 handler 经 pool 调用的操作 --

    def navigate(self, url: str, timeout_ms: int) -> str:
        page = self._page_ctx()
        resp = page.goto(url, timeout=timeout_ms, wait_until="load")
        status = resp.status if resp else "?"
        return (f"title: {page.title()}" + NL
                + f"url: {page.url}" + NL
                + f"http status: {status}" + NL + NL
                + _aria_snapshot(page))

    def snapshot(self) -> str:
        page = self._page_ctx()
        return (f"url: {page.url}" + NL + NL
                + _aria_snapshot(page) + NL + NL
                + "-- visible text --" + NL + _visible_text(page))

    def click(self, selector: str, timeout_ms: int) -> str:
        page = self._page_ctx()
        page.click(selector, timeout=timeout_ms)
        page.wait_for_load_state("load", timeout=timeout_ms)
        return (f"clicked: {selector}" + NL + NL + _aria_snapshot(page))

    def type_text(self, selector: str, text: str,
                  submit: bool, timeout_ms: int) -> str:
        page = self._page_ctx()
        page.fill(selector, text, timeout=timeout_ms)
        if submit:
            page.press(selector, "Enter", timeout=timeout_ms)
            page.wait_for_load_state("load", timeout=timeout_ms)
        return f"typed into {selector}: {text!r}" + (
            " + Enter" if submit else "")

    def press_key(self, key: str, timeout_ms: int) -> str:
        page = self._page_ctx()
        page.keyboard.press(key)
        page.wait_for_load_state("load", timeout=timeout_ms)
        return f"pressed: {key}"

    def select_option(self, selector: str, value: str, timeout_ms: int) -> str:
        page = self._page_ctx()
        page.select_option(selector, value, timeout=timeout_ms)
        return f"selected {value!r} in {selector}"

    def screenshot(self, full_page: bool, path: Optional[str]) -> str:
        page = self._page_ctx()
        out = Path(path) if path else (
            screenshots_dir() / f"shot-{time.strftime('%Y%m%d-%H%M%S')}"
            f"-{uuid.uuid4().hex[:6]}.png")
        out.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(out), full_page=full_page)
        return (f"screenshot saved: {out.resolve()}" + NL
                + f"full_page: {full_page}")

    def console_text(self, clear: bool) -> str:
        if not self.console:
            body = "(no console messages yet)"
        else:
            body = NL.join(self.console)
        if clear:
            self.console = []
        return body

    def close(self) -> str:
        self._reset()
        return "browser closed"


def _aria_snapshot(page) -> str:
    """页面结构描述。Playwright 的 aria_snapshot 对 LLM 最友好（角色树）;
    版本不支持时退回 outerHTML 片段。"""
    try:
        return page.locator("body").aria_snapshot()
    except Exception:
        html = page.content()
        return f"<body (html fallback)>{html[:4000]}"


def _visible_text(page) -> str:
    try:
        return page.evaluate("() => document.body.innerText") or ""
    except Exception:
        return "(could not read page text)"


_STATE = _BrowserState()
# max_workers=1: 所有 playwright 对象只被这一个线程触碰（sync API 非线程安全）
_BROWSER_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="browser")

# 与 tools.py 的 _WAIT_SLICE 同一约定: 小步快查取消, CPU 占用可忽略
_WAIT_SLICE = 0.05
# 单次浏览器操作的总上限（秒）。playwright 自身超时上限 60s, 这里兜底
# 极端挂起（如驱动管道僵死）, 防止轮次工作线程无限期卡死。
_OP_TIMEOUT_S = 120.0
_INTERRUPTED_TEXT = "(用户中断了本轮对话)"


def _cancel_requested() -> bool:
    """读宿主注入的取消旗标（contextvars 随 runtime 的 copy_context()
    传进本工具线程）。CLI 未注入时恒 False, 行为不变。"""
    from aulos.tools import TOOL_CANCEL_CHECK
    check = TOOL_CANCEL_CHECK.get()
    return bool(check and check())


def _run_in_browser_thread(fn, *args):
    """把浏览器操作丢进单线程池执行, 等待期间分片轮询取消旗标。

    取消路径（关键设计）: 不能只 return——池线程还被挂起的 playwright 调用
    （如 page.goto 卡在慢页面）占着, 后续 browser 调用会继续在池队列里排队,
    整轮照旧卡死。所以取消时向池再提交一个 _STATE._reset()（关 page/
    browser/pw; sync API 要求必须在池线程执行, 池队列天然串行化）: 挂起中的
    调用因 page 被关而立即抛错, 池线程被解放。浏览器下次调用会按现有
    _launch 逻辑自动重开, 无残留状态。

    RuntimeError（安装/启动问题）原样返回成 ERROR 文本; 其余异常转简短
    ERROR（保 registry 的 ToolError 可读）。"""
    if _cancel_requested():
        return _INTERRUPTED_TEXT
    fut = _BROWSER_POOL.submit(fn, *args)
    deadline = time.monotonic() + _OP_TIMEOUT_S
    while True:
        try:
            return fut.result(timeout=_WAIT_SLICE)
        except concurrent.futures.TimeoutError:
            now_cancelled = _cancel_requested()
            if not now_cancelled and time.monotonic() < deadline:
                continue
            # 取消或总超时: 池线程可能仍被挂起的 playwright 调用占用。
            # 提交 _reset 从池内拆台（关闭会让挂起调用立即抛错返回）,
            # 等它跑完再收口——期间 fn 的 future 也会就绪（error 形态）。
            reset = _BROWSER_POOL.submit(_STATE._reset)
            try:
                reset.result(timeout=10.0)
            except concurrent.futures.TimeoutError:
                pass   # reset 本身僵死就不再等, fn 的收尾交给 except 分支
            try:
                fut.result(timeout=5.0)
            except Exception:
                pass   # fn 的报错不覆盖下面的收口语义
            return (_INTERRUPTED_TEXT if now_cancelled
                    else f"ERROR: browser operation timed out after "
                         f"{int(_OP_TIMEOUT_S)}s (browser has been reset)")
        except RuntimeError as e:
            return f"ERROR: {e}"
        except Exception as e:
            return f"ERROR: browser operation failed: {e}"


# --- 参数整理（线程池外）: 统一签名 (params, workdir) -> str ---

def _clamp_ms(raw, default=8000, cap=60_000) -> int:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1000, min(n, cap))


def browser_navigate_tool(params: dict, workdir: Optional[str] = None) -> str:
    url = str(params.get("url") or "").strip()
    if not url:
        return "ERROR: url is required"
    if not url.startswith(("http://", "https://")):
        url = "http://" + url
    return _run_in_browser_thread(_STATE.navigate, url,
                                  _clamp_ms(params.get("timeout")))


def browser_snapshot_tool(params: dict, workdir: Optional[str] = None) -> str:
    return _run_in_browser_thread(_STATE.snapshot)


def browser_click_tool(params: dict, workdir: Optional[str] = None) -> str:
    selector = str(params.get("selector") or "").strip()
    if not selector:
        return "ERROR: selector is required"
    return _run_in_browser_thread(_STATE.click, selector,
                                  _clamp_ms(params.get("timeout")))


def browser_type_tool(params: dict, workdir: Optional[str] = None) -> str:
    selector = str(params.get("selector") or "").strip()
    if not selector:
        return "ERROR: selector is required"
    text = str(params.get("text") or "")
    return _run_in_browser_thread(_STATE.type_text, selector, text,
                                  bool(params.get("submit")),
                                  _clamp_ms(params.get("timeout")))


def browser_press_tool(params: dict, workdir: Optional[str] = None) -> str:
    key = str(params.get("key") or "").strip()
    if not key:
        return "ERROR: key is required"
    return _run_in_browser_thread(_STATE.press_key, key,
                                  _clamp_ms(params.get("timeout")))


def browser_select_tool(params: dict, workdir: Optional[str] = None) -> str:
    selector = str(params.get("selector") or "").strip()
    value = str(params.get("value") or "").strip()
    if not selector or not value:
        return "ERROR: selector and value are required"
    return _run_in_browser_thread(_STATE.select_option, selector, value,
                                  _clamp_ms(params.get("timeout")))


def browser_screenshot_tool(params: dict, workdir: Optional[str] = None) -> str:
    return _run_in_browser_thread(_STATE.screenshot,
                                  bool(params.get("full_page")),
                                  params.get("path") or None)


def browser_console_tool(params: dict, workdir: Optional[str] = None) -> str:
    return _run_in_browser_thread(_STATE.console_text,
                                  bool(params.get("clear")))


def browser_close_tool(params: dict, workdir: Optional[str] = None) -> str:
    return _run_in_browser_thread(_STATE.close)


# --- 工具 spec: 描述与参数 schema 给模型看 ---

_COMMON_TIMEOUT = {
    "timeout": {"type": "integer",
                "description": "Milliseconds, 1000-60000, default 8000"},
}

SELECTOR_DOC = (
    "CSS selector or text engine ('text=Login', 'role=button[name=Submit]')")

def _browser_visibility_doc() -> str:
    """工具描述里按当前实际可见性自述（headless 写死时代的描述会骗模型）。"""
    try:
        headless = _STATE._headless
    except Exception:
        headless = True
    return ("headless (invisible)" if headless
            else "headed (a visible Chromium window the user can watch)")


browser_navigate_spec = {
    "name": "browser_navigate",
    "description": (
        "Open a URL in a Chromium browser (Playwright; visibility depends "
        "on user config). Returns "
        "page title, final URL, HTTP status and an aria snapshot of the "
        "page structure. First call of a web-testing flow; subsequent "
        "snapshot/click/type operate on the same page."),
    "input_schema": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "http(s) URL"},
            **_COMMON_TIMEOUT,
        },
        "required": ["url"],
    },
}

browser_snapshot_spec = {
    "name": "browser_snapshot",
    "description": (
        "Capture the current browser page as an aria snapshot (accessibility "
        "tree with roles/names) plus visible text. Use it after navigate or "
        "interactions to inspect what the page shows now — no arguments."),
    "input_schema": {"type": "object", "properties": {}},
}

browser_click_spec = {
    "name": "browser_click",
    "description": (
        "Click an element in the current page, wait for load, return the "
        "updated aria snapshot. Pair with browser_snapshot to find selectors."),
    "input_schema": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": SELECTOR_DOC},
            **_COMMON_TIMEOUT,
        },
        "required": ["selector"],
    },
}

browser_type_spec = {
    "name": "browser_type",
    "description": (
        "Clear and type text into an input/textarea in the current page. "
        "Set submit=true to press Enter afterwards (e.g. search boxes, "
        "login forms)."),
    "input_schema": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": SELECTOR_DOC},
            "text": {"type": "string", "description": "Text to type"},
            "submit": {"type": "boolean",
                       "description": "Press Enter after typing, default false"},
            **_COMMON_TIMEOUT,
        },
        "required": ["selector", "text"],
    },
}

browser_press_spec = {
    "name": "browser_press",
    "description": (
        "Press a keyboard key in the current page (e.g. 'Enter', 'Escape', "
        "'Tab'). Use for key-driven interactions not tied to an input."),
    "input_schema": {
        "type": "object",
        "properties": {
            "key": {"type": "string",
                    "description": "Key name like 'Enter', 'Escape', 'ArrowDown'"},
            **_COMMON_TIMEOUT,
        },
        "required": ["key"],
    },
}

browser_select_spec = {
    "name": "browser_select",
    "description": (
        "Select an option in a <select> dropdown in the current page "
        "(matches by value or label)."),
    "input_schema": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": SELECTOR_DOC},
            "value": {"type": "string", "description": "Option value/label"},
            **_COMMON_TIMEOUT,
        },
        "required": ["selector", "value"],
    },
}

browser_screenshot_spec = {
    "name": "browser_screenshot",
    "description": (
        "Save a PNG screenshot of the current page. Returns the absolute "
        "file path (default under ~/.aulos/screenshots/). Set full_page=true "
        "to capture beyond the viewport."),
    "input_schema": {
        "type": "object",
        "properties": {
            "full_page": {"type": "boolean",
                          "description": "Full scrollable page, default false"},
            "path": {"type": "string",
                     "description": "Optional output file path (.png)"},
        },
    },
}

browser_console_spec = {
    "name": "browser_console",
    "description": (
        "Read console messages and uncaught JS errors (pageerror) collected "
        "since page open. Essential for web testing: check it after "
        "interactions to catch silent JS failures. Set clear=true to drain."),
    "input_schema": {
        "type": "object",
        "properties": {
            "clear": {"type": "boolean",
                      "description": "Clear messages after reading, default false"},
        },
    },
}

browser_close_spec = {
    "name": "browser_close",
    "description": (
        "Close the browser and release resources. Call when testing is done "
        "for this conversation."),
    "input_schema": {"type": "object", "properties": {}},
}

BROWSER_TOOL_SPECS = [
    browser_navigate_spec, browser_snapshot_spec, browser_click_spec,
    browser_type_spec, browser_press_spec, browser_select_spec,
    browser_screenshot_spec, browser_console_spec, browser_close_spec,
]

# worker（subagent）可用名: 与 SUBAGENT_TOOL_HANDLERS 保持同步
BROWSER_TOOL_NAMES = {s["name"] for s in BROWSER_TOOL_SPECS}


def register_browser_tools(registry):
    """把 9 个浏览器工具注册进 ToolRegistry（main.build_registry 调用）。
    注册时把浏览器实际可见性拼进 navigate 描述, 模型不会按过时的
    "headless" 假设向用户转述。"""
    browser_navigate_spec["description"] = (
        f"Open a URL in a Chromium browser (Playwright; currently "
        f"{_browser_visibility_doc()}). Returns "
        "page title, final URL, HTTP status and an aria snapshot of the "
        "page structure. First call of a web-testing flow; subsequent "
        "snapshot/click/type operate on the same page.")
    return (registry
            .register(name="browser_navigate", handler=browser_navigate_tool)
            .register(name="browser_snapshot", handler=browser_snapshot_tool)
            .register(name="browser_click", handler=browser_click_tool)
            .register(name="browser_type", handler=browser_type_tool)
            .register(name="browser_press", handler=browser_press_tool)
            .register(name="browser_select", handler=browser_select_tool)
            .register(name="browser_screenshot", handler=browser_screenshot_tool)
            .register(name="browser_console", handler=browser_console_tool)
            .register(name="browser_close", handler=browser_close_tool))
