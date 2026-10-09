"""长回合延迟治理三件套测试: 回合内思考自动降档、迭代软收束提示、
配置解析与 build_runtime 接线、每轮调用耗时日志。

运行方式（在 x-code 目录下）:
    uv run pytest tests/test_latency_governance.py -v
"""

import json

import pytest

from api_client import MessageStopEvent, TextDeltaEvent, ToolUseEvent, UsageInfo
from config import ConfigError, ConfigLoader, RuntimeConfig, RuntimeFeatureConfig
import call_log
from main import build_runtime
from models import Message, Session
from permissions import ALLOW_MODE, PermissionPolicy
from runtime import ConversationRuntime
from tools import ToolRegistry


@pytest.fixture(autouse=True)
def clean_latency_env(monkeypatch):
    for key in ("CLAUDE_THINKING_AUTO_DOWNSHIFT",
                "CLAUDE_DOWNSHIFT_AFTER_ITERATIONS",
                "CLAUDE_CONVERGENCE_NUDGE_AT"):
        monkeypatch.delenv(key, raising=False)


# ------------------------------------------------------------
# 测试替身（循 test_loop_budget.py 的 ScriptedClient, 加思考档位记录）
# ------------------------------------------------------------

def make_tool_events(out_tokens: int = 10) -> list:
    """带工具调用的事件流（ALLOW 模式放行, NoopExecutor 执行）。"""
    return [
        ToolUseEvent(id="t1", name="bash", input='{"command": "ls"}'),
        MessageStopEvent(usage=UsageInfo(input_tokens=1_000, output_tokens=out_tokens)),
    ]


def make_events(text: str, out_tokens: int = 10) -> list:
    return [
        TextDeltaEvent(text=text),
        MessageStopEvent(usage=UsageInfo(input_tokens=1_000, output_tokens=out_tokens)),
    ]


class ScriptedClient:
    """按剧本逐次返回事件流; 记录每次调用收到的思考档位。"""

    def __init__(self, script: list):
        self.script = list(script)
        self.calls = 0
        self.seen_thinking: list = []
        self.thinking_level = "medium"   # runtime 构建时读取（会话级等级初值）

    def stream(self, system_prompt, messages, thinking_level=None, *,
               model=None, include_tools=True, emit_output=None,
               on_event=None) -> list:
        if not include_tools or emit_output is not None:
            raise TypeError("side-calls unsupported")  # 锁定旧客户端语义: 摘要类 side-call 走不通
        self.seen_thinking.append(thinking_level)
        events = self.script[self.calls] if self.calls < len(self.script) else self.script[-1]
        self.calls += 1
        return events


class NoopExecutor:
    def execute(self, tool_name, input, tool_use_id=None) -> str:
        return ""


def make_runtime(client, **budgets) -> ConversationRuntime:
    runtime = ConversationRuntime(
        session=Session(),
        api_client=client,
        tool_executor=NoopExecutor(),
        permission_policy=PermissionPolicy(active_mode=ALLOW_MODE),
        system_prompt=["你是助手"],
    )
    for name, value in budgets.items():
        if name == "thinking_downshift":     # builder 收 (enabled, after) 两参
            runtime.with_thinking_downshift(*value)
        else:
            getattr(runtime, f"with_{name}")(value)
    return runtime


# ------------------------------------------------------------
# 思考自动降档 — 回合内每完成 N 轮降一档, 只改请求参数不改用户设置
# ------------------------------------------------------------

def test_thinking_downshifts_mid_turn():
    # after=5: 前 5 轮保持 medium, 第 6 轮起降到 low
    client = ScriptedClient([make_tool_events()] * 7)
    runtime = make_runtime(client, thinking_downshift=(True, 5), max_iterations=7)

    runtime.run_turn("hi")

    assert client.seen_thinking == ["medium"] * 5 + ["low"] * 2
    # 用户设置不被改写——新回合自动恢复
    assert runtime.thinking_level() == "medium"


def test_thinking_downshift_disabled_keeps_level():
    client = ScriptedClient([make_tool_events()] * 4)
    runtime = make_runtime(client, thinking_downshift=(False, 1), max_iterations=4)

    runtime.run_turn("hi")

    assert client.seen_thinking == ["medium"] * 4


def test_thinking_downshift_steps_from_max():
    client = ScriptedClient([make_tool_events()] * 4)
    runtime = make_runtime(client, thinking_downshift=(True, 1), max_iterations=4)
    runtime.set_thinking_level("max")

    runtime.run_turn("hi")

    # after=1: 每轮降一档 max→high→medium→low
    assert client.seen_thinking == ["max", "high", "medium", "low"]


# ------------------------------------------------------------
# 迭代软收束提示 — 达到阈值注入一次 [System note], 历史保持一致
# ------------------------------------------------------------

def test_convergence_nudge_fires_once():
    client = ScriptedClient([make_tool_events()] * 5)
    runtime = make_runtime(client, convergence_nudge=3, max_iterations=5)

    summary = runtime.run_turn("hi")

    assert summary.iterations_exhausted is True
    nudges = [m for m in runtime.session().messages
              if m.role == "user" and "tool rounds" in m.content[0].text]
    assert len(nudges) == 1
    assert "already run 3 tool rounds" in nudges[0].content[0].text
    # 落点: 第 3 对 (assistant, tool) 之后、第 4 次调用之前——历史一致点
    roles = [m.role for m in runtime.session().messages]
    assert roles == (["user"] + ["assistant", "tool"] * 3
                     + ["user"] + ["assistant", "tool"] * 2 + ["user"])


