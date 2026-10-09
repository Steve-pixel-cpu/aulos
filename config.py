import json
import os
from enum import Enum
from pathlib import Path
from typing import Literal, Optional, Any

from pydantic import BaseModel, Field

# 应用名与用户级目录的唯一来源: ~/.aulos（目录名跟 APP_NAME 走, 改名只动这一处）。
# 前身 x-code: 首次启动时若存在 ~/.aulos 且 ~/.aulos 不存在, 自动整体迁移
# （会话/设置/令牌/技能/宠物等全部数据, 见 _migrate_legacy_dir()）。
APP_NAME = "aulos"
LEGACY_APP_NAME = "x-code"
USER_DIR = Path.home() / ("." + APP_NAME)


def _migrate_legacy_dir() -> None:
    """一次性迁移: ~/.aulos → ~/.aulos（仅当旧目录存在且新目录不存在）。
    原子性: 同盘 rename, 瞬间完成; 迁移后旧目录不存在, 回滚 = 改回名字重跑。
    失败(跨盘/占用)不致命: 退回旧目录继续跑, 下次启动再试。"""
    legacy = Path.home() / ("." + LEGACY_APP_NAME)
    if not legacy.is_dir() or USER_DIR.exists():
        return
    try:
        legacy.rename(USER_DIR)
        print(f"[aulos] 已迁移用户数据: {legacy} -> {USER_DIR}")
    except OSError as e:
        print(f"[aulos] 用户数据迁移失败({e}), 继续使用旧目录 {legacy}")


_migrate_legacy_dir()
SETTINGS_FILE = USER_DIR / "settings.json"
# 记忆库（memory/store.py 读写; 与 settings.json 同目录同约定: 读-改-写, 不加锁）
MEMORY_FILE = USER_DIR / "memory.json"


class ConfigSource(Enum):
    USER = "user"         # 用户全局 (~/.aulos/settings.json)
    PROJECT = "project"   # 项目级别 (.claude/settings.json)
    LOCAL = "local"       # 本地个人 (.claude/settings.local.json)


class ConfigEntry(BaseModel):
    """一个配置文件的位置和来源"""
    source: ConfigSource
    path: Path
    model_config = {"Frozen": True, "arbitrary_types_allowed": True}


class ConfigError(Exception):
    def __init__(self, message: str, kind: str = "parse"):
        self.kind = kind  # "io" or "parse"
        super().__init__(message)


# 模型上下文窗口默认值: GLM-5.3 官方端点为 1M tokens。第三方中转可能砍到
# 128k/200k——配置 contextWindow 或 env CLAUDE_CONTEXT_WINDOW 调小,
# auto-compact 阈值随之收缩（未显式配置时 = 窗口 × COMPACT_THRESHOLD_RATIO）。
DEFAULT_CONTEXT_WINDOW = 1_000_000
COMPACT_THRESHOLD_RATIO = 0.75


# ============================================================================
# MCP 服务器配置: 三级配置里的 "mcpServers" key（与 Claude Code 格式兼容）
#
#   "mcpServers": {
#     "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] },
#     "docs":  { "type": "http", "url": "http://localhost:3000/mcp",
#                "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
#   }
#
# 深度合并由 deep_merge 天然支持: 用户级声明、项目级覆盖同名项。
# ============================================================================
class McpServerConfig(BaseModel):
    """一台 MCP 服务器的连接描述。type 缺省 = stdio（本地子进程）。"""
    name: str                                   # 配置里的 key, 用作工具名前缀
    transport: Literal["stdio", "http", "sse"] = "stdio"
    command: Optional[str] = None               # stdio: 可执行文件
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)   # stdio: 额外环境变量
    cwd: Optional[str] = None                   # stdio: 子进程工作目录
    url: Optional[str] = None                   # http/sse: 端点地址
    headers: dict[str, str] = Field(default_factory=dict)  # http/sse: 请求头
    timeout: int = 60                           # 单次工具调用超时（秒）


