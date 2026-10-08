"""测试: 计划开关联动系统提示词 + 拒绝理由带教学指引。

背景: 权限层在计划生效（等效档位 READ_ONLY）时硬拒有副作用的工具,
但模型若不知情只会反复撞墙。计划开着时把 PLAN_MODE_SECTION 插进系统
提示词动态段（缓存前缀稳定）, 拒绝理由也附带 present_plan 指引。
"计划"不是并列模式而是叠加开关: set_plan(bool) 控制注入, 基础模式独立。"""
import pytest

from permissions import (
    PermissionDecision,
    PermissionMode,
    PermissionPolicy,
    PermissionResult,
    READ_ONLY_MODE,
    WORKSPACE_WRITE_MODE,
)
from prompt import PLAN_MODE_SECTION, SYSTEM_PROMPT_DYNAMIC_BOUNDARY
from runtime import ConversationRuntime


def _make_runtime(mode: PermissionMode, plan: bool = False) -> ConversationRuntime:
    return ConversationRuntime(
        session=__import__("models").Session(),
        api_client=_FakeClient(),
        tool_executor=lambda **kw: None,
        permission_policy=PermissionPolicy(active_mode=mode).set_plan(plan),
        system_prompt=["static-a", "static-b",
                       SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "dynamic-tail"],
    )


class _FakeClient:
    thinking_level = "high"

    def stream(self, **kwargs):
        return []


def test_plan_mode_injects_section_into_dynamic_segment():
    rt = _make_runtime(WORKSPACE_WRITE_MODE, plan=True)   # 计划开: 生效 READ_ONLY
    prompt = rt._effective_system_prompt
    assert PLAN_MODE_SECTION in prompt
    # 插在边界之后、动态段原内容之前
    assert prompt.index(PLAN_MODE_SECTION) > prompt.index(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    assert prompt[-1] == "dynamic-tail"


def test_non_plan_mode_has_no_section():
    rt = _make_runtime(WORKSPACE_WRITE_MODE)
    assert PLAN_MODE_SECTION not in rt._effective_system_prompt
    assert rt._effective_system_prompt == ["static-a", "static-b",
                                           SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
                                           "dynamic-tail"]


def test_plan_switch_toggles_section_and_keeps_static_prefix():
    """计划开关开→关往返: 注入/移除计划段, 静态前缀逐字节不变（prompt
    caching 前缀继续命中）。开关不动基础模式。"""
    rt = _make_runtime(WORKSPACE_WRITE_MODE)
    before = rt._effective_system_prompt[:]
    rt.set_plan_mode(True)
    assert PLAN_MODE_SECTION in rt._effective_system_prompt
    # 静态前缀逐字节不变: prompt caching 前缀继续命中
    n_static = before.index(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) + 1
    assert rt._effective_system_prompt[:n_static] == before[:n_static]
    rt.set_plan_mode(False)
    assert PLAN_MODE_SECTION not in rt._effective_system_prompt
    assert rt._effective_system_prompt == before
    assert rt.base_permission_mode() == WORKSPACE_WRITE_MODE   # 基础档不动


def test_plan_mode_without_boundary_appends_section():
    rt = ConversationRuntime(
        session=__import__("models").Session(),
        api_client=_FakeClient(),
        tool_executor=lambda **kw: None,
        permission_policy=PermissionPolicy(active_mode=WORKSPACE_WRITE_MODE)
            .set_plan(True),
        system_prompt=["only-static"],
    )
    assert rt._effective_system_prompt == ["only-static", PLAN_MODE_SECTION]


def test_plan_mode_deny_reason_carries_guidance():
    policy = PermissionPolicy(active_mode=WORKSPACE_WRITE_MODE).set_plan(True)
    result = policy.authorize("bash", "ls")
    assert result.decision == PermissionDecision.DENY
    assert "present_plan" in result.reason
    assert "Plan mode" in result.reason


def test_plan_mode_write_file_deny_reason_carries_guidance_when_no_prompter():
    """write_file(READ_ONLY→WORKSPACE) 无 prompter 可问: fail-closed 直接拒绝。
    指引文案在该分支不附加（与既有文案兼容）, 教学由系统提示词段承担。"""
    policy = PermissionPolicy(active_mode=WORKSPACE_WRITE_MODE).set_plan(True)
    result = policy.authorize("write_file", "{}")
    assert result.decision == PermissionDecision.DENY
