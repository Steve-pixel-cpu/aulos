# 排查任务：test_spawn_emits_started_and_done 顺序依赖失败（预先存在的测试串扰旧雷）

## 背景与已定性结论（先读这节）

上一个会话在交付 hooks/subagent 改造时，全量回归里撞见此用例失败。经排查，结论分两层：

**第一层（已修复，勿回退）**：`tests/test_agent_tools.py::test_set_api_config_provider_overrides` 原来用 `set_api_config_provider(lambda: ("k", "http://x", "m-1"))` 注入 **3 元组**全局工厂且手工还原——任何在它之后走到"api_config 回落全局工厂"路径的 worker 都会因解包 4 元组失败而死。已改为 `monkeypatch.setattr(ma, "_api_config_provider", ...)` + 4 元组（自动精确恢复）。**修完后反序双用例仍挂，所以它只是污染源之一，不是全部根因。这个修复本身是正确的，保留。**

**第二层（本任务的主目标，未修复）**：根因已定性为 **pytest 进程内累积的跨线程状态泄漏**——嫌疑集中在 dispatch 的 contextvar 绑定（`test_current_session_id_reads_real_dispatch_binding` 绑定 "sess-real" 再 unbind）与 `import aulos.server` 的模块级副作用（`set_subagent_event_bridge(_subagent_event_sink)` 设了全局 bridge 且无测试清理）与**全文件跑时 3 分钟里起过的真实后台 worker 线程**三者的交互。关键证据：**干净进程手工模拟同链路，事件齐飞**——代码路径本身是对的，雷在 pytest 运行时累积的状态。

## 你的任务

排查并修复第二层根因：让 `tests/test_subagent_events.py::test_spawn_emits_started_and_done` 在任何顺序下都不再依赖进程内残留状态。这是仓库里一个**预先存在**的测试串扰 bug（不是 hooks/subagent 改动引入的——已用 `git stash` 对照验证：bad5401 基线上改动前后同样失败）。修复它，并给出根因解释。

## 复现（100% 可复现，Windows + Git Bash 环境）

```bash
# 必挂（正序：worker_runtime 用例先跑）：
python -m pytest tests/test_agent_tools.py::test_worker_runtime_uses_job_api_config_over_global "tests/test_subagent_events.py::test_spawn_emits_started_and_done" -q -p no:randomly
# → 1 failed, 1 passed

# 必过（反序）：
python -m pytest "tests/test_subagent_events.py::test_spawn_emits_started_and_done" tests/test_agent_tools.py::test_worker_runtime_uses_job_api_config_over_global -q -p no:randomly
# → 2 passed

# 全文件跑也挂（agent_tools 全文件先跑）：
python -m pytest tests/test_agent_tools.py tests/test_subagent_events.py -q -p no:randomly
# → 1 failed, 63 passed（耗时 ~3 分钟，前面的 worker 测试起过真实后台线程）

# 注意：单独跑 spawn 用例本身永远通过。
```

## 失败现场

```
tests/test_subagent_events.py:185
E   AssertionError: assert 'subagent_event' in ['subagent_started']
```

即：spawn 同步路径发的 `subagent_started` 事件到了，但 **worker 线程镜像的 `subagent_event`（和终态 `subagent_done`）一个都没到**。`fake_worker.wait(timeout=5)` 是通过的（说明 stub 的 `run_turn` 确实执行了、`job.event_sink` 在 stub 内被调用过）——所以怀疑点在 **`job.event_sink` 本身是 None，或者 sink 调用链上事件没落到该用例的 `events` 列表**。

## 已排查过的事实（别重复走这些弯路）

