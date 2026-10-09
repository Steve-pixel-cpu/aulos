"""每次模型调用的耗时日志: 长回合"慢在哪"的一手证据。

应用此前没有任何逐日运行日志——"这个对话为什么跑了这么久"只能翻
会话 jsonl 拿相邻时间戳倒推。这里把主循环每次调用的墙钟与用量记成
一行 JSON, 按天落在 ~/.aulos/logs/runtime-YYYYMMDD.log。

写入 best-effort: 任何异常（目录只读、磁盘满……）静默吞掉——日志
只是观测手段, 绝不影响主流程。
"""
import json
from datetime import datetime
from typing import Optional

from config import USER_DIR

LOG_DIR = USER_DIR / "logs"


def log_model_call(session: Optional[str], iteration: int,
                   thinking_level: Optional[str], duration_s: float,
                   usage) -> None:
    """追加一行调用记录。usage 鸭子类型: 只要求带 context_tokens() 与
    input/output/cache 字段（runtime.TokenUsage 的口径）。"""
    try:
        record = {
            "ts": datetime.now().isoformat(timespec="milliseconds"),
            "session": session,
            "iter": iteration,
            "thinking": thinking_level,
            "duration_s": round(duration_s, 3),
            "context_tokens": usage.context_tokens(),
            "input_tokens": usage.input_tokens,
            "cache_read": usage.cache_read_input_tokens,
            "cache_creation": usage.cache_creation_input_tokens,
            "output_tokens": usage.output_tokens,
        }
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = LOG_DIR / f"runtime-{datetime.now():%Y%m%d}.log"
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass
