"""多 agent 接线测试: agent_tools.py（工具层）+ multi_agent.py 新增改动。

覆盖:
- TOOLS/registry 与 agent 工具的一致性（spec ↔ handler ↔ 白名单）
- workdir 参数从 registry 流到 AgentJob（CLI None / Web 会话目录两条路径）
- _tool_specs_for 规格过滤（递归防护的 API 层）
- spawn → complete → status/reap 读回 result 的闭环
- 收割机制: reap_ready / mark_delivered / reconcile_orphans
- 会话隔离: A 会话不收 B 会话的结果
- _AgentToolbox 单例与 set_api_config_provider 的注入/回落
"""
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile

import pytest

import aulos.agent_tools as agent_tools
from aulos.agent_tools import (
    AGENT_TOOL_SPECS,
    DEFAULT_SESSION,
    agent_list_tool,
    agent_status_tool,
    agent_wait_tool,
    bind_agent_to_session,
    get_orchestrator,
    reap_ready_tool,
    register_agent_tools,
    spawn_agent_tool,
    _session_bindings,
)
from aulos.main import TOOLS, build_registry
from aulos.multi_agent import (
    TOOL_WHITELIST,
    AgentJob,
    AgentManifest,
    AgentOrchestrator,
    _default_api_config,
    _tool_specs_for,
    set_api_config_provider,
)


class RecordingSpawn:
    def __init__(self, error: Exception | None = None):
        self.jobs = []
        self._error = error

    def __call__(self, job) -> None:
        if self._error is not None:
            raise self._error
        self.jobs.append(job)


@pytest.fixture(autouse=True)
def fake_orchestrator(monkeypatch):
    """每个用例: 单例换成假 spawn 的编排器 + 清空会话归属（不真正起线程）。

    spawn_fn 必须注入 no-op: 缺省会走 _default_spawn_fn——起真实 worker
    线程打真实 LLM, 且线程晚到的 FAILED 终态会覆盖用例刚写入的
    COMPLETED（随机翻转状态, 就是这批用例偶发红掉的第二个根因）。
    这里所有用例都是自己调 complete_agent 模拟 worker 收尾, 不需要真线程。

    单例替换必须走 monkeypatch（teardown 精确还原到 setup 前值）——
    直接赋值不还原会把 no-op 假编排器泄漏给同进程后续文件: 后面任何
    走真实 spawn 全链路的用例（如 test_subagent_events 的
    test_spawn_emits_started_and_done）会经 get_orchestrator() 捡到它,
    worker 线程根本不被创建, 只有同步路径的 subagent_started 事件,
    断言必挂且与自身代码无关。"""
    tmp = tempfile.mkdtemp()
    orch = AgentOrchestrator(Path(tmp), spawn_fn=lambda job: None)
    monkeypatch.setattr(agent_tools._toolbox, "_orchestrator", orch)
    _session_bindings.clear()
    yield orch
    _session_bindings.clear()
    shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------
# 1. spec ↔ registry ↔ 白名单 一致性
# ------------------------------------------------------------

def test_tools_include_agent_quintet():
    from aulos.skills import sync_skill_tools
    sync_skill_tools(TOOLS, [])   # 归零技能 spec: server 导入时可能已同步真实技能
    names = [s["name"] for s in TOOLS]
    assert names[-5:] == ["agent_tool", "agent_status", "agent_wait",
                          "agent_reap", "agent_list"]


def test_agent_tool_specs_match_registry_handlers():
    registry = build_registry()
    for spec in AGENT_TOOL_SPECS:
        assert spec["name"] in registry._handlers, spec["name"]


def test_agent_tools_absent_from_worker_whitelists():
    """递归防护: 任何角色的白名单都不含 agent 工具（名字层面）。"""
    for role, tools in TOOL_WHITELIST.items():
        for t in ("agent_tool", "agent_status", "agent_wait",
                  "agent_reap", "agent_list"):
            assert t not in tools, f"{role}/{t}"


# ------------------------------------------------------------
# 2. 规格过滤（worker 请求里看不到白名单外的工具）
# ------------------------------------------------------------

def test_tool_specs_for_filters_by_whitelist():
    specs = _tool_specs_for(TOOL_WHITELIST["explore"])
    assert [s["name"] for s in specs] == ["glob", "grep", "read_file"]


