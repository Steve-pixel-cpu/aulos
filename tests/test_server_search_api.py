"""GET /api/sessions/search 会话全文搜索接口测试。

用 isolated_store 夹具把 store 换到 tmp 目录, 落盘真实 JSONL 后
走 TestClient 请求, 验证查询参数传递与响应结构。

运行方式（在 aulos 目录下）:
    .venv/Scripts/python.exe -m pytest tests/test_server_search_api.py -v
"""

import server
import pytest
from fastapi.testclient import TestClient
from models import Message
from storage import SessionStore


@pytest.fixture()
def client():
    return TestClient(server.app)


@pytest.fixture()
def isolated_store(tmp_path, monkeypatch):
    fake = SessionStore(storage_dir=tmp_path)
    monkeypatch.setattr(server, "store", fake)
    server._pending_sessions.clear()
    return fake


def test_search_api_命中返回摘录(client, isolated_store):
    isolated_store.save_message("s-hit", Message.user_text("讨论 uvicorn 部署"), None)
    isolated_store.save_message("s-miss", Message.user_text("无关内容"), None)
    r = client.get("/api/sessions/search", params={"q": "uvicorn"})
    assert r.status_code == 200
    data = r.json()
    assert "s-hit" in data
    assert "s-miss" not in data
    assert "uvicorn" in data["s-hit"][0].lower()


def test_search_api_空查询返回空对象(client, isolated_store):
    isolated_store.save_message("s-a", Message.user_text("随便"), None)
    r = client.get("/api/sessions/search", params={"q": ""})
    assert r.status_code == 200
    assert r.json() == {}


def test_search_api_缺参默认空查询(client, isolated_store):
    isolated_store.save_message("s-a", Message.user_text("内容"), None)
    r = client.get("/api/sessions/search")
    assert r.status_code == 200
    assert r.json() == {}
