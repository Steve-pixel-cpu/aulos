# server_settings.py — REST: 设置 / 供应商 / Skills / 记忆 / MCP 管理
# （server 包拆分的又一个功能域）
#
# 设置页主要分区的读写端点。共享可变态（_provider_cfg / api_client /
# runtime_config / registry / _sessions）全部经 `import server` 后按
# 属性访问（call-time 解析）: 这些名字在 server.py 里会被 rebind 或被
# 测试 monkeypatch, 导入期 from-import 会把引用钉死在旧对象上。
# 路由挂在 server_common.app 上, server.py import 本模块完成注册。
"""Aulos web — 设置/供应商/Skills/记忆/MCP 管理 REST。"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import anthropic
from fastapi import HTTPException

from server_common import app
from api_client import (KNOWN_PROTOCOLS, THINKING_LEVELS,
                        normalize_protocol)
from config import (SETTINGS_FILE, USER_DIR, ConfigLoader,
                    load_utility_provider, load_utility_provider_setting,
                    save_providers, save_utility_provider_setting)
from mcp_client import MCP_TOOL_PREFIX, get_mcp_manager
from permissions import MODE_TO_NAME, NAME_TO_MODE, PermissionMode
from skills import (SkillError, delete_user_skill, discover_skills,
                    install_from_repo, register_skill_tools, skill_info,
                    sync_skill_tools)
import server


# ============================================================================
# Skills 管理: 清单查看 + 社区仓库安装 + 卸载（设置页"Skills"分区）
# 安装/卸载都会 _resync_session_prompts: 已开 Web 会话的下一轮即生效,
# 与 MCP 热重载同一体验。
# ============================================================================

def _resync_session_prompts() -> None:
    """skills 安装/卸载后热生效: 所有活跃会话按其工作目录重建系统提示。
    runtime 持有的是 sections 列表副本, 必须显式整体替换（set_system_prompt）,
    改外部变量不会被已组装的 runtime 看到。只认真正的 ConversationRuntime——
    测试里会往 _sessions 塞鸭子类型的替身, 它们没有这套接口。"""
    from runtime import ConversationRuntime
    for ws in list(server._sessions.values()):
        if not isinstance(ws.runtime, ConversationRuntime):
            continue
        ws.runtime.set_system_prompt(server._session_system_prompt(ws.workdir))


def _rebind_skill_tools() -> None:
    """skills 安装/卸载后换绑 skill_read 的 handler 到 _inner（理由同
    _attach_mcp_tools: execute 走 _inner, 挂外层壳永远调不到）。
    TOOLS 里 skill_read spec 的增删由 sync_skill_tools 完成。"""
    sync_skill_tools(server.TOOLS, discover_skills(Path.cwd(), server.USER_DIR))
    register_skill_tools(server.registry._inner,
                         discover_skills(Path.cwd(), server.USER_DIR))


@app.get("/api/skills")
async def api_get_skills(workdir: Optional[str] = None):
    """已安装技能清单（设置页 Skills 分区 + 聊天框斜杠补全数据源; 含项目级,
    标 source 供 UI 区分）。带 workdir 时按该目录发现项目级技能——Web 会话
    的技能因项目而异, 补全菜单要跟当前会话的工作目录走; 无效路径回退 cwd。"""
    wd = Path(workdir.strip()) if (workdir or "").strip() else Path.cwd()
    if not wd.is_dir():
        wd = Path.cwd()
    skills = discover_skills(wd, server.USER_DIR, on_error=lambda msg: None)
    return {"skills": skill_info(skills)}


@app.post("/api/skills/install")
async def api_install_skills(request: dict):
    """从 GitHub 仓库安装社区 skills: git clone → 解析 SKILL.md → 拷入
    ~/.aulos/skills/。body: {repo, subpath?, overwrite?}。
    仓库布局三种都认: 根目录即技能 / subpath 指向单个技能 / skills/*/ 一仓多技能。"""
    repo = str(request.get("repo") or "").strip()
    subpath = str(request.get("subpath") or "").strip()
    overwrite = bool(request.get("overwrite", False))
    if not repo:
        raise HTTPException(status_code=400, detail="repo 不能为空")
    try:
        installed = install_from_repo(repo, server.USER_DIR,
                                      subpath=subpath, overwrite=overwrite)
    except SkillError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"安装失败: {e}")
    sync_skill_tools(server.TOOLS, discover_skills(Path.cwd(), server.USER_DIR))
    _rebind_skill_tools()
    _resync_session_prompts()
    return {"ok": True, "installed": skill_info(installed)}


@app.delete("/api/skills/{name}")
async def api_delete_skill(name: str):
    """卸载用户级技能。项目级技能在仓库里, 这里不动——提示去仓库管理。"""
    try:
        delete_user_skill(name, server.USER_DIR)
    except SkillError as e:
        msg = str(e)
        if "不存在" in msg:
            project_dir = Path.cwd() / ".claude" / "skills" / name
            if project_dir.is_dir():
                raise HTTPException(
                    status_code=400,
                    detail=f"{name} 是项目级技能（位于 {project_dir}）, "
                           "请在项目仓库里管理")
        raise HTTPException(status_code=400, detail=msg)
    sync_skill_tools(server.TOOLS, discover_skills(Path.cwd(), server.USER_DIR))
    _rebind_skill_tools()
    _resync_session_prompts()
    return {"ok": True}


# --- 记忆管理: 设置页"记忆"分区 + CLI /memory 共用同一 store 单例 ---

@app.get("/api/memory")
async def api_get_memory():
    """全部记忆（updated_at 降序）+ 淘汰归档概要。"""
    from memory.tools import get_memory_store
    store = get_memory_store()
    mems = store.list_memories()
    return {"memories": mems,
            "evicted_count": len(store._load().get("evicted", []))}


@app.post("/api/memory")
async def api_add_memory(request: dict):
    """手动添加（source=user, 永不被自动淘汰）。"""
    from memory.tools import get_memory_store
    content = " ".join(str(request.get("content") or "").split())
    if not content:
        raise HTTPException(status_code=400, detail="content 不能为空")
    category = str(request.get("category") or "fact")
    if category not in ("preference", "fact", "context"):
        category = "fact"
    m = get_memory_store().add(content=content, category=category, source="user")
    return {"memory": m}


@app.patch("/api/memory/{memory_id}")
async def api_update_memory(memory_id: str, request: dict):
    from memory.tools import get_memory_store
    content = " ".join(str(request.get("content") or "").split())
    if not content:
        raise HTTPException(status_code=400, detail="content 不能为空")
    m = get_memory_store().update(memory_id, content)
    if m is None:
        raise HTTPException(status_code=404, detail=f"记忆不存在: {memory_id}")
    return {"memory": m}


@app.delete("/api/memory/{memory_id}")
async def api_delete_memory(memory_id: str):
    from memory.tools import get_memory_store
    if not get_memory_store().remove(memory_id):
        raise HTTPException(status_code=404, detail=f"记忆不存在: {memory_id}")
    return {"ok": True}


# --- MCP 管理: 状态查看 + 热重载 + 服务器 CRUD（设置页"MCP 服务器"分区） ---

@app.get("/api/mcp/status")
async def api_mcp_status():
    """各 MCP 服务器连接状态与工具清单（排查配置问题用）。"""
    return {"servers": get_mcp_manager().status()}


def _mcp_servers_setting() -> dict:
    """读 settings.json 的 mcpServers 原始字典。缺失/坏类型都归 {}。"""
    try:
        data = json.loads(server.SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    raw = data.get("mcpServers") if isinstance(data, dict) else None
    return raw if isinstance(raw, dict) else {}


@app.get("/api/mcp/servers")
async def api_get_mcp_servers():
    """配置视图（mcpServers 原样）+ 运行视图（连接状态）合一下发。"""
    return {"mcpServers": _mcp_servers_setting(),
            "status": get_mcp_manager().status()}


def _validate_mcp_entry(name: str, spec: dict) -> None:
    """保存前校验一台服务器描述; 口径与 config._parse_mcp_servers 一致,
    让"能保存的配置"重启后必能被加载。"""
    transport = spec.get("type", "stdio")
    if transport not in ("stdio", "http", "sse"):
        raise HTTPException(status_code=400,
                            detail=f"{name}: type 只支持 stdio / http / sse")
    timeout = spec.get("timeout", 60)
    if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0:
        raise HTTPException(status_code=400,
                            detail=f"{name}: timeout 必须是正整数秒")
    for key in ("args",):
        v = spec.get(key, [])
        if not isinstance(v, list) or not all(isinstance(a, str) for a in v):
            raise HTTPException(status_code=400, detail=f"{name}: args 必须是字符串数组")
    for key in ("env", "headers"):
        v = spec.get(key, {})
        if not isinstance(v, dict) or not all(
                isinstance(k, str) and isinstance(x, str) for k, x in v.items()):
            raise HTTPException(status_code=400,
                                detail=f"{name}: {key} 必须是字符串→字符串对象")
    if transport == "stdio":
        if not str(spec.get("command") or "").strip():
            raise HTTPException(status_code=400, detail=f"{name}: stdio 需要 command")
    elif not str(spec.get("url") or "").strip():
        raise HTTPException(status_code=400, detail=f"{name}: {transport} 需要 url")


@app.post("/api/mcp/servers")
async def api_save_mcp_servers(request: dict):
    """整体保存 mcpServers 并热应用（连接新服务器、断开删除的）。

    请求体 {"mcpServers": {name: spec}}; 校验失败 400 且不动现有配置。
    名字清洗规则与工具名前缀一致, 避免存进去了却连不出合法工具名。"""
    raw = request.get("mcpServers")
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="mcpServers 必须是对象")
    cleaned: dict = {}
    for name, spec in raw.items():
        if not isinstance(name, str) or not name.strip():
            raise HTTPException(status_code=400, detail="服务器名不能为空")
        if not isinstance(spec, dict):
            raise HTTPException(status_code=400, detail=f"{name}: 描述必须是对象")
        entry = {k: v for k, v in spec.items() if v not in ("", None, [], {})}
        # type 推断先于校验: {"url":...} 应识别为 http 而非按缺 command 的 stdio 拒掉
        if "type" not in entry:
            entry["type"] = "stdio" if entry.get("command") else "http"
        _validate_mcp_entry(name.strip(), entry)
        cleaned[name.strip()] = entry

    _save_setting("mcpServers", cleaned)

    # 热应用: 走既有 reload 内核（重读配置会带回刚写入的 mcpServers,
    # 并合并项目级配置——设置页改的是用户级这一层）
    try:
        fresh = ConfigLoader(cwd=Path.cwd(), config_home=server.USER_DIR).load()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"保存后加载失败: {e}")
    server.runtime_config = fresh
    # 换绑必须落在外层壳委托的 _inner 上: execute 走 _inner, 挂到外层
    # dict 的 handler 永远不会被调到, 而 _inner 里的旧 handler 闭包引用
    # 已被 connect_all 关掉的旧连接 —— 调用即 "MCP server is not connected"
    server._attach_mcp_tools(server.registry._inner, fresh.mcp_servers())
    return {"ok": True, "servers": get_mcp_manager().status(),
            "mcp_tool_count": sum(
                1 for t in server.TOOLS if t.get("name", "").startswith(MCP_TOOL_PREFIX))}


@app.post("/api/mcp/reload")
async def api_mcp_reload():
    """重读配置并热重载 MCP: 重连 → 换绑 registry → 同步 TOOLS。

    复用同一 registry 对象（Web 端 runtime 持有引用, 换绑而非重建）,
    已有会话下一轮工具调用即走新配置。配置解析失败返回 400, 不动现有连接。"""
    try:
        fresh = ConfigLoader(cwd=Path.cwd(), config_home=server.USER_DIR).load()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"配置加载失败: {e}")
    server.runtime_config = fresh
    servers: list = fresh.mcp_servers()
    # 同 save 端点: 必须换绑 _inner(理由见上)
    server._attach_mcp_tools(server.registry._inner, servers)
    return {"ok": True, "servers": get_mcp_manager().status(),
            "mcp_tool_count": sum(
                1 for t in server.TOOLS if t.get("name", "").startswith(MCP_TOOL_PREFIX))}


# ============================================================================
# REST: 设置查看与保存（设置页主体: 思考等级 / 权限模式 / 迭代与延迟治理）
# ============================================================================

@app.get("/api/settings")
async def api_get_settings():
    active = server._provider_cfg.get("active") or {}
    return {
        # 思考等级已按会话隔离, 这里返回的是"新会话的默认值"
        "thinking_level": server.api_client.thinking_level,
        "permission_mode": MODE_TO_NAME[server.app_state.permission_mode],
        # 计划开关的全局默认（新会话初值）, 与基础模式独立叠加
        "permission_plan": server.app_state.plan_active,
        # 每轮最大迭代次数（单轮任务里模型连续调用工具的次数上限）:
        # 同样是"新会话的默认值", 进行中的会话保持组装时的值
        "max_iterations": server.runtime_config.max_iterations(),
        # 长回合延迟治理: 回合内思考自动降档开关 / 降档起点迭代数 /
        # 软收束提示的注入位置（0 = 关）。会话隔离语义同 max_iterations
        "thinking_auto_downshift": server.runtime_config.thinking_auto_downshift(),
        "downshift_after_iterations": server.runtime_config.downshift_after_iterations(),
        "convergence_nudge_at": server.runtime_config.convergence_nudge_at(),
        # 前端展示用: 输入栏的模型名 + 顶栏面包屑的工作区名
        "model": server.api_client.model,
        "provider_id": active.get("provider"),
        "model_id": active.get("model"),
        "configured": server._provider_ready(server._provider_cfg),   # false → 前端弹初始化页
        "workspace": Path.cwd().name,
        "icon_ver": server._icon_ver(),
        "bg_ver": server._bg_ver(),
        "app_version": server._app_version(),   # 标题栏版本徽标; 空串 = 前端不显示
    }


@app.post("/api/settings")
async def api_post_settings(request: dict):
    thinking = request.get("thinking_level")
    if thinking is not None:
        level = str(thinking).strip().lower()
        if level not in THINKING_LEVELS:
            raise HTTPException(
                status_code=400,
                detail=f"未知思考等级: {thinking}（可选: {' | '.join(THINKING_LEVELS)}）",
            )
        server.api_client.set_thinking_level(level)  # 新会话的默认值
        _save_setting("thinkingLevel", level)
        # 存活会话各自持有等级（WS set_thinking_level 单独切换）,
        # 这里只改全局默认——与其他设置的会话隔离语义对齐。
        # 必须落盘: 不写的话重启后 settings.json 还是旧档, 新会话静默回落。

    mode_name = request.get("permission_mode")
    if mode_name is not None:
        normalized = str(mode_name).strip().lower()
        # "plan"/"read-only" 是旧版并列模式时代的值: 归一为基础模式
        # prompt + 计划开（与 WS set_permission_mode 的兼容口径一致）
        legacy_plan = normalized in ("plan", "read-only")
        if legacy_plan:
            normalized = "prompt"
        mode = NAME_TO_MODE.get(normalized)
        if mode is None:
            raise HTTPException(
                status_code=400,
                detail=f"未知权限模式: {mode_name}（可选: {' | '.join(MODE_TO_NAME.values())}）",
            )
        if mode == server.ALLOW_MODE:
            # 与 CLI 配置口径一致: allow 连将来需要问的工具也一并放行,
            # 不允许从设置进入（REPL /mode allow 临时开启不受影响）
            raise HTTPException(status_code=400, detail="allow 模式不允许从设置进入")
        server.app_state.set_permission_mode(mode)
        _save_permission_mode(mode)
        if legacy_plan:
            server.app_state.plan_active = True
            _save_setting("permissionPlan", True)
        # 只改全局默认（新会话的初值）: 权限模式是会话级的, 存活会话
        # 各自持有, 由会话内的下拉框 / WS set_permission_mode 单独切换
        # ——与 thinking_level 的会话隔离语义对齐

    # 计划开关全局默认（新会话的初值）: 与基础模式一样会话级隔离
    plan_flag = request.get("permission_plan")
    if plan_flag is not None:
        if not isinstance(plan_flag, bool):
            raise HTTPException(status_code=400,
                                detail=f"permission_plan 须为布尔, got {plan_flag!r}")
        server.app_state.plan_active = plan_flag
        _save_setting("permissionPlan", plan_flag)

    # 每轮最大迭代次数: 只改全局默认（新会话组装 runtime 时的初值）,
    # 存活会话不追改——runtime 的 _max_iterations 在 build 时定死,
    # 与 thinking_level / permission_mode 的会话隔离语义对齐
    raw_iterations = request.get("max_iterations")
    if raw_iterations is not None:
        # bool 是 int 的子类, True 会被当成 1——显式排除
        if (not isinstance(raw_iterations, int) or isinstance(raw_iterations, bool)
                or not 1 <= raw_iterations <= 10000):
            raise HTTPException(
                status_code=400,
                detail=f"max_iterations: 须为 1–10000 的整数, got {raw_iterations!r}",
            )
        server.runtime_config.feature_config.max_iterations = raw_iterations
        _save_setting("maxIterations", raw_iterations)

    # 长回合延迟治理三键: 会话隔离语义同 max_iterations（新会话生效,
    # 存活会话不追改）
    raw_downshift = request.get("thinking_auto_downshift")
    if raw_downshift is not None:
        if not isinstance(raw_downshift, bool):
            raise HTTPException(
                status_code=400,
                detail=f"thinking_auto_downshift: 须为布尔, got {raw_downshift!r}",
            )
        server.runtime_config.feature_config.thinking_auto_downshift = raw_downshift
        _save_setting("thinkingAutoDownshift", raw_downshift)

    raw_downshift_after = request.get("downshift_after_iterations")
    if raw_downshift_after is not None:
        # bool 是 int 的子类, True 会被当成 1——显式排除
        if (not isinstance(raw_downshift_after, int)
                or isinstance(raw_downshift_after, bool)
                or not 1 <= raw_downshift_after <= 10000):
            raise HTTPException(
                status_code=400,
                detail=("downshift_after_iterations: 须为 1–10000 的整数, "
                        f"got {raw_downshift_after!r}"),
            )
        server.runtime_config.feature_config.downshift_after_iterations = raw_downshift_after
        _save_setting("downshiftAfterIterations", raw_downshift_after)

    raw_nudge = request.get("convergence_nudge_at")
    if raw_nudge is not None:
        if (not isinstance(raw_nudge, int) or isinstance(raw_nudge, bool)
                or not 0 <= raw_nudge <= 10000):
            raise HTTPException(
                status_code=400,
                detail=f"convergence_nudge_at: 须为 0–10000 的整数, got {raw_nudge!r}",
            )
        server.runtime_config.feature_config.convergence_nudge_at = raw_nudge
        _save_setting("convergenceNudgeAt", raw_nudge)

    # 切换激活模型（来自输入框模型下拉）
    provider_id = request.get("provider_id")
    model_id = request.get("model_id")
    if provider_id is not None and model_id is not None:
        server._provider_cfg["active"] = {"provider": str(provider_id), "model": str(model_id)}
        save_providers(server._provider_cfg)
        server._apply_provider_config(server._provider_cfg)

    return await api_get_settings()


def _save_setting(key: str, value) -> None:
    """单个用户级设置持久化到 ~/.aulos/settings.json（读-改-写）。

    文件里其他 key（providers / activeProvider / permissionMode / ...）
    原样保留。读写都走 config.SETTINGS_FILE, 测试 monkeypatch 该路径即可
    隔离。失败只降级为不持久化（本轮内存里仍生效）, 不打断设置请求。
    """
    try:
        data = json.loads(server.SETTINGS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    data[key] = value
    try:
        server.SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        server.SETTINGS_FILE.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def _save_permission_mode(mode: PermissionMode) -> None:
    """权限模式持久化到 ~/.aulos/settings.json 的 permissionMode key。

    值用 resolve_permission_mode / config mode_map 认的规范名, 重启后能原样
    读回; 不写 "allow"（同 POST 入口, 配置口径拒绝它）。
    """
    _save_setting("permissionMode", MODE_TO_NAME[mode])


# ============================================================================
# REST: 模型供应商配置（设置页"模型"分区）
# ============================================================================

@app.get("/api/providers")
async def api_get_providers():
    return server._provider_cfg


@app.get("/api/utility-provider")
async def api_get_utility_provider():
    """设置页的 side-call 小模型配置: 原始设置 + 有效性 + 当前实际生效模型
    （诊断用, 便于发现"配了但没生效"）。不含解析出的 key/地址。"""
    setting = load_utility_provider_setting()
    return {**setting,
            "valid": load_utility_provider() is not None,
            "effective_model": server._utility_client.model if server._utility_client
            else (server.api_client.model or None)}


@app.post("/api/utility-provider")
async def api_save_utility_provider(request: dict):
    """保存 side-call 小模型设置并即时生效（重建 utility client）。
    provider 留空 = 清除设置, 回落主模型。"""
    pid = str(request.get("provider") or "").strip()
    if pid and not any(p.get("id") == pid
                       for p in server._provider_cfg.get("providers", [])):
        raise HTTPException(status_code=400, detail=f"供应商不存在: {pid}")
    setting = save_utility_provider_setting(
        {"provider": pid, "model": request.get("model")})
    server._rebuild_utility_client()
    return {**setting, "valid": load_utility_provider() is not None,
            "effective_model": server._utility_client.model if server._utility_client
            else (server.api_client.model or None)}


@app.post("/api/providers")
async def api_save_providers(request: dict):
    providers = request.get("providers")
    active = request.get("active")
    if not isinstance(providers, list):
        raise HTTPException(status_code=400, detail="providers 必须是数组")
    ids = [p.get("id") for p in providers]
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=400, detail="供应商 id 重复")
    for p in providers:
        if not p.get("id") or not p.get("name"):
            raise HTTPException(status_code=400, detail="供应商缺少 id 或名称")
        if not isinstance(p.get("models"), list):
            raise HTTPException(status_code=400, detail=f"供应商 {p.get('name')} 缺少模型列表")
        # protocol: anthropic（缺省）| openai。非法值直接拒绝保存。
        try:
            p["protocol"] = normalize_protocol(p.get("protocol"))
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"供应商 {p.get('name')} 的 protocol 非法"
                       f"（可选: {' / '.join(KNOWN_PROTOCOLS)}）",
            )
        # 照 OpenAI 习惯粘贴的 https://xxx/v1 在此归一（SDK 会自动拼 /v1/messages）
        p["base_url"] = server._normalize_base_url(p.get("base_url"),
                                                   protocol=p["protocol"])
        # 接口地址必填: 留空会让 SDK 回退到 Anthropic 官方地址, 智谱 key 必被 403
        if p.get("enabled") is not False and not p["base_url"]:
            raise HTTPException(
                status_code=400,
                detail=f"供应商 {p.get('name')} 缺少接口地址 Base URL",
            )
    cfg = {"active": active if isinstance(active, dict) else server._provider_cfg.get("active"),
           "providers": providers}
    if not isinstance(cfg["active"], dict):
        cfg["active"] = {}
    server._provider_cfg.clear()
    server._provider_cfg.update(cfg)
    save_providers(server._provider_cfg)
    server._apply_provider_config(server._provider_cfg)
    return server._provider_cfg


@app.post("/api/providers/test")
async def api_test_provider(request: dict):
    """用给定配置发一次最小请求, 验证供应商连通性。"""
    try:
        protocol = normalize_protocol(request.get("protocol"))
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"protocol 非法（可选: {' / '.join(KNOWN_PROTOCOLS)}）")
    base_url = server._normalize_base_url(request.get("base_url"), protocol=protocol) or None
    api_key = request.get("api_key") or ""
    model = request.get("model") or ""
    if not api_key or not model:
        raise HTTPException(status_code=400, detail="缺少 api_key 或 model")
    try:
        if protocol == "openai":
            from openai import OpenAI
            client = OpenAI(api_key=api_key, base_url=base_url, timeout=30.0)
            resp = client.chat.completions.create(
                model=model, max_tokens=16,
                messages=[{"role": "user", "content": "hi"}],
            )
            text = (resp.choices[0].message.content or "").strip() if resp.choices else ""
            return {"ok": True, "detail": text[:50] or "(空回复)"}
        probe = anthropic.Anthropic(api_key=api_key, base_url=base_url, timeout=30.0)
        resp = probe.messages.create(
            model=model, max_tokens=16,
            messages=[{"role": "user", "content": "hi"}],
        )
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        return {"ok": True, "detail": text.strip()[:50] or "(空回复)"}
    except Exception as e:
        return {"ok": False, "detail": str(e)[:200]}


@app.post("/api/open-config")
async def api_open_config():
    """设置页「打开配置文件」: 用系统默认程序打开 ~/.aulos/settings.json。
    文件不存在时先创建空配置, 保证每次都能打开。"""
    path = server.SETTINGS_FILE
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")
    try:
        if sys.platform == "win32":
            os.startfile(str(path))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"打开失败: {e}")
    return {"ok": True}
