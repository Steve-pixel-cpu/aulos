"""MarkdownStreamPrinter 渲染器单测。

断言用 strip_ansi() 剥色后比对纯文本, 颜色只断言关键片段存在与否
(渲染器保证成对 reset, 泄漏检查交给 strip 后无 \033 残留)。
"""
import pytest

from aulos.render import (
    ANSI_RESET,
    MarkdownStreamPrinter,
    strip_ansi,
    render_markdown_line,
)


def make_printer() -> tuple[MarkdownStreamPrinter, list[str]]:
    lines: list[str] = []

    def emit(s: str) -> None:
        lines.append(s)

    return MarkdownStreamPrinter(emit), lines


def feed_all(p: MarkdownStreamPrinter, text: str) -> list[str]:
    """按任意切块流式喂入(切块边界不落在标记中间也必须正确)。"""
    for i in range(0, len(text), 7):
        p.feed(text[i : i + 7])
    p.flush()
    return p.lines


class TestInline:
    def test_bold(self):
        p, lines = make_printer()
        feed_all(p, "知道**科比·布莱恩特**吗\n")
        assert len(lines) == 1
        assert "\033[1m科比·布莱恩特\033[0m" in lines[0]
        assert strip_ansi(lines[0]) == "知道科比·布莱恩特吗"

    def test_italic(self):
        p, lines = make_printer()
        feed_all(p, "这是*斜体*字\n")
        assert strip_ansi(lines[0]) == "这是斜体字"

    def test_inline_code(self):
        p, lines = make_printer()
        feed_all(p, "运行 `pip install` 即可\n")
        assert strip_ansi(lines[0]) == "运行 pip install 即可"

    def test_unclosed_markers_pass_through(self):
        p, lines = make_printer()
        feed_all(p, "2**3 等于 8\n")
        assert strip_ansi(lines[0]) == "2**3 等于 8"
        assert "\033[1m" not in lines[0]

    def test_asterisk_pair_not_bold(self):
        # 5 * 3 * 2 这种算术不是强调
        p, lines = make_printer()
        feed_all(p, "5 * 3 * 2 = 30\n")
        assert strip_ansi(lines[0]) == "5 * 3 * 2 = 30"

    def test_link_keeps_text_only(self):
        p, lines = make_printer()
        feed_all(p, "见[文档](https://example.com)说明\n")
        assert strip_ansi(lines[0]) == "见文档说明"
        assert "https" not in lines[0]

    def test_bold_in_list_item(self):
        p, lines = make_printer()
        feed_all(p, "- **5 个总冠军** (2000-2002)\n")
        assert strip_ansi(lines[0]) == "  • 5 个总冠军 (2000-2002)"


class TestBlocks:
    def test_heading(self):
        p, lines = make_printer()
        feed_all(p, "## 标题行\n")
        assert "\033[1m" in lines[0]
        assert strip_ansi(lines[0]) == "标题行"

    def test_bullet_list_variants(self):
        p, lines = make_printer()
        feed_all(p, "- 甲\n* 乙\n+ 丙\n正文\n")
        assert strip_ansi(lines[0]) == "  • 甲"
        assert strip_ansi(lines[1]) == "  • 乙"
        assert strip_ansi(lines[2]) == "  • 丙"
        assert strip_ansi(lines[3]) == "正文"

    def test_numbered_list(self):
        p, lines = make_printer()
        feed_all(p, "1. 第一步\n2. 第二步\n")
        assert strip_ansi(lines[0]) == "  1. 第一步"
        assert strip_ansi(lines[1]) == "  2. 第二步"

    def test_code_fence(self):
        p, lines = make_printer()
        feed_all(p, "前文\n```python\nprint('hi')\n```\n后文\n")
        assert strip_ansi(lines[0]) == "前文"
        assert "print" in lines[1]
        assert "│" in lines[1]          # 左侧竖线标记
        assert strip_ansi(lines[1]) == "│ print('hi')"
        assert strip_ansi(lines[2]) == "后文"
        # 围栏整块 dim
        assert "\033[2m" in lines[1]

    def test_code_fence_flush_unclosed(self):
        # 流结束时围栏未闭合: 内容也要吐出来, 不能吞掉
        p, lines = make_printer()
        feed_all(p, "```\ntar -xzf a.tar.gz\n")
        assert any("tar -xzf" in ln for ln in lines)

    def test_nested_list_indent(self):
        p, lines = make_printer()
        feed_all(p, "  - 缩进项\n")
        assert strip_ansi(lines[0]) == "    • 缩进项"

    def test_blockquote(self):
        p, lines = make_printer()
        feed_all(p, "> 引用内容\n")
        assert strip_ansi(lines[0]) == "│ 引用内容"

    def test_hr(self):
        p, lines = make_printer()
        feed_all(p, "上文\n---\n下文\n")
        assert "─" in lines[1]


class TestStreamingBehavior:
    def test_chunk_split_mid_marker(self):
        # 切块正好落在 ** 中间: 行完成后渲染仍必须正确
        p, lines = make_printer()
        p.feed("abc **bo")
        p.feed("ld** def\n")
        p.flush()
        assert strip_ansi(lines[0]) == "abc bold def"

    def test_flush_incomplete_line(self):
        p, lines = make_printer()
        p.feed("没有换行的结尾")
        p.flush()
        assert len(lines) == 1
        assert strip_ansi(lines[0]) == "没有换行的结尾"

    def test_empty_input(self):
        p, lines = make_printer()
        p.flush()
        assert lines == []

    def test_crlf_handled(self):
        p, lines = make_printer()
        p.feed("行一\r\n行二\n")
        p.flush()
        assert [strip_ansi(x) for x in lines] == ["行一", "行二"]

    def test_plain_text_no_markup(self):
        p, lines = make_printer()
        feed_all(p, "你好, 世界\n")
        assert strip_ansi(lines[0]) == "你好, 世界"
        assert "\033[" not in strip_ansi(lines[0])


class TestHelpers:
    def test_strip_ansi(self):
        assert strip_ansi(f"\033[1mx{ANSI_RESET}") == "x"

    def test_render_markdown_line_is_pure(self):
        # 单行渲染函数: 无状态, 不换行
        out = render_markdown_line("**a** b")
        assert out == "\033[1ma\033[0m b"

    def test_reset_balance(self):
        p, lines = make_printer()
        feed_all(p, "**a** `b` *c* [d](u) # e\n- f\n> g\n```\nh\n```\n")
        for ln in lines:
            # 粗体 reset 用全局 RESET, 数量守恒: 每个 SGR 开码对应一个 reset
            opens = ln.count("\033[1m") + ln.count("\033[3m")
            resets = ln.count(ANSI_RESET)
            assert opens <= resets, f"reset 泄漏: {ln!r}"