def test_convergence_nudge_zero_disables():
    client = ScriptedClient([make_tool_events()] * 3)
    runtime = make_runtime(client, convergence_nudge=0, max_iterations=3)

    runtime.run_turn("hi")

    nudges = [m for m in runtime.session().messages
              if m.role == "user" and "tool rounds" in m.content[0].text]
    assert nudges == []


# ------------------------------------------------------------
# 配置解析 — 三个新键的默认值 / JSON 覆盖 / env 覆盖 / 非法值
# ------------------------------------------------------------

def test_latency_config_defaults(tmp_path):
    cfg = ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()
    assert cfg.thinking_auto_downshift() is True
    assert cfg.downshift_after_iterations() == 20
    assert cfg.convergence_nudge_at() == 30


def test_latency_config_json_override(tmp_path):
    (tmp_path / "settings.json").write_text(json.dumps({
        "thinkingAutoDownshift": False,
        "downshiftAfterIterations": 15,
        "convergenceNudgeAt": 0,
    }), encoding="utf-8")

    cfg = ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()

    assert cfg.thinking_auto_downshift() is False
    assert cfg.downshift_after_iterations() == 15
    assert cfg.convergence_nudge_at() == 0


def test_latency_config_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_THINKING_AUTO_DOWNSHIFT", "false")
    monkeypatch.setenv("CLAUDE_DOWNSHIFT_AFTER_ITERATIONS", "10")
    monkeypatch.setenv("CLAUDE_CONVERGENCE_NUDGE_AT", "0")

    cfg = ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()

    assert cfg.thinking_auto_downshift() is False
    assert cfg.downshift_after_iterations() == 10
    assert cfg.convergence_nudge_at() == 0


def test_latency_config_rejects_bad_values(tmp_path):
    (tmp_path / "settings.json").write_text(
        json.dumps({"thinkingAutoDownshift": "yes"}), encoding="utf-8")
    with pytest.raises(ConfigError, match="thinkingAutoDownshift"):
        ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()

    (tmp_path / "settings.json").write_text(
        json.dumps({"convergenceNudgeAt": -1}), encoding="utf-8")
    with pytest.raises(ConfigError, match="convergenceNudgeAt"):
        ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()


# ------------------------------------------------------------
# build_runtime 接线 — 新配置不再是死配置
# ------------------------------------------------------------

def test_build_runtime_wires_latency_knobs():
    config = RuntimeConfig(feature_config=RuntimeFeatureConfig(
        thinking_auto_downshift=False,
        downshift_after_iterations=9,
        convergence_nudge_at=11,
    ))

    runtime = build_runtime(
        session=Session(),
        api_client=ScriptedClient([]),
        registry=ToolRegistry(),
        system_prompt=[],
        hooks_config=config,
    )

    assert runtime._thinking_downshift_enabled is False
    assert runtime._downshift_after == 9
    assert runtime._nudge_at == 11


# ------------------------------------------------------------
# 每轮调用耗时日志 — 一行 JSON, best-effort 不抛
# ------------------------------------------------------------

def test_call_log_writes_json_line(tmp_path, monkeypatch):
    monkeypatch.setattr(call_log, "LOG_DIR", tmp_path)
    from runtime import TokenUsage

    call_log.log_model_call(
        session="20261009-013553", iteration=3, thinking_level="medium",
        duration_s=12.3456,
        usage=TokenUsage(input_tokens=500, output_tokens=2_000,
                         cache_read_input_tokens=70_000,
                         cache_creation_input_tokens=30_000))

    files = list(tmp_path.glob("runtime-*.log"))
    assert len(files) == 1
    record = json.loads(files[0].read_text(encoding="utf-8").splitlines()[0])
    assert record["session"] == "20261009-013553"
    assert record["iter"] == 3
    assert record["thinking"] == "medium"
    assert record["duration_s"] == 12.346
    assert record["context_tokens"] == 100_500
    assert record["output_tokens"] == 2_000


def test_call_log_swallows_errors(tmp_path, monkeypatch):
    # LOG_DIR 指向一个普通文件 → mkdir/open 必败, 但绝不允许抛出
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x", encoding="utf-8")
    monkeypatch.setattr(call_log, "LOG_DIR", blocker)
    from runtime import TokenUsage

    call_log.log_model_call(
        session=None, iteration=1, thinking_level="low", duration_s=0.1,
        usage=TokenUsage(input_tokens=1, output_tokens=1))


def test_runtime_writes_call_log_per_iteration(tmp_path, monkeypatch):
    log_dir = tmp_path / "logs"
    monkeypatch.setattr(call_log, "LOG_DIR", log_dir)

    client = ScriptedClient([make_tool_events(), make_events("done")])
    runtime = make_runtime(client)
    runtime.set_log_tag("sess-1")

    runtime.run_turn("hi")

    lines = (log_dir / sorted(p.name for p in log_dir.iterdir())[0]).read_text(
        encoding="utf-8").splitlines()
    assert len(lines) == 2                          # 两次调用各一行
    records = [json.loads(line) for line in lines]
    assert [r["iter"] for r in records] == [1, 2]
    assert records[0]["session"] == "sess-1"
    assert records[0]["thinking"] == "medium"       # 未降档: 默认档位直通
