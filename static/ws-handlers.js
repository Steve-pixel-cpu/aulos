/* ============================================================
 * ws-handlers.js — 服务端消息分派与全部 on* 处理器
 *
 * 从 app.js 外迁的功能域 (拆分路线见 README「代码组织与拆分路线」)。
 * WS 消息的「接收端」: handleServerMessage 编排横切钩子 (桌宠桥/
 * 完成通知/计划收口/busy_sync 校正) 后分派到各 on* 处理器; 工具卡片
 * 渲染 (流式/分组/diff/todo/权限卡) 也在这里——只消费服务端事件,
 * 不反向驱动发送链路。
 *
 * 经典脚本, 由 index.html 在 app.js 之后 defer 加载:
 *   - connectWs 的 onmessage 在首条消息到达时才调 handleServerMessage,
 *     运行时解引用, 加载序天然安全;
 *   - 本文件加载期只定义函数与常量, 不执行任何核心调用 (grep 顶层
 *     "$(" 应为空)。
 *
 * 读的前置全局: state / runOf / colOf / $ / sendWs / scrollToBottom 系
 *               (msg-extras) / addUserBubble·addAssistantBubble (bubbles) /
 *               renderMd / escapeHtml / toast / notifyTurnEnd (notify.js)
 * 暴露的全局:   handleServerMessage + 全部 on* 处理器 + 工具卡片辅助
 * ============================================================ */
/* ============================================================
 * 服务端消息分派
 * ============================================================ */
/* 桌宠悬浮窗标注权限气泡的会话名: 只读查询, 不暴露 state 本体 */
window.aulosSessionTitle = (sid) => {
  const s = state.sessions.find(x => x.id === sid);
  return s ? (s.title || s.name || "") : "";
};

function handleServerMessage(msg, sid) {
  const run = runOf(sid);
  // 桌宠悬浮窗(pet.js 转发): 前后台会话的运行事件都镜像一份给它做状态机。
  // 装饰性钩子必须隔离——它内部抛错不能拖垮消息主处理链(曾因 pet.js
  // 引用未定义变量, turn_done 全部炸在中断, 界面永远转圈且无法中断)。
  try { window.aulosPet?.onEvent?.(msg, sid); } catch (e) { console.warn("[pet]", e); }
  // 桌宠任务桥: 桌宠专属会话的正文流攒进缓冲, 轮次收口时把回复回传给
  // 悬浮窗气泡(任务由悬浮输入框派来, 走完整 agent 轮次——见文件尾 pet 桥)
  if (petTaskSid && sid === petTaskSid) petTaskObserve(msg);
  // 完成通知（提示音 + 桌面弹窗）: turn_done/error 是轮次终点, 前台/后台
  // 两条路径都从这里过, 单点挂钩全覆盖。内部自己判断"该不该响/该不该弹"。
  // 桌宠派活的会话例外: 结果已由任务桥回传悬浮窗气泡, 主窗不响不弹——
  // 悬浮输入框的使用场景就是摸鱼, 声音/系统通知会当场暴露。
  if ((msg.type === "turn_done" || msg.type === "error") && sid !== petTaskSid) {
    try { notifyTurnEnd(msg, sid); } catch (e) { console.warn("[notify]", e); }
  }
  // 继续聊天 = 隐性否决未决计划: 服务端此时会把旧计划自动拒绝并叫停当前轮
  // （见 server 的 user 分支）, turn_interrupting/turn_started 到达即收口 UI——
  // 计划卡与右侧面板按钮定格"已过期", 正文淡化。前后台会话都要收口。
  if (run && (msg.type === "turn_interrupting" || msg.type === "turn_started")) {
    expirePlanCard(run, sid, "已过期 · 继续对话后重新规划");
  }
  // WS 建连时的服务端 busy 快照校正（前台/后台都要）: 本地 busy 的唯一清除
  // 途径是 turn_done/error, 服务进程死亡丢掉收尾事件后本地永远忙碌——
  // 死轮次的悬空工具卡在历史回放里被 !busy 跳过收口, 永远停在"运行中"。
  // busy=false 的校正只在重连时生效: 首连的快照不携带在途乐观发送的信息
  // （草稿首发: 本地先置忙碌再建连, 服务端此刻还空闲, 且首轮没有
  // turn_started 来恢复）, 误信会把整轮的忙碌 UI 杀掉。
  // 快照 true 而本地空闲 → 跟上忙碌（别的窗口的轮次活着, 保留"运行中"卡）。
  if (msg.type === "busy_sync") {
    if (!msg.busy && run && run.busy && run.reconnected) {
      if (sid === state.sessionId) endTurnUiReset();
      else settleBackgroundTurnEnd(run, sid);
    } else if (msg.busy && run && !run.busy) {
      run.busy = true;
      renderSessionList();
    }
    return;
  }
  // 后台会话: 流式内容照常写进它自己的常驻列（隐藏）, 切回时完整可见;
  // 只对 权限/结果/结束/错误 累计未读。结束/接力时同步运行态。
  if (sid !== state.sessionId) {
    if (msg.type === "text_delta") onTextDelta(msg, sid);
    else if (msg.type === "thinking_start") onThinkingStart(msg, sid);
    else if (msg.type === "thinking_end") onThinkingEnd(msg, sid);
    else if (msg.type === "tool_use_started") onToolUseStarted(msg, sid);
    else if (msg.type === "tool_use") onToolUse(msg, sid);
    // 后台会话的计划/权限请求也要走统一入口: 登记 pendingPerms + 在它的
    // 隐藏列里建审批卡。此前只刷会话列表, 切回后既无卡也无可点按钮,
    // 两个会话都在等计划审批时, 后弹的那个会让先弹的"卡住"。
    else if (msg.type === "permission_request") onPermissionRequest(msg, sid);
    else if (msg.type === "tool_result") onToolResult(msg, sid);
    else if (msg.type === "await_output") {
      run.awaiting = run.busy;
    }
    else if (msg.type === "context_compacted") addCompactNotice(colOf(sid), true);
    else if (msg.type === "mode_changed") onModeChanged(msg, sid);
    else if (msg.type === "thinking_changed") onThinkingChanged(msg, sid);
    else if (msg.type === "model_changed") onModelChanged(msg, sid);

    else if (msg.type === "tool_result") bumpUnread(sid);
    else if (msg.type === "permission_resolved") onPermissionResolved(msg, sid);
    else if (msg.type === "turn_done" || msg.type === "error") {
      bumpUnread(sid);
      settleBackgroundTurnEnd(run, sid);
      // 打断收口与前台 onTurnDone 一致: 「已停止」挂在本轮思考行上
      if (msg.type === "turn_done" && msg.interrupted
          && run.lastThinkRow && run.lastThinkRow.isConnected) {
        const tag = document.createElement("span");
        tag.className = "t-stopped";
        tag.textContent = "已停止";
        run.lastThinkRow.appendChild(tag);
      }
    } else if (msg.type === "turn_started") {
      run.busy = true;               // 排队的后续消息接力开跑
      run.lastThinkRow = null;
      settleRelayedMessages(msg, sid);
      beginOptimisticThinking(run, sid, colOf(sid));
    }
    return;
  }
  switch (msg.type) {
    case "text_delta":         onTextDelta(msg, sid); break;
    case "tool_use_started":   onToolUseStarted(msg, sid); break;
    case "tool_use":           onToolUse(msg, sid); break;
    case "tool_result":        onToolResult(msg, sid); break;
    case "thinking_start":     onThinkingStart(msg, sid); break;
    case "thinking_end":       onThinkingEnd(msg, sid); break;
    case "turn_queued":        onTurnQueued(msg); break;
    case "turn_started":       onTurnStarted(msg, sid); break;
    case "turn_queued_user":   onTurnQueuedUser(msg, sid); break;
    case "turn_queue_cleared": onQueueCleared(sid); break;
    case "await_output":       onAwaitOutput(msg, state.sessionId); break;
    case "context_compacted":  addCompactNotice(msgCol(), true); break;
    case "rate_limited_retry": onRateLimitedRetry(msg, sid); break;
    case "turn_interrupting":  onTurnInterrupting(msg, sid); break;
    case "permission_request": onPermissionRequest(msg, sid); break;
    case "permission_resolved": onPermissionResolved(msg, sid); break;
    case "mode_changed":       onModeChanged(msg, sid); break;
    case "thinking_changed":   onThinkingChanged(msg, sid); break;
    case "model_changed":      onModelChanged(msg, sid); break;
    case "turn_done":          onTurnDone(msg); break;
    case "session_renamed":    onSessionRenamed(msg); break;
    case "error":              onError(msg); break;
    default: console.warn("未知消息类型", msg);
  }
}

function bumpUnread(sid) {
  const run = runOf(sid);
  run.unread += 1;
  const s = state.sessions.find(x => x.id === sid);
  if (s) s._unreadShown = run.unread;
  renderSessionList();
}

/* ---------- 正文流式（sid 感知: 后台会话写进自己的列） ---------- */
function onTextDelta(msg, sid) {
  const run = runOf(sid);
  clearRateLimitNote(run);   // 正文已到: 限流重试成功, 撤提示行
  const active = sid === state.sessionId;
  run.awaiting = false;                    // 首个内容事件: 等待空窗结束
  if (active) syncThinkingIndicator();
  dropOptimisticThinking(run);   // 正文先到: 撤掉还没被 thinking_start 接管的乐观胶囊
  if (!run.curBubble) {
    run.curBubble = addAssistantBubble("", "", colOf(sid));
    run.curBubble._raw = "";
  }
  run.curBubble._raw += msg.text;
  run.curBubble.innerHTML = renderMd(run.curBubble._raw);
  decorateCode(run.curBubble);
  decorateTables(run.curBubble);
  scrollToBottom();
}

