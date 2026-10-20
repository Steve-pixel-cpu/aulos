#!/usr/bin/env python3
"""修复残余 v2: 任意 't("...")\s*[fF]?".*"' 相邻(无运算符)的隐式拼接 → 中间插 +。
处理 t() 后跟字符串、字符串后跟 t()、t() 后跟 t() 的所有缩进变体。"""
import re
import sys
from pathlib import Path

def fix(path: str) -> int:
    p = Path(path)
    src = p.read_text(encoding='utf-8')
    # t("...")<newline><indent>STRING 或 f"..."  → 补 +
    pat1 = re.compile(r'(t\("[a-z_.0-9]+"[^)\n]*\))(\n\s+)(?=[fF]?["\'])')
    src, n1 = pat1.subn(r'\1 +\2', src)
    # STRING<newline><indent>t("...") → 补 +(字符串行尾)
    pat2 = re.compile(r'([fF]?"(?:\\.|[^"\\])*")(\n\s+)(?=t\("[a-z_.0-9]+")')
    src, n2 = pat2.subn(r'\1 +\2', src)
    # t("...")<newline><indent>t("...") → 补 +
    pat3 = re.compile(r'(t\("[a-z_.0-9]+"[^)\n]*\))(\n\s+)(?=t\(")')
    src, n3 = pat3.subn(r'\1 +\2', src)
    # 同行: t("...") "str" / t("...") f"..."
    pat4 = re.compile(r'(t\("[a-z_.0-9]+"[^)]*\)) (?=[fF]?["\'])')
    src, n4 = pat4.subn(r'\1 + ', src)
    p.write_text(src, encoding='utf-8', newline='')
    return n1 + n2 + n3 + n4

for a in sys.argv[1:]:
    print(a, '->', fix(a), '处')
