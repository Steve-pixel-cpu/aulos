"""shell 选择与启动检查的平台分支测试（monkeypatch 模拟 POSIX 环境）。

运行: uv run pytest tests/test_shell_platform.py -v
"""

import shutil

import pytest

import tools
from tools import bash_tool, git_bash_unavailable_reason


def _mock_posix(monkeypatch, system="Linux", bash=None, sh=None):
    """把平台伪装成 POSIX, 并接管 which 与真实执行（只捕获 argv）。"""
    monkeypatch.setattr(tools.platform, "system", lambda: system)

    def which(name):
        if name == "bash":
            return bash
        if name == "sh":
            return sh
        return None

    monkeypatch.setattr(tools.shutil, "which", which)
    return which


@pytest.fixture
def capture_argv(monkeypatch):
    captured = {}

    def fake_run(argv, cwd, timeout):
        captured["argv"] = argv
        return "ok"

    monkeypatch.setattr(tools, "_run_command", fake_run)
    return captured


# ------------------------------------------------------------
# bash_tool POSIX 分支: 有 bash 用 bash, dash 陷阱消除
# ------------------------------------------------------------

def test_posix_prefers_bash_over_sh(monkeypatch, capture_argv):
    """Ubuntu 的 sh 是 dash, bashism 会语法报错——必须优先 bash。"""
    _mock_posix(monkeypatch, bash="/usr/bin/bash", sh="/usr/bin/dash")

    bash_tool({"command": "echo hi"})

    assert capture_argv["argv"][0] == "/usr/bin/bash"
    assert capture_argv["argv"][1:3] == ["-lc", "echo hi"]


def test_posix_falls_back_to_sh_without_bash(monkeypatch, capture_argv):
    _mock_posix(monkeypatch, bash=None, sh="/bin/sh")

    bash_tool({"command": "echo hi"})

    assert capture_argv["argv"][0] == "/bin/sh"


def test_posix_never_uses_windows_git_bash_paths(monkeypatch, capture_argv):
    """bash.exe 形状的候选路径不允许泄漏进 POSIX argv。"""
    _mock_posix(monkeypatch, bash="/bin/bash", sh="/bin/sh")

    bash_tool({"command": "echo hi"})

    assert "bash.exe" not in capture_argv["argv"][0]


# ------------------------------------------------------------
# git_bash_unavailable_reason POSIX 分支: 查系统 shell, 不查 Git Bash
# ------------------------------------------------------------

def test_posix_reason_none_when_system_shell_exists(monkeypatch):
    _mock_posix(monkeypatch, system="Darwin", bash=None, sh="/bin/sh")
    assert git_bash_unavailable_reason() is None


def test_posix_reason_reported_when_no_shell(monkeypatch):
    _mock_posix(monkeypatch, system="Darwin", bash=None, sh=None)
    reason = git_bash_unavailable_reason()
    assert reason is not None and "bash/sh" in reason


def test_windows_path_still_requires_git_bash(monkeypatch):
    """Windows 行为不回归: 没装 Git Bash 仍给出安装指引。"""
    monkeypatch.setattr(tools.platform, "system", lambda: "Windows")
    monkeypatch.setattr(tools, "_git_bash", lambda: None)
    reason = git_bash_unavailable_reason()
    assert reason is not None and "Git Bash" in reason