def expand_env_vars(value: Any) -> Any:
    """递归展开字符串里的 ${VAR} / $VAR。未定义的变量替换为空串——
    和 shell 行为一致, 配置里引用可选变量时不用写条件判断。"""
    if isinstance(value, str):
        return os.path.expandvars(value)
    if isinstance(value, list):
        return [expand_env_vars(v) for v in value]
    if isinstance(value, dict):
        return {k: expand_env_vars(v) for k, v in value.items()}
    return value


def _parse_mcp_servers(merged: dict) -> list[McpServerConfig]:
    """merged["mcpServers"] → McpServerConfig 列表。结构非法抛 ConfigError;
    单台服务器描述缺字段同样报错——MCP 配错应该响亮失败而不是静默丢弃。"""
    raw = merged.get("mcpServers")
    if raw is None:
        return []
    if not isinstance(raw, dict):
        raise ConfigError("mcpServers: expected JSON object keyed by server name",
                          kind="parse")

    servers: list[McpServerConfig] = []
    for name, spec in raw.items():
        if not isinstance(name, str) or not name.strip():
            raise ConfigError("mcpServers: server name must be a non-empty string",
                              kind="parse")
        if not isinstance(spec, dict):
            raise ConfigError(f"mcpServers.{name}: expected a JSON object",
                              kind="parse")

        spec = expand_env_vars(spec)
        raw_type = spec.get("type", "stdio")
        if raw_type in ("stdio", "http", "sse"):
            transport = raw_type
        else:
            raise ConfigError(
                f"mcpServers.{name}.type: unsupported transport '{raw_type}' "
                "(stdio/http/sse)", kind="parse")

        timeout = spec.get("timeout", 60)
        if not isinstance(timeout, int) or timeout <= 0:
            raise ConfigError(
                f"mcpServers.{name}.timeout: expected positive integer, got {timeout!r}",
                kind="parse")

        if transport == "stdio":
            command = spec.get("command")
            if not isinstance(command, str) or not command.strip():
                raise ConfigError(
                    f"mcpServers.{name}: stdio server requires 'command'", kind="parse")
            args = spec.get("args", [])
            env = spec.get("env", {})
            cwd = spec.get("cwd")
            if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
                raise ConfigError(f"mcpServers.{name}.args: must be an array of strings",
                                  kind="parse")
            if not isinstance(env, dict) or not all(
                    isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
                raise ConfigError(
                    f"mcpServers.{name}.env: must be an object of string→string",
                    kind="parse")
            if cwd is not None and not isinstance(cwd, str):
                raise ConfigError(f"mcpServers.{name}.cwd: must be a string", kind="parse")
            servers.append(McpServerConfig(
                name=name.strip(), transport="stdio",
                command=command, args=args, env=env, cwd=cwd, timeout=timeout))
        else:
            url = spec.get("url")
            if not isinstance(url, str) or not url.strip():
                raise ConfigError(
                    f"mcpServers.{name}: {transport} server requires 'url'", kind="parse")
            headers = spec.get("headers", {})
            if not isinstance(headers, dict) or not all(
                    isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
                raise ConfigError(
                    f"mcpServers.{name}.headers: must be an object of string→string",
                    kind="parse")
            servers.append(McpServerConfig(
                name=name.strip(), transport=transport, url=url,
                headers=headers, timeout=timeout))
    return servers


def deep_merge(target: dict, source: dict) -> dict:
    result = dict(target)

    for key, value in source.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            # 两边都是字典 → 递归合并
            result[key] = deep_merge(result[key], value)
        else:
            # 否则直接覆盖
            result[key] = value
    return result

class RuntimeFeatureConfig(BaseModel):
    hooks_pre_tool_use: list[str] = Field(default_factory=list)
    hooks_post_tool_use: list[str] = Field(default_factory=list)
    model: Optional[str] = None
    permission_mode: Optional[str] = None
    # 计划开关（与 permission_mode 独立叠加）: permissionMode 配成
    # "plan"/"read-only" 旧值时 = 基础模式 prompt + 计划开
    permission_plan: bool = False
    timeout: int = 30
    # 默认与 runtime.DEFAULT_MAX_ITERATIONS 对齐。10 是历史占位值，
    # 接线前从未生效——真放出来正常任务一轮就会被掐断
    max_iterations: int = 128
    # 模型上下文窗口（GLM-5.3 官方 1M; 第三方中转按实际窗口配）
    context_window: int = DEFAULT_CONTEXT_WINDOW
    # auto-compact 触发阈值。必须明显低于模型真实上下文窗口（还要给
    # max_tokens 留位）, 否则永远轮不到它触发——只会等 API 报 context
    # length。未显式配置时 = context_window × COMPACT_THRESHOLD_RATIO,
    # 在 parse_feature_config 里推导。
    token_budget: int = int(DEFAULT_CONTEXT_WINDOW * COMPACT_THRESHOLD_RATIO)
    # 默认 medium: 每轮思考预算 8192。high(16384) 下单轮思考的流式墙钟
    # 就有 50~60s, 且 GLM 系强制思考、思考内容不进历史——每轮循环都全额
    # 重付, 是长会话"思考很久不见动静"观感的大头。深任务按项目配
    # thinkingLevel 或 CLAUDE_THINKING_LEVEL 调高（会话内可随时切档）。
    thinking_level: str = "medium"
    # 单轮输出预算（含思考）。与 runtime.DEFAULT_TURN_OUTPUT_BUDGET 对齐:
    # 思考型模型一次大思考烧 8k~16k, 预算太紧会把轮次掐死在动手之前。
    turn_token_budget: int = 262_144
    # 回合内思考自动降档: 同一回合的工具迭代每越过 downshift_after_iterations
    # 的整数倍（20/40/…）, 思考档降一级（high→medium→low, 触底 low）。
    # 只影响当回合, 新回合恢复用户设定。长回合后段多是执行与收尾, 每轮
    # 全额思考预算（high=16k）只白烧墙钟——单回合 50 轮能拖出半小时纯思考。
    thinking_auto_downshift: bool = True
    downshift_after_iterations: int = 20
    # 迭代软收束提示: 回合迭代达到该值时注入一次 [System note], 提醒模型
    # 汇总已有证据、直接行动或作答。0 = 关闭。硬上限仍是 maxIterations。
    convergence_nudge_at: int = 30
    # read_file/grep 的行预算字符上限: 超限全文落盘 tool-outputs/<日期>/,
    # 会话里只留前 40(50) 行 + 落盘标记。读文件结果全量驻留是上下文膨胀
    # 的最大单一来源（实测单会话 read_file×87 + grep×55 全量进上下文）。
    tool_result_char_limit: int = 20_000
    # 同文件重读去重: 文件未变时的整读只回一行 unchanged（带首次读取时刻）,
    # 任何写入介入或文件变化即失效; offset/limit/force=true 永远给全文。
    reread_dedup: bool = True
    # MCP 服务器列表（配置 mcpServers key）。空列表 = 未配置, 零开销。
    mcp_servers: list[McpServerConfig] = Field(default_factory=list)

class RuntimeConfig(BaseModel):
    merged: dict = Field(default_factory=dict)
    loaded_entries: list[ConfigEntry] = Field(default_factory=list)
    feature_config: RuntimeFeatureConfig = Field(default_factory=RuntimeFeatureConfig)

    model_config = {"arbitrary_types_allowed": True}

    def get(self, key: str) -> Optional[Any]:
        return self.merged.get(key)



    def hooks_pre(self) -> list[str]:
        return self.feature_config.hooks_pre_tool_use

    def hooks_post(self) -> list[str]:
        return self.feature_config.hooks_post_tool_use

    def model(self) -> Optional[str]:
        return self.feature_config.model

    def thinking_level(self) -> str:
        return self.feature_config.thinking_level

    def permission_mode(self) -> Optional[str]:
        return self.feature_config.permission_mode

    def permission_plan(self) -> bool:
        return self.feature_config.permission_plan

    def timeout(self) -> int:
        return self.feature_config.timeout

    def token_budget(self) -> int:
        return self.feature_config.token_budget

    def context_window(self) -> int:
        return self.feature_config.context_window

    def max_iterations(self) -> int:
        return self.feature_config.max_iterations

    def turn_token_budget(self) -> int:
        return self.feature_config.turn_token_budget

    def thinking_auto_downshift(self) -> bool:
        return self.feature_config.thinking_auto_downshift

    def downshift_after_iterations(self) -> int:
        return self.feature_config.downshift_after_iterations

    def convergence_nudge_at(self) -> int:
        return self.feature_config.convergence_nudge_at

    def tool_result_char_limit(self) -> int:
        return self.feature_config.tool_result_char_limit

    def reread_dedup(self) -> bool:
        return self.feature_config.reread_dedup

    def mcp_servers(self) -> list["McpServerConfig"]:
        return self.feature_config.mcp_servers

    @staticmethod
    def empty() -> "RuntimeConfig":
        """空配置 — 用于测试或默认场景。源码: config.rs:251-257"""
        return RuntimeConfig()

class ConfigLoader:
    """
        参数:
            cwd: 当前工作目录（项目根目录）
            config_home: 用户配置目录（aulos 使用 ~/.aulos）
    """
    def __init__(self, cwd: Path, config_home: Path):
        self.cwd = cwd
        self.config_home = config_home



    def discover(self)  -> list[ConfigEntry]:

        return [
            # 用户全局配置（两个位置）
            ConfigEntry(source = ConfigSource.USER,path= self.config_home /".claude.json"),
            ConfigEntry(source =ConfigSource.USER, path=self.config_home / "settings.json"),
            # 项目配置（两个位置）
            ConfigEntry(source =ConfigSource.PROJECT, path=self.cwd / ".claude.json"),
            ConfigEntry(source =ConfigSource.PROJECT, path=self.cwd / ".claude"/ "settings.json"),
            # 本地配置（一个位置）
            ConfigEntry(source =ConfigSource.LOCAL, path=self.cwd / ".claude"/ "settings.local.json"),
        ]

    def parse_feature_config(self, merged: dict) -> RuntimeFeatureConfig:
        hooks = merged.get("hooks", {})
        if not isinstance(hooks, dict):
            raise ConfigError("hooks: expected JSON object", kind="parse")

        pre = hooks.get("PreToolUse", [])
        post = hooks.get("PostToolUse", [])
        if not isinstance(pre, list) or not isinstance(post, list):
            raise ConfigError("hooks.PreToolUse/PostToolUse: must be arrays", kind="parse")

        # permission_mode: CC 支持多种别名 (config.rs:511-518)
        # 只读模式已移除——配置值解析为 (基础模式名, 计划开关) 二元组。
        # "plan"/"read-only"/"default" 是旧版并列模式时代的写法: 归一为
        # 基础模式 prompt + 计划开（读-only 工作流由计划开关表达）。
        raw_mode = merged.get("permissionMode")
        permission_mode = None
        permission_plan = False
        if isinstance(raw_mode, str):
            mode_map = {
                "default": ("prompt", False),
                "plan": ("prompt", True), "read-only": ("prompt", True),
                "acceptEdits": ("workspace-write", False),
                "auto": ("workspace-write", False),
                "workspace-write": ("workspace-write", False),
                "dontAsk": ("danger-full-access", False),
                "danger-full-access": ("danger-full-access", False),
                # Web 设置页的"每次询问"是可持久化的全局默认（server 的
                # MODE_TO_NAME 会把 PROMPT_MODE 写成这个名）; 漏了它的话,
                # 设置页一选, 下次启动就直接 ConfigError
                "prompt": ("prompt", False),
            }
            if raw_mode not in mode_map:
                raise ConfigError(f"permissionMode: unsupported mode '{raw_mode}'", kind="parse")
            permission_mode, permission_plan = mode_map[raw_mode]

        # thinking_level: 思考深浅档位，budget 映射见 api_client.THINKING_LEVEL_TO_BUDGET
        raw_level = merged.get("thinkingLevel", "medium")
        if not isinstance(raw_level, str) or raw_level.strip().lower() not in (
            "low", "medium", "high", "max",
        ):
            raise ConfigError(f"thinkingLevel: unsupported level '{raw_level}'", kind="parse")

        # context_window: 模型真实上下文窗口, 决定 auto-compact 阈值的
        # 推导基数。tokenBudget 未显式配置时 = 窗口 × 0.75; 显式配置仍覆盖。
        context_window = merged.get("contextWindow", DEFAULT_CONTEXT_WINDOW)
        if not isinstance(context_window, int) or context_window <= 0:
            raise ConfigError(
                f"contextWindow: expected positive integer, got {context_window!r}",
                kind="parse",
            )
        raw_budget = merged.get("tokenBudget")
        if raw_budget is not None and (
                not isinstance(raw_budget, int) or raw_budget <= 0):
            raise ConfigError(
                f"tokenBudget: expected positive integer, got {raw_budget!r}",
                kind="parse",
            )
        token_budget = (raw_budget if raw_budget is not None
                        else int(context_window * COMPACT_THRESHOLD_RATIO))

        # 回合内思考自动降档与软收束提示（长回合延迟治理, 详见字段注释）
        raw_downshift = merged.get("thinkingAutoDownshift", True)
        if not isinstance(raw_downshift, bool):
            raise ConfigError(
                f"thinkingAutoDownshift: expected boolean, got {raw_downshift!r}",
                kind="parse",
            )
        downshift_after = merged.get("downshiftAfterIterations", 20)
        if not isinstance(downshift_after, int) or isinstance(downshift_after, bool) \
                or downshift_after <= 0:
            raise ConfigError(
                f"downshiftAfterIterations: expected positive integer, got {downshift_after!r}",
                kind="parse",
            )
        nudge_at = merged.get("convergenceNudgeAt", 30)
        if not isinstance(nudge_at, int) or isinstance(nudge_at, bool) or nudge_at < 0:
            raise ConfigError(
                f"convergenceNudgeAt: expected non-negative integer, got {nudge_at!r}",
                kind="parse",
            )
        raw_char_limit = merged.get("toolResultCharLimit", 20_000)
        if (not isinstance(raw_char_limit, int) or isinstance(raw_char_limit, bool)
                or raw_char_limit <= 0):
            raise ConfigError(
                f"toolResultCharLimit: expected positive integer, got {raw_char_limit!r}",
                kind="parse",
            )
        raw_dedup = merged.get("rereadDedup", True)
        if not isinstance(raw_dedup, bool):
            raise ConfigError(
                f"rereadDedup: expected boolean, got {raw_dedup!r}",
                kind="parse",
            )

        return RuntimeFeatureConfig(
            hooks_pre_tool_use=pre,
            hooks_post_tool_use=post,
            model=merged.get("model"),
            permission_mode=permission_mode,
            permission_plan=permission_plan,
            timeout=merged.get("timeout", 30),
            max_iterations=merged.get("maxIterations", 128),
            context_window=context_window,
            token_budget=token_budget,
            thinking_level=raw_level.strip().lower(),
            turn_token_budget=merged.get("turnTokenBudget", 262_144),
            thinking_auto_downshift=raw_downshift,
            downshift_after_iterations=downshift_after,
            convergence_nudge_at=nudge_at,
            tool_result_char_limit=raw_char_limit,
            reread_dedup=raw_dedup,
            mcp_servers=_parse_mcp_servers(merged),
        )

    @staticmethod
    def _read_json(path: Path) -> Optional[dict]:
        """读取 JSON 文件；空文件返回 {}，不存在或非法返回 None"""

        if not path.exists():
            return None

        is_legacy = path.name == ".claude.json"

        try:
            text = path.read_text(encoding="utf-8")
        except OSError as e:
            raise ConfigError(f"{path}: {e}", kind="io") from e

        # 空文件或纯空白 → 视为空配置
        if not text.strip():
            return {}

        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            if is_legacy:
                return None

            raise ConfigError(f"{path}: {e}", kind="parse") from e

        if not isinstance(data, dict):
            if is_legacy:
                return None
            raise ConfigError(f"{path}: top-level value must be a JSON object", kind="parse")

        return data

    @staticmethod
    def _apply_env_overrides(merged: dict) -> None:
        def _env_bool(value: str) -> bool:
            low = value.strip().lower()
            if low in ("1", "true", "yes", "on"):
                return True
            if low in ("0", "false", "no", "off"):
                return False
            raise ValueError(value)

        env_map = {
            "ANTHROPIC_API_KEY": "api_key",
            "CLAUDE_MODEL": "model",
            "CLAUDE_TIMEOUT": ("timeout", int),
            "CLAUDE_MAX_ITERATIONS": ("maxIterations", int),
            "CLAUDE_CONTEXT_WINDOW": ("contextWindow", int),
            "CLAUDE_TOKEN_BUDGET": ("tokenBudget", int),
            "CLAUDE_TURN_TOKEN_BUDGET": ("turnTokenBudget", int),
            "CLAUDE_THINKING_LEVEL": "thinkingLevel",
            "CLAUDE_THINKING_AUTO_DOWNSHIFT": ("thinkingAutoDownshift", _env_bool),
            "CLAUDE_DOWNSHIFT_AFTER_ITERATIONS": ("downshiftAfterIterations", int),
            "CLAUDE_CONVERGENCE_NUDGE_AT": ("convergenceNudgeAt", int),
            "CLAUDE_TOOL_RESULT_CHAR_LIMIT": ("toolResultCharLimit", int),
            "CLAUDE_REREAD_DEDUP": ("rereadDedup", _env_bool),
        }

        for key, target in env_map.items():
            value = os.getenv(key)
            if value is None:
                continue
            if isinstance(target, tuple):
                config_key, converter = target
                try:
                    merged[config_key] = converter(value)
                except ValueError as e:
                    raise ConfigError(
                        f"env {key}={value!r}: cannot convert to {converter.__name__}",
                        kind="parse",
                    )
            else:
                merged[target] = value

    def load(self) -> RuntimeConfig:
        """
        加载并合并所有配置。

            算法：
            1. 遍历所有可能的配置文件路径
            2. 跳过不存在的文件
            3. 读取存在的文件（JSON）
            4. 按优先级深度合并

        """
        merged: dict[str, Any] = {}
        loaded_entries: list[ConfigEntry] = []

        for entry in self.discover():
            content = self._read_json(entry.path)
            if content is None:
                continue
            merged = deep_merge(merged, content)
            loaded_entries.append(entry)

        self._apply_env_overrides(merged)

        # ★ Eager Feature Parsing — 加载完立刻解析
        feature_config = self.parse_feature_config(merged)

        return RuntimeConfig(
            merged = merged,
            loaded_entries = loaded_entries,
            feature_config= feature_config
        )







# ============================================================================
# aulos 用户设置: SETTINGS_FILE（~/.aulos/settings.json）
# 供应商配置的读写归口在此（providers / activeProvider 是其中的普通 key,
# 其余 key 原样保留——以后的用户级设置也放这个文件, 不再另起文件名）
# ============================================================================
def load_providers() -> dict:
    """读供应商配置; 无文件/损坏/缺 key = 未配置空态（不写盘,
    由前端初始化页引导填写）。没有 .env 之类的兜底来源。"""
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"active": {}, "providers": []}
    if not isinstance(data, dict) or not isinstance(data.get("providers"), list):
        return {"active": {}, "providers": []}
    active = data.get("activeProvider")
    return {"active": active if isinstance(active, dict) else {},
            "providers": data["providers"]}


def save_providers(cfg: dict) -> None:
    """写供应商配置: 读-改-写, 文件里其他 key 原样保留。"""
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    data["providers"] = cfg.get("providers", [])
    data["activeProvider"] = cfg.get("active") or {}
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# utilityProvider（settings.json 的 utilityProvider 键）: side-call（自动
# 命名/压缩摘要/会话记忆摘要）走它指向的供应商, 主循环不动——摘要、起
# 名这类整理型调用用便宜模型足够, 且与主循环不抢同一个 client。
UTILITY_PROVIDER_KEY = "utilityProvider"


def load_utility_provider() -> Optional[dict]:
    """读 side-call 专用供应商配置。

    settings.json: {"utilityProvider": {"provider": <providers 里的 id>,
    "model": "模型名"}}。未配置 / 指向不存在或被禁用的供应商 / 缺 key 或
    base_url = 返回 None（调用方回落主模型, 与未配置前行为一致）。
    返回 {"api_key", "base_url", "protocol", "model"}; base_url 原样返回,
    由调用方按协议 normalize_base_url（同 providers 主配置的口径）。"""
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    want = data.get(UTILITY_PROVIDER_KEY)
    if not isinstance(want, dict):
        return None
    provider_id = want.get("provider")
    prov = next((p for p in data.get("providers", [])
                 if isinstance(p, dict) and p.get("id") == provider_id), None)
    if not (prov and prov.get("enabled") and prov.get("api_key")
            and str(prov.get("base_url") or "").strip()):
        return None
    return {
        "api_key": prov.get("api_key"),
        "base_url": str(prov.get("base_url") or "").strip(),
        "protocol": prov.get("protocol"),
        "model": str(want.get("model") or "").strip() or None,
    }


def load_utility_provider_setting() -> dict:
    """读原始设置（设置页 UI 用, 不含解析出的 key/地址——那是
    load_utility_provider 的事）。返回 {"provider": <id|None>,
    "model": <名|None>}。"""
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"provider": None, "model": None}
    if not isinstance(data, dict):
        return {"provider": None, "model": None}
    want = data.get(UTILITY_PROVIDER_KEY)
    if not isinstance(want, dict):
        return {"provider": None, "model": None}
    return {"provider": want.get("provider") or None,
            "model": str(want.get("model") or "").strip() or None}


