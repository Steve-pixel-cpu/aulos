"""终端渲染: 调色板 + 渐进式 Markdown 流式渲染器。

设计约束(与 main.py 原有视觉规范一致):
- ANSI 码只允许出现在 _paint 一处, 所有颜色经 c_xxx() 成对包裹/重置,
  任何异常路径都不可能把颜色泄漏到后续输出。
- 零依赖: 不引 rich/prompt_toolkit, 手写行级渲染。
- 流式安全: 按行缓冲, 换行才渲染整行, 避免半行 `**` 闪烁;
  未闭合标记当原样文本输出(降级), 绝不吞内容。

视觉语言向 Claude Code 看齐: 正文渲染 markdown(粗体/列表/代码块),
克制配色 —— 正文默认色、代码/提示 dim 灰、工具/提示符青色。
"""

from __future__ import annotations

import re

# --- 调色板 (单一来源; main.py 从这里 import) ---
ANSI_RESET = "\033[0m"
_ANSI_BOLD = "\033[1m"
_ANSI_DIM = "\033[2m"
_ANSI_ITALIC = "\033[3m"
_ANSI_RED = "\033[31m"
_ANSI_YELLOW = "\033[33m"
_ANSI_CYAN = "\033[36m"


def _paint(code: str, text: str) -> str:
    """成对包裹: code + text + reset。颜色只在这一处拼接。"""
    return f"{code}{text}{ANSI_RESET}" if text else text


def c_dim(s: str) -> str:
    """暗灰: 工具结果预览 / 分隔线 / 代码块。"""
    return _paint(_ANSI_DIM, s)


def c_red(s: str) -> str:
    """红色: 错误信息（配 ✗ 前缀）。"""
    return _paint(_ANSI_RED, s)


def c_yellow(s: str) -> str:
    """黄色: 权限询问。"""
    return _paint(_ANSI_YELLOW, s)


def c_cyan(s: str) -> str:
    """青色: 工具调用提示 / 提示符。"""
    return _paint(_ANSI_CYAN, s)


def c_bold(s: str) -> str:
    """粗体: 标题 / 强调。"""
    return _paint(_ANSI_BOLD, s)


# --- 行内标记 ---

# 代码 span 先替换为占位符, 避免 span 内的 ** 等被当作标记二次处理
_CODE_SPAN = re.compile(r"`([^`\n]+)`")
_LINK = re.compile(r"\[([^\]\n]*)\]\([^)\n]*\)")          # [文本](链接) → 文本
_BOLD = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*")
_ITALIC = re.compile(r"(?<!\*)\*(?=[^\s*])((?:[^*\n]|\*\*)*?)(?<=[^\s*])\*(?!\*)")

_PH = "\x00"          # 代码占位前缀(内容里不会出现)


def strip_ansi(s: str) -> str:
    """剥掉全部 SGR 转义码(测试与降级复位用)。"""
    return re.sub(r"\033\[[0-9;]*m", "", s)


def render_inline(text: str) -> str:
    """行内标记 → ANSI。不闭合/空匹配一律原样保留。

    顺序: 先摘 code span(占位保护) → 链接剥 URL → 粗体 → 斜体 → 归还 span。
    """
    stash: list[str] = []

    def _stash_code(m: "re.Match[str]") -> str:
        stash.append(c_yellow(m.group(1)))
        return f"{_PH}{len(stash) - 1}{_PH}"

    def _restore(m: "re.Match[str]") -> str:
        idx = int(m.group(1))
        return stash[idx] if 0 <= idx < len(stash) else m.group(0)

    text = _CODE_SPAN.sub(_stash_code, text)
    text = _LINK.sub(r"\1", text)
    text = _BOLD.sub(lambda m: _paint(_ANSI_BOLD, m.group(1)), text)
    text = _ITALIC.sub(lambda m: _paint(_ANSI_ITALIC, m.group(1)), text)
    return re.sub(rf"{_PH}(\d+){_PH}", _restore, text)


# --- 块级结构 ---

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_ORDERED = re.compile(r"^(\s*)(\d{1,3})[.)]\s+(.*)$")
_QUOTE = re.compile(r"^(\s*)>\s?(.*)$")
_HR = re.compile(r"^\s*([-*_])\s*(?:\1\s*){2,}$")
_FENCE_OPEN = re.compile(r"^(\s*)```")

CODE_PREFIX = "│ "        # 代码块/引用行左侧竖线
BULLET = "•"


def render_code_line(line: str) -> str:
    """代码块内一行: dim + 左竖线, 内容原样不碰。"""
    return c_dim(f"{CODE_PREFIX}{line}")


def render_markdown_line(line: str) -> str:
    """单行 markdown → ANSI 渲染行(无状态, 不带换行)。

    调用方负责代码围栏状态; 该函数只看单行。
    """
    line = line.rstrip("\n")
    if not line.strip():
        return ""
    if _HR.match(line):
        return c_dim("─" * 40)
    m = _HEADING.match(line)
    if m:
        return c_bold(render_inline(m.group(2).strip()))
    m = _FENCE_OPEN.match(line)
    if m:                      # 围栏开/闭行本身: 不输出(内容行自带竖线)
        return ""
    m = _BULLET.match(line)
    if m:
        indent, body = m.group(1), m.group(2)
        return f"{indent}  {BULLET} {render_inline(body)}"
    m = _ORDERED.match(line)
    if m:
        indent, num, body = m.groups()
        return f"{indent}  {num}. {render_inline(body)}"
    m = _QUOTE.match(line)
    if m:
        return c_dim(f"{CODE_PREFIX}{render_inline(m.group(2))}")
    return render_inline(line)


class MarkdownStreamPrinter:
    """流式 markdown 打印器: feed(delta) 任意切块, 按行渲染。

    emit: 输出回调(默认 print 的等价物)。渲染结果同时存 self.lines
    供测试断言。flush() 兜底吐出未换行的尾巴(围栏未闭合也吐内容)。
    """

    def __init__(self, emit=None):
        self._buf = ""
        self._in_code = False
        self._emit = emit if emit is not None else _default_emit
        self.lines: list[str] = []

    def feed(self, delta: str) -> None:
        self._buf += delta
        # \r\n 归一为 \n, 防 Windows 流把回车当内容
        self._buf = self._buf.replace("\r\n", "\n")
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self._print_line(line)

    def flush(self) -> None:
        if self._buf:
            self._print_line(self._buf)
            self._buf = ""

    def _print_line(self, line: str) -> None:
        if self._in_code:
            if _FENCE_OPEN.match(line):      # 围栏闭合
                self._in_code = False
                return
            out = render_code_line(line)
        else:
            if _FENCE_OPEN.match(line):      # 围栏开启; 语言标注不输出
                self._in_code = True
                return
            out = render_markdown_line(line)
        if out:
            self.lines.append(out)
            self._emit(out)


def _default_emit(s: str) -> None:
    print(s)