def test_tool_specs_for_general_has_no_agent_tools():
    names = [s["name"] for s in _tool_specs_for(TOOL_WHITELIST["general"])]
    assert "agent_tool" not in names
    assert set(names) == set(TOOL_WHITELIST["general"])


def test_tool_specs_for_unknown_tool_is_skipped():
    assert _tool_specs_for({"not-a-real-tool"}) == []


# ------------------------------------------------------------
# 3. handler 的错误路径与空态
# ------------------------------------------------------------

def test_status_unknown_id_returns_error_string():
    out = agent_status_tool({"agent_id": "ghost"})
    assert "ERROR" in out and "ghost" in out


def test_status_requires_agent_id():
    assert "ERROR" in agent_status_tool({})


def test_list_empty_state():
    assert agent_list_tool({}) == "(no subagents yet)"


def test_spawn_rejects_empty_input_via_tool_error():
    out = spawn_agent_tool({"description": "  ", "prompt": "p"})
    assert out.startswith("ERROR:")


# ------------------------------------------------------------
# 4. workdir 参数流: registry → handler → AgentJob
# ------------------------------------------------------------

def test_spawn_via_registry_passes_workdir_to_job():
    rec = RecordingSpawn()
    orch = AgentOrchestrator(Path(tempfile.mkdtemp()), spawn_fn=rec)
    agent_tools._toolbox._orchestrator = orch
    registry = build_registry()
    out = registry.execute(
        "agent_tool",
        json.dumps({"description": "d", "prompt": "p", "subagent_type": "verification"}),
        workdir="D:/some/project",
    )
    assert "agent_id" in out
    assert rec.jobs[0].workdir == "D:/some/project"
    assert rec.jobs[0].allowed_tools == set(TOOL_WHITELIST["verification"])


def test_spawn_without_workdir_defaults_to_none():
    rec = RecordingSpawn()
    agent_tools._toolbox._orchestrator = AgentOrchestrator(
        Path(tempfile.mkdtemp()), spawn_fn=rec)
    spawn_agent_tool({"description": "d", "prompt": "p"}, workdir=None)
    assert rec.jobs[0].workdir is None


# ------------------------------------------------------------
# 4b. api_config 参数流: 派生会话 → handler → AgentJob → worker runtime
#     （worker 跟随派生会话的专属模型/供应商; CLI / 无绑定回落全局工厂）
# ------------------------------------------------------------

def test_spawn_without_session_binding_passes_none_api_config(monkeypatch):
    """无会话绑定（CLI）: api_config=None → worker 回落全局工厂。
    桩掉 worker_api_config: 该函数现读真实 ~/.aulos/settings.json,
    不隔离会把用户已配置的 workerProvider 泄漏进测试。"""
    monkeypatch.setattr(agent_tools, "current_session_id", lambda: None)
    monkeypatch.setattr(agent_tools, "worker_api_config", lambda: None)
    rec = RecordingSpawn()
    agent_tools._toolbox._orchestrator = AgentOrchestrator(
        Path(tempfile.mkdtemp()), spawn_fn=rec)
    spawn_agent_tool({"description": "d", "prompt": "p"}, workdir=None)
    assert rec.jobs[0].api_config is None


def test_spawn_carries_session_api_config(monkeypatch):
    """Web 有会话绑定: job 带上派生会话解析出的连接四元组。
    同上桩掉 worker_api_config, 隔离真实设置的 workerProvider。"""
    quad = ("sk-x", "https://api.example.com", "session-model", "openai")
    monkeypatch.setattr(agent_tools, "current_session_id", lambda: "s-1")
    monkeypatch.setattr(agent_tools, "worker_api_config", lambda: None)
    monkeypatch.setattr(agent_tools, "current_session_api_config", lambda: quad)
    rec = RecordingSpawn()
    agent_tools._toolbox._orchestrator = AgentOrchestrator(
        Path(tempfile.mkdtemp()), spawn_fn=rec)
    spawn_agent_tool({"description": "d", "prompt": "p"}, workdir=None)
    assert rec.jobs[0].api_config == quad