def save_utility_provider_setting(want: Optional[dict]) -> dict:
    """写原始设置: 读-改-写保留文件里其他 key。provider 为空 = 清除
    （整键删除, 回落主模型）。返回清洗后的生效设置。"""
    cleaned = {"provider": None, "model": None}
    if isinstance(want, dict):
        cleaned = {"provider": str(want.get("provider") or "").strip() or None,
                   "model": str(want.get("model") or "").strip() or None}
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    if cleaned["provider"] is None:
        data.pop(UTILITY_PROVIDER_KEY, None)
    else:
        data[UTILITY_PROVIDER_KEY] = cleaned
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return cleaned


# 命令前缀白名单: 与供应商配置同文件（commandAllowlist 键）, 读-改-写
# 保留其他 key。规则是 shell 词序前缀（如 "git push"、"uv run pytest"）,
# 授权层按词对齐匹配——见 permissions.shell_command_matches_allowlist。
ALLOWLIST_KEY = "commandAllowlist"
ALLOWLIST_MAX_RULES = 100
ALLOWLIST_MAX_RULE_LEN = 200


def load_command_allowlist() -> list:
    """读命令白名单规则; 无文件/损坏/形状不对 = 空列表。"""
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rules = data.get(ALLOWLIST_KEY) if isinstance(data, dict) else None
    if not isinstance(rules, list):
        return []
    out: list = []
    for r in rules:
        if isinstance(r, str) and r.strip():
            out.append(r.strip())
    return out[:ALLOWLIST_MAX_RULES]


