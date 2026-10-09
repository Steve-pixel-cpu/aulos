"""JSONL 读取必须按物理行(\\n)切分, 不能用 str.splitlines()。

现场事故: 一条 read_file tool_result 把 PNG 二进制读进了 output,
JSON 字符串里出现原始 U+0085 字符。splitlines() 把 U+0085(U+2028/U+2029
同理)当行边界, 一条合法 JSON 记录被切成多段, 每段解析失败——
轻则刷 "JSON 解析失败" WARN, 重则消息条目被丢、parent_uuid 链断裂,
该条之前的全部历史在回放时消失。

写入方 _append_entry 只写 "\\n"(json.dumps 不转义 U+0085/U+2028/U+2029),
因此读取必须与写入对齐: 只有 "\\n" 是行边界。

运行方式（在 aulos 目录下）:
    uv run pytest tests/test_storage_jsonl_split.py -v
"""

import json

from models import Message
from storage import SessionStore


def _store(tmp_path) -> SessionStore:
    return SessionStore(storage_dir=tmp_path)


def test_字符串含U_plus_0085不切断记录(tmp_path):
    # 复刻现场: output 里的原始 NEL 字符(U+0085)不能被当成行边界
    store = _store(tmp_path)
    sid = "s1"
    uuid1 = store.save_message(
        sid, Message.user_text("before"), None)
    uuid2 = store.save_message(
        sid, Message.user_text("png\u0085binary\u0085bytes"), uuid1)
    msgs, _ = store.load_session(sid)
    assert len(msgs) == 2
    assert msgs[1].content[0].text == "png\u0085binary\u0085bytes"


def test_字符串含U_plus_2028_2029不切断记录(tmp_path):
    store = _store(tmp_path)
    sid = "s2"
    uuid1 = store.save_message(sid, Message.user_text("a"), None)
    uuid2 = store.save_message(
        sid, Message.user_text("line\u2028sep\u2029para"), uuid1)
    msgs, _ = store.load_session(sid)
    assert len(msgs) == 2
    assert msgs[1].content[0].text == "line\u2028sep\u2029para"


def test_损坏文件不产生splitlines假告警(tmp_path, capfd):
    # 真坏行(非法 JSON)仍要告警一次; 合法但含 U+0085 的行不再被误切
    store = _store(tmp_path)
    sid = "s3"
    entry = {
        "uuid": "u1", "parent_uuid": None,
        "message": {"role": "user", "content": [{"type": "text",
                                                 "text": "x\u0085y"}]},
        "timestamp": "2026-01-01T00:00:00+00:00",
    }
    (tmp_path / f"{sid}.jsonl").write_text(
        json.dumps(entry, ensure_ascii=False) + "\n", encoding="utf-8")
    entries = store._read_entries(tmp_path / f"{sid}.jsonl")
    assert len(entries) == 1          # 一条完整记录, 未被 U+0085 切开
    out = capfd.readouterr().out
    assert "JSON 解析失败" not in out  # 不再有 splitlines 假告警
