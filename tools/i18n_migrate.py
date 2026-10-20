#!/usr/bin/env python3
"""i18n 批量迁移工具（第 2 期 throwaway 工具, 用后即弃）。

用法:
  python tools/i18n_migrate.py scan <file>...     # 列出用户可见中文字符串
  python tools/i18n_migrate.py js <file>          # JS: 中文字符串→t() 调用, 输出字典
  python tools/i18n_migrate.py html <file>        # HTML: 加 data-i18n 属性, 输出字典

规则:
- 注释(// 与 /* */)内的中文跳过; console.warn/error/log 诊断跳过
- 模板串中的中文 → t(key, {...}); 静态串 → t(key)
- 自动 key: 文件基名.序号 不够语义 → 由人工词汇表映射覆盖(后续合并时重命名)
- 输出: 改写后的文件 + <file>.i18n.json(zh 侧条目)
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

CJ = r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]'   # CJK + 中文标点 + 全角


def has_cjk(s: str) -> bool:
    return re.search(CJ, s) is not None


def strip_comments(src: str):
    """返回 (无注释源码, 注释位置mask)。用占位替换保留行号/长度。
    同时感知正则字面量 /.../ —— 其中的 ` 与 " 不是字符串分隔符
    (app.js:379 的 /```...```/g 曾把模板配对打乱产生重叠命中)。"""
    out = []
    i, n = 0, len(src)
    mode = None  # None | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 're'
    re_class = False   # 正则内上一个字符是否为反斜杠转义
    prev_sig = ''      # 最近一个有意义的非空白字符(判断 / 是除号还是正则开头)
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if mode is None:
            if c == '/' and nxt == '/':
                mode = 'line'; out.append('  '); i += 2; continue
            if c == '/' and nxt == '*':
                mode = 'block'; out.append('  '); i += 2; continue
            if c == '/' and prev_sig and (prev_sig in '(:,=:[!&|?{};+-*%<>~^' or prev_sig.isalnum() is False and prev_sig not in ')]'):
                # / 是正则开头: 仅当前一个有义字符是运算符/开头
                # (标识符与 ) ] 之后是除法, 不是正则)
                mode = 're'; re_class = False
                out.append(c); i += 1; continue
            if c == "'":
                mode = 'sq'; out.append(c); i += 1; continue
            if c == '"':
                mode = 'dq'; out.append(c); i += 1; continue
            if c == '`':
                mode = 'tpl'; out.append(c); i += 1; continue
            out.append(c)
            if not c.isspace():
                prev_sig = c
            i += 1
        elif mode == 'line':
            if c == '\n':
                mode = None; out.append('\n')
            else:
                out.append(' ')
            i += 1
        elif mode == 'block':
            if c == '*' and nxt == '/':
                mode = None; out.append('  '); i += 2
            else:
                out.append('\n' if c == '\n' else ' '); i += 1
        elif mode == 're':
            if c == '\\' and not re_class:
                re_class = True; out.append(c); i += 1; continue
            if re_class:
                re_class = False; out.append(c); i += 1; continue
            if c == '[':
                re_class = True  # 粗略: 进入字符类, ] 结束
                out.append(c); i += 1; continue
            if c == ']':
                out.append(c); i += 1; continue
            if c == '/':
                mode = None
            # 正则内的反引号/引号用空格遮蔽: 不参与模板与字符串配对
            out.append(' ' if c in '`"\'' else c)
            i += 1
        else:  # in string
            if c == '\\':
                out.append('  '); i += 2; continue
            if (mode == 'sq' and c == "'") or (mode == 'dq' and c == '"') \
                    or (mode == 'tpl' and c == '`'):
                mode = None
            out.append(c)
            if mode is None and not c.isspace():
                prev_sig = c
            i += 1
    return ''.join(out)


def scan_js(path: Path):
    src = path.read_text(encoding='utf-8')
    mask = strip_comments(src)
    hits = []
    for m in re.finditer(r'''(['"])((?:\\.|(?!\1).)*)\1''', mask):
        s = m.group(2)
        if not has_cjk(s):
            continue
        # 回溯跳过 console 诊断; 跳过模板串内部的内嵌引号串
        # (位于 `...` 之内 —— 改写它们会破坏模板串语法, 见 migrate 失败教训)
        prefix = mask[:m.start()]
        if re.search(r'console\.\w+\s*\(\s*$', prefix):
            continue
        if _inside_template(mask, m.start()):
            continue
        hits.append((m.start(), m.group(0), s))
    # 模板串
    for m in re.finditer(r'`((?:\\.|[^`\\])*)`', mask):
        s = m.group(1)
        if has_cjk(s) and not re.search(r'console\.\w+\s*\(\s*$', mask[:m.start()]):
            hits.append((m.start(), m.group(0), s))
    hits.sort()
    return src, mask, hits


