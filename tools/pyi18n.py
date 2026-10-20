#!/usr/bin/env python3
"""Python 后端 i18n 迁移工具 v2（第 3 期）。

tokenize 定位字符串; docstring(ast)与日志(print/logging)排除; 其余 CJK 串迁移。
f-string: f"...{expr!r:fmt}..." → t(key, {"p0": expr!r:fmt}); 模板里 {{ }} 还原为字面 { }。
"""
from __future__ import annotations
import ast
import io
import json
import re
import sys
import tokenize
from pathlib import Path

CJ = re.compile(r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]')
LBR, RBR = '\x00L\x00', '\x00R\x00'   # f-string 转义括号的中间态标记


def _is_log_line(line: str) -> bool:
    return bool(re.search(r'\b(print\s*\(|logging\.\w+|logger\.\w+|_log\w*\s*\()', line))


def _docstring_lines(src: str) -> set:
    lines = set()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return lines
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                    and isinstance(body[0].value.value, str):
                lines.update(range(body[0].lineno, body[0].end_lineno + 1))
    return lines


def _standalone_string_rows(src: str) -> set:
    """ast: 整个实参/右值就是单个字符串或 f-string 的行号集合。

    隐式拼接("a" "b" 跨行)中的中文段属于英文协议文本(prompt schema),
    永不迁移; 只有"独立字符串"才迁。"""
    rows = set()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return rows

    def mark(v):
        if isinstance(v, ast.Constant) and isinstance(v.value, str):
            rows.update(range(v.lineno, v.end_lineno + 1))
        elif isinstance(v, ast.JoinedStr):
            rows.update(range(v.lineno, v.end_lineno + 1))

    class V(ast.NodeVisitor):
        def visit_Call(self, node):
            for a in node.args:
                mark(a)
            for kw in node.keywords:
                mark(kw.value)
            self.generic_visit(node)

        def visit_Assign(self, node):
            mark(node.value)
            self.generic_visit(node)

        def visit_AnnAssign(self, node):
            if node.value:
                mark(node.value)
            self.generic_visit(node)

        def visit_Return(self, node):
            if node.value:
                mark(node.value)
            self.generic_visit(node)
    V().visit(tree)
    return rows


def scan(path: Path):
    """返回 (src, hits); hit = (row, raw, kind)。"""
    src = path.read_text(encoding='utf-8')
    docs = _docstring_lines(src)
    standalone = _standalone_string_rows(src)
    src_lines = src.split('\n')
    hits = []
    for m in re.finditer(r'''[fF]?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')''', src):
        row = src[:m.start()].count('\n') + 1
        if row not in standalone or row in docs:
            continue
        if not CJ.search(m.group(0)):
            continue
        if _is_log_line(src_lines[row - 1]):
            continue
        kind = 'fstring' if m.group(0)[:1] in 'fF' else 'str'
        hits.append((row, m.group(0), kind))
    hits.sort()
    return src, hits


def migrate(path: Path):
    src, hits = scan(path)
    prefix = re.sub(r'[^a-z0-9]', '_', path.stem.lower())
    entries = {}
    out_lines = src.split('\n')
    for n, (row, raw, kind) in enumerate(hits, 1):
        key = f"{prefix}.{n:03d}"
        line = out_lines[row - 1]
        pos = line.find(raw)
        if pos < 0:
            continue
        if kind == 'fstring':
            inner = raw[2:-1]
            params = []
            def repl(mm):
                params.append(mm.group(1))
                return '{p%d}' % (len(params) - 1)
            templ = inner.replace('{{', LBR).replace('}}', RBR)
            templ = re.sub(r'\{([^{}]+)\}', repl, templ)
            templ = templ.replace(LBR, '{').replace(RBR, '}')
            # 表达式可能带 !r / :fmt 转换, 也可能是复杂表达式(函数调用等)——
            # 拆出纯表达式进参数; 带转换的整段求值后塞进参数
            clean = []
            for e in params:
                em = re.match(r'^([^!:]+?)\s*(![rsa]|:.*)?$', e.strip())
                if em and em.group(2):
                    expr, conv = em.group(1).strip(), em.group(2)
                    if conv.startswith('!'):
                        fn = {'r': 'repr', 's': 'str', 'a': 'ascii'}[conv[1]]
                        clean.append(f'{fn}({expr})')
                    else:   # :fmt
                        clean.append(f'format({expr}, "{conv[1:]}")')
                elif em:
                    clean.append(em.group(1).strip())
                else:
                    clean.append(e.strip())
            pstr = ', '.join('"p%d": %s' % (i, e) for i, e in enumerate(clean))
            call = 't("%s", {%s})' % (key, pstr)
            entries[key] = templ
        else:
            entries[key] = raw[1:-1]
            call = 't("%s")' % key
        out_lines[row - 1] = line[:pos] + call + line[pos + len(raw):]
    return '\n'.join(out_lines), entries


def main():
    cmd = sys.argv[1]
    for a in sys.argv[2:]:
        p = Path(a)
        if cmd == 'scan':
            _, hits = scan(p)
            print(f"== {p.name}: {len(hits)} 条")
        elif cmd == 'py':
            new, entries = migrate(p)
            p.write_text(new, encoding='utf-8', newline='')
            Path(f"tools/{p.stem}.i18n.json").write_text(
                json.dumps(entries, ensure_ascii=False, indent=1), encoding='utf-8')
            print(f"{p.name}: {len(entries)} entries")


if __name__ == '__main__':
    main()