1. **与 git 工作树无关**：`git stash` 后同样失败（bad5401 基线）。
2. **3 元组工厂污染**：见顶部"第一层"，已修复并验证不是唯一根因。
3. **干净的独立进程无法复现**：用 python 脚本手工模拟"先 build_subagent_runtime 一次 → 再走 spawn 全链路"，事件齐飞（`subagent_started` + 20 个 `subagent_event`）。**代码路径正确，差异在 pytest 运行环境累积的状态**（conftest fixture / monkeypatch / contextvar / 后台线程）——这是"第二层定性"的核心依据。
4. **二分结论**：`tests/test_agent_tools.py` 的前 27 个用例 + spawn 用例 → 全过；后 26 个 + spawn 用例 → 全过；**只有整个 agent_tools.py 文件先跑才挂**。且全文件跑耗时 3 分钟 vs 分批 3.5 秒——注意"整个文件跑"才有的东西：conftest 的模块级/per-module fixture、以及**起过真实后台 worker 线程的用例**（`test_multi_agent.py` 风格的 spawn 线程）。
5. **重点嫌疑（第二层根因的三要素，均未完全验证）**：
   - **contextvar 跨线程泄漏**：`tests/test_agent_tools.py::test_current_session_id_reads_real_dispatch_binding`（约 :398-412）在主线程绑定真实 `aulos.server.dispatch`（session_id="sess-real"）再 unbind。注意 `run_turn` 的取消检查、dispatch 绑定都靠 contextvar——**后台 worker 线程在 `copy_context()` 快照时可能捕走了别用例的绑定**；
   - **模块级 bridge 副作用**：`import aulos.server` 执行 `set_subagent_event_bridge(_subagent_event_sink)`（server.py:415 附近），把全局 bridge 设成"查 `_sessions` 字典"的函数且**没有任何测试清理**；
   - **慢机器异步窗口**：全文件跑 3 分钟 vs 分批 3.5 秒——前面用例起过的真实后台 worker 线程可能还没死透，它们触碰全局 orchestrator 单例/bridge 的时机与本用例重叠。
   spawn 用例自己会 `set_subagent_event_bridge(lambda sid: events.append)` 覆盖 bridge——所以若 bridge 是嫌疑，问题应在**覆盖之后又有什么把它变了**，或者 **`current_session_id()` 在 spawn 线程里返回了意外值**。
6. **相关机制**（读这些文件建立模型）：
   - `aulos/agent_tools.py`：`_current_event_sink()`（~:280，`_event_bridge(current_session_id() or DEFAULT_SESSION)`）、`set_subagent_event_bridge`、`current_session_id()`（经 server.dispatch 的 contextvar，绑定缺席返回 None）
   - `aulos/server.py`：模块级 `set_subagent_event_bridge(_subagent_event_sink)`（:415）、`_subagent_event_sink`（查 `_sessions` + `web_session.emits`，查不到返回 None）
   - `aulos/multi_agent.py`：`_default_spawn_fn._worker`（事件镜像经 `job.event_sink`）、`build_subagent_runtime`
   - `tests/test_subagent_events.py`：`fake_worker` fixture（:118-150，stub `_Runtime`）、用例本体（:152-183）

## 排查建议路径

1. 在 spawn 用例的 `spawn_agent_tool` 调用后、断言前，打印 `orch._store_dir` 下最新 manifest 与 `job.event_sink`（可临时 patch `ma.build_subagent_runtime` 的 fake_build 里加 `print(job.event_sink)`）——先分清 **sink 是 None** 还是 **sink 非 None 但事件进了别的列表**。
2. 若 sink 非 None：检查它是不是用例自设的 `events.append`（对比 `sys.modules` 里 `agent_tools._event_bridge.__name__`/闭包标识）——可能被**异步的旧 worker 线程**（前面 3 分钟里某个用例的 worker 在慢机器上还没死透）在终态调用了 `set_subagent_event_bridge` 相关清理，或 `orch` 单例被换回。
3. 若 sink 是 None：反向查 `_event_bridge` 何时刻被置 None / `current_session_id()` 返回了什么。可用 `pytest -p no:randomly` + 在 `current_session_id()` 里临时打印。

## 验收标准

- 复现命令（正序双用例）通过；反序仍通过；`python -m pytest tests/test_agent_tools.py tests/test_subagent_events.py -q -p no:randomly` 全绿。
- `python -m pytest -q` 全量跑，此用例不再出现在失败列表（允许有其他无关失败，但要把它们和这个雷区分开报告）。
- 修复落在测试侧（fixture 隔离/状态清理）或产品侧（bridge/contextvar 的清理接口），二选一要有理由；不许用"跳过/xfail/删断言"糊弄。
- 第一层的 3 元组工厂修复（test_set_api_config_provider_overrides 的 monkeypatch 版）必须保持原样，不许回退成手工 set/还原。
- 报告：根因一句话 + 为什么反序/分批不触发 + 修了什么。

## 环境备注

- Windows 11，Git Bash；pytest 跑法照抄上面的命令（`-p no:randomly` 必带，仓库装了 pytest-randomly 类插件时序会更乱）。
- 工作目录 `D:\pyworkplace\learn_claude\aulos`，虚拟环境 `.venv`（直接 `python -m pytest` 即可，已有解释器指向）。
- 输出噪音过滤：`[mcbridge]`/`[event-bridge]` 行是无关服务日志，忽略。