/* 流式气泡收口: 有内容就固化，下一轮正文开新气泡 */
function flushAssistantBubble(run) {
  if (!run) return;
  if (run.curBubble && !run.curBubble._raw) {
    run.curBubble.closest(".msg").remove();   // 空气泡（模型直接调工具）: 移除
  }
  run.curBubble = null;
}

/* ---------- 思考行 ---------- */
const ICON_MIND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.8.7 1.4 1.5 1.6 2.5h4.8c.2-1 .8-1.8 1.6-2.5A6 6 0 0012 3z"/></svg>';
const ICON_TERM = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3.5 3L7 15M12.5 15H17"/></svg>';
const ICON_FILE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6V3z"/><path d="M14 3v4h4"/></svg>';
const ICON_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-1L20 7.5 16.5 4 5 15.5 4 20z"/></svg>';
const ICON_TOOL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"/></svg>';
// 计划模式图标: TOOL_META 在模块加载即求值, 声明必须位于其前（否则 TDZ 炸掉整个引导）
const ICON_MODE_PLAN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l1 3h3v15H5V6h3l1-3z"/><path d="M9 12h6M9 16h4"/></svg>';
const ICON_SEARCH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/><path d="M8 11h6M11 8v6"/></svg>';
const ICON_GLOB = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h5M4 11h7M4 16h5"/><path d="M14 5l6 7-6 7"/><path d="M20 12H10"/></svg>';
const ICON_TODO = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5l1.5 1.5L8 5.5"/><path d="M4 13.5l1.5 1.5L8 12.5"/><path d="M11 7h9M11 14h9M11 20h6"/></svg>';
const TOOL_META = {
  bash:       { label: "终端",     icon: ICON_TERM },
  powershell: { label: "终端",     icon: ICON_TERM },
  read_file:  { label: "读取文件", icon: ICON_FILE },
  write_file: { label: "写入文件", icon: ICON_EDIT },
  present_plan: { label: "实施计划", icon: ICON_MODE_PLAN },
  todo: { label: "任务清单", icon: ICON_TODO },
  grep: { label: "搜索内容", icon: ICON_SEARCH },
  glob: { label: "查找文件", icon: ICON_GLOB },
};

function fmtDuration(ms) {
  const s = ms / 1000;
  if (s < 1) return "不到 1 秒";
  if (s < 60) return Math.round(s) + " 秒";
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}

function onThinkingStart(msg, sid) {
  const run = runOf(sid);
  clearRateLimitNote(run);   // 思考已开始: 限流重试成功, 撤提示行
  const active = sid === state.sessionId;
  run.awaiting = false;                    // 思考行已是可见反馈: 空窗结束
  if (active) syncThinkingIndicator();
  flushAssistantBubble(run);
  if (run.curThinking) return;   // 已有实时思考行或乐观胶囊: 直接采用, 计时连续不归零
  const div = document.createElement("div");
  div.className = "think-row thinking";
  div.innerHTML = '<span class="t-ico">' + ICON_MIND + '</span>' +
    '<span class="shine">思考中…</span>';
  colOf(sid).appendChild(div);
  run.curThinking = { el: div, t0: Date.now() };
  run.lastThinkRow = div;   // 本轮思考行引用: 打断时「已停止」挂在这里
  if (active) scrollToBottom();
}

function onThinkingEnd(msg, sid) {
  const run = runOf(sid);
  const active = sid === state.sessionId;
  if (active) syncThinkingIndicator();
  const cur = run.curThinking;
  if (!cur) return;
  // 服务端计时优先，缺失（轮次兜底收口）时用客户端起止时间。
  // 例外: 乐观胶囊出身的思考行用客户端起止——服务端 duration_ms 只覆盖
  // 思考块本身, 会把 发送→首个思考块 之间的 prefill 等待丢掉, 违背
  // "等待+思考合并计时"的语义（等待就是用户真实等待的一部分）。
  const ms = (cur.optimistic || typeof msg.duration_ms !== "number")
    ? Date.now() - cur.t0 : msg.duration_ms;
  const rlMs = run.rlDelayMs || 0;
  run.rlDelayMs = 0;
  const suffix = rlMs > 0 ? '（含限流重试 ' + fmtDuration(rlMs) + '）' : '';
  cur.el.classList.remove("thinking");
  cur.el.innerHTML = '<span class="t-ico">' + ICON_MIND + '</span>' +
    '<span>思考 · 持续了 ' + fmtDuration(ms) + suffix + '</span>';
  run.curThinking = null;
  run.lastThinkRow = cur.el;
  if (active) scrollToBottom();
}

/* ---------- 乐观思考胶囊 ----------
 * 发送/接力开跑的瞬间先渲染"思考中…"胶囊, 把模型首个事件之前不可见的
 * prefill 等待（长会话可达几十秒）变成可见反馈。thinking_start 到达时,
 * onThinkingStart 的 curThinking 守卫直接采用它而不新建第二条, 计时从乐观
 * 创建时刻起连续不归零; 若首个输出是正文/工具, dropOptimisticThinking 撤下
 * （正文气泡/工具卡已经是反馈, 不能让胶囊与它们同屏挂着）。 */
function beginOptimisticThinking(run, sid, col) {
  if (run.curThinking || run.curBubble) return;   // 已有思考行/正文已开流: 不重复创建
  const div = document.createElement("div");
  div.className = "think-row thinking";
  div.innerHTML = '<span class="t-ico">' + ICON_MIND + '</span>' +
    '<span class="shine">思考中…</span>';
  col.appendChild(div);
  run.curThinking = { el: div, t0: Date.now(), optimistic: true };
  run.lastThinkRow = div;   // 打断「已停止」与轮次收口兜底都走 lastThinkRow, 复用既有逻辑
  if (sid === state.sessionId) scrollToBottom();
}

function dropOptimisticThinking(run) {
  const cur = run.curThinking;
  if (!cur || !cur.optimistic) return;   // 只撤尚未被 thinking_start 接管的
  cur.el.remove();
  if (run.lastThinkRow === cur.el) run.lastThinkRow = null;
  run.curThinking = null;
}

/* ---------- 工具调用 ---------- */
/* 工具分组: 连续的工具调用收进同一个可折叠容器（头部显示次数/状态摘要）。
 * 分组默认折叠——正文只留一行摘要, 细节点头部回看; 运行中手动展开的
 * 分组不强制收回, 轮次收口恢复默认。纯视觉层: 不参与卡片配对
 * （liveToolCards/toolResultIndex 仍指向行元素本身）。 */

function fmtToolDur(ms) {
  if (ms < 1000) return (ms / 1000).toFixed(1) + "s";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s";
}

function updateToolGroupHeader(group) {
  if (!group) return;
  const rows = group.querySelectorAll(".tool-row");
  const sum = group.querySelector(".tg-sum");
  if (!rows.length) { group.remove(); return; }   // 最后一行被撤（plan_rejected）: 分组一并撤
  if (!sum) return;
  let run = 0, ok = 0, bad = 0;
  rows.forEach(r => {
    const st = r.dataset.state;
    if (st === "run") run++;
    else if (st === "ok") ok++;
    else bad++;   // err / denied / stopped 归为需注意
  });
  group.classList.toggle("running", run > 0);
  if (run > 0) {
    const done = rows.length - run;
    sum.textContent = rows.length === 1 ? "运行中…" : "运行中 " + done + "/" + rows.length + "…";
    sum.className = "tg-sum run";
  } else {
    /* 摘要 = 迷你计数胶囊(成功绿/需注意橙) + 总耗时小字。
     * 胶囊比 "✓5 · !1" 的细杆符号好认; 耗时来自各行闭合时累加的
     * group._ms(setToolState 里 += ), 历史回放无 _t0 则无耗时, 照旧不显示。 */
    let html = '<span class="cnt ok">' + ok + '</span>';
    if (bad) html += '<span class="cnt bad">' + bad + '</span>';
    if (group._ms >= 100) html += '<span class="tg-dur">' + fmtToolDur(group._ms) + '</span>';
    sum.innerHTML = html;
    sum.className = "tg-sum" + (bad ? " bad" : "");
  }
}

/* 新工具行的落点: 上一个元素是分组就续用, 否则开新分组。
 * 帧间噪音向前跳过不打断连续性: 思考行(think-row)与"工作中"转圈(#thinking)。
 * 转圈是 syncThinkingIndicator 在每次工具事件后 appendChild 到列尾的,
 * class 里没有 think-row——645ad08 只跳 think-row, 转圈挡在中间时下一
 * 个工具又裂成新组(v4.2.6 回归, 复现页已复现)。正文气泡/代码块等
 * "结论型"节点才终结分组。
 * 新分组创建时顺手收起同列里上一个已结束的旧分组（新活动开始了, 旧的让位）。 */
function groupForNewToolRow(col) {
  let g = col.lastElementChild;
  while (g && (g.classList.contains("think-row") || g.id === "thinking")) g = g.previousElementSibling;
  if (!g || !g.classList.contains("tool-group")) {
    g = document.createElement("div");
    g.className = "tool-group collapsed";   // 默认折叠: 正文只留一行摘要, 点头部展开
    const head = document.createElement("button");
    head.type = "button";
    head.className = "tg-head";
    head.innerHTML = '<span class="tg-caret">▾</span><span class="tg-title">工具调用</span>' +
                     '<span class="tg-sum"></span>';
    head.onclick = () => {
      g.classList.toggle("collapsed");
      if (!g.classList.contains("collapsed")) g._userOpen = true;   // 手动展开: 运行中不自动收回
    };
    g.appendChild(head);
    const body = document.createElement("div");
    body.className = "tg-body";
    g.appendChild(body);
    col.appendChild(g);
  }
  const prior = col.querySelectorAll(".tool-group");
  if (prior.length > 1) {
    const prev = prior[prior.length - 2];
    // 新活动开始: 上一个已结束的分组默认收回（手动展开的是运行中分组时不动）
    if (!prev.querySelector('.tool-row[data-state="run"]')) {
      prev.classList.add("collapsed");
    }
  }
  return g;
}

