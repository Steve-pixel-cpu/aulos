#!/usr/bin/env python3
"""通用修复: 把"中文字符串行 尾随 t("xxx") 调用"的隐式拼接残余改为 + 拼接。"""
import re
import sys
from pathlib import Path

CJ = re.compile(r'[\u4e00-\u9fff]')

def fix(path: str) -> int:
    p = Path(path)
    src = p.read_text(encoding='utf-8')
    lines = src.split('\n')
    n = 0
    for i in range(len(lines) - 1):
        line, nxt = lines[i], lines[i + 1]
        # 当前行以中文字符串字面量结尾, 下一行是纯 t(...) 调用 → 中间补 +
        if CJ.search(line) and re.search(r'"[^"]*[\u4e00-\u9fff][^"]*"\s*$', line) \
                and re.match(r'^\s*t\("[a-z_.0-9]+"[^)]*\)\)?\s*$', nxt):
            lines[i] = line + ' +'
            n += 1
        # 下一行两个相邻 t() 调用(前一个缺 +): t("a"...)\n t("b"...) 的后行首补 +
        elif re.match(r'^\s*t\("[a-z_.0-9]+"[^)]*\)\)?$', line) \
                and re.match(r'^\s*t\("[a-z_.0-9]+"[^)]*\)\)?\s*$', nxt) \
                and not line.rstrip().endswith('+'):
            lines[i] = line + ' +'
            n += 1
    p.write_text('\n'.join(lines), encoding='utf-8', newline='')
    return n

for a in sys.argv[1:]:
    print(a, '->', fix(a), '处补 +')