def test_worker_runtime_uses_job_api_config_over_global(monkeypatch):
    """job 自带连接信息时优先; 全局工厂不被调用（会话模型对子代理生效）。"""
    import aulos.multi_agent as ma

    job = AgentJob(
        manifest=AgentManifest(
            agent_id="a-x", name="", description="d", subagent_type="general",
            status="running", output_file="",
            created_at="2026-01-01T00:00:00+00:00",
            started_at=None, completed_at=None, error=None,
        ),
        prompt="p",
        allowed_tools={"read_file"},
        api_config=("sk-job", "https://job.example.com", "job-model", "anthropic"),
    )

    def _forbidden():
        raise AssertionError("job.api_config 存在时不应回落全局工厂")

    monkeypatch.setattr(ma, "_api_config_provider", _forbidden)

    class _CaptureClient:
        thinking_level = "low"

        def __init__(self, **kwargs):
            self.init = kwargs

    protocol_seen = []

    def _fake_make(protocol, **kwargs):
        protocol_seen.append(protocol)
        return _CaptureClient(**kwargs)

    monkeypatch.setattr(ma, "make_api_client", _fake_make)

    captured = ma.build_subagent_runtime(job)._api_client.init
    assert captured["api_key"] == "sk-job"
    assert captured["model"] == "job-model"
    assert captured["base_url"] == "https://job.example.com"
    assert protocol_seen == ["anthropic"]


def test_worker_runtime_none_api_config_falls_back_to_global(monkeypatch):
    """job 未带连接信息（CLI）: 走全局工厂（原行为）。"""
    import aulos.multi_agent as ma

    job = AgentJob(
        manifest=AgentManifest(
            agent_id="a-y", name="", description="d", subagent_type="general",
            status="running", output_file="",
            created_at="2026-01-01T00:00:00+00:00",
            started_at=None, completed_at=None, error=None,
        ),
        prompt="p",
        allowed_tools={"read_file"},
        api_config=None,
    )
    monkeypatch.setattr(ma, "_api_config_provider",
                        lambda: ("sk-global", None, "global-model", "anthropic"))
    class _FakeClient:
        thinking_level = "low"

        def __init__(self, **kwargs):
            self.init = kwargs

    monkeypatch.setattr(ma, "make_api_client",
                        lambda protocol, **kw: _FakeClient(**kw))
    kwargs = ma.build_subagent_runtime(job)._api_client.init
    assert kwargs["model"] == "global-model"
    assert kwargs["api_key"] == "sk-global"


def test_explicit_job_workdir_beats_orchestrator_default():
    """spawn_agent 的 workdir 参数优先于编排器构造时的默认值。"""
    rec = RecordingSpawn()
    orch = AgentOrchestrator(Path(tempfile.mkdtemp()),
                             spawn_fn=rec, workdir="D:/default")
    orch.spawn_agent("d", "p", workdir="D:/override")
    assert rec.jobs[0].workdir == "D:/override"
    orch.spawn_agent("d", "p")
    assert rec.jobs[1].workdir == "D:/default"


# ------------------------------------------------------------
# 5. 闭环: spawn → complete → status / reap 读回 result
# ------------------------------------------------------------

def _spawn_and_complete(description="调查登录bug", prompt="读代码", result="bug 在 auth.py:42"):
    """spawn（经 handler, 会登记归属）→ 直接标记 completed（模拟 worker 收尾）。"""
    out = spawn_agent_tool({"description": description, "prompt": prompt})
    agent_id = out.split("agent_id: ")[1].split("\n")[0]
    fake_orchestrator_fixture = agent_tools._toolbox._orchestrator
    fake_orchestrator_fixture.complete_agent(agent_id, result)
    return agent_id


def test_status_roundtrip_after_complete():
    agent_id = _spawn_and_complete()
    data = json.loads(agent_status_tool({"agent_id": agent_id}))
    assert data["status"] == "completed"
    assert data["result"] == "bug 在 auth.py:42"
    assert data["delivered"] is False   # 还没收割


def test_status_running_state_hints_polling():
    out = spawn_agent_tool({"description": "d", "prompt": "p"})
    agent_id = out.split("agent_id: ")[1].split("\n")[0]
    status_out = agent_status_tool({"agent_id": agent_id})
    assert '"status": "running"' in status_out
    assert "Still running" in status_out


def test_list_shows_undelivered_marker():
    _spawn_and_complete()
    listing = agent_list_tool({})
    assert "(undelivered)" in listing


def test_list_after_reap_has_no_undelivered_marker():
    _spawn_and_complete()
    reap_ready_tool({})
    assert "(undelivered)" not in agent_list_tool({})


