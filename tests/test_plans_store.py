"""plans 存储模块测试：实施计划的持久化 / 状态回写 / 列表与详情。

背景: 计划模式弹出的实施计划此前只在实时 permission_request 事件里
存在一次, 批准/拒绝/刷新后无法再查看（对比: 子代理有 ~/.aulos/agents
manifest 持久化 + /api/agents）。本模块让每份计划落盘 ~/.aulos/plans/
{plan_id}.json, 供历史回看。
"""

import json

import pytest

from aulos.plans import (
    PLAN_ACTIVE_STATUSES,
    load_plan,
    plans_dir,
    save_plan,
    set_plan_status,
    list_plans,
)


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """把 plans 目录重定向到临时目录, 隔离真实 ~/.aulos。"""
    monkeypatch.setattr("aulos.plans.PLANS_DIR", tmp_path / "plans")
    return tmp_path / "plans"


def test_plans_dir_default_under_user_dir():
    from aulos.config import USER_DIR
    assert plans_dir() == USER_DIR / "plans"


def test_save_plan_persists_record(store):
    plan_id = save_plan("s1", "# 目标\n做点事", plans_dir=store)
    assert plan_id
    path = store / f"{plan_id}.json"
    assert path.exists()
    rec = json.loads(path.read_text(encoding="utf-8"))
    assert rec["plan_id"] == plan_id
    assert rec["session_id"] == "s1"
    assert rec["plan_markdown"] == "# 目标\n做点事"
    assert rec["status"] == "pending"
    assert rec["ts"] > 0


def test_save_plan_ids_unique(store):
    a = save_plan("s1", "a", plans_dir=store)
    b = save_plan("s1", "b", plans_dir=store)
    assert a != b


def test_set_plan_status_updates_record(store):
    plan_id = save_plan("s1", "m", plans_dir=store)
    set_plan_status(plan_id, "approved", plans_dir=store)
    rec = load_plan(plan_id, plans_dir=store)
    assert rec["status"] == "approved"
    assert rec["plan_markdown"] == "m"


def test_set_plan_status_missing_is_silent_noop(store):
    # 状态回写绝不抛: 批准路径在权限关键链上
    set_plan_status("nope-123", "approved", plans_dir=store)


def test_load_plan_missing_returns_none(store):
    assert load_plan("ghost", plans_dir=store) is None


def test_list_plans_newest_first_with_preview(store):
    p1 = save_plan("s1", "第一份计划" + "x" * 300, plans_dir=store)
    p2 = save_plan("s2", "第二份计划", plans_dir=store)
    items = list_plans(plans_dir=store)
    assert [i["plan_id"] for i in items] == [p2, p1]
    assert items[0]["status"] == "pending"
    assert items[0]["session_id"] == "s2"
    assert items[0]["preview"] == "第二份计划"
    assert len(items[1]["preview"]) == 200  # 截断到 200 字


def test_list_plans_skips_corrupt_files(store):
    save_plan("s1", "ok", plans_dir=store)
    (store / "broken.json").write_text("{not json", encoding="utf-8")
    items = list_plans(plans_dir=store)
    assert len(items) == 1


def test_list_plans_empty_when_dir_missing(store):
    assert list_plans(plans_dir=store) == []


def test_status_constants():
    assert PLAN_ACTIVE_STATUSES == {"pending"}


def test_load_plan_rejects_bad_ids(store):
    # plan_id 白名单（\d{13}-[0-9a-f]{8}）: 挡接口层路径穿越
    save_plan("s1", "m", plans_dir=store)
    for bad in ("../../settings", "1-2", "x" * 30, "", "1792509404392-ABC"):
        assert load_plan(bad, plans_dir=store) is None
    assert list_plans(plans_dir=store)  # 合法记录不受影响
