"""主上下文瘦身四件套测试: 工具结果行预算+落盘、同文件重读去重、
贴图降采样、subagent 委派引导。

运行方式（在 aulos 目录下）:
    uv run pytest tests/test_context_slimming.py -v
"""

import base64
import io
import json

import pytest

from api_client import MessageStopEvent, ToolUseEvent, UsageInfo
from config import ConfigError, ConfigLoader, RuntimeFeatureConfig, RuntimeConfig
import imaging
import tools
from tools import ToolRegistry, read_tool, truncate_tool_output
from main import build_runtime
from models import Message, Session
from permissions import ALLOW_MODE, PermissionPolicy
from prompt import SystemPromptBuilder
from runtime import ConversationRuntime, TURN_CONVERGENCE_NUDGE_NOTICE


# ------------------------------------------------------------
# 测试替身
# ------------------------------------------------------------

def make_events(text: str, out_tokens: int = 10) -> list:
    return [
        __import__("api_client").TextDeltaEvent(text=text),
        MessageStopEvent(usage=UsageInfo(input_tokens=1_000, output_tokens=out_tokens)),
    ]


def read_file_events(path: str, **extra) -> list:
    """带 read_file 工具调用的事件流。"""
    payload = json.dumps({"path": path, **extra})
    return [
        ToolUseEvent(id="t1", name="read_file", input=payload),
        MessageStopEvent(usage=UsageInfo(input_tokens=1_000, output_tokens=10)),
    ]


class ScriptedClient:
    def __init__(self, script: list):
        self.script = list(script)
        self.calls = 0
        self.thinking_level = "medium"

    def stream(self, system_prompt, messages, thinking_level=None, *,
               model=None, include_tools=True, emit_output=None,
               on_event=None) -> list:
        if not include_tools or emit_output is not None:
            raise TypeError("side-calls unsupported")
        events = self.script[self.calls] if self.calls < len(self.script) else self.script[-1]
        self.calls += 1
        return events


class RealToolExecutor:
    """真工具注册表 + 固定 workdir（CLI 语义）。"""

    def __init__(self, registry: ToolRegistry, workdir):
        self.registry = registry
        self.workdir = str(workdir)

    def execute(self, tool_name, input, tool_use_id=None) -> str:
        return self.registry.execute(tool_name, input, workdir=self.workdir)


def make_registry() -> ToolRegistry:
    reg = ToolRegistry()
    reg.register("read_file", read_tool)
    return reg


def make_runtime(client, workdir, **budgets) -> ConversationRuntime:
    runtime = ConversationRuntime(
        session=Session(),
        api_client=client,
        tool_executor=RealToolExecutor(make_registry(), workdir),
        permission_policy=PermissionPolicy(active_mode=ALLOW_MODE),
        system_prompt=["你是助手"],
    )
    for name, value in budgets.items():
        getattr(runtime, f"with_{name}")(value)
    return runtime


# ------------------------------------------------------------
# 改动 1: 行预算 + 超限落盘
# ------------------------------------------------------------

def test_read_file_budget_spills_and_keeps_40_lines(tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "TOOL_OUTPUTS_DIR", tmp_path / "tool-outputs")
    monkeypatch.setattr(tools, "TOOL_RESULT_CHAR_LIMIT", 2_000)
    content = "\n".join(f"line{i:03d} " + "x" * 40 for i in range(100))

    result = truncate_tool_output(content, "read_file")

    lines = result.splitlines()
    # 前 40 行原文 + 一行落盘标记
    assert lines[:40] == content.splitlines()[:40]
    assert len(lines) == 41
    marker = lines[-1]
    assert "truncated, " in marker and "chars total" in marker
    # 全文落盘且内容完整
    import re
    spill = re.search(r"Full output saved to `([^`]+)`", marker).group(1)
    assert tools.resumable_spill_path(marker) == spill   # microcompact 可找回
    assert open(spill, encoding="utf-8").read() == content


def test_pathological_single_line_shrinks_whole_lines(tmp_path, monkeypatch):
    # 压缩混淆的单行大文件: 整行粒度收缩, 至少留 1 行, 不留半行
    monkeypatch.setattr(tools, "TOOL_OUTPUTS_DIR", tmp_path / "tool-outputs")
    monkeypatch.setattr(tools, "TOOL_RESULT_CHAR_LIMIT", 500)
    content = "var a=1;" + "x" * 4999

    result = truncate_tool_output(content, "read_file")

    body, _, _ = result.partition("\n[truncated")
    assert body.startswith("var a=1;")
    assert len(body) <= 500
    assert "chars total" in result


def test_grep_line_cap_50(tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "TOOL_OUTPUTS_DIR", tmp_path / "tool-outputs")
    monkeypatch.setattr(tools, "TOOL_RESULT_CHAR_LIMIT", 10**9)   # 只触发条数档
    content = "\n".join(f"match {i}" for i in range(60))

    result = truncate_tool_output(content, "grep")

    lines = result.splitlines()
    assert lines[:50] == content.splitlines()[:50]
    assert "truncated" in lines[-1]
    assert "match 59" not in result


