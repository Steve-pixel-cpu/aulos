#!/usr/bin/env python3
"""第 4 期全局清查: JS/HTML/Python 用户可见中文残留扫描（zh 字典与注释/日志除外）。"""
import re
from pathlib import Path

CJ = re.compile(r'[\u4e00-\u9fff]')

report = []

for f in sorted(Path('static').glob('*.js')):
    if f.parent.name == 'i18n':
        continue
    n = 0
    for line in f.read_text(encoding='utf-8').split('\n'):
        t = line.strip()
        if t.startswith('//') or t.startswith('*') or t.startswith('/*'):
            continue
        if not CJ.search(line):
            continue
        stripped = re.sub(r'"(?:\\.|[^"\\])*"', '""', line)
        stripped = re.sub(r"'(?:\\.|[^'\\])*'", "''", stripped)
        stripped = re.sub(r'`(?:\\.|[^`\\])*`', '``', stripped)
        if CJ.search(stripped):
            n += 1
    if n:
        report.append(f'{f.name}: {n} 行疑似残留(非字符串/注释中文)')

for f in sorted(Path('static').glob('*.html')):
    s = f.read_text(encoding='utf-8')
    s = re.sub(r'<!--[\s\S]*?-->', '', s)
    s = re.sub(r'<script[\s\S]*?</script>', '', s)
    s = re.sub(r'>[^<]*<', '><', s)          # 文本节点(含保留的原文)剔除
    for m in re.finditer(r'[a-z-]+="[^"]*"', s):
        if CJ.search(m.group(0)) and 'data-i18n' not in m.group(0):
            report.append(f'{f.name}: 属性残留 {m.group(0)[:60]}')
            break

for f in [Path('aulos/main.py'), Path('aulos/server.py'), *sorted(Path('aulos/web').glob('*.py'))]:
    if f.name in ('zh.py', 'en.py', '__init__.py'):
        continue
    src = f.read_text(encoding='utf-8')
    for i, line in enumerate(src.split('\n'), 1):
        t = line.strip()
        if t.startswith('#') or not CJ.search(line):
            continue
        stripped = re.sub(r'"(?:\\.|[^"\\])*"', '""', line)
        stripped = re.sub(r"'(?:\\.|[^'\\])*'", "''", stripped)
        if CJ.search(stripped):
            report.append(f'{f.name}:{i} 疑似残留')

print('\n'.join(report) if report else 'JS/HTML/Python 用户可见中文残留: 无(注释/日志/zh 字典除外)')
