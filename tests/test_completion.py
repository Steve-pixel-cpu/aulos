"""AulosCompleter 补全逻辑单测: 纯逻辑, 不碰终端。"""
import pytest

from aulos.completion import AulosCompleter


@pytest.fixture
def completer() -> AulosCompleter:
    return AulosCompleter(
        commands=["help", "status", "compact", "mode", "thinking",
                  "rename", "skills", "memory", "exit"],
        mode_names=["prompt", "read-only", "danger-full-access"],
        thinking_levels=["low", "medium", "high", "max"],
        skill_names=["brainstorming", "writing-skills"],
    )


def candidates(c: AulosCompleter, text: str) -> list[str]:
    """取行尾光标处的补全候选(真实交互里光标总在行尾)。"""
    return c.candidates(text, len(text))


class TestSlashCommands:
    def test_slash_lists_all_commands_and_skills(self, completer):
        cands = candidates(completer, "/")
        for name in ("help", "status", "exit", "brainstorming", "writing-skills"):
            assert f"/{name}" in cands

    def test_prefix_filter(self, completer):
        cands = candidates(completer, "/st")
        assert "/status" in cands
        assert "/help" not in cands
        assert "/skills" not in cands

    def test_exact_match_still_offers(self, completer):
        # 完整命令名也保留在候选里(如 /mode + 空格前按 Tab 可看到完整名)
        assert "/mode" in candidates(completer, "/mod")

    def test_unknown_prefix_no_candidates(self, completer):
        assert candidates(completer, "/zzz") == []

    def test_plain_text_no_candidates(self, completer):
        # 普通对话文本不打扰: 一个候选都不给
        assert candidates(completer, "你知道科比吗") == []
        assert candidates(completer, "help me") == []


class TestSecondLevel:
    def test_mode_completes_names(self, completer):
        cands = candidates(completer, "/mode ")
        assert "prompt" in cands
        assert "read-only" in cands

    def test_mode_prefix(self, completer):
        cands = candidates(completer, "/mode re")
        assert "read-only" in cands
        assert "prompt" not in cands

    def test_thinking_completes_levels(self, completer):
        assert "medium" in candidates(completer, "/thinking me")

    def test_command_with_argument_is_not_second_level(self, completer):
        # /rename <名字> 这类自由参数: 不给二级候选, 也不给命令列表
        assert candidates(completer, "/rename 新名字") == []

    def test_slash_after_space_not_completed(self, completer):
        # "文字 /mo" —— 对话中提到的斜杠词不补全(只在行首生效)
        assert candidates(completer, "你知道 /mo") == []


class TestEdge:
    def test_empty_skill_list_ok(self):
        c = AulosCompleter(commands=["help"], mode_names=[], thinking_levels=[])
        assert "/help" in candidates(c, "/")

    def test_partial_slash(self, completer):
        # 只敲了 "/" 没有更多字符: 全部候选
        assert len(candidates(completer, "/")) >= 10

    def test_case_sensitive(self, completer):
        assert candidates(completer, "/MODE") == []