def test_under_limit_output_untouched():
    content = "short\noutput"
    assert truncate_tool_output(content, "read_file") == content
    assert truncate_tool_output(content, "grep") == content


def test_registry_executes_read_file_through_budget(tmp_path, monkeypatch):
    # 端到端: registry.execute 是唯一漏斗, 真文件读走行预算
    monkeypatch.setattr(tools, "TOOL_OUTPUTS_DIR", tmp_path / "tool-outputs")
    monkeypatch.setattr(tools, "TOOL_RESULT_CHAR_LIMIT", 300)
    big = tmp_path / "big.txt"
    big.write_text("\n".join(f"L{i}" + "y" * 60 for i in range(80)),
                   encoding="utf-8")

    reg = make_registry()
    result = reg.execute("read_file", json.dumps({"path": str(big)}),
                         workdir=str(tmp_path))

    assert "truncated" in result
    assert result.splitlines()[0].startswith("L0")
    # 标记里的落盘文件可读回全文
    import re
    spill = re.search(r"Full output saved to `([^`]+)`", result).group(1)
    assert open(spill, encoding="utf-8").read() == big.read_text(encoding="utf-8")


# ------------------------------------------------------------
# 改动 2: 同文件重读去重
# ------------------------------------------------------------

def test_second_whole_read_returns_unchanged_marker(tmp_path):
    f = tmp_path / "code.py"
    f.write_text("\n".join(f"line {i}" for i in range(30)), encoding="utf-8")
    client = ScriptedClient([
        read_file_events(str(f)),
        read_file_events(str(f)),
        make_events("done"),
    ])
    runtime = make_runtime(client, tmp_path)

    runtime.run_turn("看下这个文件")

    tool_msgs = [m for m in runtime.session().messages if m.role == "tool"]
    assert len(tool_msgs) == 2
    first, second = tool_msgs[0].content[0].output, tool_msgs[1].content[0].output
    assert "line 0" in first and "line 29" in first          # 首读全文
    assert "unchanged since last read" in second             # 重读一行话
    assert "30 lines total" in second
    assert "line 5" not in second                            # 不再带正文


def test_readd_after_external_change_returns_full(tmp_path):
    f = tmp_path / "code.py"
    f.write_text("v1\n", encoding="utf-8")
    client = ScriptedClient([
        read_file_events(str(f)),
        read_file_events(str(f)),
        make_events("mid"),
    ])

    runtime = make_runtime(client, tmp_path)
    runtime.run_turn("第一遍")
    f.write_text("v2 — 文件被外部改动了\n" * 5, encoding="utf-8")
    client.script = [read_file_events(str(f)), make_events("done")]
    client.calls = 0
    runtime.run_turn("再看一遍")

    tool_msgs = [m for m in runtime.session().messages if m.role == "tool"]
    last = tool_msgs[-1].content[0].output
    assert "unchanged" not in last
    assert "v2" in last


def test_offset_and_force_bypass_dedup(tmp_path):
    f = tmp_path / "code.py"
    f.write_text("\n".join(f"line {i}" for i in range(30)), encoding="utf-8")
    client = ScriptedClient([
        read_file_events(str(f)),
        read_file_events(str(f), offset=2),
        read_file_events(str(f), force=True),
        make_events("done"),
    ])
    runtime = make_runtime(client, tmp_path)

    runtime.run_turn("带参数读")

    tool_msgs = [m for m in runtime.session().messages if m.role == "tool"]
    # offset=2: 分页读, 绕过去重给真内容
    assert "lines 2-" in tool_msgs[1].content[0].output
    assert "unchanged" not in tool_msgs[1].content[0].output
    # force=true: 强制重读给全文
    assert "unchanged" not in tool_msgs[2].content[0].output
    assert "line 29" in tool_msgs[2].content[0].output


def test_dedup_disabled_keeps_full_content(tmp_path):
    f = tmp_path / "code.py"
    f.write_text("hello\n", encoding="utf-8")
    client = ScriptedClient([
        read_file_events(str(f)),
        read_file_events(str(f)),
        make_events("done"),
    ])
    runtime = make_runtime(client, tmp_path, reread_dedup=False)

    runtime.run_turn("hi")

    tool_msgs = [m for m in runtime.session().messages if m.role == "tool"]
    assert "unchanged" not in tool_msgs[1].content[0].output
    assert "hello" in tool_msgs[1].content[0].output


# ------------------------------------------------------------
# 改动 3: 贴图降采样 + 原图落盘
# ------------------------------------------------------------

def _png_bytes(w: int, h: int, color=(120, 90, 200)) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