# ------------------------------------------------------------
# 6. 收割机制
# ------------------------------------------------------------

def test_reap_returns_result_and_marks_delivered():
    agent_id = _spawn_and_complete(result="结论: 内存泄漏在 cache.py")
    out = reap_ready_tool({})
    assert agent_id in out
    assert "内存泄漏在 cache.py" in out
    # 再收一次: 已标记 delivered, 不重复注入
    out2 = reap_ready_tool({})
    assert "no pending results" in out2
    # manifest 落盘状态正确
    data = json.loads(agent_status_tool({"agent_id": agent_id}))
    assert data["delivered"] is True


def test_reap_empty_state_message():
    assert "no pending results" in reap_ready_tool({})


def test_reap_skips_running_agents():
    spawn_agent_tool({"description": "慢任务", "prompt": "p"})   # 保持 running
    out = reap_ready_tool({})
    assert "no pending results" in out


def test_reap_collects_multiple_results():
    _spawn_and_complete(description="任务一", result="结果一")
    _spawn_and_complete(description="任务二", result="结果二")
    out = reap_ready_tool({})
    assert "结果一" in out and "结果二" in out


def test_reap_worker_with_empty_result():
    _spawn_and_complete(description="哑任务", result="")
    out = reap_ready_tool({})
    assert "returned no text" in out


# ------------------------------------------------------------
# 7. 会话隔离
# ------------------------------------------------------------

def test_reap_isolated_by_session(monkeypatch):
    """Web 多会话: A 会话派的任务, B 会话收不到。"""
    monkeypatch.setattr(agent_tools, "current_session_id", lambda: "sess-A")
    agent_id_a = _spawn_and_complete(result="A 的结果")

    monkeypatch.setattr(agent_tools, "current_session_id", lambda: "sess-B")
    out_b = reap_ready_tool({})
    assert "no pending results" in out_b       # B 收不到 A 的
    assert "A 的结果" not in out_b

    monkeypatch.setattr(agent_tools, "current_session_id", lambda: "sess-A")
    out_a = reap_ready_tool({})
    assert "A 的结果" in out_a
    assert agent_id_a in out_a


def test_cli_session_uses_default_bucket(monkeypatch):
    """CLI（current_session_id=None）的 spawn/reap 都走 DEFAULT_SESSION。"""
    monkeypatch.setattr(agent_tools, "current_session_id", lambda: None)
    agent_id = _spawn_and_complete(result="cli 结果")
    assert agent_id in _session_bindings[DEFAULT_SESSION]
    out = reap_ready_tool({})
    assert "cli 结果" in out


def test_current_session_id_reads_real_dispatch_binding():
    """回归钉子: 不 monkeypatch, 走真实 server.dispatch 绑定链路。

    曾经 TurnDispatch 没有 current_session_id 方法, AttributeError 被
    agent_tools 的兜底 except 吞掉恒返回 None——Web 端所有会话的 worker
    都落进 cli 桶, 会话隔离静默失效。"""
    from aulos.server import dispatch
    dispatch.bind(emit=lambda p: None, session_id="sess-real")
    try:
        assert agent_tools.current_session_id() == "sess-real"
    finally:
        dispatch.unbind()
    assert agent_tools.current_session_id() is None


# ------------------------------------------------------------
# 8. 孤儿对账（multi_agent.reconcile_orphans）
#    语义: "running" ≠ 孤儿。只有 owner 进程已死（或旧 manifest 无
#    owner_pid 记录）的 running 才是上次进程遗留的孤儿, 才标记 failed。
#    多进程共享 ~/.aulos/agents/ 时, 活进程正在跑的 worker 绝不能被
#    另一个进程的启动对账误杀（曾经的真实事故: 3 秒大的 worker 被误标,
#    跑完后 complete_agent 又把状态翻转回 completed, .md 里两段矛盾结果）。
# ------------------------------------------------------------

def _spawn_dead_pid_agent(orch, description="死 PID 孤儿"):
    """用确证已死的 PID 造一个真孤儿 manifest（模拟上次进程崩溃遗留）。"""
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()  # 确证退出
    rec = RecordingSpawn()
    orch2 = AgentOrchestrator(orch._store_dir, spawn_fn=rec)
    m = orch2.spawn_agent(description, "p", _owner_pid=proc.pid)
    return m


