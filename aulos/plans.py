"""实施计划的持久化存储。

背景: 计划模式弹出的实施计划此前只活在实时 permission_request 事件里,
批准/拒绝/刷新后全文即不可再查看（对比: 子代理有 ~/.aulos/agents 的
manifest 持久化 + GET /api/agents 供历史回看）。本模块让每份计划原子
落盘 ~/.aulos/plans/{plan_id}.json, 记录全文与决议状态, 供
GET /api/plans 系列接口与前端"历史计划"回看。

并发模型: 与 multi_agent 的 manifest 一致——fsatomic 原子写 + 读重试,
坏文件跳过不炸列表。测试用 monkeypatch 重定向 PLANS_DIR 隔离真实目录。
"""

import json
import re
import threading
import time
import uuid
from pathlib import Path

from aulos.config import USER_DIR
from aulos.fsatomic import atomic_write_text, read_text_with_retry

PLANS_DIR = USER_DIR / "plans"

# pending 计划仍是"活"的: 前端可据此给条目加待批标识
PLAN_ACTIVE_STATUSES = {"pending"}

_PREVIEW_LEN = 200

# plan_id 白名单: {毫秒时间戳}-{uuid8}（见 save_plan）
PLAN_ID_RE = re.compile(r"\d{13}-[0-9a-f]{8}")

_lock = threading.Lock()


def _records_dir(plans_dir_override=None) -> Path:
    d = Path(plans_dir_override) if plans_dir_override else PLANS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def plans_dir() -> Path:
    """当前生效的 plans 目录（测试通过 monkeypatch PLANS_DIR 重定向）。"""
    return PLANS_DIR


def save_plan(session_id: str, markdown: str, *,
              plans_dir: Path = None) -> str:
    """保存一份计划, 返回 plan_id。初始状态 pending。

    plan_id = {毫秒时间戳}-{uuid8}: request_id（perm-N）跨进程重启会重置,
    不能作持久化主键。"""
    rec_dir = _records_dir(plans_dir)
    ts_ms = int(time.time() * 1000)
    plan_id = f"{ts_ms}-{uuid.uuid4().hex[:8]}"
    record = {
        "plan_id": plan_id,
        "session_id": session_id or "",
        "ts": ts_ms,
        "plan_markdown": markdown or "",
        "status": "pending",
    }
    # 文件名含 uuid 必唯一; 锁只做 mkdir/写序列化（每次弹计划卡才走一次）
    with _lock:
        atomic_write_text(rec_dir / f"{plan_id}.json",
                          json.dumps(record, ensure_ascii=False))
    return plan_id


def set_plan_status(plan_id: str, status: str, *,
                    plans_dir: Path = None) -> None:
    """回写计划决议状态。绝不抛: 批准/拒绝在权限关键链上,
    存储抖动不能影响决议本身。"""
    rec_dir = _records_dir(plans_dir)
    path = rec_dir / f"{plan_id}.json"
    try:
        record = json.loads(read_text_with_retry(path))
        record["status"] = status
        with _lock:
            atomic_write_text(path, json.dumps(record, ensure_ascii=False))
    except Exception:
        pass


def load_plan(plan_id: str, *, plans_dir: Path = None) -> dict | None:
    """读一份计划全文; 缺失/损坏/非法 id 返回 None。

    plan_id 格式白名单（\\d+-[0-9a-f]{8}）: 接口层直接拼路径,
    挡住 ../ 反斜杠等路径穿越输入。"""
    if not PLAN_ID_RE.fullmatch(str(plan_id)):
        return None
    path = _records_dir(plans_dir) / f"{plan_id}.json"
    try:
        record = json.loads(read_text_with_retry(path))
        return record if isinstance(record, dict) and record.get("plan_id") else None
    except Exception:
        return None


def list_plans(*, plans_dir: Path = None) -> list[dict]:
    """全部计划的摘要, 按时间倒序（新→旧）。损坏文件跳过。
    供 GET /api/plans 与前端历史列表; 任何异常返回空列表。"""
    rec_dir = _records_dir(plans_dir)
    items: list[dict] = []
    try:
        files = list(rec_dir.glob("*.json"))
    except Exception:
        return []
    for path in files:
        try:
            record = json.loads(read_text_with_retry(path))
            if not isinstance(record, dict) or not record.get("plan_id"):
                continue
            markdown = str(record.get("plan_markdown") or "")
            items.append({
                "plan_id": record["plan_id"],
                "session_id": str(record.get("session_id") or ""),
                "ts": int(record.get("ts") or 0),
                "status": str(record.get("status") or "pending"),
                "preview": markdown[:_PREVIEW_LEN],
            })
        except Exception:
            continue
    items.sort(key=lambda i: i["ts"], reverse=True)
    return items
