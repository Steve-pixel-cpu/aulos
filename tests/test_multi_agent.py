"""multi_agent.py 的验收测试。

运行方式（在 aulos 目录下）:
    uv run pytest            # 全部
    uv run pytest -v         # 带用例名
    uv run pytest -k spawn   # 按关键字筛选用例

测试分两层:
- 已实现部分（白名单 / spawn 成功与失败路径）: 红了 = 有 bug，需要修
- 未实现部分（get_status / list_agents / name 推导）: 红了 = 还没写，照测试补
"""

import json
import threading
import time
from pathlib import Path

import pytest

from aulos.multi_agent import (
    SUBAGENT_TOOL_HANDLERS,
    TOOL_WHITELIST,
    AgentJob,
    AgentManifest,
    AgentOrchestrator,
    allowed_tools_for_subagent,
)


def test_every_whitelisted_tool_has_a_handler():
    """白名单里的工具名必须在 SUBAGENT_TOOL_HANDLERS 里有对应 handler,
    且在 TOOLS 里有规格——否则 worker 组装时静默跳过注册, 模型调到
    未注册工具才报错。实锤: grep/glob/web_search/web_fetch 曾长期缺席,
    explore worker 全部退化成只能 read_file 直读。"""
    from aulos.main import TOOLS
    spec_names = {s["name"] for s in TOOLS}
    for role, allowed in TOOL_WHITELIST.items():
        missing_handler = allowed - set(SUBAGENT_TOOL_HANDLERS)
        assert not missing_handler, f"{role} 白名单工具缺 handler: {missing_handler}"
        missing_spec = allowed - spec_names
        assert not missing_spec, f"{role} 白名单工具缺规格: {missing_spec}"


# ------------------------------------------------------------
# 工具: 假 spawn_fn — 只记录收到的 job，不真正启动任何东西
# ------------------------------------------------------------

class RecordingSpawn:
    """可编程的假 spawn_fn: 记录 job，可选地抛异常。"""

    def __init__(self, error: Exception | None = None):
        self.jobs: list[AgentJob] = []
        self._error = error

    def __call__(self, job: AgentJob) -> None:
        if self._error is not None:
            raise self._error
        self.jobs.append(job)


def make_orchestrator(store_dir, spawn_fn=None) -> tuple[AgentOrchestrator, RecordingSpawn]:
    rec = RecordingSpawn()
    orch = AgentOrchestrator(store_dir, spawn_fn=rec if spawn_fn is None else spawn_fn)
    return orch, (rec if spawn_fn is None else spawn_fn)


# ------------------------------------------------------------
# 1. 白名单
# ------------------------------------------------------------

def test_explore_is_read_only():
    tools = allowed_tools_for_subagent("explore")
    assert "read_file" in tools
    assert "bash" not in tools
    assert "write_file" not in tools


def test_build_subagent_runtime_rejects_handlerless_whitelist_tool(monkeypatch, tmp_path):
    """白名单含无 handler 的工具时组装必须当场炸, 不许静默跳过。
    （配错进 FAILED 可被 L2 兜底接住并暴露错误, 无声降级则整场半盲。）"""
    from aulos.multi_agent import AgentJob, AgentManifest, build_subagent_runtime
    from aulos.runtime import ConversationRuntime
    monkeypatch.setattr("aulos.multi_agent.make_api_client", lambda *a, **k: object())

    manifest = AgentManifest(
        agent_id="a-x", name="", description="d", subagent_type="explore",
        status="running", output_file="",
        created_at="2026-01-01T00:00:00+00:00",
        started_at=None, completed_at=None, error=None,
    )
    job = AgentJob(manifest=manifest, prompt="p",
                   allowed_tools={"read_file", "grep", "no_such_tool"})
    with pytest.raises(ValueError, match="no_such_tool"):
        build_subagent_runtime(job)


def test_verification_gets_bash_but_not_write():
    tools = allowed_tools_for_subagent("verification")
    assert "bash" in tools
    assert "write_file" not in tools


