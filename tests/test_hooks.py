"""生命周期 hook（turn_start / turn_end / subagent_done）的规格钉子。

契约:
- settings.json `hooks.TurnStart/TurnEnd/SubagentDone` 声明命令列表;
- 命令经 `sh -lc` 执行, stdin 收 JSON 载荷（hook_event_name + 事件字段）,
  环境变量 HOOK_EVENT 可读;
- exit 0/2/其他 = allow/deny/warn——但生命周期事件是通知性质, DENY 不
  阻断任何东西, stdout 全部作为 messages 收集（由调用方决定附加或记日志）;
- hook 列表为空 → 零开销短路, 不起进程。

运行: python -m pytest tests/test_hooks.py -v
"""
import json

import pytest

from aulos.config import ConfigLoader
from aulos.hooks import HookEvent, HookOutcome, HookRunner


# ------------------------------------------------------------
# 配置解析: settings.json 声明 → RuntimeFeatureConfig 字段
# ------------------------------------------------------------

def _load(tmp_path, settings: dict):
    (tmp_path / "settings.json").write_text(
        json.dumps(settings), encoding="utf-8")
    return ConfigLoader(cwd=tmp_path, config_home=tmp_path).load()


def test_settings_hooks_lifecycle_lists_parse(tmp_path):
    cfg = _load(tmp_path, {"hooks": {
        "TurnStart": ["echo start"],
        "TurnEnd": ["echo end"],
        "SubagentDone": ["echo done"],
    }})
    assert cfg.hooks_turn_start() == ["echo start"]
    assert cfg.hooks_turn_end() == ["echo end"]
    assert cfg.hooks_subagent_done() == ["echo done"]


def test_settings_hooks_lifecycle_default_empty(tmp_path):
    cfg = _load(tmp_path, {})
    assert cfg.hooks_turn_start() == []
    assert cfg.hooks_turn_end() == []
    assert cfg.hooks_subagent_done() == []


def test_settings_hooks_lifecycle_type_error(tmp_path):
    with pytest.raises(Exception, match="must be arrays"):
        _load(tmp_path, {"hooks": {"TurnStart": "not-a-list"}})


def test_from_config_wires_lifecycle_lists(tmp_path):
    cfg = _load(tmp_path, {"hooks": {
        "TurnStart": ["a"], "TurnEnd": ["b"], "SubagentDone": ["c"]}})
    runner = HookRunner.from_config(cfg)
    assert runner.turn_start == ["a"]
    assert runner.turn_end == ["b"]
    assert runner.subagent_done == ["c"]


# ------------------------------------------------------------
# 执行契约: stdin 载荷 / 环境变量 / 退出码语义 / 空列表短路
# ------------------------------------------------------------

def test_turn_end_payload_via_stdin(tmp_path):
    """TurnEnd hook 收到 JSON 载荷: hook_event_name + summary。"""
    payload_path = tmp_path / "payload.json"
    script = f"cat > '{payload_path.as_posix()}'"
    runner = HookRunner(turn_end=[script])
    res = runner.run_turn_end("回合结论摘要")
    assert res.denied is False            # 通知性质: DENY 不存在
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    assert payload["hook_event_name"] == "turn_end"
    assert payload["summary"] == "回合结论摘要"


def test_subagent_done_payload_fields(tmp_path):
    """SubagentDone 载荷带 agent_id 与 subagent_type。"""
    seen = {}
    script = ("python -c \"import sys,json;"
              "d=json.load(sys.stdin);"
              "open(r'%s','w').write(json.dumps(d))\"" % (tmp_path / "p.json"))
    runner = HookRunner(subagent_done=[script])
    res = runner.run_subagent_done("abc123", "explore")
    assert res.denied is False
    data = json.loads((tmp_path / "p.json").read_text(encoding="utf-8"))
    seen.update(data)
    assert seen["hook_event_name"] == "subagent_done"
    assert seen["agent_id"] == "abc123"
    assert seen["subagent_type"] == "explore"


def test_lifecycle_empty_list_short_circuits():
    """空列表零开销: 不起进程直接返回 allow。"""
    runner = HookRunner()
    assert runner.run_turn_start().messages == []
    assert runner.run_turn_end("s").messages == []
    assert runner.run_subagent_done("id", "explore").messages == []


def test_lifecycle_nonzero_exit_collects_warning(tmp_path):
    """exit 1（warn）: stdout 收进 messages, 不阻断、不置 denied。"""
    runner = HookRunner(turn_start=["echo 注入的提醒; exit 1"])
    res = runner.run_turn_start()
    assert res.denied is False
    assert any("注入的提醒" in m for m in res.messages)


def test_lifecycle_deny_degrades_to_note():
    """exit 2（deny 语义）: 生命周期事件下退化为通知, 不置 denied。"""
    runner = HookRunner(turn_start=["echo 你被拒绝了; exit 2"])
    res = runner.run_turn_start()
    assert res.denied is False
    assert any("你被拒绝了" in m for m in res.messages)


def test_turn_start_env_event_name(tmp_path):
    """环境变量 HOOK_EVENT 可读（与工具 hook 同约定）。用 python 写文件
    避免 shell 重定向/变量的平台差异（Git Bash vs cmd）。"""
    out = tmp_path / "env.txt"
    script = (f"python -c \"import os;"
              f"open(r'{out}', 'w').write(os.environ.get('HOOK_EVENT',''))\"")
    runner = HookRunner(turn_start=[script])
    runner.run_turn_start()
    assert "turn_start" in out.read_text(encoding="utf-8")


def _is_windows() -> bool:
    import os
    return os.name == "nt"
