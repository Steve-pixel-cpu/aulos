# -*- coding: utf-8 -*-
"""判分: delegate-subagent —— 子代理真的写了产物文件。

注: harness 的 evaluate(workspace) 只拿工作区, Leader 的最终回复文本
不落工作区, 无法机械断言"回复里含子代理结果关键词"; 产物文件存在且
内容正确即证明 链路(Leader 派发 → worker 执行 → 结果交付)全程无
「无消息内容!」整场报废——那会让文件根本不被创建。
"""
from pathlib import Path

from harness import Check


def evaluate(workspace: Path) -> list[Check]:
    path = workspace / "project" / "greeting.txt"
    if not path.exists():
        return [Check("project/greeting.txt 存在", False,
                      "文件未创建——检查子代理是否真的被派发/是否中途 failed")]
    content = path.read_text(encoding="utf-8").strip()
    return [
        Check("project/greeting.txt 存在", True),
        Check("内容 = hello-subagent", content == "hello-subagent",
              f"实际: {content!r}"),
    ]