/* 轮次收口/历史回放后调用: 全部结束的分组回到默认折叠态（运行中的分组不动） */
function collapseFinishedToolGroups(col) {
  if (!col) return;
  col.querySelectorAll(".tool-group").forEach(g => {
    g._userOpen = false;   // 轮次收口: 重置手动展开标记, 新一轮恢复默认折叠
    if (g.querySelector('.tool-row[data-state="run"]')) return;
    g.classList.add("collapsed");
  });
}

function describeInput(raw, name) {  // 卡片标题一行摘要: JSON 先取 command/path 等关键字段，失败展示原文
  const clip = (s) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > 90 ? t.slice(0, 90) + "…" : t;
  };
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      if (data.action === "write" && Array.isArray(data.items)) {
        const done = data.items.filter(it => it.status === "completed").length;
        return data.items.length + " 项 (已完成 " + done + ")";
      }
      if (data.action === "read") return "读取当前清单";
      if (name === "grep") {
        let s = "/" + String(data.pattern || "") + "/";
        if (data.glob) s += "  ·  " + data.glob;
        if (data.output_mode && data.output_mode !== "files_with_matches") s += "  ·  " + data.output_mode;
        return s;
      }
      if (name === "glob") return String(data.pattern || "");
      for (const k of ["command", "path", "file_path", "url", "content", "plan"]) {
        if (typeof data[k] === "string" && data[k].trim()) {
          return clip(data[k]);
        }
      }
      return clip(Object.keys(data)
        .map(k => `${k}=${String(data[k])}`).join(" "));
    }
  } catch (e) { /* not json */ }
  return clip(String(raw || ""));
}

function addToolCard({ id, name, input, result }, col) {
  const meta = TOOL_META[name] || { label: name, icon: ICON_TOOL };
  const row = document.createElement("div");
  row.className = "tool-row";
  row.innerHTML =
    '<span class="t-ico">' + meta.icon + '</span>' +
    '<span class="tname2"></span><span class="tdesc"></span><span class="t-dur"></span><span class="tstate"></span>';
  row.querySelector(".tname2").textContent = meta.label;
  row.querySelector(".tdesc").textContent = describeInput(input, name);
  row.dataset.tool = name;
  row.dataset.input = input || "";
  row._t0 = Date.now();   // 结果到达时在 setToolState 里折算耗时小字
  // 悬停给完整入参（压平空白, 截 2000 字防巨体）——摘要 90 字截断曾把
  // 命令尾部的 `| xargs sh -c …` 藏掉, 只读白名单拒绝看起来像误拒
  const hover = String(input || "").replace(/\s+/g, " ").trim();
  if (hover.length > 90) row.title = hover.slice(0, 2000);
  // 落进工具分组（连续调用折叠为一组）, 不再逐条平铺在消息列
  groupForNewToolRow(col || msgCol()).querySelector(".tg-body").appendChild(row);
  if (result) {
    completeToolCard(row, result);
  } else {
    setToolState(row, "run");
  }
  scrollToBottom();
  return row;
}

/* ---------- diff 展示: write_file 结果卡的统一 diff 面板 ----------
 * 服务端在 tool_result 事件/历史回放里带 result_meta.diff（unified diff）。
 * 面板插在工具行下方, 默认折叠, 点头部展开/收起; ± 行绿/红着色。 */
function renderDiffPanel(row, diffText, meta) {
  if (!diffText || row.querySelector(".td-wrap")) return;
  const lines = diffText.split(String.fromCharCode(10));
  // 统计增删行数（跳过 ---/+++/@@ 头）
  let add = 0, del = 0;
  for (const l of lines) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  const wrap = document.createElement("div");
  wrap.className = "td-wrap";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "td-head";
  head.innerHTML =
    '<span class="td-caret">▸</span>' +
    '<span class="td-sum">' + (meta && meta.created ? "新建文件" : "变更") + '</span>' +
    '<span class="td-add">+' + add + '</span><span class="td-del">-' + del + '</span>';
  const body = document.createElement("div");
  body.className = "td-body";
  body.hidden = true;
  const table = document.createElement("div");
  table.className = "td-table";
  for (const l of lines) {
    const ln = document.createElement("div");
    let cls = "ctx";
    if (l.startsWith("+") && !l.startsWith("+++")) cls = "add";
    else if (l.startsWith("-") && !l.startsWith("---")) cls = "del";
    else if (l.startsWith("@@")) cls = "hunk";
    ln.className = "td-line " + cls;
    ln.textContent = l.length ? l : " ";
    table.appendChild(ln);
  }
  body.appendChild(table);
  head.onclick = () => {
    body.hidden = !body.hidden;
    head.querySelector(".td-caret").textContent = body.hidden ? "▸" : "▾";
  };
  wrap.appendChild(head);
  wrap.appendChild(body);
  row.insertAdjacentElement("afterend", wrap);   // 面板独立于工具行, 不挤一行式布局
}

function setToolState(row, kind) {
  row.dataset.state = kind;
  const st = row.querySelector(".tstate");
  st.className = "tstate " + kind;
  st.textContent = { run: "运行中", ok: "已完成", err: "出错",
                     denied: "已拒绝", stopped: "已中断" }[kind] || kind;
  // 耗时小字: 结果闭合那一刻起算。过短（<100ms，历史回放/同 tick 闭合）不显示,
  // 避免整列 "0.0s" 噪音; 悬空收口的行没有 _t0 也不显示
  const dur = row.querySelector(".t-dur");
  if (row._t0 && kind !== "run") {
    const ms = Date.now() - row._t0;
    if (ms >= 100) dur.textContent = fmtToolDur(ms);
    // 分组总耗时: 同一把尺子, 闭合行累加到所属分组(头部摘要用)
    const grp = row.closest(".tool-group");
    if (grp && ms >= 100) grp._ms = (grp._ms || 0) + ms;
  }
  updateToolGroupHeader(row.closest(".tool-group"));
}

function completeToolCard(row, { is_error, denied, result_meta, output }) {
  if (denied) {
    setToolState(row, "denied");
  } else if (is_error) {
    setToolState(row, "err");
  } else {
    setToolState(row, "ok");
  }
  if (result_meta && result_meta.diff) {
    renderDiffPanel(row, result_meta.diff, result_meta);
  }
  if (row.dataset.tool === "todo") {
    renderTodoCard(row);
  } else {
    // 命令/工具输出面板: 输出非空即渲染（此前 output 只进历史, 界面上
    // 无处可看——点卡片没有任何反应）。出错自动展开, 成功默认收起。
    renderOutputPanel(row, output, !!is_error && !denied);
  }
}

/* ---------- 输出展示: 工具卡的统一输出面板 ----------
 * tool_result 的 output（命令 stdout/stderr、工具摘要）此前只进模型历史,
 * 界面无处可看。面板插在工具行下方（与 diff 面板同构）, 默认折叠;
 * is_error 自动展开——出错时用户最关心的就是输出。纯 textContent,
 * 不走 markdown 渲染, 超长截断（完整输出在会话历史里）。 */
const OUTPUT_PANEL_MAX = 20000;
function renderOutputPanel(row, outputText, autoOpen) {
  if (!outputText || !String(outputText).trim()) return;
  if (row.querySelector(".to-wrap")) return;
  let text = String(outputText);
  if (text.length > OUTPUT_PANEL_MAX) {
    text = text.slice(0, OUTPUT_PANEL_MAX) +
      "\n\n[... 已截断, 共 " + text.length + " 字符; 完整输出见上下文]";
  }
  const wrap = document.createElement("div");
  wrap.className = "to-wrap" + (autoOpen ? " has-err" : "");
  const head = document.createElement("button");
  head.type = "button";
  head.className = "to-head";
  head.innerHTML = '<span class="to-caret">▸</span><span class="to-sum">输出</span>';
  const body = document.createElement("div");
  body.className = "to-body";
  body.hidden = !autoOpen;
  head.querySelector(".to-caret").textContent = body.hidden ? "▸" : "▾";
  const pre = document.createElement("div");
  pre.className = "to-pre";
  pre.textContent = text;
  body.appendChild(pre);
  head.onclick = () => {
    body.hidden = !body.hidden;
    head.querySelector(".to-caret").textContent = body.hidden ? "▸" : "▾";
  };
  wrap.appendChild(head);
  wrap.appendChild(body);
  row.insertAdjacentElement("afterend", wrap);
}

/* todo 卡: 工具行下方渲染任务清单本体（取代裸文本结果）。数据取自
 * 工具入参（write 时最新鲜、且历史回放可用——tool_use 块的 input 就有） */
function renderTodoCard(row) {
  if (row.querySelector(".todo-list")) return;
  let items = null;
  try {
    const data = JSON.parse(row.dataset.input || "{}");
    if (data.action === "write" && Array.isArray(data.items)) items = data.items;
  } catch (e) { /* 历史数据无 input */ }
  if (!items || !items.length) return;
  const wrap = document.createElement("div");
  wrap.className = "todo-list";
  const done = items.filter(it => it.status === "completed").length;
  const prog = document.createElement("div");
  prog.className = "todo-prog";
  const track = document.createElement("div");
  track.className = "todo-track";
  const bar = document.createElement("div");
  bar.className = "todo-bar";
  bar.style.width = Math.round(done / items.length * 100) + "%";
  track.appendChild(bar);
  prog.appendChild(track);
  const label = document.createElement("span");
  label.textContent = done + "/" + items.length;
  prog.appendChild(label);
  wrap.appendChild(prog);
  for (const it of items) {
    const line = document.createElement("div");
    line.className = "todo-item " + (it.status || "pending");
    line.textContent = it.content || "";
    wrap.appendChild(line);
  }
  row.insertAdjacentElement("afterend", wrap);
}

