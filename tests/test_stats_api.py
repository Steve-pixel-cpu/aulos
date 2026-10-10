"""调用遥测 API 测试（server_stats.py）。

日志目录 monkeypatch 到 tmp_path, 不碰真实 ~/.aulos/logs;
server 路由走 TestClient 验证响应结构与防御行为（坏行/空目录/截断）。

运行方式（在 aulos 目录下）:
    python -m pytest tests/test_stats_api.py -q
"""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

import server
import server_stats


@pytest.fixture()
def client():
    return TestClient(server.app)


@pytest.fixture()
def log_dir(tmp_path, monkeypatch):
    """日志目录重定向到 tmp, 每个用例独立。"""
    d = tmp_path / "logs"
    d.mkdir()
    monkeypatch.setattr(server_stats, "LOG_DIR", d)
    return d


def _rec(day: str, ts: str, session: str, duration_s=1.0,
         input_tokens=100, cache_read=0, cache_creation=0, output_tokens=10,
         **over):
    """一条 call_log 形态的记录。day=YYYYMMDD 只决定落在哪个文件。"""
    r = {
        "ts": ts, "session": session, "iter": 1, "thinking": "high",
        "duration_s": duration_s, "context_tokens": 1000,
        "input_tokens": input_tokens, "cache_read": cache_read,
        "cache_creation": cache_creation, "output_tokens": output_tokens,
        "prefix_fp": "ab12cd34ef56",
    }
    r.update(over)
    return r


def _write(log_dir, day: str, records):
    lines = "\n".join(
        r if isinstance(r, str) else _json_dumps(r) for r in records)
    (log_dir / f"runtime-{day}.log").write_text(lines + "\n", encoding="utf-8")


def _json_dumps(r):
    import json
    return json.dumps(r, ensure_ascii=False)


# ------------------------------------------------------------
# 纯函数: 解析防御 / 聚合
# ------------------------------------------------------------

def test_norm_record_rejects_bad_shapes():
    assert server_stats._norm_record(None) is None
    assert server_stats._norm_record("不是字典") is None
    assert server_stats._norm_record({}) is None                      # 缺 session/ts
    assert server_stats._norm_record({"session": "s"}) is None
    assert server_stats._norm_record({"session": "s", "ts": "不是时间",
                                      **{f: 0 for f in server_stats._NUM_FIELDS}}) is None
    ok = server_stats._norm_record(_rec("20260101", "2026-01-01T10:00:00", "s1"))
    assert ok is not None and ok["date"] == "20260101"
    # session 键必须存在但值可为 None（call_log 允许无会话调用）
    none_sess = _rec("20260101", "2026-01-01T10:00:00", None)
    assert server_stats._norm_record(none_sess)["session"] is None


def test_scan_records_skips_broken_lines_and_counts(log_dir):
    good = _rec("20260102", "2026-01-02T10:00:00.000", "s1")
    _write(log_dir, "20260102", [
        good,
        "{不是JSON",                                        # 解析失败
        _json_dumps({"session": "s2"}),                     # 字段缺失
        _json_dumps({**good, "duration_s": "一秒"}),        # 数值字段类型不对
        _rec("20260102", "2026-01-02T10:00:01.000", "s2"),
        "",                                                 # 空行: 忽略不计坏
    ])
    records, meta = server_stats.scan_records()
    assert [r["session"] for r in records] == ["s1", "s2"]   # 时间升序
    assert meta == {"broken_lines": 3}


def test_scan_records_missing_dir_is_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(server_stats, "LOG_DIR", tmp_path / "不存在")
    records, meta = server_stats.scan_records()
    assert records == [] and meta == {"broken_lines": 0}
    # collect_records 同口径
    assert server_stats.collect_records() == []


def test_cache_hit_rate_zero_denominator_is_none():
    assert server_stats.cache_hit_rate(0, 0) is None
    assert server_stats.cache_hit_rate(0, 100) == 0.0
    assert server_stats.cache_hit_rate(75, 25) == 0.75


def test_aggregate_days_dedupes_sessions_and_sorts_desc(log_dir):
    _write(log_dir, "20260101", [
        _rec("20260101", "2026-01-01T10:00:00", "s1", input_tokens=100, cache_read=300),
        _rec("20260101", "2026-01-01T10:00:30", "s1", input_tokens=100, cache_read=0),
        _rec("20260101", "2026-01-01T11:00:00", "s2", input_tokens=0, cache_read=0),
    ])
    _write(log_dir, "20260103", [
        _rec("20260103", "2026-01-03T10:00:00", "s3", duration_s=4.0,
             input_tokens=0, cache_read=0),   # 全零分母 → 命中率 null
    ])
    days = server_stats.aggregate_days(server_stats.collect_records())
    assert [d["date"] for d in days] == ["20260103", "20260101"]   # 降序
    d1 = days[1]
    assert d1["calls"] == 3
    assert d1["sessions"] == 2                                    # s1 去重
    assert d1["total_duration_s"] == 3.0 and d1["avg_duration_s"] == 1.0
    # 命中率 = 300 / (300 + 100+100+0) = 300/500
    assert d1["cache_hit_rate"] == round(300 / 500, 4)  # 0.6
    # 全零分母 → null
    assert days[0]["cache_hit_rate"] is None


def test_aggregate_days_respects_n(log_dir):
    for i in range(1, 4):
        day = f"2026010{i}"
        _write(log_dir, day, [_rec(day, f"2026-01-0{i}T10:00:00", "s")])
    days = server_stats.aggregate_days(server_stats.collect_records(), n=2)
    assert [d["date"] for d in days] == ["20260103", "20260102"]


