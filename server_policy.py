# server_policy.py — REST: 权限策略（server 包拆分的又一个功能域）
#
# 命令白名单 / deny 规则 / 敏感路径 / 附加工作目录的查看与增删,
# 以及桌宠悬浮窗用的权限批复端点。保存即热推所有活跃 runtime
# （setter 经 server.X 取, call-time 解析——测试 monkeypatch
# server._sessions 必须生效, 不能在导入期钉死引用）。
# 路由挂在 server_common.app 上, server.py import 本模块完成注册。
"""Aulos web — 权限策略 REST（allowlist / denylist / 敏感路径 / 附加目录 / 批复）。"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from server_common import app
from config import (load_command_allowlist, save_command_allowlist,
                    load_additional_directories, save_additional_directories,
                    load_command_denylist, save_command_denylist,
                    load_sensitive_paths, save_sensitive_paths)


# ============================================================================
# REST: 命令白名单（设置页"权限"分区 + 审批卡"总是允许"）
# ============================================================================

def _apply_allowlist_to_runtimes(rules: list) -> None:
    """白名单热更新: 推给所有已组装的会话 runtime（含 CLI 共享的规则源,
    各 runtime 的策略对象各持一份, 逐一 set）。"""
    import server
    for ws in list(server._sessions.values()):
        if ws.runtime is not None:
            try:
                ws.runtime.set_command_allowlist(rules)
            except Exception:
                pass


def _workspace_roots_for(workdir: Optional[str]) -> list:
    """会话的 workspace 根: 会话工作目录（未绑定时退为服务进程 cwd——
    与执行层 Popen 继承 cwd 的实际行为一致）+ 全局附加目录。
    写路径分级（permissions.classify_write_path）与 shell 敏感路径
    扫描都以这组根为基准。"""
    base = workdir if workdir else str(Path.cwd())
    return [base] + load_additional_directories()


def _apply_workspace_roots_to_runtimes() -> None:
    """附加目录增删后热更新所有活跃 runtime 的 workspace 根。
    各会话根不同（含各自 workdir）, 按会话逐个重算。"""
    import server
    for ws in list(server._sessions.values()):
        if ws.runtime is not None:
            try:
                ws.runtime.set_workspace_roots(_workspace_roots_for(ws.workdir))
            except Exception:
                pass


def _apply_policy_list(setter_name: str, value: list) -> None:
    """把一份策略清单(deny 规则/敏感路径)热推给所有活跃 runtime。
    setter 找不到(runtime 未组装等)逐个静默——设置保存已落盘,
    新会话组装时自然带上。"""
    import server
    for ws in list(server._sessions.values()):
        if ws.runtime is not None:
            try:
                getattr(ws.runtime, setter_name)(value)
            except Exception:
                pass


@app.get("/api/settings/allowlist")
async def api_get_allowlist():
    return {"rules": load_command_allowlist()}


@app.post("/api/settings/allowlist")
async def api_add_allowlist_rule(request: dict):
    """新增一条前缀规则。规则清洗（压空白/去重/限长）在 save 层统一做;
    重复添加幂等（返回现有列表）。成功后热更新所有活跃 runtime。"""
    rule = request.get("rule")
    if not isinstance(rule, str) or not rule.strip():
        raise HTTPException(status_code=400, detail="rule 不能为空")
    rules = load_command_allowlist() + [rule]
    saved = save_command_allowlist(rules)
    _apply_allowlist_to_runtimes(saved)
    return {"ok": True, "rules": saved}


@app.delete("/api/settings/allowlist")
async def api_delete_allowlist_rule(request: dict):
    """删除一条规则（按原文精确匹配; 前端从列表渲染而来, 原文可用）。"""
    rule = request.get("rule")
    if not isinstance(rule, str) or not rule:
        raise HTTPException(status_code=400, detail="rule 不能为空")
    rules = [r for r in load_command_allowlist() if r != rule]
    saved = save_command_allowlist(rules)
    _apply_allowlist_to_runtimes(saved)
    return {"ok": True, "rules": saved}


@app.post("/api/sessions/{session_id}/allow-rules")
async def api_add_session_allow_rule(session_id: str, request: dict):
    """会话级命令白名单（审批卡"本会话允许"）: 只写该会话 runtime 的
    策略对象, 不落盘, 会话结束即失效。runtime 未组装时 409——能弹审批
    卡说明 runtime 已在, 这里只是防御。"""
    import server
    web_session = server._sessions.get(session_id)
    if web_session is None:
        raise HTTPException(status_code=404, detail="会话不存在或未打开")
    if web_session.runtime is None:
        raise HTTPException(status_code=409, detail="会话 runtime 未组装")
    rule = str(request.get("rule") or "").strip()
    if not rule:
        raise HTTPException(status_code=400, detail="rule 不能为空")
    web_session.runtime.add_session_allow_rule(rule)
    return {"ok": True, "rule": rule}


# ============================================================================
# REST: deny 规则（设置页"权限"分区）。任一命令段命中前缀即整体拒绝,
# 优先于一切 allow——表达"git push 可以, git push --force 不行"这类例外。
# ============================================================================

@app.get("/api/settings/denylist")
async def api_get_denylist():
    return {"rules": load_command_denylist()}


@app.post("/api/settings/denylist")
async def api_add_denylist_rule(request: dict):
    rule = request.get("rule")
    if not isinstance(rule, str) or not rule.strip():
        raise HTTPException(status_code=400, detail="rule 不能为空")
    saved = save_command_denylist(load_command_denylist() + [rule])
    _apply_policy_list("set_command_denylist", saved)
    return {"ok": True, "rules": saved}


@app.delete("/api/settings/denylist")
async def api_delete_denylist_rule(request: dict):
    rule = request.get("rule")
    if not isinstance(rule, str) or not rule:
        raise HTTPException(status_code=400, detail="rule 不能为空")
    saved = save_command_denylist(
        [r for r in load_command_denylist() if r != rule])
    _apply_policy_list("set_command_denylist", saved)
    return {"ok": True, "rules": saved}


# ============================================================================
# REST: 用户敏感路径（设置页"权限"分区）。命中(绝对或相对 workspace 根)
# 的写入/破坏族命令按 sensitive 处理——任何模式强制裁决。
# ============================================================================

@app.get("/api/settings/sensitive-paths")
async def api_get_sensitive_paths():
    return {"paths": load_sensitive_paths()}


@app.post("/api/settings/sensitive-paths")
async def api_add_sensitive_path(request: dict):
    p = str(request.get("path") or "").strip()
    if not p:
        raise HTTPException(status_code=400, detail="path 不能为空")
    saved = save_sensitive_paths(load_sensitive_paths() + [p])
    _apply_policy_list("set_sensitive_paths", saved)
    return {"ok": True, "paths": saved}


@app.delete("/api/settings/sensitive-paths")
async def api_delete_sensitive_path(request: dict):
    p = str(request.get("path") or "").strip()
    if not p:
        raise HTTPException(status_code=400, detail="path 不能为空")
    saved = save_sensitive_paths([x for x in load_sensitive_paths() if x != p])
    _apply_policy_list("set_sensitive_paths", saved)
    return {"ok": True, "paths": saved}


# ============================================================================
# REST: 附加工作目录（写路径分级的 workspace 根扩展）
# 审批卡"允许并记住该目录"写入; 设置页"权限"分区可增删。
# ============================================================================

@app.get("/api/settings/additional-dirs")
async def api_get_additional_dirs():
    return {"dirs": load_additional_directories()}


@app.post("/api/settings/additional-dirs")
async def api_add_additional_dir(request: dict):
    """新增一个附加目录（须存在）。保存后重算所有活跃会话的 workspace 根,
    越界写立即变为根内写（不再弹问）。"""
    d = str(request.get("dir") or "").strip()
    if not d:
        raise HTTPException(status_code=400, detail="dir 不能为空")
    p = Path(d)
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"目录不存在: {d}")
    saved = save_additional_directories(
        load_additional_directories() + [str(p.resolve())])
    _apply_workspace_roots_to_runtimes()
    return {"ok": True, "dirs": saved}


@app.delete("/api/settings/additional-dirs")
async def api_delete_additional_dir(request: dict):
    """移除一个附加目录（按原文精确匹配; 前端从列表渲染而来）。"""
    d = str(request.get("dir") or "").strip()
    if not d:
        raise HTTPException(status_code=400, detail="dir 不能为空")
    saved = save_additional_directories(
        [x for x in load_additional_directories() if x != d])
    _apply_workspace_roots_to_runtimes()
    return {"ok": True, "dirs": saved}


# ============================================================================
# REST: 权限批复（桌宠悬浮窗"点菲比批条子"用; 主窗走 WS permission_response）
# ============================================================================

@app.post("/api/permissions/respond")
async def api_permission_respond(request: dict):
    """按 request_id 批复当前挂起的权限请求。与 WS permission_response
    走同一 prompter.resolve 链路: 请求已被主窗批复/已过期时 resolve 静默
    忽略 stale id（FIFO 消费侧丢弃）, 幂等安全。"""
    import server
    web_session = server._sessions.get(str(request.get("session_id") or ""))
    if web_session is None:
        raise HTTPException(status_code=404, detail="会话不存在或未打开")
    prompter = web_session.prompter
    if prompter is None:
        raise HTTPException(status_code=409, detail="当前没有待审批的请求")
    request_id = str(request.get("request_id") or "")
    if not request_id:
        raise HTTPException(status_code=400, detail="request_id 不能为空")
    approved = bool(request.get("approved"))
    prompter.resolve(request_id, approved)
    # 广播批复结果: 走桌宠/REST 批复时主窗不知道请求已被处理, 其
    # pendingPerms 登记与审批卡按钮会永久滞留（"等待授权…"指示不消失）。
    # 事件对 WS 路径批复的重复到达无害——前端按"未定格才定格"幂等处理。
    web_session.broadcast({
        "type": "permission_resolved",
        "session_id": web_session.session_id,
        "request_id": request_id,
        "approved": approved,
    })
    return {"ok": True}