function onToolUseStarted(msg, sid) {
  // content_block_start(tool_use) 即建卡: 大参数（write_file 整文件等）的
  // JSON 流式期可达几十秒, 此前这段时间画面全静（转圈已收、卡片未建）,
  // 像卡死。参数传完后 onToolUse 按 id 复用这张卡补全描述。
  const run = runOf(sid);
  if (msg.id && run.liveToolCards[msg.id]) return;   // 幂等: 卡已在
  const active = sid === state.sessionId;
  run.awaiting = false;                    // 工具卡已是可见反馈: 空窗结束
  clearRateLimitNote(run);
  if (active) syncThinkingIndicator();
  flushAssistantBubble(run);
  dropOptimisticThinking(run);
  const card = addToolCard({ id: msg.id, name: msg.name, input: "" }, colOf(sid));
  card.querySelector(".tdesc").textContent = "接收参数中…";
  if (msg.id) run.liveToolCards[msg.id] = card;
  run.activeToolCard = card;
}

function onToolUse(msg, sid) {
  const run = runOf(sid);
  const active = sid === state.sessionId;
  run.awaiting = false;                    // 工具卡已是可见反馈: 空窗结束
  clearRateLimitNote(run);   // 工具调用已到: 限流重试成功, 撤提示行
  if (active) syncThinkingIndicator();
  flushAssistantBubble(run);   // 工具前先收掉流式中的正文气泡
  dropOptimisticThinking(run);   // 工具先于思考到达: 撤掉乐观胶囊（工具卡已是反馈）
  // tool_use_started 已提前建卡: 就地补全真实参数, 不重复建卡
  const existing = msg.id ? run.liveToolCards[msg.id] : null;
  if (existing) {
    existing.querySelector(".tdesc").textContent = describeInput(msg.input, msg.name || existing.dataset.tool);
    existing.dataset.input = msg.input || "";          // todo 卡等从入参渲染的地方依赖它
    existing._t0 = Date.now();   // 占位卡早于参数到达: 耗时从参数齐全起算
    run.activeToolCard = existing;
    return;
  }
  const card = addToolCard({ id: msg.id, name: msg.name, input: msg.input }, colOf(sid));
  if (msg.id) run.liveToolCards[msg.id] = card;   // 按 id 登记, 结果精确配对
  run.activeToolCard = card;
}

function onToolResult(msg, sid) {
  const run = runOf(sid);
  // 聊天点播: music_play 的结果镜像带 result_meta.music, 转交电台开播。
  // 只在实时事件里播——历史回放（completeToolCard 的 result_meta 只渲染 diff）
  // 不重播旧歌, 刷新页面不会凭空响起来。
  if (msg.result_meta && msg.result_meta.music && !msg.is_error) {
    const ok = window.aulosMusicPlay && window.aulosMusicPlay(msg.result_meta.music);
    if (!ok) toast("电台没接住点播指令, 点侧栏 ♫ 手动播吧");
  }
  if (msg.plan_rejected) {
    // 计划被拒: 计划卡已渲染拒绝态, 不补失败工具卡。但 tool_use_started
    // 可能已提前建了占位卡（present_plan 也会先镜像）, 就地移除, 不留悬卡
    if (msg.id && run.liveToolCards[msg.id]) {
      const card = run.liveToolCards[msg.id];
      delete run.liveToolCards[msg.id];
      const group = card.closest(".tool-group");   // 先取: remove 后节点脱离 DOM, closest 拿不到分组
      card.remove();
      if (run.activeToolCard === card) run.activeToolCard = null;
      updateToolGroupHeader(group);   // 空了会整个撤掉分组
    }
    return;
  }
  flushAssistantBubble(run);
  // 配对优先级: 流式卡片(按 id) → 历史回放登记的卡片(断线重同步接缝) →
  // 旧单槽位 → 都配不上(旧数据)才新开兜底卡片
  let card = null;
  if (msg.id && run.liveToolCards[msg.id]) {
    card = run.liveToolCards[msg.id];
    delete run.liveToolCards[msg.id];
  }
  if (!card && msg.id && run.toolResultIndex[msg.id]) {
    card = run.toolResultIndex[msg.id];
    delete run.toolResultIndex[msg.id];
  }
  if (!card && run.activeToolCard) card = run.activeToolCard;
  if (card) {
    completeToolCard(card, msg);
  } else {
    completeToolCard(addToolCard({ id: msg.id, name: msg.name, input: msg.input }, colOf(sid)), msg);
  }
  // （msg.result_meta 由 completeToolCard 消费: write_file 的 diff 面板）
  if (run.activeToolCard === card) run.activeToolCard = null;
}

/* 轮次收口: 把该会话所有还挂在"运行中"的工具卡统一闭合为"已中断"
 * （被打断/异常/断连丢事件, 结果永远来不了）。 */
function sweepPendingToolCards(run) {
  const sweep = c => { if (c && c.dataset.state === "run") setToolState(c, "stopped"); };
  Object.values(run.liveToolCards || {}).forEach(sweep);
  Object.values(run.toolResultIndex || {}).forEach(sweep);
  run.liveToolCards = {};
  run.toolResultIndex = {};
  run.activeToolCard = null;
}

/* 后台会话的轮次终点收口: busy 复位 + 悬空工具卡 sweep + 各类滞留 UI 清理。
 * turn_done/error 分支与 busy_sync 校正共用（前台会话走 endTurnUiReset）。 */
function settleBackgroundTurnEnd(run, sid) {
  run.busy = false;
  run.awaiting = false;
  run.queued = false;
  settlePendingPermsOnTurnEnd(run, sid);
  // 轮次收口: 悬空工具行标"已中断", 清掉流式指针
  sweepPendingToolCards(run);
  collapseFinishedToolGroups(colOf(sid));   // 后台会话已结束的分组回到默认折叠
  clearRateLimitNote(run);   // 限流退避提示一并撤下
  run.curBubble = null;
  // 思考行/乐观胶囊兜底收口（客户端计时）, 与前台 endTurnUiReset 一致;
  // 只清指针的话, 行会永远卡在"思考中…"动画态
  if (run.curThinking) onThinkingEnd({}, sid);
  renderSessionList();   // 收口即重绘: 后台会话跑完, 侧栏"运行中"转圈立刻停
}

/* ---------- 权限审批: 聊天流内联卡片（替代旧模态弹窗） ---------- */
const ICON_PRM_OK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>';
const ICON_PRM_NO = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/* 允许/拒绝按钮组: 工具审批卡与计划卡共用, 点击即决定 */
function buildPermChoices(requestId, sid, allowLabel, denyLabel) {
  const choices = document.createElement("div");
  choices.className = "pr-choices";
  for (const trip of [[true, "allow", allowLabel, ICON_PRM_OK],
                      [false, "deny", denyLabel, ICON_PRM_NO]]) {
    const val = trip[0], cls = trip[1], label = trip[2], icon = trip[3];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pr-btn " + cls;
    btn.innerHTML = icon;
    const txt = document.createElement("span");
    txt.textContent = label;
    btn.appendChild(txt);
    btn.onclick = function () { respondPermission(requestId, val, sid); };
    choices.appendChild(btn);
  }
  return choices;
}

/* 决定后的结果标记: 勾/叉图标 + 文案 */
function makePrMark(text, approved) {
  const mark = document.createElement("span");
  mark.className = "pr-mark";
  mark.innerHTML = approved ? ICON_PRM_OK : ICON_PRM_NO;
  const txt = document.createElement("span");
  txt.textContent = text;
  mark.appendChild(txt);
  return mark;
}

/* 命令前缀规则提取: 从入参 command 里取前 ≤2 个词（剥 VAR=val 前缀）,
 * 作为"以 xx 开头"的白名单规则。包管理器 run/exec/test 类取 3 词——
 * "uv run pytest -q" 提 "uv run pytest" 而不是 "uv run"(那会连带放行
 * "uv run python 任意脚本")。UI 层示意即可, 服务端保存时会再清洗、
 * 授权层按 shlex 词对齐匹配（比这里更严格）。取不出词返回 null。 */
const RULE_RUNNER_FIRST = new Set(["uv", "npm", "pnpm", "yarn", "bun", "deno"]);
const RULE_RUNNER_SECOND = new Set(["run", "exec", "test", "x"]);
function allowlistRuleOf(input) {
  let cmd = "";
  try {
    const data = JSON.parse(input || "{}");
    if (typeof data.command === "string") cmd = data.command;
  } catch (e) { /* not json */ }
  let words = cmd.trim().split(/\s+/).filter(w => w && !/^[A-Za-z_][A-Za-z0-9_]*=$/.test(w));
  const n = (words.length >= 3 && RULE_RUNNER_FIRST.has((words[0] || "").toLowerCase())
    && RULE_RUNNER_SECOND.has((words[1] || "").toLowerCase())) ? 3 : 2;
  words = words.slice(0, n).map(w => w.replace(/["']/g, ""));
  const rule = words.join(" ").trim().slice(0, 80);
  return rule || null;
}

/* 请求是否仍挂起: 记忆类按钮的副作用(写白名单/附加目录)只在请求真正
 * 待批时才允许发生。批复可能在按钮 POST 的竞态窗口里经别的路径
 * (主按钮/桌宠/REST)完成——已处理就不再落任何副作用。 */
function permRequestPending(requestId, sid) {
  const run = runOf(sid);
  return !!(run && run.pendingPerms[requestId]);
}

/* "总是允许"按钮: 把该命令的前缀规则加入白名单并批准本次请求。
 * 只给 bash/powershell 审批卡渲染——白名单是 shell 语义。 */
function buildAlwaysAllowBtn(requestId, sid, input) {
  const rule = allowlistRuleOf(input);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pr-btn always";
  btn.innerHTML = ICON_PRM_OK;
  const txt = document.createElement("span");
  txt.textContent = rule ? `总是允许"${rule} …"` : "总是允许";
  btn.appendChild(txt);
  btn.onclick = async function () {
    if (!permRequestPending(requestId, sid)) return;
    btn.disabled = true;
    try {
      const r = await fetch("/api/settings/allowlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: rule || (allowlistRuleOf(input) || "bash") }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || r.status);
      }
      const data = await r.json();
      respondPermission(requestId, true, sid);
      toast(`已加白名单并允许: ${(data.rules || []).slice(-1)[0] || rule}`);
      if (typeof renderAllowlistSettings === "function") renderAllowlistSettings();
    } catch (e) {
      btn.disabled = false;
      toast("加白名单失败: " + e.message);
    }
  };
  return btn;
}

/* "本会话允许"按钮: 前缀规则只写入该会话 runtime 的会话级白名单（不落盘）,
 * 会话内同类命令不再弹问, 会话结束即失效——比"总是允许"轻一档的记忆。 */
function buildSessionAllowBtn(requestId, sid, input) {
  const rule = allowlistRuleOf(input);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pr-btn session";
  btn.innerHTML = ICON_PRM_OK;
  const txt = document.createElement("span");
  txt.textContent = rule ? `本会话允许"${rule} …"` : "本会话允许";
  btn.appendChild(txt);
  btn.onclick = async function () {
    if (!permRequestPending(requestId, sid)) return;
    btn.disabled = true;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/allow-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: rule || "bash" }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || r.status);
      }
      respondPermission(requestId, true, sid);
      toast(`本会话内不再询问: ${rule || "该命令"}`);
    } catch (e) {
      btn.disabled = false;
      toast("会话规则写入失败: " + e.message);
    }
  };
  return btn;
}

