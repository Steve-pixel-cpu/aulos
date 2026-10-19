"""委派预算护栏的规格钉子。

背景: 系统提示写明"broad 调研（3+ 文件 / 5+ 检索）必须委派 explore
worker", 实测模型仍在主对话串行 grep→read 累计 30+ 次、11+ 文件（每步
单独看都是 targeted read, 累积超标——提示词拦不住）。执行层兜: 本回合
只读调用数/去重触碰文件数超软档 → 结果附一次提醒; 超硬档 → 拒绝执行、
指路 agent_tool sweep。仅主对话 runtime 打开开关（worker 共用 _execute_tool
管线, 但组装时不打开——explore 的只读探查是合法主业）。新用户回合/压缩
激活清零; 写入介入不清零（管的是上下文预算, 不是文件新鲜度）。

触发口径: 计数达到阈值的那一次调用即触发（>=）; 软/硬档都是两个维度
（调用数、去重文件数）先到者生效。默认阈值 soft 5/3, hard 10/6。

运行: uv run pytest tests/test_delegation_limit.py -v
"""

from test_repeat_guard import (RecordingExecutor,  # noqa: E402
                               _run_tools, make_runtime)


def _budget_runtime(executor, **kw) -> "ConversationRuntime":
    """打开委派预算开关的 runtime（照 build_runtime 的 builder 接线）。"""
    return make_runtime(executor).with_delegation_budget(True, **kw)


def _calls_n(n: int, start: int = 0):
    """n 个不同参数的 read_file（去重文件数 = n）。"""
    return [("read_file", f'{{"path": "f{start + i}.py"}}') for i in range(n)]


# 默认阈值的隔离档位（只留一个维度, 让断言只依赖单一计数器）
_CALLS_ONLY = dict(soft_calls=5, hard_calls=10, soft_files=0, hard_files=0)
_FILES_ONLY = dict(soft_calls=0, hard_calls=0, soft_files=3, hard_files=6)

# ------------------------------------------------------------
# 开关语义: 默认关（worker 模式）, 打开后生效
# ------------------------------------------------------------

def test_开关关闭时永不拦_永不提醒():
    """worker runtime 与未接线的主对话都走默认关——explore 只读探查不受影响。"""
    ex = RecordingExecutor()
    rt = make_runtime(ex)                      # 未调用 with_delegation_budget
    outs = _run_tools(rt, _calls_n(20))
    assert all(o.content[0].is_error is False for o in outs)
    assert not any("Delegation budget" in o.content[0].output for o in outs)
    assert len(ex.executed) == 20


def test_开关打开_阈值内全部放行():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, soft_calls=15, hard_calls=25,
                         soft_files=10, hard_files=30)
    outs = _run_tools(rt, _calls_n(20))
    assert all(o.content[0].is_error is False for o in outs)
    assert len(ex.executed) == 20


def test_默认阈值下文件维度先到硬档():
    """默认 soft_files=3/hard_files=6: 6 个不同文件即拒绝——文件维度
    比调用维度（10）先触发。钉住真实默认行为。"""
    ex = RecordingExecutor()
    rt = _budget_runtime(ex)
    outs = _run_tools(rt, _calls_n(8))
    assert outs[4].content[0].is_error is False
    assert outs[5].content[0].is_error is True      # 第 6 个文件
    assert "REFUSED" in outs[5].content[0].output
    assert len(ex.executed) == 5


# ------------------------------------------------------------
# 软档: 计数达到 soft 阈值的那次附加一次提醒, 照常执行, 每回合封顶一条
# ------------------------------------------------------------

def test_软档提醒一次_结果照常_后续安静():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, **_CALLS_ONLY)    # soft_calls=5
    outs = _run_tools(rt, _calls_n(9))
    # 1~4 干净; 第 5 次（计数达 5）附提醒且非错误; 6~9 照常且不再提醒
    assert not any("Delegation budget" in o.content[0].output for o in outs[:4])
    assert "Delegation budget" in outs[4].content[0].output
    assert outs[4].content[0].is_error is False
    assert not any("Delegation budget" in o.content[0].output for o in outs[5:])
    assert all(o.content[0].is_error is False for o in outs)
    assert len(ex.executed) == 9               # 软档不拦执行


def test_软档双维度先到者触发_默认阈值下是文件维度():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex)                   # 默认 soft 5/3: 第 3 个文件先到
    outs = _run_tools(rt, _calls_n(6))
    assert "Delegation budget" in outs[2].content[0].output   # files=3
    assert outs[2].content[0].is_error is False
    assert not any("Delegation budget" in o.content[0].output
                   for i, o in enumerate(outs) if i != 2)    # 封顶一条


def test_软档文案含当前计数与硬档预告():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, **_CALLS_ONLY)
    outs = _run_tools(rt, _calls_n(5))
    text = outs[4].content[0].output
    assert "5 read-only" in text
    assert "subagent" in text.lower()
    assert "10" in text                        # 硬档预告


# ------------------------------------------------------------
# 硬档: 拒绝执行, 不触达执行器; 同回合一律拒绝
# ------------------------------------------------------------

def test_硬档拒绝_不触达执行器_后续持续拒绝():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, **_CALLS_ONLY)    # hard_calls=10
    outs = _run_tools(rt, _calls_n(13))
    # 1~9 执行; 第 10 次（计数达 10）起拒绝
    assert all(o.content[0].is_error is False for o in outs[:9])
    assert outs[9].content[0].is_error is True
    assert "REFUSED" in outs[9].content[0].output
    assert "subagent" in outs[9].content[0].output.lower()
    assert "next user turn" in outs[9].content[0].output
    assert all(o.content[0].is_error is True for o in outs[10:])
    assert len(ex.executed) == 9               # 拒绝的 4 次没到执行器