def test_no_whitelist_contains_agent_tool():
    for role, tools in TOOL_WHITELIST.items():
        assert "Agent" not in tools, f"角色 {role} 的白名单里出现了 Agent 工具"


def test_unknown_type_falls_back_to_general():
    assert allowed_tools_for_subagent("ninja-turtle") == TOOL_WHITELIST["general"]


def test_whitelist_not_polluted_by_job_mutation(tmp_path):
    """worker 改了自己手里的 allowed_tools 副本，不能影响全局白名单。"""
    orch, rec = make_orchestrator(tmp_path / "agents")
    orch.spawn_agent("d", "p", subagent_type="explore")
    job = rec.jobs[0]
    assert job.allowed_tools is not TOOL_WHITELIST["explore"]  # 递出去的必须是副本
    job.allowed_tools.add("write_file")
    assert TOOL_WHITELIST["explore"] == {"read_file", "grep", "glob"}  # 全局白名单不受影响


# ------------------------------------------------------------
# 2. spawn_agent 成功路径
# ------------------------------------------------------------

def test_spawn_returns_running_manifest(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    manifest = orch.spawn_agent("调查登录bug", "读代码找出原因", subagent_type="explore")

    assert manifest.status == "running"
    assert manifest.subagent_type == "explore"  # 归一化后的名字
    assert manifest.completed_at is None  # 未到终态不得填写
    assert manifest.error is None
    assert len(manifest.agent_id) == 12


def test_spawn_creates_md_and_json_pair(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    manifest = orch.spawn_agent("调查登录bug", "读代码找出原因")

    store = tmp_path / "agents"
    files = sorted(p.name for p in store.iterdir())
    assert files == [f"{manifest.agent_id}.json", f"{manifest.agent_id}.md"]

    md_text = (store / f"{manifest.agent_id}.md").read_text(encoding="utf-8")
    assert "读代码找出原因" in md_text
    assert manifest.agent_id in md_text


def test_manifest_json_round_trips(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    manifest = orch.spawn_agent("调查登录bug", "读代码找出原因", subagent_type="explore")

    raw = json.loads((tmp_path / "agents" / f"{manifest.agent_id}.json").read_text(encoding="utf-8"))
    restored = AgentManifest.model_validate(raw)
    assert restored.agent_id == manifest.agent_id
    assert restored.status == "running"


def test_spawn_passes_tools_and_prompt_copy_to_job(tmp_path):
    orch, rec = make_orchestrator(tmp_path / "agents")
    manifest = orch.spawn_agent("调查登录bug", "读代码找出原因", subagent_type="explore")

    job = rec.jobs[0]
    assert job.prompt == "读代码找出原因"
    assert job.allowed_tools == {"read_file", "grep", "glob"}
    assert job.manifest.agent_id == manifest.agent_id
    assert job.manifest is not manifest  # job 里的 manifest 必须是副本，不是同一个对象


def test_spawn_normalizes_type(tmp_path):
    orch, rec = make_orchestrator(tmp_path / "agents")
    manifest = orch.spawn_agent("d", "p", subagent_type="  Explore ")
    assert manifest.subagent_type == "explore"
    assert rec.jobs[0].allowed_tools == {"read_file", "grep", "glob"}


# ------------------------------------------------------------
# 3. spawn_agent 失败路径
# ------------------------------------------------------------

def test_spawn_rejects_empty_description(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    with pytest.raises(ValueError):
        orch.spawn_agent("   ", "p")


def test_spawn_rejects_empty_prompt(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    with pytest.raises(ValueError):
        orch.spawn_agent("d", "")


def test_spawn_fn_failure_raises_runtime_error_with_cause(tmp_path):
    """spawn_fn 崩溃 → RuntimeError，且保留原始异常链 (raise ... from e)。"""
    boom = RecordingSpawn(error=OSError("线程创建失败"))
    orch = AgentOrchestrator(tmp_path / "agents", spawn_fn=boom)
    with pytest.raises(RuntimeError) as excinfo:
        orch.spawn_agent("d", "p")
    assert isinstance(excinfo.value.__cause__, OSError)


def test_spawn_fn_failure_still_leaves_manifest_on_disk(tmp_path):
    """铁律: manifest 在 spawn_fn 之前落盘，spawn 失败也要能查到这个 agent。"""
    boom = RecordingSpawn(error=OSError("线程创建失败"))
    orch = AgentOrchestrator(tmp_path / "agents", spawn_fn=boom)
    with pytest.raises(RuntimeError):
        orch.spawn_agent("d", "p")
    jsons = list((tmp_path / "agents").glob("*.json"))
    assert len(jsons) == 1  # 失败了，但记账还在


# ------------------------------------------------------------
# 4. get_status（尚未实现 — 这些是验收标准）
# ------------------------------------------------------------

def test_get_status_reads_from_disk(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    manifest = orch.spawn_agent("调查登录bug", "读代码找出原因")
    status = orch.get_status(manifest.agent_id)
    assert isinstance(status, AgentManifest)
    assert status.agent_id == manifest.agent_id
    assert status.status == "running"


def test_get_status_unknown_id_raises_filenotfound(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    with pytest.raises(FileNotFoundError):
        orch.get_status("no-such-agent")


# ------------------------------------------------------------
# 5. list_agents（尚未实现 — 这些是验收标准）
# ------------------------------------------------------------

def test_list_agents_returns_all(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    m1 = orch.spawn_agent("任务一", "p1")
    m2 = orch.spawn_agent("任务二", "p2")
    agents = orch.list_agents()
    assert {a.agent_id for a in agents} == {m1.agent_id, m2.agent_id}


def test_list_agents_skips_corrupted_manifest(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    m1 = orch.spawn_agent("任务一", "p1")
    (tmp_path / "agents" / "zz-broken.json").write_text("{不是json", encoding="utf-8")
    agents = orch.list_agents()
    assert [a.agent_id for a in agents] == [m1.agent_id]  # 坏文件跳过，好的照常返回


def test_list_agents_empty_when_dir_missing(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "never-created")
    assert orch.list_agents() == []





# ------------------------------------------------------------
# 6. name 默认值（设计决定: 未提供时存空字符串，不做 slug）
# ------------------------------------------------------------

def test_name_defaults_to_empty_string(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    manifest = orch.spawn_agent("d", "p")
    assert manifest.name == ""  # 设计决定: None → ""，不许出现字面 None


def test_explicit_name_is_kept(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    manifest = orch.spawn_agent("d", "p", name="my-worker")
    assert manifest.name == "my-worker"


# ------------------------------------------------------------
# 7. 终态持久化（complete_agent / fail_agent / spawn 失败回填）
# ------------------------------------------------------------

def test_complete_agent_marks_completed_and_appends_result(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    m = orch.spawn_agent("d", "任务描述原文")
    orch.complete_agent(m.agent_id, "结论: bug 在第 42 行")

    status = orch.get_status(m.agent_id)
    assert status.status == "completed"
    assert status.completed_at is not None  # completed_at 只在终态填写
    assert status.error is None

    md = Path(status.output_file).read_text(encoding="utf-8")
    assert "第 42 行" in md       # 结果追加进了 .md
    assert "任务描述原文" in md   # 原任务描述还在 —— 是追加，不是覆盖


def test_fail_agent_records_error(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    m = orch.spawn_agent("d", "p")
    orch.fail_agent(m.agent_id, "线程崩了")

    status = orch.get_status(m.agent_id)
    assert status.status == "failed"
    assert status.error == "线程崩了"
    assert status.completed_at is not None  # failed 也是终态，同样盖时间戳


def test_spawn_fn_failure_marks_agent_failed_on_disk(tmp_path):
    """闭环: spawn 失败时用手里现成的 manifest 标记 failed，盘上可查。"""
    boom = RecordingSpawn(error=OSError("炸了"))
    orch = AgentOrchestrator(tmp_path / "agents", spawn_fn=boom)
    with pytest.raises(RuntimeError):
        orch.spawn_agent("d", "p")

    agents = orch.list_agents()
    assert len(agents) == 1
    assert agents[0].status == "failed"
    assert agents[0].error is not None


def test_terminal_ops_on_missing_id_raise(tmp_path):
    orch, _ = make_orchestrator(tmp_path / "agents")
    with pytest.raises(FileNotFoundError):
        orch.complete_agent("no-such-id", "r")
    with pytest.raises(FileNotFoundError):
        orch.fail_agent("no-such-id", "e")


# ------------------------------------------------------------
# 8. 终态不可降级覆盖（对账误标与 worker 正常收尾的竞争防线）
#    曾经的真实事故: 3 秒大的 worker 被另一进程的启动对账误标 failed,
#    82 秒后 worker 正常跑完, complete_agent 无条件覆盖 → 状态翻转,
#    .md 里留下两段矛盾 Result。终态一旦写入, 另一侧必须让步。
# ------------------------------------------------------------

def test_fail_agent_cannot_downgrade_completed(tmp_path):
    """completed 之后 fail_agent 到达: 状态保持 completed, 不翻转。"""
    orch, _ = make_orchestrator(tmp_path / "agents")
    m = orch.spawn_agent("d", "p")
    orch.complete_agent(m.agent_id, "正常完成的结果")

    orch.fail_agent(m.agent_id, "迟到的失败标记")

    status = orch.get_status(m.agent_id)
    assert status.status == "completed"        # 状态不被降级
    assert status.result == "正常完成的结果"    # 结果不被清掉
    assert status.error is None                # 错误不写进 manifest


def test_complete_agent_cannot_overwrite_failed(tmp_path):
    """failed 之后 complete_agent 到达: 状态保持 failed（先到先得）。"""
    orch, _ = make_orchestrator(tmp_path / "agents")
    m = orch.spawn_agent("d", "p")
    orch.fail_agent(m.agent_id, "先到的失败")

    orch.complete_agent(m.agent_id, "迟到的结果")

    status = orch.get_status(m.agent_id)
    assert status.status == "failed"
    assert status.error == "先到的失败"


# ------------------------------------------------------------
# 9. wait_agents（阻塞等待终态 — agent_wait 工具的编排层基座）
#    动机: Leader（LLM）每轮 agent_status 轮询 = 一整轮模型推理。
#    等待应发生在最便宜的层（Python 阻塞）, 而不是最贵的层（LLM 回合）。
# ------------------------------------------------------------

def test_wait_returns_immediately_when_already_completed(tmp_path):
    """终态已写入（Event 已 set）→ 立即返回 completed manifest, 不等满 timeout。"""
    orch, _ = make_orchestrator(tmp_path / "agents")
    m = orch.spawn_agent("d", "p")
    orch.complete_agent(m.agent_id, "结论: bug 在 auth.py:42")

    t0 = time.monotonic()
    out = orch.wait_agents([m.agent_id], timeout_s=10)
    elapsed = time.monotonic() - t0

    assert elapsed < 5          # 立即返回, 不是睡满 timeout
    assert len(out) == 1
    assert out[0].status == "completed"
    assert out[0].result == "结论: bug 在 auth.py:42"


def test_wait_unblocks_when_worker_completes_mid_wait(tmp_path):
    """等待中途 worker 写终态 → Event 触发解除阻塞（不是靠超时兜底返回）。"""
    orch, _ = make_orchestrator(tmp_path / "agents")
    m = orch.spawn_agent("d", "p")

    def _late_complete():
        time.sleep(0.3)
        orch.complete_agent(m.agent_id, "迟来的结果")

    threading.Thread(target=_late_complete, daemon=True).start()
    out = orch.wait_agents([m.agent_id], timeout_s=10)

    assert out[0].status == "completed"
    assert out[0].result == "迟来的结果"


def test_wait_timeout_returns_running_snapshot(tmp_path):
    """到时未完 → 返回 running 快照, 不抛错。"""
    orch, _ = make_orchestrator(tmp_path / "agents")
    m = orch.spawn_agent("慢任务", "p")

    out = orch.wait_agents([m.agent_id], timeout_s=1)

    assert len(out) == 1
    assert out[0].status == "running"


def test_wait_falls_back_to_disk_poll_without_event(tmp_path):
    """无内存 Event（模拟跨进程/重启后的 manifest）→ 读盘兜底轮询也能等到终态。"""
    orch, _ = make_orchestrator(tmp_path / "agents")
    m = orch.spawn_agent("d", "p")
    # 模拟"不是本进程派的": 清掉本进程 Event, 只留磁盘 manifest
    orch._events.clear()

    def _late_complete():
        time.sleep(0.3)
        # 直接写终态文件, 模拟另一进程的 worker 收尾
        fresh = orch.get_status(m.agent_id)
        from aulos.multi_agent import AgentStatus
        orch._persist_terminal_state(
            manifest=fresh, status=AgentStatus.COMPLETED.value,
            result="别的进程写的结果", error=None)

    threading.Thread(target=_late_complete, daemon=True).start()
    out = orch.wait_agents([m.agent_id], timeout_s=10)

    assert out[0].status == "completed"
    assert out[0].result == "别的进程写的结果"


def test_wait_mode_any_returns_on_first_terminal(tmp_path):
    """mode=any: 两个 agent, 一个先到终态就立即返回（两个都在结果里）。"""
    orch, _ = make_orchestrator(tmp_path / "agents")
    slow = orch.spawn_agent("慢", "p")
    fast = orch.spawn_agent("快", "p")
    orch.complete_agent(fast.agent_id, "先完成")

    t0 = time.monotonic()
    out = orch.wait_agents([slow.agent_id, fast.agent_id],
                           timeout_s=10, mode="any")
    elapsed = time.monotonic() - t0

    assert elapsed < 5
    by_id = {m.agent_id: m for m in out}
    assert by_id[fast.agent_id].status == "completed"
    assert by_id[slow.agent_id].status == "running"


def test_wait_mode_all_waits_for_every_agent(tmp_path):
    """mode=all（缺省）: 全部到终态才返回。"""
    orch, _ = make_orchestrator(tmp_path / "agents")
    a = orch.spawn_agent("a", "p")
    b = orch.spawn_agent("b", "p")
    orch.complete_agent(a.agent_id, "done")

    def _late():
        time.sleep(0.3)
        orch.fail_agent(b.agent_id, "炸了")

    threading.Thread(target=_late, daemon=True).start()
    out = orch.wait_agents([a.agent_id, b.agent_id], timeout_s=10)  # 缺省 all

    by_id = {m.agent_id: m for m in out}
    assert by_id[a.agent_id].status == "completed"
    assert by_id[b.agent_id].status == "failed"   # failed 也是终态, 等它


def test_wait_unknown_id_raises(tmp_path):
    """wait 不存在的 id: 与 get_status 同口径, 抛 FileNotFoundError。"""
    orch, _ = make_orchestrator(tmp_path / "agents")
    with pytest.raises(FileNotFoundError):
        orch.wait_agents(["ghost"], timeout_s=1)


def test_wait_failed_terminal_does_not_hang(tmp_path):
    """终态是 failed（Event 同样 set）→ 立即返回, 不挂到超时。"""
    orch, _ = make_orchestrator(tmp_path / "agents")
    m = orch.spawn_agent("d", "p")
    orch.fail_agent(m.agent_id, "启动就炸")

    out = orch.wait_agents([m.agent_id], timeout_s=10)
    assert out[0].status == "failed"
    assert out[0].error == "启动就炸"