/* 写工具目标路径所在目录（取绝对路径才有可记的目录; 相对路径交给
 * 服务端 resolve 会按服务进程 cwd 解析, 记错目录不如不记）。 */
function writeTargetDirOf(input) {
  let p = "";
  try {
    const data = JSON.parse(input || "{}");
    if (typeof data.path === "string") p = data.path;
  } catch (e) { return null; }
  if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith("/")) return null;
  p = p.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const dir = i > 0 ? p.slice(0, i) : null;
  return dir && dir.length > 2 ? dir : null;
}

/* "允许并记住该目录"按钮: 写出 workspace 根的审批卡专用——目标目录加入
 * 全局附加目录（additionalDirectories）并批准本次, 之后写该目录不再弹问。
 * 敏感路径（escalation=sensitive）不给记忆出路, 每次都问。 */
function buildRememberDirBtn(requestId, sid, input) {
  const dir = writeTargetDirOf(input);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pr-btn always";
  btn.innerHTML = ICON_PRM_OK;
  const txt = document.createElement("span");
  txt.textContent = dir ? `允许并记住 ${dir}` : "允许并记住该目录";
  btn.appendChild(txt);
  btn.onclick = async function () {
    if (!permRequestPending(requestId, sid)) return;
    if (!dir) { respondPermission(requestId, true, sid); return; }
    btn.disabled = true;
    try {
      const r = await fetch("/api/settings/additional-dirs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || r.status);
      }
      respondPermission(requestId, true, sid);
      toast(`已记住目录, 之后写该目录不再询问: ${dir}`);
    } catch (e) {
      btn.disabled = false;
      toast("记住目录失败: " + e.message);
    }
  };
  return btn;
}

function onPermissionRequest(msg, sid) {
  // sid 缺省 = 当前会话（旧事件流路径）: WS 分发处总是带 sid
  const sid2 = sid || state.sessionId;
  const run = runOf(sid2);
  if (run.pendingPerms[msg.request_id]) return;   // 重放/重连重复事件: 忽略
  run.pendingPerms[msg.request_id] = msg;
  bumpUnread(sid2);
  // 等待授权也是"等模型"的一种: 点亮空窗态, 否则画面全静止,
  // 用户会以为这轮已经跑完
  run.awaiting = run.busy;
  if (sid2 === state.sessionId) syncThinkingIndicator();

  const meta = TOOL_META[msg.tool_name] || { label: msg.tool_name, icon: ICON_TOOL };
  if (msg.tool_name === "present_plan") {
    renderPlanCard(msg, sid2, run);
    return;
  }
  const row = document.createElement("div");
  row.className = "perm-row";
  row.dataset.reqId = msg.request_id;

  // 卡片式: 头行(图标+工具+等待提示) / 命令行 / 按钮行, 点按钮即决定
  const head = document.createElement("div");
  head.className = "pr-head";
  const ico = document.createElement("span");
  ico.className = "pr-ico";
  ico.innerHTML = meta.icon;
  const title = document.createElement("span");
  title.className = "pr-title";
  title.textContent = meta.label;
  const hint = document.createElement("span");
  hint.className = "pr-hint";
  hint.innerHTML = '<i class="pr-dot"></i>等待确认';
  head.appendChild(ico); head.appendChild(title); head.appendChild(hint);
  row.appendChild(head);

  const body = describeInput(msg.input, msg.name) || "(无参数)";
  const cmd = document.createElement("div");
  cmd.className = "pr-cmd";
  cmd.textContent = body;
  row.appendChild(cmd);

  // 弹问原因（敏感路径/写出 workspace 根）: 用户得知道这次为什么弹
  if (msg.detail) {
    const why = document.createElement("div");
    why.className = "pr-detail";
    why.textContent = "⚠ " + msg.detail;
    row.appendChild(why);
  }

  row.appendChild(buildPermChoices(msg.request_id, sid2, "允许", "拒绝"));
  // shell 命令审批卡追加记忆按钮: "总是允许"入全局白名单（落盘）,
  // "本会话允许"只写会话级规则（会话结束失效）——同类命令不再逐条问
  if (msg.tool_name === "bash" || msg.tool_name === "powershell") {
    row.appendChild(buildAlwaysAllowBtn(msg.request_id, sid2, msg.input));
    row.appendChild(buildSessionAllowBtn(msg.request_id, sid2, msg.input));
  }
  // 写出 workspace 根的审批卡: 记住目标目录（加入附加目录）后免问;
  // 敏感路径不给记忆出路（escalation=sensitive 不渲染此按钮）
  if ((msg.tool_name === "write_file" || msg.tool_name === "edit_file")
      && msg.escalation === "outside-write") {
    row.appendChild(buildRememberDirBtn(msg.request_id, sid2, msg.input));
  }

  colOf(sid2).appendChild(row);
  if (sid2 === state.sessionId) scrollToBottom();
}

/* ---------- 计划预览卡: present_plan 专用 ----------
 * markdown 渲染计划全文, 单选批准/拒绝; 批准后端自动升级模式并继续,
 * 拒绝则收起选择区、标记"已拒绝"，模型会修订后再次提交。 */
/* present_plan 的 input → markdown 计划全文（解析失败回退原文） */
function planTextOf(input) {
  try {
    const data = JSON.parse(input || "{}");
    return typeof data.plan === "string" ? data.plan : String(input || "");
  } catch (e) { return String(input || ""); }
}

/* 右侧计划面板呈现一份计划: 全文渲染 + 审批按钮 + 归属会话标记。
 * 当前会话的新计划（renderPlanCard）与切回会话的恢复
 * （syncPlanPanelForActiveSession）共用。面板全局只有一份, 归属
 * 记在 #plan-actions 的 reqId/reqSession 上, 收口/批复据此认领。 */
function showPlanInPanel(reqId, sid, planText) {
  const pane = $("pane");
  const body = $("plan-body");
  _planSource = planText;   // 复制按钮用: 始终复制 markdown 源文
  body.innerHTML = renderMd(planText);
  decorateCode(body);
  decorateTables(body);
  body.classList.remove("stale");   // 新计划到达: 清掉上一份的过期淡化
  const actions = $("plan-actions");
  actions.innerHTML = "";
  actions.dataset.reqId = reqId;
  actions.dataset.reqSession = sid;   // 面板归属: 批复/收口只认这个会话
  actions.appendChild(buildPermChoices(reqId, sid, "批准并实施", "拒绝"));
  const s = state.sessions.find(x => x.id === sid);
  $("plan-title").textContent = "实施计划" + (s ? " · " + displayTitle(s) : "");
  pane.classList.add("plan-open");
}

/* 切会话/回草稿态时同步右侧面板: 当前会话有未决 present_plan 就恢复显示
 * （后台会话收到计划时不抢面板, 靠这里在切回时补弹——两个会话都在等
 * 计划审批时, 先弹的那个不再被后弹的顶掉）; 没有则只收起面板, 不清正文
 * （用户可能还在看上一份已定的计划全文）。 */
function syncPlanPanelForActiveSession() {
  const run = curRun();
  const pend = run ? Object.values(run.pendingPerms)
    .filter(p => p && p.tool_name === "present_plan") : [];
  if (pend.length) {
    const msg = pend[pend.length - 1];   // 最近提交的一份未决计划
    showPlanInPanel(msg.request_id, state.sessionId, planTextOf(msg.input));
  } else {
    $("pane").classList.remove("plan-open");
  }
}

function renderPlanCard(msg, sid2, run) {
  const active = sid2 === state.sessionId;
  // 右侧计划面板只属于当前会话: 新计划在此弹出; 后台会话不抢面板,
  // 只建聊天流卡 + 登记 pendingPerms, 切回时 syncPlanPanelForActiveSession 补弹
  if (active) showPlanInPanel(msg.request_id, sid2, planTextOf(msg.input));

  // 聊天流轻量卡: 面板被收起时也能就地批准/拒绝
  const card = document.createElement("div");
  card.className = "plan-card";
  card.dataset.reqId = msg.request_id;
  const head = document.createElement("div");
  head.className = "plan-head";
  head.innerHTML = '<span class="pr-ico">' + ICON_MODE_PLAN + '</span>' +
    '<span class="plan-title">实施计划</span>' +
    '<span class="pr-hint"><i class="pr-dot"></i>等待确认' +
    (active ? "（已在右侧面板打开）" : "") + '</span>';
  card.appendChild(head);
  card.appendChild(buildPermChoices(msg.request_id, sid2, "批准并实施", "拒绝"));
  colOf(sid2).appendChild(card);
  if (active) scrollToBottom();
}