def save_command_allowlist(rules: list) -> list:
    """写命令白名单: 去重保序、逐条清洗, 返回清洗后的生效列表。
    读-改-写保留 settings.json 里其他 key。"""
    out: list = []
    seen: set = set()
    for r in (rules or []):
        if not isinstance(r, str):
            continue
        cleaned = " ".join(r.split())   # 压掉内部多余空白
        if not cleaned or len(cleaned) > ALLOWLIST_MAX_RULE_LEN:
            continue
        if cleaned.lower() in seen:
            continue
        seen.add(cleaned.lower())
        out.append(cleaned)
        if len(out) >= ALLOWLIST_MAX_RULES:
            break
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    data[ALLOWLIST_KEY] = out
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


# 附加工作目录（additionalDirectories 键）: 写路径分级（permissions.
# classify_write_path）除了会话工作目录外还放行这些目录——跨仓库协作
# 时"允许并记住该目录"免逐次审批。审批卡按钮写入, 设置页可增删。
ADDITIONAL_DIRS_KEY = "additionalDirectories"
ADDITIONAL_DIRS_MAX = 50
ADDITIONAL_DIR_MAX_LEN = 400


def load_additional_directories() -> list:
    """读附加目录列表; 无文件/损坏/形状不对 = 空列表。"""
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    dirs = data.get(ADDITIONAL_DIRS_KEY) if isinstance(data, dict) else None
    if not isinstance(dirs, list):
        return []
    return [d.strip() for d in dirs
            if isinstance(d, str) and d.strip()][:ADDITIONAL_DIRS_MAX]


