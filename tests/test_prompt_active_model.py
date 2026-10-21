# -*- coding: utf-8 -*-
"""环境段模型行 = 实际使用的模型, 不是构建期硬编码。

回归背景: 环境段曾是 `Model family: Claude Opus 4.6` 的字面常量
（prompt.rs 搬运残留）。配了 OpenAI 兼容端点（如 deepseek）的部署里,
系统提示仍然自称 Opus——模型从自己的提示里读到假身份, 用户问"你是
什么模型"时会照着念。钉住三条:

- 环境段只带占位符, build() 不固化任何模型名
- 发请求前按本次实际模型渲染（会话覆盖 > client.model）
- 模型未知时整行省略, 不退化成任何默认名
"""
import pytest

from aulos.prompt import (MODEL_PLACEHOLDER, SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
                          SystemPromptBuilder, render_active_model)


def _env_section(sections):
    return next(s for s in sections if s.startswith("# Environment"))


def test_build_leaves_placeholder_not_a_hardcoded_model():
    sections = SystemPromptBuilder().with_os("Darwin", "25").build()
    env = _env_section(sections)
    assert MODEL_PLACEHOLDER in env
    assert "Opus" not in env


def test_render_substitutes_active_model():
    sections = SystemPromptBuilder().with_os("Darwin", "25").build()
    rendered = _env_section(
        render_active_model(sections, "deepseek-v4.1-flash-1017"))
    assert "deepseek-v4.1-flash-1017" in rendered
    assert MODEL_PLACEHOLDER not in rendered
    assert "Opus" not in rendered


@pytest.mark.parametrize("model", [None, "", "   "])
def test_unknown_model_omits_the_line_entirely(model):
    sections = SystemPromptBuilder().with_os("Darwin", "25").build()
    rendered = _env_section(render_active_model(sections, model))
    assert MODEL_PLACEHOLDER not in rendered
    assert "Model" not in rendered
    # 其余环境行原样保留
    assert "Working directory" in rendered


def test_static_prefix_is_byte_identical_after_render():
    """模型行在缓存边界之后: 渲染不改变静态前缀, prompt caching 不受影响。"""
    sections = SystemPromptBuilder().with_os("Darwin", "25").build()
    rendered = render_active_model(sections, "some-model")
    i = sections.index(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    j = rendered.index(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    assert sections[:i] == rendered[:j]


def test_runtime_renders_session_model_not_hardcoded(monkeypatch):
    """会话模型覆盖优先于 client.model, 且随 set_model 立即变化。"""
    from aulos.runtime import ConversationRuntime
    from aulos.models import Session
    from aulos.permissions import PermissionMode, PermissionPolicy

    class _Client:
        model = "client-default-model"
        thinking_level = "high"

        def stream(self, system_prompt, messages, thinking_level=None, **kw):
            self.seen = system_prompt
            return []

    client = _Client()
    runtime = ConversationRuntime(
        session=Session(messages=[]),
        api_client=client,
        tool_executor=None,
        permission_policy=PermissionPolicy(PermissionMode.DANGER_FULL_ACCESS),
        system_prompt=SystemPromptBuilder().with_os("Darwin", "25").build(),
    )
    runtime.set_model("session-model")
    assert "session-model" in "\n".join(runtime._rendered_system_prompt())

    runtime.set_model(None)   # 回到跟随 client
    effective = "\n".join(runtime._rendered_system_prompt())
    assert "client-default-model" in effective
    assert "session-model" not in effective