$("plan-close").onclick = () => $("pane").classList.remove("plan-open");

/* 计划全文复制: 复制 markdown 源文（renderPlanCard 存于 _planSource）,
 * 粘贴到文档/issue 语法结构完好; 按钮短暂显示"已复制"后回弹 */
let _planSource = "";
$("plan-copy").onclick = async () => {
  if (!_planSource) return;
  await copyText(_planSource);
  const btn = $("plan-copy");
  btn.innerHTML = CHECK_SVG + "<span>已复制</span>";
  setTimeout(() => { btn.innerHTML = COPY_SVG + "<span>复制</span>"; }, 1400);
};

/* 计划过期收口: 用户不批计划而是继续发消息追加需求, 或轮次已收口时,
 * 未决的 present_plan 在协议层已是死请求（服务端 prompter 已换新）。
 * 前端就地定格: 聊天流计划卡与右侧面板按钮标"已过期/已中断", 正文淡化
 * 但保留可读——模型随后会重新规划, 新计划以新 reqId 覆盖面板。
 * 只清前端 pendingPerms, 不发 permission_response（旧 reqId 发了只会错配）。 */
function expirePlanCard(run, sid, label) {
  const rids = Object.keys(run.pendingPerms).filter(rid =>
    run.pendingPerms[rid] && run.pendingPerms[rid].tool_name === "present_plan");
  if (!rids.length) return;
  for (const rid of rids) delete run.pendingPerms[rid];
  for (const rid of rids) {
    colOf(sid).querySelectorAll(`.plan-card[data-req-id="${rid}"]`).forEach(card => {
      if (card.classList.contains("allowed") || card.classList.contains("denied")) return;
      card.classList.add("denied", "expired");
      const choices = card.querySelector(".pr-choices");
      if (choices) choices.remove();
      card.appendChild(makePrMark(label, false));
    });
  }
  // 右侧面板: 显示的正是被过期的这份计划（且属于本会话）→ 按钮区定格, 正文淡化
  const pa = $("plan-actions");
  if (rids.includes(pa.dataset.reqId) && pa.dataset.reqSession === sid) {
    pa.innerHTML = "";
    pa.appendChild(makePrMark(label, false));
    $("plan-body").classList.add("stale");
  }
  renderSessionList();   // 计划过期即重绘: 侧栏"待批计划"徽标立刻熄灭
}

/* 审批卡定格: 撤按钮, 标记结果（本地批复与 permission_resolved 广播共用,
 * "已定格"的卡跳过——两条路径可能先后到达同一 rid, 幂等） */
function markPermResolved(sid, requestId, approved) {
  const markCard = card => {
    if (!card) return;
    if (card.classList.contains("allowed") || card.classList.contains("denied")) return;
    card.classList.add(approved ? "allowed" : "denied");
    const choices = card.querySelector(".pr-choices");
    if (choices) choices.remove();
    // 记忆类按钮(总是允许/本会话允许/记住目录)直接挂在卡上, 不在
    // .pr-choices 里——不摘掉的话定格后仍可点击, 且副作用(写白名单/
    // 附加目录)照常发生。在途请求不受影响(用户已表达的意图保留)。
    card.querySelectorAll(".pr-btn").forEach(b => b.remove());
    card.appendChild(makePrMark(
      approved
        ? (card.classList.contains("plan-card") ? "已批准 · 开始实施" : "已允许")
        : "已拒绝",
      approved));
  };
  colOf(sid).querySelectorAll(
    `.perm-row[data-req-id="${requestId}"], .plan-card[data-req-id="${requestId}"]`
  ).forEach(markCard);
  // 右侧面板脚注同步定格（面板正显示这份计划且属于本会话才动——
  // 面板可能已被另一会话的计划占用）
  const pa = $("plan-actions");
  if (pa.dataset.reqId === requestId && pa.dataset.reqSession === sid) {
    pa.innerHTML = "";
    pa.appendChild(makePrMark(approved ? "已批准 · 开始实施" : "已拒绝", approved));
  }
  renderSessionList();   // 批复即重绘: 侧栏"待批计划"徽标立刻熄灭（本地批复与广播共用此口）
}

/* 桌宠/REST 批复的同步: 服务端广播 permission_resolved, 主窗据此清
 * pendingPerms 登记并定格审批卡。不广播的话主窗永远不知道请求已被
 * 悬浮窗处理——"等待授权…"指示与可点按钮全部滞留到轮次结束。 */
function onPermissionResolved(msg, sid) {
  const run = runOf(sid);
  if (!run || !msg.request_id) return;
  if (run.pendingPerms[msg.request_id]) delete run.pendingPerms[msg.request_id];
  markPermResolved(sid, msg.request_id, !!msg.approved);
  if (sid === state.sessionId) syncThinkingIndicator();   // "等待授权"标签即时纠偏
}

/* 轮次收口: 未决审批卡定格为已拒绝（服务端此刻已朝安全侧 DENY）,
 * 并清空登记。前台后台两条收口路径共用——漏掉哪条, stale 登记都会
 * 让"等待授权…"标签在该会话后续等待窗口里永久滞留。 */
function settlePendingPermsOnTurnEnd(run, sid) {
  for (const rid of Object.keys(run.pendingPerms)) {
    const card = colOf(sid).querySelector(
      `.perm-row[data-req-id="${rid}"], .plan-card[data-req-id="${rid}"]`);
    if (card && !card.classList.contains("allowed") && !card.classList.contains("denied")) {
      card.classList.add("denied");
      const choices = card.querySelector(".pr-choices");
      if (choices) choices.remove();
      // 同 markPermResolved: 记忆类按钮一并摘除, 防定格后仍可点出副作用
      card.querySelectorAll(".pr-btn").forEach(b => b.remove());
      card.appendChild(makePrMark("已拒绝", false));
    }
    // 右侧计划面板若正显示这份计划（且属于本会话）: 按钮区一并定格, 不留死按钮
    if (run.pendingPerms[rid]?.tool_name === "present_plan"
        && $("plan-actions").dataset.reqId === rid
        && $("plan-actions").dataset.reqSession === sid) {
      const pa = $("plan-actions");
      pa.innerHTML = "";
      pa.appendChild(makePrMark("已中断", false));
      $("plan-body").classList.add("stale");
    }
  }
  run.pendingPerms = {};
}

function respondPermission(requestId, approved, sid) {
  const run = runOf(sid);
  if (!run || !run.pendingPerms[requestId]) return;
  delete run.pendingPerms[requestId];
  sendWs({ type: "permission_response", request_id: requestId, approved }, sid);
  markPermResolved(sid, requestId, approved);
}

/* ---------- 轮次结束 / 错误 ---------- */
function endTurnUiReset() {
  const run = curRun();
  if (run) {
    run.busy = false;
    run.awaiting = false;
    run.queued = false;
    run.unread = 0;             // 前台亲眼看完了, 未读清零
    clearRateLimitNote(run);    // 轮次收口: 限流退避提示一并撤下
    flushAssistantBubble(run);
    // 未决审批登记一并收口（服务端已朝安全侧 DENY）: 不清的话 stale
    // 条目会让下个"等待授权"标签永久滞留
    settlePendingPermsOnTurnEnd(run, state.sessionId);
    // 轮次结束还有工具行停在"运行中"（被打断/异常, 结果永远来不了）: 收口
    sweepPendingToolCards(run);
    collapseFinishedToolGroups(colOf(state.sessionId));   // 已结束的分组随轮次收口回到默认折叠
    if (run.curThinking) onThinkingEnd({}, state.sessionId);   // 思考行兜底收口（客户端计时）
  }
  syncThinkingIndicator();
  setBusyUi(false);
  renderSessionList();          // 运行标识/未读刷新
}

function onTurnQueued(msg) {
  addNoteBubble("warn", `并发已满（上限 ${msg.max_concurrent} 轮），等前面的轮次结束后自动开始`);
}

function onAwaitOutput(msg, sid) {
  // 模型调用已发出、首个 token 未到的空窗（每轮 prefill / 工具跑完后的下一轮）:
  // 空窗状态记在会话上, 显示统一走 syncThinkingIndicator 重算——
  // 切到该会话时也能正确显示/隐藏, 不会残留到别的会话
  const run = runOf(sid);
  if (run && run.busy) {
    run.awaiting = true;
    if (sid === state.sessionId) syncThinkingIndicator();
  }
}

/* ---------- 接力: 轮到待发送的后续消息了 ---------- */
/* 接力消息转正: 按 qid 逐条撤下对应待发送卡片（服务端把待发送区的多条
 * 消息合并成一轮接力, items 里逐条对应; 旧消息无 qid 时回退按文本匹配）,
 * 并补 user 气泡——计划接力路径发送时已乐观加上（挂 _qid）, 按 qid 查重
 * 跳过防双气泡; 普通排队/其他窗口/历史回放没有 _qid, 在此补上 */
function settleRelayedMessages(msg, sid) {
  const run = runOf(sid);
  const col = colOf(sid);
  const items = Array.isArray(msg.items) && msg.items.length
    ? msg.items
    : [{ qid: msg.qid, text: msg.text, attachments: msg.attachments }];
  items.forEach(it => {
    const qi = run.queue.findIndex(q =>
      it.qid ? q.qid === it.qid : q.text === it.text);
    if (qi >= 0) run.queue.splice(qi, 1);
    const dup = it.qid && col.querySelector(`.msg.user[_qid="${it.qid}"]`);
    if (!dup) addUserBubble(it.text, it.attachments, col, msg.ts);
  });
}