def test_reconcile_marks_dead_pid_running_as_failed():
    """真孤儿（owner PID 已死）→ 对账标记 failed。"""
    orch = agent_tools._toolbox._orchestrator
    m1 = _spawn_dead_pid_agent(orch, "孤儿一")
    m2 = _spawn_dead_pid_agent(orch, "孤儿二")
    n = orch.reconcile_orphans()
    assert n == 2
    s1 = orch.get_status(m1.agent_id)
    assert s1.status == "failed"
    assert "重启" in s1.error
    assert orch.get_status(m2.agent_id).status == "failed"


def test_reconcile_spares_running_of_live_process():
    """活进程正在跑的 worker 不被对账误杀（跨进程共享 store 的核心场景）。"""
    orch = agent_tools._toolbox._orchestrator
    rec = RecordingSpawn()
    orch2 = AgentOrchestrator(orch._store_dir, spawn_fn=rec)
    # 本测试进程还活着 → spawn_agent 默认记 owner_pid=os.getpid()
    m = orch2.spawn_agent("活进程的 worker", "p")
    n = orch.reconcile_orphans()
    assert n == 0
    assert orch.get_status(m.agent_id).status == "running"


def test_reconcile_legacy_manifest_without_owner_pid_treated_as_orphan():
    """旧版本 manifest 没有 owner_pid 字段 → 无法验尸, 按孤儿处理。"""
    orch = agent_tools._toolbox._orchestrator
    rec = RecordingSpawn()
    orch2 = AgentOrchestrator(orch._store_dir, spawn_fn=rec)
    m = orch2.spawn_agent("旧版遗留", "p")
    # 抹掉 owner_pid, 伪装成 5.1.1 时代写的 manifest
    json_path = orch._store_dir / f"{m.agent_id}.json"
    d = json.loads(json_path.read_text(encoding="utf-8"))
    assert "owner_pid" in d  # spawn 已在记录 owner（新行为生效的前提）
    del d["owner_pid"]
    json_path.write_text(json.dumps(d), encoding="utf-8")
    n = orch.reconcile_orphans()
    assert n == 1
    assert orch.get_status(m.agent_id).status == "failed"


def test_reconcile_keeps_terminal_states():
    agent_id = _spawn_and_complete()
    orch = agent_tools._toolbox._orchestrator
    n = orch.reconcile_orphans()
    assert n == 0
    assert orch.get_status(agent_id).status == "completed"


# ------------------------------------------------------------
# 9. 过期清理（multi_agent.cleanup_expired）
#    终态记录（completed/failed）在结果收割后没有留存价值, 永久累积
#    会拖慢 list_agents 的 glob+逐文件解析。只删超期的终态记录;
#    running/pending 与未过期的记录一律不动（worker 线程可能还在写）。
# ------------------------------------------------------------

def _age_manifest(orch, agent_id, days):
    """把 manifest 的 created_at 拨回 N 天前, 模拟旧记录。"""
    json_path = orch._store_dir / f"{agent_id}.json"
    d = json.loads(json_path.read_text(encoding="utf-8"))
    old = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    d["created_at"] = old
    d["started_at"] = old
    json_path.write_text(json.dumps(d), encoding="utf-8")


def test_cleanup_removes_old_terminal_records():
    """超期终态记录: 两个文件（.json + .md）都被删, 返回删除数。"""
    orch = agent_tools._toolbox._orchestrator
    old_id = _spawn_and_complete(description="过期记录", result="旧结果")
    fresh_id = _spawn_and_complete(description="新鲜记录")
    _age_manifest(orch, old_id, days=8)   # 超过 7 天
    removed = orch.cleanup_expired(retention_days=7)
    assert removed == 1
    assert not (orch._store_dir / f"{old_id}.json").exists()
    assert not (orch._store_dir / f"{old_id}.md").exists()
    # 新鲜的终态记录不受影响
    assert orch.get_status(fresh_id).status == "completed"


def test_cleanup_keeps_running_regardless_of_age():
    """running 记录哪怕很老也不能删（worker 可能还在写终态）。"""
    orch = agent_tools._toolbox._orchestrator
    rec = RecordingSpawn()
    orch2 = AgentOrchestrator(orch._store_dir, spawn_fn=rec)
    m = orch2.spawn_agent("很老的 running", "p", _owner_pid=os.getpid())
    _age_manifest(orch, m.agent_id, days=30)
    removed = orch.cleanup_expired(retention_days=7)
    assert removed == 0
    assert orch.get_status(m.agent_id).status == "running"