def save_additional_directories(dirs: list) -> list:
    """写附加目录: 去重保序（normcase 归一——Windows 大小写不敏感）、
    逐条清洗限长, 返回生效列表。读-改-写保留 settings.json 其他 key。"""
    out: list = []
    seen: set = set()
    for d in (dirs or []):
        if not isinstance(d, str):
            continue
        cleaned = d.strip()
        if not cleaned or len(cleaned) > ADDITIONAL_DIR_MAX_LEN:
            continue
        key = os.path.normcase(cleaned)
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
        if len(out) >= ADDITIONAL_DIRS_MAX:
            break
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    data[ADDITIONAL_DIRS_KEY] = out
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def _load_string_list(key: str, max_items: int, max_len: int) -> list:
    """按 allowlist 口径读字符串列表; 无文件/损坏/形状不对 = 空列表。"""
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = data.get(key) if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [x.strip() for x in items
            if isinstance(x, str) and x.strip()][:max_items]


def _save_string_list(key: str, items: list, max_items: int,
                      max_len: int, *, normcase_dedupe: bool = False) -> list:
    """按 allowlist 口径写字符串列表: 清洗/去重保序/限长, 读-改-写
    保留 settings.json 其他 key。normcase_dedupe 用于路径类键。"""
    out: list = []
    seen: set = set()
    for raw in (items or []):
        if not isinstance(raw, str):
            continue
        cleaned = " ".join(raw.split())
        if not cleaned or len(cleaned) > max_len:
            continue
        k = os.path.normcase(cleaned) if normcase_dedupe else cleaned.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(cleaned)
        if len(out) >= max_items:
            break
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    data[key] = out
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


