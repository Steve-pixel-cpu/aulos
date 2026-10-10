"""测试: subagent 委派引导——让"派 worker 调查"成为模型的顺手选择。

背景（用户观察: aulos 很少自发派 subagent 调查, 但提示词明明写过）,
三个结构性原因各一条回归:
1. explore/plan worker 白名单只有 read_file——派出去的调查员连 grep/glob
   都没有, 大扫描任务必然低效, 模型"试过一次不划算"就不再派。
   修复: 只读 worker 配齐 grep/glob/read_file 三件套。
2. plan 模式把 agent_tool 当普通写工具硬拒（拒绝文案只教 read_file）——
   "先调研再计划"恰是委派的主场景, 却被权限层掐死。修复: 计划覆盖生效
   时, explore 委派按只读放行（worker 白名单本身只读, 无绕过面）。
3. 结论检查点只催"收敛", 不提委派选项——长调查螺旋里模型把"再查一条"
   当唯一出路。修复: 检查点文本给出"派 worker / 收敛作答"的分流指引。
"""
import json

import pytest

from multi_agent import TOOL_WHITELIST, allowed_tools_for_subagent
from permissions import (PermissionDecision, PermissionMode, PermissionPolicy,
                         READ_ONLY_MODE, WORKSPACE_WRITE_MODE)


# ------------------------------------------------------------
# 1. 只读 worker 的工具箱: 调查三件套
# ------------------------------------------------------------

def test_explore_worker_has_readonly_search_tools():
    assert {"read_file", "grep", "glob"} <= TOOL_WHITELIST["explore"]


def test_plan_worker_has_readonly_search_tools():
    assert {"read_file", "grep", "glob"} <= TOOL_WHITELIST["plan"]


def test_explore_whitelist_stays_readonly():
    """扩容只到只读三件套: bash/写工具绝不进 explore/plan——
    这是 plan 模式放行委派的安全前提（下组测试依赖它）。"""
    forbidden = {"bash", "powershell", "write_file", "edit_file",
                 "agent_tool", "web_fetch"}
    assert not (TOOL_WHITELIST["explore"] & forbidden)
    assert not (TOOL_WHITELIST["plan"] & forbidden)


def test_unknown_type_falls_back_to_general():
    assert allowed_tools_for_subagent("nope") == TOOL_WHITELIST["general"]


# ------------------------------------------------------------
# 2. plan 模式放行 explore 委派（只读无绕过面）
# ------------------------------------------------------------

def _plan_policy() -> PermissionPolicy:
    p = PermissionPolicy(WORKSPACE_WRITE_MODE)
    p.with_tool_requirement("agent_tool", WORKSPACE_WRITE_MODE)
    p.set_plan(True)
    return p


def test_plan_mode_allows_explore_spawn_without_prompter():
    """计划开着: 派 explore worker 不弹问直接放行——worker 白名单只读,
    委派本身就是调研手段, 掐死它等于逼模型自己一条条 grep。"""
    r = _plan_policy().authorize("agent_tool",
                                 json.dumps({"description": "扫描",
                                             "prompt": "只读调查",
                                             "subagent_type": "explore"}),
                                 None)
    assert r.decision == PermissionDecision.ALLOW


def test_plan_mode_still_denies_general_spawn():
    """general worker 能写文件——计划模式下委派它仍是写通道, 维持拒绝。"""
    r = _plan_policy().authorize("agent_tool",
                                 json.dumps({"description": "干活",
                                             "prompt": "改代码",
                                             "subagent_type": "general"}),
                                 None)
    assert r.decision == PermissionDecision.DENY


def test_plan_mode_denies_general_spawn_default_type():
    """不传 subagent_type 缺省 general（可写）——同样拒绝, 不留后门。"""
    r = _plan_policy().authorize("agent_tool",
                                 json.dumps({"description": "d",
                                             "prompt": "p"}),
                                 None)
    assert r.decision == PermissionDecision.DENY


def test_workspace_write_mode_unaffected():
    """非计划模式: agent_tool 档位未变, workspace-write 直接放行。"""
    p = PermissionPolicy(WORKSPACE_WRITE_MODE)
    p.with_tool_requirement("agent_tool", WORKSPACE_WRITE_MODE)
    r = p.authorize("agent_tool",
                    json.dumps({"description": "d", "prompt": "p",
                                "subagent_type": "general"}), None)
    assert r.decision == PermissionDecision.ALLOW


# ------------------------------------------------------------
# 3. 结论检查点带委派分流指引
# ------------------------------------------------------------

def test_checkpoint_text_mentions_delegation():
    from runtime import CONCLUSION_CHECKPOINT_TEXT
    low = CONCLUSION_CHECKPOINT_TEXT.lower()
    assert "delegate" in low or "subagent" in low
    # 既有语义保留: 对靶自查 + 收敛作答
    assert "original question" in low
    assert "final answer" in low
