"""browser_tools 取消路径测试: 用户停止/插队打断时, 卡在浏览器操作上的
轮次要能及时收口（正是「开着浏览器时发不出消息」bug 的回归门）。

不真开浏览器——mock 池任务与 _reset, 只验证 _run_in_browser_thread 的
取消语义:
1. 提交前已取消 → 不提交, 直接返回中断文本;
2. 运行中取消 → 及时返回中断文本, 且向池调度 _reset（解锁挂起的调用）;
3. 正常路径与总超时路径语义不回归。
"""
import threading
import time

import pytest

import aulos.browser_tools as bt
from aulos.tools import TOOL_CANCEL_CHECK

pytestmark = pytest.mark.slow


@pytest.fixture
def cancel_flag():
    """可控的取消旗标: 置位后 _cancel_requested() 返回 True。"""
    flag = {"stop": False}
    tok = TOOL_CANCEL_CHECK.set(lambda: flag["stop"])
    yield flag
    TOOL_CANCEL_CHECK.reset(tok)


def test_cancelled_before_submit(cancel_flag, monkeypatch):
    """提交前已取消: 不进池, 直接返回中断文本。"""
    cancel_flag["stop"] = True
    submitted = []

    def spy_submit(fn, *a):
        submitted.append(fn)
        raise AssertionError("should not submit when cancelled")

    monkeypatch.setattr(bt._BROWSER_POOL, "submit", spy_submit)
    out = bt._run_in_browser_thread(lambda: "ok")
    assert out == bt._INTERRUPTED_TEXT
    assert submitted == []


def test_cancelled_while_running_schedules_reset(cancel_flag, monkeypatch):
    """运行中取消: 及时返回中断文本 + _reset 被调度执行。"""
    cancel_flag["stop"] = False
    started = threading.Event()
    release = threading.Event()

    def stuck():
        started.set()
        release.wait(10.0)   # 模拟挂起的 page.goto
        raise RuntimeError("page killed by reset")

    resets = []
    real_reset = bt._STATE._reset

    def spy_reset():
        resets.append(time.monotonic())
        release.set()        # reset 关页面 → 挂起调用被解放
        return real_reset()

    monkeypatch.setattr(bt._STATE, "_reset", spy_reset)
    deadline = time.monotonic() + 15.0

    def soon_cancel():
        # 主线程 0.3s 后置位取消旗标（在 _run_in_browser_thread 轮询到之前）
        started.wait(5.0)
        time.sleep(0.3)
        cancel_flag["stop"] = True

    canceller = threading.Thread(target=soon_cancel)
    canceller.start()
    out = bt._run_in_browser_thread(stuck)
    canceller.join(5.0)

    assert out == bt._INTERRUPTED_TEXT
    assert resets, "取消后必须调度 _reset 解锁池线程"
    assert time.monotonic() < deadline


def test_no_cancel_returns_result(cancel_flag):
    """无取消: 正常返回值不变。"""
    out = bt._run_in_browser_thread(lambda a, b: f"{a}-{b}", "x", 1)
    assert out == "x-1"


def test_runtime_error_still_readable(cancel_flag):
    """RuntimeError（安装/启动问题）仍转成 ERROR 文本, 不回归。"""
    def boom():
        raise RuntimeError("playwright is not installed. Run: uv add playwright")
    out = bt._run_in_browser_thread(boom)
    assert out.startswith("ERROR: playwright is not installed")


def test_op_timeout_resets_and_reports(cancel_flag, monkeypatch):
    """总超时路径: 返回超时 ERROR 并 reset 浏览器（防池线程永久占用）。"""
    cancel_flag["stop"] = False
    monkeypatch.setattr(bt, "_OP_TIMEOUT_S", 0.3)
    started = threading.Event()
    release = threading.Event()
    resets = []

    def stuck():
        started.set()
        release.wait(10.0)
        return "late"

    monkeypatch.setattr(bt._STATE, "_reset", lambda: resets.append(1) or release.set())

    out = bt._run_in_browser_thread(stuck)
    assert out.startswith("ERROR: browser operation timed out")
    assert resets, "总超时也应 reset 解锁池线程"
