import json
import os
import subprocess
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from aulos.config import RuntimeConfig


class HookEvent(Enum):
    PRE_TOOL_USE = "pre_tool_use"
    POST_TOOL_USE = "post_tool_use"
    TURN_START = "turn_start"
    TURN_END = "turn_end"
    SUBAGENT_DONE = "subagent_done"

class HookOutcome(Enum):
    ALLOW = "allow"
    DENY = "deny"
    WARN = "warn"

class HookResult(BaseModel):
    denied: bool
    messages: list[str] = Field(default_factory=list)

    @classmethod
    def allow(cls,messages: list[str] | None = None) -> "HookResult":
        return cls(denied= False, messages= messages or [])

    @classmethod
    def deny(cls, messages: list[str] | None = None) -> "HookResult":
        return cls(denied=True, messages=messages or [])


class HookRunner:

    def __init__(self, pre_tool_use: Optional[list[str]] = None,
                 post_tool_use: Optional[list[str]] = None,
                 turn_start: Optional[list[str]] = None,
                 turn_end: Optional[list[str]] = None,
                 subagent_done: Optional[list[str]] = None):
        self.pre_tool_use = pre_tool_use or []
        self.post_tool_use = post_tool_use or []
        # 生命周期事件（turn/subagent）: 通知性质, DENY 不阻断任何东西——
        # 回合已经发生/结束, 阻断没有意义; hook 的 stdout 会作为 system
        # note 附加进对话（见 runtime/multi_agent 的调用点）。
        self.turn_start = turn_start or []
        self.turn_end = turn_end or []
        self.subagent_done = subagent_done or []

    @classmethod
    def from_config(cls, config: RuntimeConfig) -> "HookRunner":
        """从 RuntimeConfig 加载。源码: hooks.rs:61-63"""
        return cls(
            pre_tool_use=config.hooks_pre(),
            post_tool_use=config.hooks_post(),
            turn_start=config.hooks_turn_start(),
            turn_end=config.hooks_turn_end(),
            subagent_done=config.hooks_subagent_done(),
        )

    def run_pre_tool_use(self, tool_name: str, tool_input: str) -> HookResult:
        return self._run_commands(
            event=HookEvent.PRE_TOOL_USE,
            commands = self.pre_tool_use,
            tool_name=tool_name,
            tool_input=tool_input,
            tool_output=None,
            is_error=False,
        )

    def run_post_tool_use(self, tool_name: str, tool_input: str, tool_output: str, is_error: bool) -> HookResult:
        return self._run_commands(
            event=HookEvent.POST_TOOL_USE,
            commands=self.post_tool_use,
            tool_name=tool_name,
            tool_input = tool_input,
            tool_output = tool_output,
            is_error= is_error
        )

    def run_turn_start(self) -> HookResult:
        """回合开始（用户消息已入列, 首次模型调用前）。无拒绝语义。"""
        return self._run_lifecycle_commands(HookEvent.TURN_START,
                                            self.turn_start)

    def run_turn_end(self, summary_text: str) -> HookResult:
        """回合终局（run_turn 返回前）。summary 摘要经 stdin 载荷下发。"""
        return self._run_lifecycle_commands(HookEvent.TURN_END,
                                            self.turn_end,
                                            payload_extra={"summary": summary_text[:2000]})

    def run_subagent_done(self, agent_id: str, subagent_type: str) -> HookResult:
        """worker 终态（completed/failed）时触发。独立线程内同步调用。"""
        return self._run_lifecycle_commands(
            HookEvent.SUBAGENT_DONE, self.subagent_done,
            payload_extra={"agent_id": agent_id, "subagent_type": subagent_type})

    def _run_lifecycle_commands(
        self,
        event: HookEvent,
        commands: list[str],
        payload_extra: Optional[dict] = None,
    ) -> HookResult:
        """生命周期事件的执行器: 复用 _run_command 的进程/超时/退出码语义,
        但载荷是事件字段而非工具字段; DENY 与 WARN 同等处理（只收集
        stdout 作为 note, 不阻断——终局事件阻断无意义）。"""
        if not commands:
            return HookResult.allow()
        messages = []
        for command in commands:
            outcome, message = self._run_command(
                command=command, event=event,
                tool_name="", tool_input="",
                tool_output=None, is_error=None,
                payload_extra=payload_extra or {},
                deny_is_refusal=False,
            )
            if message:
                messages.append(message)
        return HookResult.allow(messages=messages)

    def _run_command(
        self,
        command: str,
        event: HookEvent,
        tool_name: str,
        tool_input: str,
        tool_output: Optional[str],
        is_error: Optional[bool],
        payload_extra: Optional[dict] = None,
        deny_is_refusal: bool = True,
    ) -> tuple[HookOutcome, str]:
        # 构造传给 hook 的 JSON 数据（通过 stdin 传入）
        payload = {
            "hook_event_name": event.value,
            "tool_name": tool_name,
            "tool_input": tool_input,
            "tool_output": tool_output,
            "tool_result_is_error": is_error,
        }
        payload.update(payload_extra or {})
        payload = json.dumps(payload)
        # 设置环境变量（hook 脚本可以直接读取）
        env = os.environ.copy()
        env["HOOK_EVENT"] = event.value
        env["HOOK_TOOL_NAME"] = tool_name
        env["HOOK_TOOL_INPUT"] = tool_input
        env["HOOK_TOOL_IS_ERROR"] = "1" if is_error else "0"
        if tool_output is not None:
            env["HOOK_TOOL_OUTPUT"] = tool_output

        try:
            result = subprocess.run(
                ["sh", "-lc", command],  # 用 shell 执行命令
                input=payload,  # 通过 stdin 传入 JSON
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
                encoding="utf-8",
                errors="replace"
            )
            stdout = result.stdout.strip()
            stderr = result.stderr.strip()
            exit_code = result.returncode
            if exit_code == 0:
                # 退出码 0 → 允许
                return HookOutcome.ALLOW, stdout

            elif exit_code == 2:
                # 退出码 2 → 拒绝（生命周期事件下退化为通知, 不阻断）
                return HookOutcome.DENY, stdout

            else:
                # 其他退出码 → 警告（允许执行，但记录警告）
                warning = f"Hook `{command}` exited with status {exit_code}; allowing tool execution to continue"
                if stdout:
                    warning += f": {stdout}"
                elif stderr:
                    warning += f": {stderr}"

                return HookOutcome.WARN, warning

        except subprocess.TimeoutExpired:
            return HookOutcome.WARN, f"Hook `{command}` timed out"
        except Exception as e:
            return HookOutcome.WARN, f"Hook `{command}` failed: {e}"

    def _run_commands(
        self,
        event: HookEvent,
        commands: list[str],
        tool_name: str,
        tool_input: str,
        tool_output: Optional[str],
        is_error: Optional[bool],
    ) -> HookResult:
        if not commands:
            return HookResult.allow()

        messages = []
        for command in commands:
            outcome, message = self._run_command(
                command=command,
                event=event,
                tool_name=tool_name,
                tool_input=tool_input,
                tool_output=tool_output,
                is_error=is_error,
            )
            if outcome == HookOutcome.ALLOW:
                if message:
                    messages.append(message)
            elif outcome == HookOutcome.DENY:
                deny_message = message or f"{event.value} hook denied tool `{tool_name}`"
                messages.append(deny_message)
                return HookResult.deny(messages=messages)
            elif outcome == HookOutcome.WARN:
                messages.append(message)

        return HookResult.allow(messages=messages)


