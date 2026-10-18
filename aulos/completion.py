"""REPL 补全: 纯逻辑候选生成, 不碰终端。

设计:
- AulosCompleter 只认行首的斜杠命令(对话正文不打扰);
  `/mode ` `/thinking ` 有二级候选, 其余命令(如 /rename <自由参数>)不补。
- prompt_toolkit 的 Completer 适配只做一层薄包装(在 run_repl 内),
  这里保持零第三方 import —— 单测与复用都不需要装它。
"""

from __future__ import annotations

from typing import Optional, Sequence

# 有二级参数补全的命令 → 取值函数名(AulosCompleter 构造时注入列表)
_SECOND_LEVEL_KEYS = ("mode", "thinking")


class AulosCompleter:
    """斜杠命令补全候选生成器。

    candidates(text, cursor) 返回当前光标处的候选文本列表
    (prompt_toolkit 的 get_completions 协议简化版: 直接给文本,
    由适配层包成 Completion 对象)。
    """

    def __init__(self,
                 commands: Sequence[str],
                 mode_names: Sequence[str],
                 thinking_levels: Sequence[str],
                 skill_names: Sequence[str] = (),
                 model_names: Sequence[str] = ()):
        self._commands = list(commands)
        self._skills = list(skill_names)
        self._second_level = {
            "mode": list(mode_names),
            "thinking": list(thinking_levels),
            "model": list(model_names),
        }

    def candidates(self, text: str, cursor: Optional[int] = None) -> list[str]:
        """text 为整行输入, cursor 为光标列(默认行尾)。

        只在光标位于行首斜杠命令段时给候选:
        - "/xxx": 命令 + 技能名
        - "/mode xxx" / "/thinking xxx": 对应取值
        其他情况(普通文本/命令后自由参数)一律空列表。
        """
        if cursor is None:
            cursor = len(text)
        head = text[:cursor]
        if not head.startswith("/"):
            return []
        body = head[1:]
        if " " not in body:
            # 一级: 命令/技能前缀过滤
            prefix = body
            pool = [f"/{c}" for c in self._commands]
            pool += [f"/{s}" for s in self._skills]
            return sorted(c for c in pool if c.startswith(f"/{prefix}"))
        # 二级: "/cmd " 后补参数取值(仅 mode/thinking; 其余命令无候选)
        first, _, rest = body.partition(" ")
        values = self._second_level.get(first)
        if values is None:
            return []
        rest = rest.strip()
        return sorted(v for v in values if v.startswith(rest))