def test_oversized_image_downsampled_and_original_spilled(tmp_path, monkeypatch):
    monkeypatch.setattr(imaging, "IMAGES_DIR", tmp_path / "images")
    raw = _png_bytes(2400, 1800)          # 单边 > 1568
    att = {"kind": "image", "media_type": "image/png",
           "data": base64.b64encode(raw).decode("ascii")}

    out = imaging.slim_image_attachments([att])

    assert out[0] is not att
    from PIL import Image
    img = Image.open(io.BytesIO(base64.b64decode(out[0]["data"])))
    assert max(img.size) <= 1568
    assert out[0]["media_type"] in ("image/png", "image/jpeg")
    # 原图落盘
    spilled = list((tmp_path / "images").iterdir())
    assert len(spilled) == 1
    assert spilled[0].read_bytes() == raw


def test_small_image_untouched(tmp_path, monkeypatch):
    monkeypatch.setattr(imaging, "IMAGES_DIR", tmp_path / "images")
    raw = _png_bytes(400, 300)
    att = {"kind": "image", "media_type": "image/png",
           "data": base64.b64encode(raw).decode("ascii")}

    out = imaging.slim_image_attachments([att])

    assert out[0] is att                            # 原对象原样返回
    assert not (tmp_path / "images").exists()       # 没有超限项, 不落盘


def test_huge_pixels_force_jpeg_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(imaging, "IMAGES_DIR", tmp_path / "images")
    monkeypatch.setattr(imaging, "MAX_BYTES", 2_000)   # 逼进 JPEG 档
    raw = _png_bytes(2000, 1200, color=(10, 20, 30))
    att = {"kind": "image", "media_type": "image/png",
           "data": base64.b64encode(raw).decode("ascii")}

    out = imaging.slim_image_attachments([att])

    assert out[0]["media_type"] == "image/jpeg"


def test_oversized_image_slipped_through_run_turn(tmp_path, monkeypatch):
    # 端到端: 带超限贴图的用户消息入会话时已换成缩后版本
    monkeypatch.setattr(imaging, "IMAGES_DIR", tmp_path / "images")
    raw = _png_bytes(2400, 1800)
    client = ScriptedClient([make_events("ok")])
    runtime = make_runtime(client, tmp_path)
    att = {"kind": "image", "media_type": "image/png",
           "data": base64.b64encode(raw).decode("ascii")}

    runtime.run_turn("看这张图", attachments=[att])

    user_msg = runtime.session().messages[0]
    block = user_msg.content[1]
    from PIL import Image
    img = Image.open(io.BytesIO(base64.b64decode(block.source["data"])))
    assert max(img.size) <= 1568
    assert len(list((tmp_path / "images").iterdir())) == 1


# ------------------------------------------------------------
# 改动 4: subagent 委派引导
# ------------------------------------------------------------

def test_system_prompt_contains_delegation_rule():
    section = SystemPromptBuilder._subagents_section()
    assert "3 or more files" in section
    assert "5 or more search/read calls" in section
    assert "MUST be delegated" in section
    # 旧的抑制性表述不再出现
    assert "spawn workers only when" not in section


def test_convergence_nudge_mentions_subagent_sweep():
    assert "delegate one subagent sweep" in TURN_CONVERGENCE_NUDGE_NOTICE


# ------------------------------------------------------------
# 配置: toolResultCharLimit / rereadDedup
# ------------------------------------------------------------

def test_slim_config_defaults(tmp_path):
    cfg = ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()
    assert cfg.tool_result_char_limit() == 20_000
    assert cfg.reread_dedup() is True


def test_slim_config_json_and_env_override(tmp_path, monkeypatch):
    (tmp_path / "settings.json").write_text(json.dumps({
        "toolResultCharLimit": 8000, "rereadDedup": False,
    }), encoding="utf-8")
    cfg = ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()
    assert cfg.tool_result_char_limit() == 8000
    assert cfg.reread_dedup() is False

    monkeypatch.setenv("CLAUDE_TOOL_RESULT_CHAR_LIMIT", "4096")
    monkeypatch.setenv("CLAUDE_REREAD_DEDUP", "true")
    cfg = ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()
    assert cfg.tool_result_char_limit() == 4096
    assert cfg.reread_dedup() is True


def test_slim_config_rejects_bad_values(tmp_path):
    (tmp_path / "settings.json").write_text(
        json.dumps({"toolResultCharLimit": 0}), encoding="utf-8")
    with pytest.raises(ConfigError, match="toolResultCharLimit"):
        ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()
    (tmp_path / "settings.json").write_text(
        json.dumps({"rereadDedup": "yes"}), encoding="utf-8")
    with pytest.raises(ConfigError, match="rereadDedup"):
        ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()


def test_build_runtime_wires_slim_knobs():
    config = RuntimeConfig(feature_config=RuntimeFeatureConfig(
        reread_dedup=False, tool_result_char_limit=7777))

    runtime = build_runtime(
        session=Session(),
        api_client=ScriptedClient([]),
        registry=ToolRegistry(),
        system_prompt=[],
        hooks_config=config,
    )

    assert runtime._reread_dedup_enabled is False
