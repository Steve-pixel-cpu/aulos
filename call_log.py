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


def _prefix_fingerprint(messages) -> Optional[str]:
    """请求前缀指纹: 倒数第二条 user 消息文本的 sha1 前 12 位（不足两条
    user 时取最后一条）。

    用途: 判断"上一迭代结束时的全部历史"这次和上次是否一致——
    prompt cache 命中的前提是前缀逐字节相同。cache_read=0 而指纹没变
    → 供应商侧缓存被逐出; 指纹变了 → 我们自己改了请求视图（压缩/
    修补/降档换参）击穿了缓存。取倒数第二条是因为最后一条 user 通常是
    本迭代新加的（工具结果）, 必然与上次不同。"""
    try:
        user_msgs = [m for m in messages if getattr(m, "role", "") == "user"]
        if not user_msgs:
            return None
        target = user_msgs[-2] if len(user_msgs) >= 2 else user_msgs[-1]
        text = target.content[0].text
        return __import__("hashlib").sha1(
            text.encode("utf-8")).hexdigest()[:12]
    except Exception:
        return None


def log_model_call(session: Optional[str], iteration: int,
                   thinking_level: Optional[str], duration_s: float,
                   usage, messages=None) -> None:
    """追加一行调用记录。usage 鸭子类型: 只要求带 context_tokens() 与
    input/output/cache 字段（runtime.TokenUsage 的口径）。messages 可选:
    传入本次请求的消息视图时, 额外记录前缀指纹供缓存击穿归因。"""
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
        if messages is not None:
            record["prefix_fp"] = _prefix_fingerprint(messages)
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = LOG_DIR / f"runtime-{datetime.now():%Y%m%d}.log"
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass
