#!/usr/bin/env python3
"""只读统计: 会话 JSONL 里工具调用的分布画像。

回答「是不是工具调用过多」——不靠感觉, 靠三个分布:
  a. 每条 assistant 消息的 tool_use 块数(并行度): 众数/P90/最大, >8 占比
  b. 轮询类工具(agent_status/task_output/agent_reap)同 id 回合内重调频次
  c. 每回合(用户消息到下一个用户消息之间)工具调用总数分布

用法: python scripts/tool_call_stats.py [sessions目录]   # 缺省 ~/.aulos/sessions
"""
from __future__ import annotations

import glob
import json
import os
import sys
from collections import Counter

POLL_TOOLS = {"agent_status", "task_output", "agent_reap"}
TURN_BOUNDARY_HINTS = ("[System note]",)   # 不用于切回合, 只标注收束提示


def iter_messages(path: str):
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except Exception:
                continue   # 撕裂行跳过, 与 storage._read_entries 的容错一致
            m = e.get("message")
            if isinstance(m, dict) and isinstance(m.get("content"), list):
                yield m


def percentile(sorted_vals: list, p: float):
    if not sorted_vals:
        return 0
    i = min(len(sorted_vals) - 1, int(round(p / 100 * (len(sorted_vals) - 1))))
    return sorted_vals[i]


def main(sessions_dir: str) -> None:
    files = sorted(glob.glob(os.path.join(sessions_dir, "*.jsonl")))
    if not files:
        print(f"no session files under {sessions_dir}")
        return

    # a. 单消息并行度
    batch_sizes: list[int] = []
    # b. 轮询重调
    poll_same_id: Counter[str] = Counter()     # "session|tool|id" -> 回合内最大重调次数
    # c. 回合级总量
    turn_totals: list[int] = []
    per_file_summary = []

    for f in files:
        sid = os.path.basename(f)
        cur_turn_tools = 0
        turn_poll: Counter[tuple] = Counter()  # (tool, id) -> 本回合次数
        f_batches = []
        for m in iter_messages(f):
            role = m.get("role")
            blocks = m.get("content", [])
            if role == "user":
                # 纯文本 user 消息开新回合; 带工具结果的 user 条目(end_turn 风格)
                # 不切——先按 role 粗切, 结果块里没有 text 时不切
                has_text = any(
                    isinstance(b, dict) and b.get("type") == "text" for b in blocks)
                if has_text:
                    if cur_turn_tools:
                        turn_totals.append(cur_turn_tools)
                    cur_turn_tools = 0
                    turn_poll = Counter()
                continue
            if role != "assistant":
                continue
            tool_uses = [b for b in blocks
                         if isinstance(b, dict) and b.get("type") == "tool_use"]
            n = len(tool_uses)
            if n:
                batch_sizes.append(n)
                f_batches.append(n)
                cur_turn_tools += n
                for b in tool_uses:
                    name = b.get("name", "")
                    if name in POLL_TOOLS:
                        try:
                            inp = json.loads(b.get("input") or "{}")
                        except Exception:
                            inp = {}
                        tid = (inp.get("task_id") or inp.get("agent_id")
                               or inp.get("id") or "?")
                        turn_poll[(name, str(tid))] += 1
        if cur_turn_tools:
            turn_totals.append(cur_turn_tools)
        for key, cnt in turn_poll.items():
            poll_same_id[f"{sid}|{key[0]}|{key[1]}"] = cnt
        per_file_summary.append((sid, len(f_batches),
                                 max(f_batches) if f_batches else 0))

    bs = sorted(batch_sizes)
    total = len(bs)
    print(f"== sessions: {len(files)}, tool_use 消息: {total}, "
          f"tool_use 总数: {sum(bs)}")
    print(f"\n[a] 单条 assistant 消息 tool_use 块数(并行度):")
    if total:
        dist = Counter(bs)
        for size in sorted(dist):
            bar = "#" * min(40, dist[size])
            print(f"  {size:3d} 个: {dist[size]:4d} 条 {bar}")
        print(f"  众数={Counter(bs).most_common(1)[0][0]}  "
              f"P50={percentile(bs,50)}  P90={percentile(bs,90)}  "
              f"max={bs[-1]}  >8 占比={sum(1 for x in bs if x > 8)/total:.1%}")

    print(f"\n[b] 轮询类工具同 id 回合内重调(次数≥2 才列出):")
    hot = {k: v for k, v in poll_same_id.items() if v >= 2}
    if hot:
        for k, v in sorted(hot.items(), key=lambda kv: -kv[1]):
            print(f"  {v} 次  {k}")
    else:
        print("  (无——没有出现同 id 连续轮询)")

    tt = sorted(turn_totals)
    print(f"\n[c] 每回合工具调用总数(共 {len(tt)} 个回合):")
    if tt:
        print(f"  P50={percentile(tt,50)}  P90={percentile(tt,90)}  "
              f"max={tt[-1]}  ≥30 轮迭代的回合占比="
              f"{sum(1 for x in tt if x >= 30)/len(tt):.1%}")
        top5 = sorted(tt, reverse=True)[:5]
        print(f"  最大的 5 个回合: {top5}")

    print(f"\n[d] 每文件: (session, tool_use消息数, 最大单消息块数)")
    for sid, cnt, mx in per_file_summary:
        print(f"  {sid}  msgs={cnt}  max_batch={mx}")


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
        "~/.aulos/sessions")
    main(d)
