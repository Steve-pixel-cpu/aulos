#!/usr/bin/env python3
"""合并各文件 .i18n.json 到 static/i18n/zh.js / en.js（第 2 期 throwaway）。"""
import json
import glob
import re
from pathlib import Path

# 术语表: 界面高频词统一译法
GLOSSARY = {
    "会话": "Session", "任务": "Task", "设置": "Settings", "工作区": "Workspace",
    "模型": "Model", "供应商": "Provider", "权限": "Permission", "复制": "Copy",
    "重试": "Retry", "停止": "Stop", "发送": "Send", "删除": "Delete",
    "确定": "OK", "取消": "Cancel", "保存": "Save", "加载中": "Loading",
    "失败": "Failed", "错误": "Error", "成功": "Success", "警告": "Warning",
}

PUNCT = {"，": ", ", "。": ". ", "：": ": ", "；": "; ", "？": "? ", "！": "! ",
         "（": " (", "）": ") ", "「": '"', "」": '"', "『": '"', "』": '"',
         "、": ", ", "…": "...", "·": " · "}


def translate(s: str) -> str:
    """轻量机翻骨架: 术语表替换 + 标点转换。生成后由人工(AI)复核。"""
    out = s
    for zh, en in GLOSSARY.items():
        out = out.replace(zh, en)
    for zh, en in PUNCT.items():
        out = out.replace(zh, en)
    return out


def main():
    entries = {}
    for f in sorted(glob.glob('static/*.i18n.json')):
        entries.update(json.load(open(f, encoding='utf-8')))
    print(f'合并 {len(entries)} 条')
    zh_js = Path('static/i18n/zh.js')
    src = zh_js.read_text(encoding='utf-8')
    add_zh = ''.join(f'  "{k}": {json.dumps(v, ensure_ascii=False)},\n'
                     for k, v in entries.items())
    src = src.replace('};\n})();', add_zh + '};\n})();')
    zh_js.write_text(src, encoding='utf-8', newline='')
    en_js = Path('static/i18n/en.js')
    src = en_js.read_text(encoding='utf-8')
    add_en = ''.join(f'  "{k}": {json.dumps(translate(v), ensure_ascii=False)},\n'
                     for k, v in entries.items())
    src = src.replace('};\n})();', add_en + '};\n})();')
    en_js.write_text(src, encoding='utf-8', newline='')
    print('zh.js / en.js 已合并')


if __name__ == '__main__':
    main()