def test_cleanup_keeps_recent_failed_record():
    """未过期的 failed 记录保留（错误信息还在排查窗口内）。"""
    orch = agent_tools._toolbox._orchestrator
    rec = RecordingSpawn()
    orch2 = AgentOrchestrator(orch._store_dir, spawn_fn=rec)
    try:
        orch2.spawn_agent("", "")   # 空描述直接 ValueError, 不产生文件
    except ValueError:
        pass
    m = orch2.spawn_agent("新失败", "p", _owner_pid=1)  # PID 1 视为死 → 后续可标 failed
    orch2.reconcile_orphans()   # 把它标成 failed（终态）
    _age_manifest(orch, m.agent_id, days=2)   # 2 天, 未过期
    removed = orch.cleanup_expired(retention_days=7)
    assert removed == 0
    assert orch.get_status(m.agent_id).status == "failed"


def test_cleanup_removes_old_failed_record():
    """超期的 failed 记录同样清理。"""
    orch = agent_tools._toolbox._orchestrator
    rec = RecordingSpawn()
    orch2 = AgentOrchestrator(orch._store_dir, spawn_fn=rec)
    m = orch2.spawn_agent("老失败", "p", _owner_pid=1)
    orch2.reconcile_orphans()   # 标 failed
    _age_manifest(orch, m.agent_id, days=10)
    removed = orch.cleanup_expired(retention_days=7)
    assert removed == 1
    assert not (orch._store_dir / f"{m.agent_id}.json").exists()
    assert not (orch._store_dir / f"{m.agent_id}.md").exists()


def test_reconcile_also_runs_cleanup():
    """清理挂在对账之后: 启动时 reconcile_orphans 顺带清一次过期记录。"""
    orch = agent_tools._toolbox._orchestrator
    old_id = _spawn_and_complete(description="对账时顺带清理", result="旧")
    _age_manifest(orch, old_id, days=8)
    n = orch.reconcile_orphans()
    # 返回值仍是对账数（无孤儿）, 清理是副作用
    assert n == 0
    assert not (orch._store_dir / f"{old_id}.json").exists()


def test_cleanup_default_retention_is_seven_days():
    """缺省保留 7 天: 6 天前的记录保留, 8 天前的删除。"""
    orch = agent_tools._toolbox._orchestrator
    keep_id = _spawn_and_complete(description="六天前")
    drop_id = _spawn_and_complete(description="八天前")
    _age_manifest(orch, keep_id, days=6)
    _age_manifest(orch, drop_id, days=8)
    removed = orch.cleanup_expired()   # 不传参, 用缺省值
    assert removed == 1
    assert (orch._store_dir / f"{keep_id}.json").exists()
    assert not (orch._store_dir / f"{drop_id}.json").exists()


def test_reap_ready_ignores_delivered():
    orch = agent_tools._toolbox._orchestrator
    agent_id = _spawn_and_complete()
    assert len(orch.reap_ready()) == 1
    orch.mark_delivered([agent_id])
    assert orch.reap_ready() == []
    # delivered 重复标记幂等
    assert orch.mark_delivered([agent_id]) == 1


# ------------------------------------------------------------
# 9. API 配置工厂: 注入与回落
# ------------------------------------------------------------

def test_set_api_config_provider_overrides(monkeypatch):
    """注入的全局工厂覆盖默认。monkeypatch 自动还原——手工 set/还原
    会把中间态（3 元组/旧工厂）漏进后续用例的异步 worker 线程。"""
    import aulos.multi_agent as ma
    monkeypatch.setattr(ma, "_api_config_provider",
                        lambda: ("k", "http://x", "m-1", "anthropic"))
    assert ma._api_config_provider() == ("k", "http://x", "m-1", "anthropic")


def test_default_api_config_tolerates_empty_key(monkeypatch):
    """空串 key（Web 初始化页场景）不抛 RuntimeError, 只有缺失才抛。"""
    monkeypatch.setenv("API_KEY", "")
    from aulos.multi_agent import _default_api_config
    key, url, model = _default_api_config()
    assert key == ""