function onTurnStarted(msg, sid) {
  const run = runOf(sid);
  run.busy = true;
  run.awaiting = false;      // 新一轮: 上一轮的空窗状态作废, 等 await_output 重新点亮
  run.lastThinkRow = null;   // 新一轮开始: 打断标记只属于当前轮的思考行
  settleRelayedMessages(msg, sid);
  beginOptimisticThinking(run, sid, colOf(sid));   // 排队消息接力开跑: 立刻给反馈
  if (sid === state.sessionId) {
    renderQueueCards();
    syncThinkingIndicator();
    setBusyUi(true);
    scrollToBottom();
  }
  renderSessionList();
}

function onTurnQueuedUser(msg, sid) {
  // 服务端入队回执: 前端只显示中性的"待发送"徽标, 不展示排队位置
}

function onQueueCleared(sid) {
  // 打断/断连清空待发送区: 撤掉全部卡片, 文本放回输入框不丢
  const run = runOf(sid);
  if (!run.queue.length) return;
  const items = run.queue.slice();
  run.queue.length = 0;
  if (sid === state.sessionId) {
    renderQueueCards();
    const texts = items.map(it => it.text).filter(t => t);
    const cur = $("input").value.trim();
    $("input").value = cur ? cur + "\n" + texts.join("\n") : texts.join("\n");
    autoGrow($("input"));
    // 排队区清空: 附件一并放回附件草稿, 不丢
    const atts = items.flatMap(it => it.attachments || []);
    if (atts.length) setAttachDraft(attachDraftOf().concat(atts));
    saveCurrentInput();
  }
}

function fmtTokens(n) {
  if (typeof n !== "number" || n <= 0) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/* 轮次用量行: turn_done 带来本轮 token 消耗, 渲染成一条淡色小字。
 * 全零（断线显形/被打断在首个请求前）时不渲染——没有信息量的行是噪音。 */
function addUsageNote(usage) {
  if (!usage || typeof usage !== "object") return;
  const total = (usage.input_tokens || 0) + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  if (!total) return;
  const parts = [];
  const out = fmtTokens(usage.output_tokens);
  const cin = fmtTokens(usage.cache_creation_input_tokens);
  const cred = fmtTokens(usage.cache_read_input_tokens);
  const inp = fmtTokens(usage.input_tokens);
  if (inp) parts.push("输入 " + inp);
  if (out) parts.push("输出 " + out);
  if (cin) parts.push("缓存写 " + cin);
  if (cred) parts.push("缓存读 " + cred);
  addNoteBubble("usage", "本轮 token · " + parts.join(" · "));
}

function onTurnDone(msg) {
  endTurnUiReset();
  addUsageNote(msg.usage);
  if (msg.interrupted) {
    // 「已停止」挂在本轮思考行的胶囊里; 本轮没思考过（工具/正文阶段打断）才落成独立提示行
    const row = curRun()?.lastThinkRow;
    if (row && row.isConnected) {
      const tag = document.createElement("span");
      tag.className = "t-stopped";
      tag.textContent = "已停止";
      row.appendChild(tag);
    } else {
      addNoteBubble("stopped", "已停止");
    }
  } else if (msg.budget_exhausted) {
    addBudgetNote(msg.usage);
  } else if (msg.iterations_exhausted) {
    addNoteBubble("warn", `已达单轮最大迭代次数（${msg.iterations} 次调用），已提前收束本轮`);
  }
  // 刷新侧栏标题/消息数，标题可能被自动命名更新
  (async () => { await loadSessions(); refreshDocTitle(); })();
}

/* 预算横幅: 带真实累计输出（与触发预算的计数同口径, 修复前显示的是
 * 最后一次调用的用量）+ 一键"继续"。收束点历史已完整落定, 继续 =
 * 用户手打"继续"发送, 无需任何服务端配合。 */
function addBudgetNote(usage) {
  const div = document.createElement("div");
  div.className = "note warn";
  const out = usage && usage.output_tokens ? fmtTokens(usage.output_tokens) : "";
  div.textContent = "⚠ 本轮输出 token 预算已用尽"
    + (out ? `（累计输出 ${out}，可调大 turnTokenBudget）` : "") + "，已提前收束本轮";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "note-act";
  btn.textContent = "继续";
  btn.onclick = () => { btn.disabled = true; sendFixedText("继续"); };
  div.appendChild(btn);
  msgCol().appendChild(div);
  scrollToBottom();
}

/* 固定文本直接开一轮: 与 sendCurrent 的非草稿、非忙碌路径同构（turn_done
 * 之后必然处于该状态）, 不经过输入框, 不动用户正在打的草稿。 */
function sendFixedText(text) {
  const run = curRun();
  if (!run || !run.ws || run.ws.readyState !== 1) {
    toast("连接未就绪，请手动发送「继续」");
    return;
  }
  addUserBubble(text, []);
  run.busy = true;
  run.awaiting = false;
  run.lastThinkRow = null;   // 新一轮开始: 打断标记只属于当前轮的思考行
  beginOptimisticThinking(run, state.sessionId, msgCol());
  syncThinkingIndicator();
  setBusyUi(true);
  renderSessionList();
  updateSendBtn();
  sendWs({ type: "user", text, attachments: [], qid: genQid() });
}

function onSessionRenamed(msg) {
  // AI 命名完成（在 turn_done 之后异步到达）: 刷新列表 + 顶栏标题
  (async () => { await loadSessions(); refreshDocTitle(); })();
}

function onError(msg) {
  // 错误也是本轮结束: 不复位 busy 的话输入框会永久锁死，看起来像卡死
  endTurnUiReset();
  addNoteBubble("err", msg.message || "未知错误");
}

function addNoteBubble(kind, text) {
  const div = document.createElement("div");
  div.className = "note " + kind;
  div.textContent = (kind === "err" ? "✗ " : kind === "warn" ? "⚠ " : "") + text;
  msgCol().appendChild(div);
  scrollToBottom();
}

/* ---------- 压缩续接消息: 模型指令, 非对话内容 ----------
 * 旧版压缩把续接摘要作为 user 消息持久化, 回放显示成一整面墙。
 * 按固定前缀识别（与 compact.py 的 continuation_text 对应）后渲染为
 * 一行式提示卡; 新版压缩不再落盘, 只发 context_compacted 提示。 */
const COMPACT_MARK = "This session is being continued from a previous conversation";
function isCompactNotice(text) { return text.startsWith(COMPACT_MARK); }
function addCompactNotice(col, live) {
  const div = document.createElement("div");
  div.className = "note compact-note";
  div.textContent = (live ? "本轮已自动压缩上下文" : "此处之前的上下文已压缩")
    + "（摘要仅供模型使用，完整对话记录不受影响）";
  (col || msgCol()).appendChild(div);
  scrollToBottom();
}

/* ---------- 模型导向系统提示: [System note] 前缀的 user 消息 ----------
 * 收束提醒/预算耗尽/迭代上限/截断恢复等内部导向文案以 user 角色落进
 * 历史（供模型读取）, 对用户没有任何可行动的信息——回放时直接跳过,
 * 不渲染。 */
const SYSTEM_NOTE_MARK = "[System note]";
function isSystemNote(text) { return text.startsWith(SYSTEM_NOTE_MARK); }

/* ---------- 限流退避提示: 同一轮的多条原地更新一行, 有进展/收口即撤 ---------- */
function onRateLimitedRetry(msg, sid) {
  const run = runOf(sid);
  // 累计本条思考行里的退避等待: 收口时在"思考 · 持续了 X"后标注,
  // 不让纯 API 等待被读成模型在思考
  run.rlDelayMs = (run.rlDelayMs || 0) + Math.max(0, Number(msg.delay_s) || 0) * 1000;
  let el = run.rlNote;
  if (!el || !el.isConnected) {
    el = document.createElement("div");
    el.className = "note warn rl-note";
    colOf(sid).appendChild(el);
    run.rlNote = el;
  }
  el.textContent =
    `⚠ 触发限流，${Math.round(msg.delay_s)} 秒后进行第 ${msg.attempt}/${msg.max_retries} 次重试…`;
  if (sid === state.sessionId) scrollToBottom();
}

function clearRateLimitNote(run) {
  if (run && run.rlNote) {
    run.rlNote.remove();
    run.rlNote = null;
  }
}

/* ---------- 打断受理反馈: 静默窗口（退避/建连/长工具）内停止不是瞬时的,
 * 明确告诉用户"已受理、正在收束", 避免连点; 轮次收口自动清除 ---------- */
function onTurnInterrupting(msg, sid) {
  const run = runOf(sid);
  let el = run.rlNote;
  if (!el || !el.isConnected) {
    el = document.createElement("div");
    el.className = "note stopped rl-note";
    colOf(sid).appendChild(el);
    run.rlNote = el;
  }
  el.textContent = "正在中断当前轮，模型输出/命令收束后即停止…";
  if (sid === state.sessionId) scrollToBottom();
}

function addErrorBubble(text) {
  addNoteBubble("err", text);
}


/* ============================================================
 * 发送 / 中断 / 输入框
 * 同一个圆钮双形态: 输入框有内容 = 发送; 为空且本轮进行中 = 中断
 * ============================================================ */
function updateSendBtn() {
  const hasText = !!$("input").value.trim();
  const hasAttach = attachDraftOf().length > 0;   // 有附件无文字也点亮发送
  const busy = !!(curRun() && curRun().busy);
  const btn = $("btn-send");
  const stop = !hasText && !hasAttach && busy;
  btn.dataset.mode = stop ? "stop" : "send";
  btn.dataset.tip = stop ? "中断对话" : "发送";
}
function setBusyUi(busy) {
  // 忙碌态占位符对齐 Claude.ai: 提示可以直接继续排队
  $("input").placeholder = busy ? "继续输入以排队后续修改" : "提出后续修改要求";
  updateSendBtn();
}

/* 本会话是否正卡在计划审批（pendingPerms 全部是 present_plan）。
 * 侧栏会话项的 awaiting-plan 高亮共用这个判断 */
function isAwaitingPlan(run) {
  if (!run || !run.pendingPerms) return false;
  const pending = Object.values(run.pendingPerms);
  return pending.length > 0 && pending.every(p => p.tool_name === "present_plan");
}

/* "思考中"转圈 = 当前会话忙（整个 busy 期间都转）。此前各事件分支里
 * 手工开关、切换会话不重算: 切到空闲会话转圈残留、后台轮次跑完转圈不灭
 * ——统一在这里按当前会话重算。节点挂在当前会话消息列最底部, 随内容滚动。 */
function syncThinkingIndicator() {
  let el = $("thinking");
  if (!el) {   // 节点不在静态 HTML 里, 惰性创建后挪到当前会话消息列末尾
    el = document.createElement("div");
    el.id = "thinking";
    el.innerHTML = '<span class="spin"></span><span class="t">工作中…</span>';
  }
  const run = curRun();
  const show = !!(run && run.busy);
  el.style.display = show ? "flex" : "none";
  if (state.sessionId) {
    colOf(state.sessionId).appendChild(el);
    if (show) scrollToBottom();   // 挂到列尾会撑高内容: 贴底时跟着滚, 别让转圈悬在视口外
  }
}

async function sendCurrent() {
  const input = $("input");
  const text = input.value.trim();
  const attachments = attachDraftOf().slice();   // 发送快照, 与草稿解耦
  const run = curRun();
  const busy = !!(run && run.busy);
  if (!text && !attachments.length) return;   // 只发图不打字也允许
  if (!state.draft && (!run || !run.ws || run.ws.readyState !== 1)) return;
  // 草稿态: 此刻才向服务端要 id 建会话条目；失败则留在草稿态
  let firstWorkdir = "";
  if (state.draft) {
    firstWorkdir = state.draftDir || "";
    try {
      const r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workdir: firstWorkdir }),   // 创建即绑定项目, 列表立刻归组
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      state.sessionId = (await r.json()).id;
    } catch (e) {
      toast("创建会话失败: " + e.message);
      return;
    }
  }
  msgCol().querySelector(".empty-state")?.remove();
  $("pane").classList.remove("empty-view");   // 有内容了: 输入卡落回底部
  skillMenuDestroy();   // 发送即收起斜杠补全（排队/插队路径同样覆盖）
  $("ws-dock").innerHTML = "";                // 草稿态的工作区条/建议 chips 一并撤下
  $("sug-dock").innerHTML = "";
  nearBottom = true;
  scrollToBottom(true);   // 发送是用户主动行为: 无论滚到哪里, 立刻回到底部看最新消息
  const qid = genQid();   // 本地生成: 排队卡片与服务端排队区按同一 qid 配对
  // 计划审批挂起时追加 = 否决计划并立刻接力: 不进待发送卡（否则要手动点
  // "立即"才发得上）, 乐观加气泡 + 就地定格旧计划, 服务端打断当前轮后
  // 以这条消息为下一棒开跑（turn_started 回执按 qid 去重, 不重复加气泡）
  if (busy && isAwaitingPlan(runOf(state.sessionId))) {
    const pr = runOf(state.sessionId);
    addUserBubble(text, attachments, msgCol(), null, qid);
    input.value = "";
    setAttachDraft([]);          // 已发送: 清空本会话的附件草稿
    autoGrow(input);
    saveCurrentInput();          // 已发送: 清空本会话的输入草稿
    updateSendBtn();             // 输入已清空: 圆钮切回"停止"形态, 随时可中断
    expirePlanCard(pr, state.sessionId, "已过期 · 继续对话后重新规划");
    sendWs({ type: "user", text, attachments, qid });
    return;
  }
  // 本轮在跑: 消息进入输入框上方的待发送卡片, 轮到它时才出现在消息列
  if (busy) {
    runOf(state.sessionId).queue.push({ qid, text, attachments });
    input.value = "";
    setAttachDraft([]);          // 已发送: 清空本会话的附件草稿
    autoGrow(input);
    saveCurrentInput();          // 已发送: 清空本会话的输入草稿
    updateSendBtn();             // 输入已清空: 圆钮切回"停止"形态, 随时可中断
    renderQueueCards();
    sendWs({ type: "user", text, attachments, qid });
    return;
  }
  addUserBubble(text, attachments);
  input.value = "";
  setAttachDraft([]);          // 已发送: 清空本会话的附件草稿
  autoGrow(input);
  saveCurrentInput();          // 已发送: 清空本会话的输入草稿
  updateSendBtn();             // 输入已清空: 忙碌态下圆钮切回"停止"形态
  const myRun = runOf(state.sessionId);
  if (!busy) {
    myRun.busy = true;
    myRun.awaiting = false;
    myRun.lastThinkRow = null;   // 新一轮开始: 打断标记只属于当前轮的思考行
    beginOptimisticThinking(myRun, state.sessionId, msgCol());   // 乐观胶囊: 发送瞬间即有反馈
    syncThinkingIndicator();
    setBusyUi(true);
    renderSessionList();   // 立即显示运行状态（转圈图标）
  }
  if (state.draft) {
    state.draft = false;
    state.draftDir = null;   // 已转正: 预选项目用完即清
    myRun.loaded = true;   // 草稿列里的气泡就是全部内容, 无需再拉历史
    renderQueueCards();   // 草稿转正: 现在挂在具体会话上（新会话队列必为空, 清掉草稿态可能的残留）
    // 草稿列转正为该会话的消息列（气泡不挪窝）
    colOf("__draft__").id = "msg-col-" + state.sessionId;
    // 列表此刻才出现新条目并选中；WS 建立期间消息会排队，onopen 后冲刷
    await loadSessions();
    renderSessionList();
    markActiveSession();
    refreshDocTitle();
    connectWs(state.sessionId);
  }
  // 草稿态预选的权限模式/计划开关: 先于首条消息冲进 pendingSends/WS,
  // onopen 按序发送保证服务端在建会话首条消息前就切好模式
  if (state.draftMode || state.draftPlan != null) {
    const base = state.draftMode || "prompt";
    const plan = !!state.draftPlan;
    myRun.permissionMode = mkModeValue(base, plan);
    myRun.planActive = plan;
    sendWs({ type: "set_permission_mode", mode: base, plan });
    state.draftMode = null;
    state.draftPlan = null;
  }
  sendWs({ type: "user", text, attachments, workdir: firstWorkdir, qid });
}