def test_aggregate_sessions_totals_and_order(log_dir):
    _write(log_dir, "20260101", [
        _rec("20260101", "2026-01-01T10:00:00", "s-fast", duration_s=1.0),
        _rec("20260101", "2026-01-01T10:01:00", "s-slow", duration_s=2.0),
        _rec("20260101", "2026-01-01T10:02:00", "s-slow", duration_s=5.0),
    ])
    sessions = server_stats.aggregate_sessions(server_stats.collect_records())
    assert [s["session"] for s in sessions] == ["s-slow", "s-fast"]   # 总耗时降序
    slow = sessions[0]
    assert slow["calls"] == 2
    assert slow["total_duration_s"] == 7.0 and slow["avg_duration_s"] == 3.5
    assert slow["max_duration_s"] == 5.0
    assert slow["first_ts"] == "2026-01-01T10:01:00"
    assert slow["last_ts"] == "2026-01-01T10:02:00"


def test_filter_calls_sorts_and_truncates():
    recs = [
        _rec("20260101", "2026-01-01T10:02:00", "s1"),
        _rec("20260101", "2026-01-01T10:00:00", "s1"),
        _rec("20260101", "2026-01-01T10:01:00", "s2"),
    ]
    cut, truncated = server_stats.filter_calls(recs, limit=2)
    assert [r["ts"] for r in cut][0] == "2026-01-01T10:00:00"   # 升序
    assert len(cut) == 2 and truncated is True
    full, truncated = server_stats.filter_calls(recs, limit=200)
    assert len(full) == 3 and truncated is False


# ------------------------------------------------------------
# server 路由
# ------------------------------------------------------------

def test_api_stats_days(client, log_dir):
    _write(log_dir, "20260101", [
        _rec("20260101", "2026-01-01T10:00:00", "s1", input_tokens=100, cache_read=100),
        _rec("20260101", "2026-01-01T10:00:10", "s2"),
    ])
    r = client.get("/api/stats/days")
    assert r.status_code == 200
    body = r.json()
    assert body["broken_lines"] == 0
    assert len(body["days"]) == 1
    day = body["days"][0]
    assert day["date"] == "20260101"
    assert day["calls"] == 2 and day["sessions"] == 2
    # 命中率 = 100 / (100 + 100+100) = 100/300
    assert day["cache_hit_rate"] == round(100 / 300, 4)


def test_api_stats_days_bad_line_counted(client, log_dir):
    _write(log_dir, "20260101", [
        _rec("20260101", "2026-01-01T10:00:00", "s1"),
        "垃圾行",
    ])
    body = client.get("/api/stats/days").json()
    assert body["broken_lines"] == 1
    assert body["days"][0]["calls"] == 1


def test_api_stats_sessions(client, log_dir):
    _write(log_dir, "20260101", [
        _rec("20260101", "2026-01-01T10:00:00", "s-a", duration_s=2.0),
        _rec("20260101", "2026-01-01T10:01:00", "s-b", duration_s=9.0),
    ])
    body = client.get("/api/stats/sessions").json()
    assert body["broken_lines"] == 0
    assert [s["session"] for s in body["sessions"]] == ["s-b", "s-a"]
    assert body["sessions"][0]["total_duration_s"] == 9.0


def test_api_stats_calls_default_date_is_today(client, log_dir):
    today = datetime.now().strftime("%Y%m%d")
    _write(log_dir, today, [
        _rec(today, f"{today[:4]}-{today[4:6]}-{today[6:]}T10:00:00", "s1"),
    ])
    body = client.get("/api/stats/calls").json()
    assert body["date"] == today
    assert body["total"] == 1 and body["truncated"] is False
    assert body["calls"][0]["session"] == "s1"


def test_api_stats_calls_date_and_limit(client, log_dir):
    day = "20260105"
    iso = "2026-01-05"
    _write(log_dir, day, [
        _rec(day, f"{iso}T10:00:0{i}.000", f"s{i}") for i in range(5)
    ])
    r = client.get("/api/stats/calls", params={"date": day, "limit": 3})
    assert r.status_code == 200
    body = r.json()
    assert body["date"] == day
    assert body["total"] == 5 and len(body["calls"]) == 3
    assert body["truncated"] is True
    assert [c["ts"] for c in body["calls"]] == sorted(
        c["ts"] for c in body["calls"])                     # 升序
    # 全量: 不截断
    body = client.get("/api/stats/calls", params={"date": day}).json()
    assert len(body["calls"]) == 5 and body["truncated"] is False


def test_api_stats_calls_bad_date_is_400(client, log_dir):
    assert client.get("/api/stats/calls",
                      params={"date": "2026-01-05"}).status_code == 400
    assert client.get("/api/stats/calls",
                      params={"date": "notadate"}).status_code == 400


def test_api_stats_missing_log_dir_no_500(client, tmp_path, monkeypatch):
    monkeypatch.setattr(server_stats, "LOG_DIR", tmp_path / "没有这个目录")
    for path in ("/api/stats/days", "/api/stats/sessions", "/api/stats/calls"):
        r = client.get(path)
        assert r.status_code == 200, path
        body = r.json()
        assert body["broken_lines"] == 0
    assert client.get("/api/stats/days").json()["days"] == []
    assert client.get("/api/stats/sessions").json()["sessions"] == []
    body = client.get("/api/stats/calls").json()
    assert body["calls"] == [] and body["total"] == 0