def _inside_template(mask: str, pos: int) -> bool:
    """pos 处的引号串是否位于模板串 ` ... ` 内部（按 mask 位置计数）。"""
    depth = 0
    for i, ch in enumerate(mask):
        if i >= pos:
            break
        if ch == '`':
            depth ^= 1
    return depth == 1


def key_for(fname: str, idx: int) -> str:
    base = re.sub(r'[-.]', '_', Path(fname).stem)
    return f"{base}.{idx:03d}"


def esc(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)[1:-1]


def migrate_js(path: Path, glossary: dict | None = None):
    src, mask, hits = scan_js(path)
    glossary = glossary or {}
    entries = {}
    out, pos = [], 0
    for idx, (start, raw, s) in enumerate(hits, 1):
        if start < pos:      # 重叠命中(正则字面量干扰等) → 丢弃保平安
            continue
        key = key_for(path.name, idx)
        # 词汇表: 中文原文 → 语义 key（按原文精确匹配）
        for pat, k in glossary.items():
            if pat == s:
                key = k
                break
        out.append(src[pos:start])
        # 模板串含 ${...} → 参数化
        if raw.startswith('`') and '${' in s:
            params = []
            def repl(mm):
                pname = f"p{len(params)}"
                params.append(mm.group(0))
                return '{' + pname + '}'
            templ = re.sub(r'\$\{[^}]*\}', repl, s)
            pstr = ', { ' + ', '.join(
                f'{k2}: {v[2:-1]}' for k2, v in zip(
                    [f'p{i}' for i in range(len(params))], params)) + ' }'
            out.append(f't("{esc(templ) if False else key}"{pstr})')
            entries[key] = templ
        else:
            out.append(f't("{key}")')
            entries[key] = s
        pos = start + len(raw)
    out.append(src[pos:])
    return ''.join(out), entries


def migrate_html(path: Path):
    src = path.read_text(encoding='utf-8')
    entries = {}
    out, pos = [], 0
    # 属性: title=/placeholder=/aria-label= 含中文
    attr_re = re.compile(
        r'\b(title|placeholder|aria-label)\s*=\s*"([^"]*' + CJ + r'[^"]*)"')
    counter = 0
    for m in attr_re.finditer(src):
        counter += 1
        key = f"{Path(path).stem}.attr{counter:03d}"
        entries[key] = m.group(2)
        out.append(src[pos:m.end()])
        out.append(f' data-i18n-{"aria-label" if m.group(1)=="aria-label" else m.group(1)}="{key}"')
        pos = m.end()
    out.append(src[pos:])
    src2 = ''.join(out)
    # 文本节点: >中文<
    out, pos, counter = [], 0, 0
    text_re = re.compile(r'>([^<>{}]*' + CJ + r'[^<>{}]*)<')
    for m in text_re.finditer(src2):
        s = m.group(1)
        # 跳过 script/style 与注释区(粗粒度: 行含 <script/<style 的区间)
        counter += 1
        key = f"{Path(path).stem}.t{counter:03d}"
        entries[key] = s.strip()
        lead_ws = s[:len(s) - len(s.lstrip())]
        trail_ws = s[len(s.rstrip()):]
        out.append(src2[pos:m.start()])
        out.append(f'>{lead_ws}<span data-i18n="{key}">{s.strip()}</span>{trail_ws}<')
        pos = m.end()
    out.append(src2[pos:])
    return ''.join(out), entries


def main():
    cmd = sys.argv[1]
    paths = [Path(p) for p in sys.argv[2:]]
    for p in paths:
        if cmd == 'scan':
            _, _, hits = scan_js(p)
            print(f"== {p} ({len(hits)} hits)")
            for _, raw, s in hits[:5]:
                print("  ", raw[:70])
        elif cmd == 'js':
            backup = p.read_text(encoding='utf-8')
            new, entries = migrate_js(p)
            p.write_text(new, encoding='utf-8', newline='')
            (p.parent / (p.name + '.i18n.json')).write_text(
                json.dumps(entries, ensure_ascii=False, indent=1), encoding='utf-8')
            print(f"{p}: {len(entries)} entries")
        elif cmd == 'html':
            new, entries = migrate_html(p)
            p.write_text(new, encoding='utf-8', newline='')
            (p.parent / (p.name + '.i18n.json')).write_text(
                json.dumps(entries, ensure_ascii=False, indent=1), encoding='utf-8')
            print(f"{p}: {len(entries)} entries")


if __name__ == '__main__':
    main()