# deny 规则(P3): 任一命令段命中前缀即整体拒绝, 优先于一切 allow。
# 用于表达例外——"git push" 已加白但 "git push --force" 永不执行。
DENYLIST_KEY = "commandDenylist"


def load_command_denylist() -> list:
    return _load_string_list(DENYLIST_KEY, ALLOWLIST_MAX_RULES,
                             ALLOWLIST_MAX_RULE_LEN)


def save_command_denylist(rules: list) -> list:
    return _save_string_list(DENYLIST_KEY, rules, ALLOWLIST_MAX_RULES,
                             ALLOWLIST_MAX_RULE_LEN)


# 用户声明的敏感路径(P5): 绝对路径或相对 workspace 根的路径; 写入或被
# 破坏族点名即 sensitive, 与内置清单(.git/~/.ssh/shell 配置)同一语义。
SENSITIVE_PATHS_KEY = "sensitivePaths"
SENSITIVE_PATHS_MAX = 50
SENSITIVE_PATH_MAX_LEN = 400


def load_sensitive_paths() -> list:
    return _load_string_list(SENSITIVE_PATHS_KEY, SENSITIVE_PATHS_MAX,
                             SENSITIVE_PATH_MAX_LEN)


def save_sensitive_paths(paths: list) -> list:
    return _save_string_list(SENSITIVE_PATHS_KEY, paths, SENSITIVE_PATHS_MAX,
                             SENSITIVE_PATH_MAX_LEN, normcase_dedupe=True)