def test_文件数硬档_调用数未超也拦():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, **_FILES_ONLY)    # hard_files=6
    outs = _run_tools(rt, _calls_n(8))
    assert outs[4].content[0].is_error is False
    assert outs[5].content[0].is_error is True            # 第 6 个文件触发
    assert len(ex.executed) == 5


def test_同文件重读_文件数不涨_调用数照涨():
    """去重: 同一文件反复 read 只算 1 个文件, 但调用数照涨——切香肠式的
    "换个 offset 再看一眼"逃不过调用数档位。"""
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, soft_calls=0, hard_calls=8,
                         soft_files=0, hard_files=2)
    same = [("read_file", f'{{"path": "big.py", "offset": {i * 100}}}')
            for i in range(9)]         # 同文件不同范围: repeat guard 不误触
    outs = _run_tools(rt, same)
    # 文件数恒 1, 文件档（hard=2）不触发; 调用数第 8 次到硬档
    assert all(o.content[0].is_error is False for o in outs[:7])
    assert outs[7].content[0].is_error is True
    assert len(ex.executed) == 7


def test_路径写法归一_换写法同文件():
    """normpath+normcase 归一: './x/a.py' 与 'x/a.py' 同键, 换写法不涨
    文件数; grep/glob 缺省 path 提不出归因键（保守漏记, 只计调用数）。"""
    from aulos.runtime import _delegation_file_key
    assert (_delegation_file_key("read_file", '{"path": "./x/a.py"}')
            == _delegation_file_key("read_file", '{"path": "x/a.py"}'))
    assert _delegation_file_key("grep", '{"pattern": "p"}') is None
    assert _delegation_file_key("grep", '{"pattern": "p", "path": "src"}') is not None


# ------------------------------------------------------------
# grep/glob 同受约束; 非只读工具不计数
# ------------------------------------------------------------

def test_grep_glob计入预算():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, soft_calls=0, hard_calls=5,
                         soft_files=0, hard_files=0)
    grep = [("grep", f'{{"pattern": "foo{i}", "path": "s"}}') for i in range(6)]
    outs = _run_tools(rt, grep)
    assert outs[3].content[0].is_error is False
    assert outs[4].content[0].is_error is True            # 计数达 5
    assert len(ex.executed) == 4


def test_写入与bash不计数_委派预算不受变异介入影响():
    """与 repeat guard 的差异点: 写入不清零——预算管的是上下文消耗。
    bash 调用穿插其中, 只读调用数照常累计到硬档。"""
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, soft_calls=0, hard_calls=6,
                         soft_files=0, hard_files=0)
    calls = _calls_n(4)
    calls += [("write_file", '{"path": "w.py", "content": "x"}'),
              ("bash", '{"command": "python build.py"}')]
    calls += _calls_n(2, start=100)
    outs = _run_tools(rt, calls)
    # 只读调用恰好 6 个 → 第 6 个只读调用（槽位 7）被拒; 写/bash 照常
    assert outs[7].content[0].is_error is True
    assert outs[5].content[0].is_error is False        # write 照常
    assert outs[6].content[0].is_error is False        # bash 照常
    assert len(ex.executed) == 7


# ------------------------------------------------------------
# 清零: 新用户回合 / 压缩激活（写入不清零——上一测试已钉）
# ------------------------------------------------------------

def test_新回合清零_预算重发():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, soft_calls=0, hard_calls=6,
                         soft_files=0, hard_files=0)
    outs = _run_tools(rt, _calls_n(8))
    assert outs[5].content[0].is_error is True             # 第 6 个: 到硬档
    assert len(ex.executed) == 5

    # 新用户回合: run_turn 顶部清零, 这里手动模拟
    with rt._guard_lock:
        rt._delegation_calls = 0
        rt._touched_files.clear()
        rt._delegation_warned = False
    outs = _run_tools(rt, _calls_n(7, start=200))
    assert outs[4].content[0].is_error is False            # 第 5 个: 预算内
    assert outs[5].content[0].is_error is True             # 第 6 个: 又到硬档


def test_压缩激活清零():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, soft_calls=0, hard_calls=6,
                         soft_files=0, hard_files=0)
    _run_tools(rt, _calls_n(8))
    with rt._guard_lock:                       # 模拟 _activate_compact 的清零块
        rt._delegation_calls = 0
        rt._touched_files.clear()
        rt._delegation_warned = False
    (out,) = _run_tools(rt, _calls_n(1, start=300))
    assert out.content[0].is_error is False


# ------------------------------------------------------------
# 阈值 0 = 档位关闭; builder 链参数钳制
# ------------------------------------------------------------

def test_阈值为零_对应档位关闭():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, soft_calls=0, hard_calls=0,
                         soft_files=3, hard_files=0)       # 只剩文件软档
    outs = _run_tools(rt, _calls_n(20))
    assert all(o.content[0].is_error is False for o in outs)   # 永不拒
    assert "Delegation budget" in outs[2].content[0].output    # 第 3 个文件提醒
    assert not any("Delegation budget" in o.content[0].output
                   for i, o in enumerate(outs) if i != 2)     # 封顶一条
    assert len(ex.executed) == 20


def test_builder负数钳到零():
    ex = RecordingExecutor()
    rt = _budget_runtime(ex, soft_calls=-5, hard_calls=-1,
                         soft_files=0, hard_files=0)
    outs = _run_tools(rt, _calls_n(12))
    assert all(o.content[0].is_error is False for o in outs)   # 全档关闭