function sendWs(obj, sid) {
  const run = sid ? runOf(sid) : curRun();
  if (!run) return;
  if (run.ws && run.ws.readyState === 1) {
    run.ws.send(JSON.stringify(obj));
  } else if (run.ws && run.ws.readyState === 0) {
    run.pendingSends.push(obj);   // 连接建立中: onopen 后冲刷
  }
}

$("btn-send").onclick = () => {
  if ($("btn-send").dataset.mode === "stop") sendWs({ type: "stop" });
  else sendCurrent();
};
$("btn-new").onclick = () => startDraft();   // 包一层: 别把点击事件对象当成 draftDir 传进去

$("input").addEventListener("keydown", ev => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    if (skillMenuActive()) return;   // 斜杠补全菜单开着: Enter 交给它(选用, 不发送)
    ev.preventDefault();
    sendCurrent();
  }
});
$("input").addEventListener("input", () => { saveCurrentInput(); updateSendBtn(); skillMenuUpdate(); });
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}
$("input").addEventListener("input", () => autoGrow($("input")));

/* ============================================================
 * 侧栏交互: 分组/项目切换 + 搜索 + 快捷键
 * ============================================================ */
function setSideTab(tab) {
  state.sideTab = tab;
  $("tab-project").classList.toggle("on", tab === "project");
  $("tab-group").classList.toggle("on", tab === "group");
  renderSessionList();
}
$("tab-project").onclick = () => setSideTab("project");
$("tab-group").onclick = () => setSideTab("group");

function openSearch() {
  $("search-box").classList.add("open");
  $("search-input").focus();
}
function closeSearch() {
  $("search-box").classList.remove("open");
  $("search-input").value = "";
  state.fulltext = null;      // 清掉全文命中态, 残留会让下次渲染闪现旧摘录
  clearTimeout(_ftsTimer);
  renderSessionList();
}
$("btn-search").onclick = () => {
  // 再次点击搜索按钮 = 收起（并清空过滤）; Ctrl+K 同理可开可关
  if ($("search-box").classList.contains("open")) closeSearch();
  else openSearch();
};

let _ftsTimer = null;
let _ftsSeq = 0;
function scheduleFulltextSearch() {
  // 防抖 300ms 后请求全文接口; 竞态用递增 seq 兜底——慢响应的旧请求
  // 返回时 seq 已变, 结果丢弃（快速打字时防止旧词结果覆盖新词渲染）
  clearTimeout(_ftsTimer);
  const q = ($("search-input").value || "").trim();
  if (!q) {
    state.fulltext = null;
    renderSessionList();
    return;
  }
  _ftsTimer = setTimeout(async () => {
    const seq = ++_ftsSeq;
    state.fulltext = { query: q, hits: null, pending: true };
    renderSessionList();
    try {
      const r = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error(r.status);
      const hits = await r.json();
      if (seq !== _ftsSeq) return;          // 过期响应丢弃
      state.fulltext = { query: q, hits, pending: false };
    } catch (e) {
      if (seq !== _ftsSeq) return;
      state.fulltext = { query: q, hits: {}, pending: false };  // 失败静默回落标题过滤
    }
    renderSessionList();
  }, 300);
}

$("search-input").addEventListener("input", () => { renderSessionList(); scheduleFulltextSearch(); });
$("search-input").addEventListener("keydown", ev => {
  if (ev.key === "Escape") closeSearch();
});

document.addEventListener("keydown", ev => {
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === "n") {
    ev.preventDefault();
    startDraft();
  } else if (mod && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    if ($("search-box").classList.contains("open")) closeSearch();
    else openSearch();
  }
});
