# server_stats.py — REST: 调用遥测（server 包拆分的又一个功能域）
#
# 只读聚合 call_log.py 落盘的逐次模型调用日志（~/.aulos/logs/runtime-YYYYMMDD.log,
# 每行一条 JSON）, 不碰会话/模型状态。路由挂在 server_common.app 上,
# server.py import 本模块完成注册。
#
# 解析防御: 坏行（JSON 解析失败/字段缺失/类型不对）跳过并计入 broken_lines
# 随响应返回; 日志目录不存在按空数据处理, 不 500。大文件逐行流式读。
"""Aulos web — 调用遥测 API（天概览 / 会话排行 / 单日调用流水）。"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Optional

from fastapi import HTTPException

from server_common import app
from config import USER_DIR

# 独立定义（不 import call_log 的常量）: 遥测读侧与日志写侧解耦,
# 测试 monkeypatch 本模块的 LOG_DIR 即可重定向, 不牵连写侧。
LOG_DIR = USER_DIR / "logs"

_DAY_RE = re.compile(r"^\d{8}$")

# 聚合必须携带的数值字段（call_log.record 的口径）; 缺失/非数值 → 该行按坏行跳过
_NUM_FIELDS = ("duration_s", "context_tokens", "input_tokens",
               "cache_read", "cache_creation", "output_tokens")


# ============================================================================
# 纯函数层: 解析与聚合（无 FastAPI 依赖, tests/test_stats_api.py 直测）
# ============================================================================

def _norm_record(raw) -> Optional[dict]:
    """单行 JSON → 归一化记录; 结构不符返回 None（调用方计坏行）。
    session 允许 None 值（call_log 可写 None）但键必须存在。"""
    if not isinstance(raw, dict) or "session" not in raw:
        return None
    ts = raw.get("ts")
    if not isinstance(ts, str) or not ts:
        return None
    try:
        day = datetime.fromisoformat(ts).strftime("%Y%m%d")
    except ValueError:
        return None
    rec = {"ts": ts, "date": day, "session": raw.get("session"),
           "iter": raw.get("iter"), "thinking": raw.get("thinking"),
           "prefix_fp": raw.get("prefix_fp")}
    for f in _NUM_FIELDS:
        v = raw.get(f)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        rec[f] = v
    return rec


def _day_files() -> list[str]:
    """日志目录里出现过的全部日期（YYYYMMDD 升序）。目录不存在 → 空。"""
    try:
        return sorted(p.name.removeprefix("runtime-").removesuffix(".log")
                      for p in LOG_DIR.glob("runtime-*.log"))
    except OSError:
        return []


def scan_records(date: Optional[str] = None) -> tuple[list[dict], dict]:
    """读一天（date 给定）或全部日期（None）的调用记录, 逐行流式解析。
    返回 (记录列表[按 ts 升序], 元信息{broken_lines})。文件不存在按空。"""
    dates = [date] if date else _day_files()
    records: list[dict] = []
    broken = 0
    for d in dates:
        try:
            fh = (LOG_DIR / f"runtime-{d}.log").open("r", encoding="utf-8")
        except OSError:
            continue          # 当天还没有日志 = 空数据, 不是错误
        with fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except ValueError:
                    broken += 1
                    continue
                rec = _norm_record(raw)
                if rec is None:
                    broken += 1
                    continue
                records.append(rec)
    records.sort(key=lambda r: r["ts"])
    return records, {"broken_lines": broken}


def collect_records(date: Optional[str] = None) -> list[dict]:
    """纯读取入口: date=None 聚合全部日期; 需要 broken_lines 时用 scan_records。"""
    return scan_records(date)[0]


def cache_hit_rate(cache_read: int | float, input_tokens: int | float):
    """缓存命中率 = cache_read / (cache_read + input); 分母 0 → None。"""
    denom = cache_read + input_tokens
    return round(cache_read / denom, 4) if denom > 0 else None


def aggregate_days(records: list[dict], n: int = 14) -> list[dict]:
    """逐天聚合, 最近 n 天在前（date 降序）。会话数按 session 去重。"""
    by_day: dict[str, list[dict]] = {}
    for r in records:
        by_day.setdefault(r["date"], []).append(r)
    days = [_agg_day(d, rs) for d, rs in by_day.items()]
    days.sort(key=lambda x: x["date"], reverse=True)
    return days[:max(0, n)]


def _agg_day(date: str, rs: list[dict]) -> dict:
    durs = [r["duration_s"] for r in rs]
    inp = sum(r["input_tokens"] for r in rs)
    cr = sum(r["cache_read"] for r in rs)
    return {
        "date": date,
        "calls": len(rs),
        "sessions": len({r["session"] for r in rs}),
        "total_duration_s": round(sum(durs), 3),
        "avg_duration_s": round(sum(durs) / len(durs), 3),
        "input_tokens": inp,
        "cache_read_tokens": cr,
        "cache_creation_tokens": sum(r["cache_creation"] for r in rs),
        "output_tokens": sum(r["output_tokens"] for r in rs),
        "cache_hit_rate": cache_hit_rate(cr, inp),
    }


def aggregate_sessions(records: list[dict], n: int = 50) -> list[dict]:
    """按会话聚合（全部日期），按总耗时降序, 前 n 条。"""
    by_session: dict[Optional[str], list[dict]] = {}
    for r in records:
        by_session.setdefault(r["session"], []).append(r)
    out = []
    for sid, rs in by_session.items():
        durs = [r["duration_s"] for r in rs]
        tss = sorted(r["ts"] for r in rs)
        out.append({
            "session": sid,
            "calls": len(rs),
            "total_duration_s": round(sum(durs), 3),
            "avg_duration_s": round(sum(durs) / len(durs), 3),
            "max_duration_s": round(max(durs), 3),
            "input_tokens": sum(r["input_tokens"] for r in rs),
            "cache_read_tokens": sum(r["cache_read"] for r in rs),
            "cache_creation_tokens": sum(r["cache_creation"] for r in rs),
            "output_tokens": sum(r["output_tokens"] for r in rs),
            "first_ts": tss[0],
            "last_ts": tss[-1],
        })
    out.sort(key=lambda x: x["total_duration_s"], reverse=True)
    return out[:max(0, n)]


def filter_calls(records: list[dict], limit: int = 200) -> tuple[list[dict], bool]:
    """单日流水: 时间升序 + limit 截断。返回 (行, 是否被截断)。"""
    rows = sorted(records, key=lambda r: r["ts"])
    cut = rows[:max(0, limit)]
    return cut, len(rows) > len(cut)


# ============================================================================
# 路由层
# ============================================================================

def _check_date(date: Optional[str]) -> str:
    d = date or datetime.now().strftime("%Y%m%d")
    if not _DAY_RE.match(d):
        raise HTTPException(status_code=400,
                            detail=f"日期格式应为 YYYYMMDD: {date!r}")
    return d


@app.get("/api/stats/days")
async def api_stats_days(n: int = 14):
    """最近 n 天（有日志的天）逐天聚合。"""
    records, meta = scan_records()
    return {**meta, "days": aggregate_days(records, n=min(max(n, 1), 365))}


@app.get("/api/stats/sessions")
async def api_stats_sessions(n: int = 50):
    """按会话聚合（全部日期），按总耗时降序。"""
    records, meta = scan_records()
    return {**meta, "sessions": aggregate_sessions(records, n=min(max(n, 1), 500))}


@app.get("/api/stats/calls")
async def api_stats_calls(date: Optional[str] = None, limit: int = 200):
    """指定日（缺省今天）的原始调用流水，时间升序，limit 截断。"""
    d = _check_date(date)
    records, meta = scan_records(d)
    calls, truncated = filter_calls(records, limit=min(max(limit, 0), 2000))
    return {**meta, "date": d, "total": len(records),
            "truncated": truncated, "calls": calls}
