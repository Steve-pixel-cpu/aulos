"""GET /api/plans 系列接口测试: 历史计划列表 + 全文详情。

仿 /api/agents 模式: 供前端历史回放回填可点开的计划卡; 目录缺失/损坏
返回空而不炸（不阻塞历史回放）。
"""

import json

import pytest
from fastapi.testclient import TestClient

from aulos import server
from aulos.plans import save_plan


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("aulos.plans.PLANS_DIR", tmp_path / "plans")
    return TestClient(server.app)


def test_list_plans_api_empty(client):
    r = client.get("/api/plans")
    assert r.status_code == 200
    assert r.json() == []


def test_list_plans_api_returns_summaries(client):
    pid = save_plan("sess-1", "# 标题\n" + "细节" * 200)
    r = client.get("/api/plans")
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 1
    it = items[0]
    assert it["plan_id"] == pid
    assert it["session_id"] == "sess-1"
    assert it["status"] == "pending"
    assert len(it["preview"]) <= 200
    # 摘要不含全文, 全文走详情接口
    assert "plan_markdown" not in it


def test_get_plan_api_full_text(client):
    pid = save_plan("sess-1", "# 全文计划")
    r = client.get(f"/api/plans/{pid}")
    assert r.status_code == 200
    rec = r.json()
    assert rec["plan_markdown"] == "# 全文计划"
    assert rec["plan_id"] == pid


def test_get_plan_api_404_on_missing(client):
    r = client.get("/api/plans/ghost-404")
    assert r.status_code == 404


def test_list_plans_api_skips_corrupt(client):
    save_plan("sess-1", "ok")
    from aulos.plans import PLANS_DIR
    (PLANS_DIR / "broken.json").write_text("{bad", encoding="utf-8")
    r = client.get("/api/plans")
    assert r.status_code == 200
    assert len(r.json()) == 1
