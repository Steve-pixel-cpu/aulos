"""storage.search_sessions 全文搜索测试。

设计要点（2026-10-10 会话全文搜索）:
- 只搜消息正文（text 块 / tool_use.input / tool_result.output / file 块）,
  title/workdir 等元数据记录不进正文——标题过滤已由前端承担, 后端不重复。
- 大小写不敏感的子串匹配, 与前端标题搜索语义一致。
- 每会话最多返回 MAX 条摘录, 摘录带前后上下文与省略号, 压成单行。
- 按 (mtime_ns, size) 缓存文件的可搜索文本: 未变更的文件不再重新解析,
  追加消息后缓存自然失效（新内容可被搜到）。

运行方式（在 aulos 目录下）:
    uv run pytest tests/test_search_sessions.py -v
"""

from models import Message, ToolResultContentBlock, TextContentBlock
from storage import SessionStore


def _store(tmp_path) -> SessionStore:
    return SessionStore(storage_dir=tmp_path)


def test_全文搜索命中消息正文(tmp_path):
    store = _store(tmp_path)
    store.save_message("s-a", Message.user_text("讨论 uvicorn 部署方案"), None)
    store.save_message("s-b", Message.user_text("今天天气不错"), None)
    hits = store.search_sessions("uvicorn")
    assert "s-a" in hits
    assert "s-b" not in hits
    assert "uvicorn" in hits["s-a"][0].lower()


def test_空查询返回空结果(tmp_path):
    store = _store(tmp_path)
    store.save_message("s-a", Message.user_text("随便写点"), None)
    assert store.search_sessions("") == {}
    assert store.search_sessions("   ") == {}


def test_大小写不敏感(tmp_path):
    store = _store(tmp_path)
    store.save_message("s-a", Message.user_text("Hello UVICORN World"), None)
    hits = store.search_sessions("uvicorn")
    assert "s-a" in hits


def test_工具结果与文件附件可被搜索(tmp_path):
    store = _store(tmp_path)
    store.save_message("s-t", Message(role="tool", content=[
        ToolResultContentBlock(id="t1", name="read_file",
                               output="def train_model(): pass"),
    ]), None)
    store.save_message("s-f", Message.user_input(
        "看下附件", [{"kind": "file", "name": "a.txt", "text": "quartz 缓存说明"}]),
        None)
    assert "s-t" in store.search_sessions("train_model")
    assert "s-f" in store.search_sessions("quartz")


def test_标题记录不算正文不参与搜索(tmp_path):
    store = _store(tmp_path)
    store.save_message("s-x", Message.user_text("普通消息"), None)
    store.set_title("s-x", "独一份的关键词标题")
    assert "s-x" not in store.search_sessions("独一份的关键词标题")


def test_摘录带省略号且压成单行(tmp_path):
    store = _store(tmp_path)
    long_text = "前" * 200 + "关键词" + "后" * 200 + "\n换行也压掉"
    store.save_message("s-a", Message.user_text(long_text), None)
    snip = store.search_sessions("关键词")["s-a"][0]
    assert snip.startswith("…") and snip.endswith("…")
    assert "\n" not in snip
    assert "关键词" in snip
    assert len(snip) < 200  # 摘录不是全文回显


def test_每会话摘录条数有上限(tmp_path):
    store = _store(tmp_path)
    text = " ".join(f"第{i}处关键词" for i in range(20))
    store.save_message("s-a", Message.user_text(text), None)
    assert len(store.search_sessions("关键词")["s-a"]) <= 3


def test_追加消息后缓存失效新内容可搜(tmp_path):
    store = _store(tmp_path)
    store.save_message("s-a", Message.user_text("初始内容"), None)
    assert "s-a" not in store.search_sessions("新加的暗号")
    store.save_message("s-a", Message.user_text("新加的暗号在这里"), None)
    assert "s-a" in store.search_sessions("新加的暗号")


def test_不存在的查询词返回不含该会话(tmp_path):
    store = _store(tmp_path)
    store.save_message("s-a", Message.user_text("完全无关"), None)
    assert store.search_sessions("查无此词") == {}