# ------------------------------------------------------------
# 10. agent_wait 工具层: 阻塞等待 + 终态直接返回结果
#     动机: Leader 逐轮 agent_status 轮询 = 每轮一整次 LLM 推理。
#     agent_wait 把等待压进一次工具调用的 Python 阻塞里。
# ------------------------------------------------------------

def _spawn_only(description="等待目标", prompt="p"):
    out = spawn_agent_tool({"description": description, "prompt": prompt})
    return out.split("agent_id: ")[1].split("\n")[0]


def test_wait_tool_spec_in_specs_and_registry():
    """spec ↔ handler ↔ 注册三方一致（与既有四件套同口径）。"""
    from aulos.main import build_registry
    names = [s["name"] for s in AGENT_TOOL_SPECS]
    assert names == ["agent_tool", "agent_status", "agent_wait",
                     "agent_reap", "agent_list"]
    registry = build_registry()
    assert "agent_wait" in registry._handlers


def test_wait_tool_absent_from_worker_whitelists():
    """递归防护: 白名单不含 agent_wait。"""
    from aulos.multi_agent import TOOL_WHITELIST
    for role, tools in TOOL_WHITELIST.items():
        assert "agent_wait" not in tools, f"{role}"


def test_wait_tool_returns_completed_result_directly():
    """已完成 → 一次调用直接拿到 result 全文（无需再 status/reap）。"""
    agent_id = _spawn_and_complete(result="终态结果原文")
    out = agent_wait_tool({"agent_ids": agent_id, "timeout_s": 10})
    assert '"status": "completed"' in out
    assert "终态结果原文" in out
    # 引导 Leader 收尾: 结果注入对话仍走 reap
    assert "agent_reap" in out


def test_wait_tool_blocks_until_terminal():
    """running 起步 → 中途 completed → wait 返回时已是终态。"""
    import threading, time as _t
    agent_id = _spawn_only()
    orch = agent_tools._toolbox._orchestrator

    def _late():
        _t.sleep(0.3)
        orch.complete_agent(agent_id, "迟到但完整")

    threading.Thread(target=_late, daemon=True).start()
    out = agent_wait_tool({"agent_ids": agent_id, "timeout_s": 10})
    assert '"status": "completed"' in out
    assert "迟到但完整" in out


def test_wait_tool_timeout_returns_running_with_retry_hint():
    """超时 → running 快照 + 明确的可重试指引, 不抛错。"""
    agent_id = _spawn_only("慢任务")
    out = agent_wait_tool({"agent_ids": agent_id, "timeout_s": 1})
    assert '"status": "running"' in out
    assert "agent_wait" in out   # 提示可以再次 wait


def test_wait_tool_multiple_ids_and_mode_any():
    """多 id: 逗号分隔字符串; mode=any 任一终态即返回。"""
    fast = _spawn_only("快")
    slow = _spawn_only("慢")
    orch = agent_tools._toolbox._orchestrator
    orch.complete_agent(fast, "快的结果")
    out = agent_wait_tool({"agent_ids": f"{slow},{fast}",
                           "timeout_s": 10, "mode": "any"})
    assert '"status": "completed"' in out
    assert "快的结果" in out


def test_wait_tool_requires_ids():
    assert "ERROR" in agent_wait_tool({})


def test_wait_tool_rejects_bad_mode():
    agent_id = _spawn_only()
    out = agent_wait_tool({"agent_ids": agent_id, "timeout_s": 1,
                           "mode": "sometimes"})
    assert "ERROR" in out


def test_wait_tool_timeout_clamped():
    """timeout_s 钳制到 [1, 600]: 传 0 不炸, 传负数也不炸。"""
    agent_id = _spawn_only()
    out = agent_wait_tool({"agent_ids": agent_id, "timeout_s": 0})
    assert "agent_id" in out   # 正常返回（running 快照或终态）, 非 ERROR


def test_wait_tool_unknown_id_errors():
    out = agent_wait_tool({"agent_ids": "ghost", "timeout_s": 1})
    assert "ERROR" in out and "ghost" in out


def test_spawn_text_now_recommends_wait_not_poll():
    """spawn 返回文案教 Leader 用 agent_wait（不再教轮询）。"""
    out = spawn_agent_tool({"description": "d", "prompt": "p"})
    assert "agent_wait" in out
    assert "Poll agent_status" not in out
