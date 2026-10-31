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
    expirePlanCard(run, sid, t("ws_handlers.001"));
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
    } else if (msg.busy && run && !run.busy && !run.stopping) {
      // 停止收束窗口内重连: 后端权威 busy 还是 true（旧轮在收束）, 但本地
      // 已提前定格「已停止」——不能把 busy 拉回, 否则空闲观感被推翻
      run.busy = true;
      renderSessionList();
    }
    return;
  }
  // LLM 层连通状态（连接指示器权威源之一）: 全局态而非会话态——后台会话
  // 的连接收到广播也要立即生效, 因此必须赶在后台会话分支之前处理。
  if (msg.type === "llm_status") {
    state.llmStatus = { ok: msg.ok, detail: msg.detail || "" };
    renderConn();
    return;
  }
  // 后台会话: 流式内容照常写进它自己的常驻列（隐藏）, 切回时完整可见;
  // 只对 权限/结果/结束/错误 累计未读。结束/接力时同步运行态。
  if (sid !== state.sessionId) {
    if (msg.type === "text_delta") onTextDelta(msg, sid);
    else if (msg.type === "thinking_start") onThinkingStart(msg, sid);
    else if (msg.type === "thinking_delta") onThinkingDelta(msg, sid);
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
    // 子代理事件照常派发: 卡片建在派它的会话自己的 run 里(col 逻辑
    // 上隐藏但节点活着, 切回即所见)。此前该分支吞掉 subagent_*,
    // 切走期间完成的子代理永远停在"运行中", 任务 prompt 气泡
    // (user_message 镜像)也丢——切回因 run.loaded 不重拉历史,
    // 无任何自救路径(2026-10-21 现场: 面板有结果但卡仍"运行中")。
    else if (msg.type === "subagent_started") onSubagentStarted(msg, sid);
    else if (msg.type === "subagent_event") onSubagentEvent(msg, sid);
    else if (msg.type === "subagent_done") onSubagentDone(msg, sid);

    else if (msg.type === "tool_result") bumpUnread(sid);
    else if (msg.type === "permission_resolved") onPermissionResolved(msg, sid);
    else if (msg.type === "plan_completed") onPlanCompleted(msg, sid);
    else if (msg.type === "turn_done" || msg.type === "error") {
      bumpUnread(sid);
      settleBackgroundTurnEnd(run, sid);
      run.stopping = false;   // 权威收口: 提前定格窗口旗清零
      // 打断收口与前台 onTurnDone 一致: 「已停止」挂在本轮思考行上
      // (markStoppedTag 自带去重: 提前定格过的不会重复挂)
      if (msg.type === "turn_done" && msg.interrupted) markStoppedTag(run, sid);
    } else if (msg.type === "turn_started") {
      run.busy = true;               // 排队的后续消息接力开跑
      run.stopping = false;          // 接力轮开跑: 旧轮的停止窗口旗作废
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
    case "thinking_delta":     onThinkingDelta(msg, sid); break;
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
    case "plan_completed":    onPlanCompleted(msg, sid); break;
    case "mode_changed":       onModeChanged(msg, sid); break;
    case "thinking_changed":   onThinkingChanged(msg, sid); break;
    case "model_changed":      onModelChanged(msg, sid); break;
    case "turn_done":          onTurnDone(msg); break;
    case "subagent_started":   onSubagentStarted(msg, sid); break;
    case "subagent_event":     onSubagentEvent(msg, sid); break;
    case "subagent_done":      onSubagentDone(msg, sid); break;
    case "session_renamed":    onSessionRenamed(msg); break;
    case "session_unarchived": onSessionUnarchived(msg); break;
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
/* 悬空真思考行的纵深防御: thinking_end 因兼容层缺 content_block_stop 而
 * 永远不来时(GLM 线, 服务端有镜像补发兜底, 但历史窗口/丢包仍可漏),
 * 正文/工具事件即思考已结束的实证——就地按客户端计时收口。真思考行
 * 定格为耗时胶囊(不像乐观胶囊那样整个移除), 实时文本与包装行一并拆除。 */
function closeDanglingThinking(run, sid) {
  const cur = run.curThinking;
  if (!cur || cur.optimistic) return;   // 乐观胶囊有专门的撤销路径, 不在此处理
  onThinkingEnd({}, sid);
}

function onTextDelta(msg, sid) {
  const run = runOf(sid);
  clearRateLimitNote(run);   // 正文已到: 限流重试成功, 撤提示行
  const active = sid === state.sessionId;
  run.awaiting = false;                    // 首个内容事件: 等待空窗结束
  if (active) syncThinkingIndicator();
  closeDanglingThinking(run, sid);   // 悬空思考行: 正文即收口实证
  dropOptimisticThinking(run);   // 正文先到: 撤掉还没被 thinking_start 接管的乐观胶囊
  if (!run.curBubble) {
    run.curBubble = addAssistantBubble("", "", colOf(sid));
    run.curBubble._raw = "";
  }
  run.curBubble._raw += msg.text;
  run.curBubble.innerHTML = renderMd(run.curBubble._raw);
  decorateCode(run.curBubble, true);   // streaming: 不折叠(防高度振荡), 收口补
  decorateTables(run.curBubble);
  scrollToBottom();
}

/* 流式气泡收口: 有内容就固化，下一轮正文开新气泡 */
function flushAssistantBubble(run) {
  if (!run) return;
  if (run.curBubble && !run.curBubble._raw) {
    run.curBubble.closest(".msg").remove();   // 空气泡（模型直接调工具）: 移除
  }
  // DOM 定型后统一补折叠（流式中 decorateCode(_, true) 只装饰未折叠）
  if (run.curBubble) collapsePendingCode(run.curBubble);
  run.curBubble = null;
}

/* ---------- 思考行 ---------- */
const ICON_MIND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.8.7 1.4 1.5 1.6 2.5h4.8c.2-1 .8-1.8 1.6-2.5A6 6 0 0012 3z"/></svg>';
const ICON_TERM = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3.5 3L7 15M12.5 15H17"/></svg>';
const ICON_FILE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6V3z"/><path d="M14 3v4h4"/></svg>';
const ICON_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-1L20 7.5 16.5 4 5 15.5 4 20z"/></svg>';
const ICON_TOOL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"/></svg>';
/* 锤子: 折叠头常驻图标(替代工具箱), 运行中由 CSS(.tg-ico2)驱动敲击动画:
 * 柄尾为轴 抬起-砸下-顿一拍循环。用户提供的老 A 锤(fill 风格, 1024 viewBox),
 * 去色改 currentColor 跟随主题; 运行时染强调色。
 * 柄尾(动画轴)在新 SVG 坐标系里 ≈ (888, 860) */
const ICON_HAMMER = '<svg width="14" height="14" viewBox="0 0 1024 1024" fill="currentColor"><g class="hammer-g"><path d="M277.12 642.986667L59.946667 425.6 298.453333 187.093333l359.253334-87.466666 81.28 81.28-461.866667 462.08z m-108.8-217.386667l108.8 108.8 347.733333-347.733333-287.36 69.76-168.96 168.96z"/><path d="M813.226667 936.106667L351.573333 474.666667l151.04-151.04L964.053333 785.066667l-151.04 151.04zM460.373333 474.666667l352.853334 352.853333 42.453333-42.453333-353.066667-352.853334-42.453333 42.453334z"/></g></svg>';
// 计划模式图标: TOOL_META 在模块加载即求值, 声明必须位于其前（否则 TDZ 炸掉整个引导）
const ICON_MODE_PLAN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l1 3h3v15H5V6h3l1-3z"/><path d="M9 12h6M9 16h4"/></svg>';
const ICON_SEARCH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/><path d="M8 11h6M11 8v6"/></svg>';
const ICON_GLOB = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h5M4 11h7M4 16h5"/><path d="M14 5l6 7-6 7"/><path d="M20 12H10"/></svg>';
const ICON_TODO = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5l1.5 1.5L8 5.5"/><path d="M4 13.5l1.5 1.5L8 12.5"/><path d="M11 7h9M11 14h9M11 20h6"/></svg>';
// 子智能体机器人: 方头 + 天线 + 双眼, 与其他工具图标同笔画口径
// (stroke 1.8 / round)。agent 系工具统一用它, 子智能体卡升级时换上,
// 与下方"等待子代理"等普通工具行的图标位对齐
const ICON_BOT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="11" rx="2.5"/><path d="M12 8V5.5"/><circle cx="12" cy="4" r="1.2"/><path d="M9.2 13v1.6M14.8 13v1.6"/></svg>';
const TOOL_META = {};   // 惰性填充: 首次使用时现取 t()（热切换后新卡即新语言）
function toolMeta(name) {
  if (!TOOL_META[name]) {
    const labels = {
      bash: t("ws_handlers.002"), powershell: t("ws_handlers.003"),
      read_file: t("ws_handlers.004"), write_file: t("ws_handlers.005"),
      present_plan: t("ws_handlers.006"), todo: t("ws_handlers.007"),
      grep: t("ws_handlers.008"), glob: t("ws_handlers.009"),
      agent_tool: t("ws_handlers.010"), agent_status: t("ws_handlers.011"),
      agent_wait: t("ws_handlers.012"), agent_reap: t("ws_handlers.013"),
      agent_list: t("ws_handlers.014"),
    };
    for (const k in labels) {
      TOOL_META[k] = {
        label: labels[k],
        icon: k.startsWith("agent") ? ICON_BOT
          : (k === "bash" || k === "powershell") ? ICON_TERM
          : k === "read_file" ? ICON_FILE
          : k === "write_file" ? ICON_EDIT
          : k === "present_plan" ? ICON_MODE_PLAN
          : k === "todo" ? ICON_TODO
          : k === "grep" ? ICON_SEARCH
          : k === "glob" ? ICON_GLOB : ICON_TOOL,
      };
    }
  }
  return TOOL_META[name] || { label: name, icon: ICON_TOOL };
}

function fmtDuration(ms) {
  const s = ms / 1000;
  if (s < 1) return t("ws_handlers.015");
  if (s < 60) return Math.round(s) + t("ws_handlers.016");
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r ? t("ws_handlers.017", { p0: m, p1: r }) : t("ws_handlers.018", { p0: m });
}

function onThinkingStart(msg, sid) {
  const run = runOf(sid);
  clearRateLimitNote(run);   // 思考已开始: 限流重试成功, 撤提示行
  const active = sid === state.sessionId;
  run.awaiting = false;                    // 思考行已是可见反馈: 空窗结束
  flushAssistantBubble(run);
  if (run.curThinking) {   // 已有实时思考行或乐观胶囊: 直接采用, 计时连续不归零
    if (active) syncThinkingIndicator();   // 转圈归位到列尾(可能在思考行之下)
    return;
  }
  const div = document.createElement("div");
  div.className = "think-row thinking";
  div.innerHTML = '<span class="t-ico">' + ICON_MIND + '</span>' +
    t("ws_handlers.019");
  colOf(sid).appendChild(div);
  if (active) syncThinkingIndicator();   // 思考行之后才归位转圈: 顺序反了转圈会压在思考行上面
  run.curThinking = { el: div, t0: Date.now() };
  run.lastThinkRow = div;   // 本轮思考行引用: 打断时「已停止」挂在这里
  if (active) scrollToBottom();
}

/* 思考增量 → 与"思考中…"胶囊同一行、排在胶囊框外右侧的实时滚动文本。
 * 首个增量到来时把胶囊就地包进 flex 行（.think-live-wrap）: 胶囊不伸缩,
 * 文本吃掉整行剩余宽度; 单行 nowrap + overflow:hidden + JS scrollLeft 贴尾
 * = 新字右缘入场、旧字向左流走。只保留尾部窗口文本, 长思考不吃内存。
 * 收口/撤胶囊时胶囊从包装行归位、文本消失——思考内容不入库、不回放,
 * 纯实时镜像。 */
const THINK_LIVE_MAX = 20000;   // 累计上限: 超出裁头, 窗口只滚尾
const THINK_LIVE_TAIL = 4000;   // 裁剪后保留的尾部长
function onThinkingDelta(msg, sid) {
  const run = runOf(sid);
  const active = sid === state.sessionId;
  let cur = run.curThinking;
  if (!cur) {
    // OpenAI 线（reasoning_content）只有 delta 没有 start: 懒建思考行兜底
    if (run.curBubble) return;   // 正文已在流: 不该再冒思考文本
    onThinkingStart({}, sid);
    cur = run.curThinking;
    if (!cur) return;
  }
  cur.raw = ((cur.raw || "") + (msg.text || "")).slice(-THINK_LIVE_MAX);
  if (!cur.live) {
    const wrap = document.createElement("div");
    wrap.className = "think-live-wrap";
    cur.el.parentNode.insertBefore(wrap, cur.el);   // 就地包装: 位置不变
    cur.live = document.createElement("div");
    cur.live.className = "think-live";
    wrap.appendChild(cur.el);                        // 胶囊进左格
    wrap.appendChild(cur.live);                      // 文本进右格（框外）
    cur.wrap = wrap;
    if (active) scrollToBottom();   // 行高不变, 但宽度顶满: 首现时贴底一次
  }
  const txt = cur.raw;
  cur.live.textContent = txt.length > THINK_LIVE_TAIL ? txt.slice(-THINK_LIVE_TAIL) : txt;
  window.tipIgnoreNextScroll?.(120);   // scrollLeft 贴尾同属程序化滚动: 不杀 tooltip
  cur.live.scrollLeft = cur.live.scrollWidth;   // 贴尾: 新字从右缘入场, 旧字向左滚走
}

/* 撤实时思考文本并把胶囊从包装行归位（收口 / 撤乐观胶囊共用）。
 * 无包装行（还没收到过 delta）时是 no-op。 */
function dropThinkingLive(cur) {
  if (!cur || !cur.live) return;
  if (cur.wrap && cur.wrap.parentNode) {
    cur.wrap.parentNode.insertBefore(cur.el, cur.wrap);   // 胶囊回到原位置
    cur.wrap.remove();                                    // 文本随包装行一起消失
  } else {
    cur.live.remove();
  }
  cur.wrap = null;
  cur.live = null;
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
  const suffix = rlMs > 0 ? t("ws_handlers.020") + fmtDuration(rlMs) + t("ws_handlers.021") : '';
  dropThinkingLive(cur);   // 实时滚动行随思考结束一起撤下
  cur.el.classList.remove("thinking");
  cur.el.innerHTML = '<span class="t-ico">' + ICON_MIND + '</span>' +
    t("ws_handlers.022") + fmtDuration(ms) + suffix + '</span>';
  run.curThinking = null;
  run.lastThinkRow = cur.el;
  absorbThinkRowIntoToolGroup(cur.el);
  if (active) scrollToBottom();
}

/* 思考行收口后的归类: 前面若已有一个工具分组（中间只隔"工作中"转圈）,
 * 说明这轮思考是"工具结果 → 模型消化 → 下一步"的中间推理, 挪进该分组
 * 尾部——否则每个工具间隙的思考都散落在组外, 一轮 N 次调用就拖出 N 条
 * 孤行。组前第一条思考（本轮的引导推理）保持独立显示。行元素原样搬移,
 * lastThinkRow 引用与打断「已停止」标记不受影响; 思考期间不会有新工具行
 * 落入分组（工具事件会先收掉思考行）, 追加到尾部即保持时间顺序。 */
function absorbThinkRowIntoToolGroup(el) {
  let prev = el.previousElementSibling;
  while (prev && (prev.id === "thinking" || prev.classList.contains("think-row"))) {
    prev = prev.previousElementSibling;   // 转圈/相邻思考行不阻断归类
  }
  if (!prev || !prev.classList.contains("tool-group")) return;
  prev.querySelector(".tg-body").appendChild(el);
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
    t("ws_handlers.023");
  col.appendChild(div);
  run.curThinking = { el: div, t0: Date.now(), optimistic: true };
  run.lastThinkRow = div;   // 打断「已停止」与轮次收口兜底都走 lastThinkRow, 复用既有逻辑
  if (sid === state.sessionId) scrollToBottom();
}

function dropOptimisticThinking(run) {
  const cur = run.curThinking;
  if (!cur || !cur.optimistic) return;   // 只撤尚未被 thinking_start 接管的
  dropThinkingLive(cur);   // 胶囊下方挂着的实时思考行一起撤
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
  // 头部预览: 优先正在运行的那个工具, 否则组内最后一个 —— 不展开也能跟上 AI 的动作
  const prevEl = group.querySelector(".tg-prev");
  if (prevEl) {
    const src = group.querySelector('.tool-row[data-state="run"]') || rows[rows.length - 1];
    const d = src && src.querySelector(".tdesc");
    const txt = d ? d.textContent : "";
    prevEl.textContent = txt;
    prevEl.hidden = !txt;
  }
  if (run > 0) {
    const done = rows.length - run;
    sum.textContent = rows.length === 1 ? t("ws_handlers.024") : t("ws_handlers.025") + done + "/" + rows.length + "…";
    sum.className = "tg-sum run";
  } else {
    /* 摘要 = 着色粗体计数文本(成功绿/需注意橙), 无符号无容器。
     * 数字颜色即状态语言; 耗时来自各行闭合时累加的
     * group._ms(setToolState 里 += ), 历史回放无 _t0 则无耗时, 照旧不显示。 */
    let html = "";
    if (ok) html += '<span class="cnt ok">' + ok + '</span>';
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
    head.innerHTML = '<span class="tg-ico-wrap"><span class="tg-ico2">' + ICON_HAMMER + '</span></span>' +
                     t("ws_handlers.026") +
                     '<span class="tg-sum"></span>' +
                     '<span class="tg-prev" hidden></span>';
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
    // 前 78 + 尾 12: 正则/长路径类参数尾段往往才是识别关键, 纯前缀
    // 截断会把 `...\b[^}]+$` 之类截成无法辨认的乱码
    return t.length > 90 ? t.slice(0, 78) + "…" + t.slice(-12) : t;
  };
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      if (data.action === "write" && Array.isArray(data.items)) {
        const done = data.items.filter(it => it.status === "completed").length;
        return data.items.length + t("ws_handlers.027") + done + ")";
      }
      if (data.action === "read") return t("ws_handlers.028");
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
  const meta = toolMeta(name);
  const row = document.createElement("div");
  row.className = "tool-row";
  row.innerHTML =
    '<span class="t-ico">' + meta.icon + '</span>' +
    '<span class="tname2"></span><span class="tdesc"></span><span class="t-dur"></span><span class="tstate"></span>';
  row.querySelector(".tname2").textContent = meta.label;
  row.querySelector(".tdesc").textContent = describeInput(input, name);
  row.dataset.tool = name;
  row.dataset.input = input || "";
  row._t0 = Date.now();   // 结果在 setToolState 里折算耗时小字
  // 落进工具分组（连续调用折叠为一组）, 不再逐条平铺在消息列
  groupForNewToolRow(col || msgCol()).querySelector(".tg-body").appendChild(row);
  if (result) {
    completeToolCard(row, result);
  } else {
    setToolState(row, "run");
    primeTerminalBlock(row);   // 终端工具: 参数已知的立即预插命令块（运行中可展开）
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
    '<span class="td-sum">' + (meta && meta.created ? t("ws_handlers.029") : t("ws_handlers.030")) + '</span>' +
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
  st.textContent = { run: t("ws_handlers.031"), ok: t("ws_handlers.032"), err: t("ws_handlers.033"),
                     denied: t("ws_handlers.034"), stopped: t("ws_handlers.035") }[kind] || kind;
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
  // 运行中占位收口: 行被中断/拒绝但结果没走 completeToolCard 时,
  // 预插终端块里的"运行中…"会永远挂着——就地改口为无输出
  if (kind !== "run") {
    const term = row.nextElementSibling;
    const runEl = term && term.classList.contains("to-term") ? term.querySelector(".tt-run") : null;
    if (runEl) {
      runEl.remove();
      const none = document.createElement("div");
      none.className = "tt-none";
      none.textContent = t("ws_handlers.036");
      term.appendChild(none);
    }
  }
}

function completeToolCard(row, { is_error, denied, result_meta, output }) {
  // present_plan 特判, 按卡的形态分流:
  //   .plan-card（历史回放计划卡）: 只更新状态徽标（拒绝=已拒, 其余=已批）,
  //     不追加输出面板/不降级——全文重看靠卡片点击（renderHistoryPlanCard）。
  //   .tool-row（实时镜像工具卡, addToolCard 建, state=run）: 必须 setToolState
  //     收口——此前只加 allowed class 就提前 return, "运行中"状态字永远不清,
  //     分组头摘要也跟着滞留（2026-10-21 用户实测: 计划实施完成后卡仍转圈）。
  //   两者都不渲染输出面板: 计划全文重看靠计划卡/历史面板。
  if (row.dataset.tool === "present_plan") {
    if (row.classList.contains("plan-card")) {
      row.classList.add(denied || is_error ? "denied" : "allowed");
      const head = row.querySelector(".plan-head");
      if (head && !head.querySelector(".pl-st")) {
        head.insertAdjacentHTML("beforeend",
          planStatusBadge(denied || is_error ? "rejected" : "approved"));
      }
    } else {
      setToolState(row, denied || is_error ? "denied" : "ok");
    }
    return;
  }
  // agent_tool 收口升级: spawn 回执里带 agent_id 即把工具卡升级成
  // 子智能体卡（点击开侧栏、吞掉回执原文）。此前升级只发生在实时
  // subagent_started 事件路径——历史回放（刷新/切回旧会话）与 started
  // 丢失的时序永远不升级, 回执原文整段露成代码块（2026-10-20 回归
  // 现场）。is_error 不升级: 错误回执保留原文供排障。
  if (row.dataset.tool === "agent_tool" && !row._saAgentId && !is_error && !denied) {
    const m = /agent_id:\s*([A-Za-z0-9_-]+)/.exec(String(output || ""));
    if (m) upgradeToSubagentCard(row, m[1]);
  }
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
    // 无处可看——点卡片没有任何反应）。一律默认收起, 点行展开查看;
    // is-err 保留: 出错行状态与输出红色着色不受折叠影响。
    if (is_error && !denied) row.classList.add("is-err");
    renderOutputPanel(row, output);
  }
}

/* ---------- 输出展示: 工具卡的统一输出面板 ----------
 * tool_result 的 output（命令 stdout/stderr、工具摘要）此前只进模型历史,
 * 界面无处可看。终端工具行本身即展开开关（行内展开, 不另设折叠头行）;
 * 一律默认收起, 点行展开（含出错输出——不自动撑高消息流）。纯 textContent,
 * 不走 markdown 渲染, 超长截断（完整输出在会话历史里）。 */
const OUTPUT_PANEL_MAX = 20000;
const TERMINAL_TOOLS = new Set(["bash", "powershell"]);
// 后端截断标记（tools.py 的落盘/掐中段话术）: 命中即在工具行尾标注,
// 收起态也能看出"这份输出不完整"
const OUT_TRUNCATED_RE = /output truncated|\[truncated|已截断/;

/* 从工具行取终端命令全文（入参 JSON 的 command 字段; 历史回放同路径可用） */
function terminalCommand(row) {
  if (!TERMINAL_TOOLS.has(row.dataset.tool)) return "";
  try {
    const data = JSON.parse(row.dataset.input || "{}");
    if (typeof data.command === "string" && data.command.trim()) return data.command;
  } catch (e) { /* 旧数据无 input 或非 JSON */ }
  return "";
}

function renderOutputPanel(row, outputText) {
  // 子智能体卡片豁免: spawn 回执（agent_id/type/status 那段）对用户
  // 没信息量, 点击卡片要留给"打开侧栏", 不能被终端展开语义抢走
  if (row.classList.contains("sa-card")) return;
  const cmd = terminalCommand(row);
  const out = prepOutput(outputText);
  const existing = row.nextElementSibling &&
    row.nextElementSibling.classList.contains("to-term") ? row.nextElementSibling : null;
  if (!existing && !out.hasOut && !cmd) return;   // 终端命令即使无输出也渲染: 完整命令是可见性兜底
  appendTermMeta(row, out);
  // 终端类: 深色一体化终端块——命令($ 提示符)与输出同块呈现,
  // 整块滚动（一个滚动条滚全部）, 展开即读作一段真实终端会话。
  // 运行中 primeTerminalBlock 已预插的块在此就地更新（不重复建块）
  let term = existing;
  if (!term) {
    term = document.createElement("div");
    term.className = "to-term closed";   // 默认收起, 点工具行展开
    if (!cmd) {
      const pre = document.createElement("div");
      pre.className = "to-pre";
      pre.textContent = out.text;
      term.appendChild(pre);
    }
    row.insertAdjacentElement("afterend", term);
  }
  if (cmd) {
    if (!term.querySelector(".tt-cmd")) term.appendChild(buildTermCmdEl(cmd));
    const runEl = term.querySelector(".tt-run");
    if (runEl) runEl.remove();
    let outEl = term.querySelector(".tt-out") || term.querySelector(".tt-none");
    if (!outEl) {
      outEl = document.createElement("div");
      term.appendChild(outEl);
    }
    outEl.className = out.hasOut ? "tt-out" : "tt-none";
    outEl.textContent = out.hasOut ? out.text : t("ws_handlers.037");
  }
  wireTermToggle(row);
}

/* 输出文本预处理: 截断标记 + 行数统计（创建与运行中更新两条路径共用） */
function prepOutput(outputText) {
  const raw = outputText ? String(outputText) : "";
  const hasOut = !!raw.trim();
  let text = raw;
  let cut = false;
  if (text.length > OUTPUT_PANEL_MAX) {
    text = text.slice(0, OUTPUT_PANEL_MAX) +
      t("ws_handlers.038") + text.length + t("ws_handlers.039");
    cut = true;
  }
  if (!cut && OUT_TRUNCATED_RE.test(raw)) cut = true;
  const lineCount = hasOut ? text.split(/\r?\n/).length : 0;
  return { hasOut: hasOut, text: text, cut: cut, lineCount: lineCount };
}

/* 行尾元信息（截断/行数）并进工具行——不再另设面板头行 */
function appendTermMeta(row, out) {
  const old = row.querySelector(".t-meta");
  if (old) old.remove();
  const meta = document.createElement("span");
  meta.className = "t-meta";
  if (out.cut) {
    const c = document.createElement("span");
    c.className = "t-cut";
    c.textContent = t("ws_handlers.040");
    meta.appendChild(c);
  }
  if (out.lineCount > 15) {
    const l = document.createElement("span");
    l.className = "t-loc";
    l.textContent = out.lineCount + t("ws_handlers.041");
    meta.appendChild(l);
  }
  if (meta.childNodes.length) row.appendChild(meta);
}

/* $ 提示符 + 命令全文。多行命令（heredoc/续行）按原文续行,
 * 提示符只标在首行——与真实终端一致 */
function buildTermCmdEl(cmd) {
  const cmdLines = cmd.split(/\r?\n/);
  const cmdEl = document.createElement("div");
  cmdEl.className = "tt-cmd";
  const prompt = document.createElement("span");
  prompt.className = "tt-prompt";
  prompt.textContent = "$";
  cmdEl.appendChild(prompt);
  cmdEl.appendChild(document.createTextNode(
    " " + cmdLines[0] +
    (cmdLines.length > 1 ? "\n" + cmdLines.slice(1).join("\n") : "")));
  return cmdEl;
}

/* 行内展开: 点工具行本身开关终端块。运行中的行同样可点——
 * 块里是预插的完整命令, 长命令不必等结果就能看全 */
function wireTermToggle(row) {
  if (row._termToggle) return;
  if (row.classList.contains("sa-card")) return;   // 子智能体卡片: 点击=开侧栏, 不接终端展开
  row._termToggle = true;
  row.classList.add("expandable");
  row.addEventListener("click", () => {
    const t = row.nextElementSibling;
    if (!t || !t.classList.contains("to-term")) return;
    t.classList.toggle("closed");
    row.classList.toggle("open");
  });
}

/* 运行中预插终端块: 命令参数到齐即渲染 $ 命令全文 + 运行中占位,
 * 默认收起（点行展开, 不自动撑高消息流）; 结果落地由 renderOutputPanel
 * 就地替换占位。占位卡参数未到齐 / 非终端工具 / 块已存在时 no-op。 */
function primeTerminalBlock(row) {
  if (!TERMINAL_TOOLS.has(row.dataset.tool)) return;
  if (row.nextElementSibling && row.nextElementSibling.classList.contains("to-term")) return;
  const cmd = terminalCommand(row);
  if (!cmd) return;
  const term = document.createElement("div");
  term.className = "to-term closed";
  term.appendChild(buildTermCmdEl(cmd));
  const runEl = document.createElement("div");
  runEl.className = "tt-run";
  runEl.textContent = t("ws_handlers.042");
  term.appendChild(runEl);
  row.insertAdjacentElement("afterend", term);
  wireTermToggle(row);
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
  closeDanglingThinking(run, sid);   // 悬空思考行: 工具卡即收口实证
  flushAssistantBubble(run);
  dropOptimisticThinking(run);
  const card = addToolCard({ id: msg.id, name: msg.name, input: "" }, colOf(sid));
  card.querySelector(".tdesc").textContent = t("ws_handlers.043");
  if (msg.id) run.liveToolCards[msg.id] = card;
  run.activeToolCard = card;
}

function onToolUse(msg, sid) {
  const run = runOf(sid);
  const active = sid === state.sessionId;
  run.awaiting = false;                    // 工具卡已是可见反馈: 空窗结束
  clearRateLimitNote(run);   // 工具调用已到: 限流重试成功, 撤提示行
  if (active) syncThinkingIndicator();
  closeDanglingThinking(run, sid);   // 悬空思考行: 工具卡即收口实证
  flushAssistantBubble(run);   // 工具前先收掉流式中的正文气泡
  dropOptimisticThinking(run);   // 工具先于思考到达: 撤掉乐观胶囊（工具卡已是反馈）
  // tool_use_started 已提前建卡: 就地补全真实参数, 不重复建卡
  const existing = msg.id ? run.liveToolCards[msg.id] : null;
  if (existing) {
    existing.querySelector(".tdesc").textContent = describeInput(msg.input, msg.name || existing.dataset.tool);
    existing.dataset.input = msg.input || "";          // todo 卡等从入参渲染的地方依赖它
    existing._t0 = Date.now();   // 占位卡早于参数到达: 耗时从参数齐全起算
    primeTerminalBlock(existing);   // 参数到齐: 终端工具预插命令块（运行中可展开）
    run.activeToolCard = existing;
    return;
  }
  const card = addToolCard({ id: msg.id, name: msg.name, input: msg.input }, colOf(sid));
  if (msg.id) run.liveToolCards[msg.id] = card;   // 按 id 登记, 结果精确配对
  run.activeToolCard = card;
}

function onToolResult(msg, sid) {
  const run = runOf(sid);
  // 被吸收为子智能体卡的 agent_tool 占位: 它的 spawn 回执直接吞掉
  // （回执内容已无意义, 卡片由 started/done 事件全权负责）
  if (msg.id && run.saAbsorbedToolIds && run.saAbsorbedToolIds.delete(msg.id)) {
    return;
  }
  // 聊天点播: music_play 的结果镜像带 result_meta.music, 转交电台开播。
  // 只在实时事件里播——历史回放（completeToolCard 的 result_meta 只渲染 diff）
  // 不重播旧歌, 刷新页面不会凭空响起来。
  if (msg.result_meta && msg.result_meta.music && !msg.is_error) {
    const ok = window.aulosMusicPlay && window.aulosMusicPlay(msg.result_meta.music);
    if (!ok) toast(t("ws_handlers.044"));
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
  // agent_tool 的结果文本里带 agent_id: 登记路由表, 后续 subagent_event 按 id 找卡
  if (card && card.dataset.tool === "agent_tool" && !msg.is_error && msg.output) {
    const m = /agent_id:\s*([A-Za-z0-9_-]+)/.exec(String(msg.output));
    if (m) registerSubagentCard(run, m[1], card);
  }
}

/* ============================================================
 * 子智能体卡片: agent_tool 派出的 subagent 在主对话流里渲染成
 * 一张专属卡片（图标 + 子智能体 · 类型 · 任务描述 + 转圈）, 点头部
 * 展开查看子代理自己的对话流（思考/工具调用, 事件经后端镜像推送）。
 *
 * 实现关键: 子代理内部事件走伪会话 id（"sub:" + agent_id）直接复用
 * 现有 onTextDelta、onThinking 等全套机制——runOf(伪 id) 惰性
 * 建立独立运行态（独立 curBubble/curThinking/liveToolCards）, 事件
 * 写进卡片 body 里的嵌套 .sa-stream 列, 与主会话的流式指针互不干扰;
 * 切会话显隐只作用于顶层 .msg-col, 嵌套列不受影响。
 * ============================================================ */
const SUB_TYPE_LABEL = {
  explore: t("ws_handlers.045"), plan: t("ws_handlers.046"), general: t("ws_handlers.047"), verification: t("ws_handlers.048"),
};

function saColOf(card) {
  return card._saStream || null;   // 游离停泊也有效: 引用在, 列就在
}

/* ---------- 子智能体侧栏（对齐右侧计划面板的交互） ----------
 * 点卡片: 流式列整体搬进 #sa-body（DOM 移动保留子节点, 事件路由零改动
 * ——colOf(伪 id) 返回的还是同一个节点）, 侧栏头部出现对应选项卡。
 * 多个子代理并行时各占一个 tab（状态点: 转圈/绿/红）, 点 tab 切换展示
 * 的流, 互不混淆。点 ✕ 收起: 列搬回卡片内嵌位置。
 * tab 行只放 运行中 + 当前打开的: 已完成的代理从主消息流的卡片入口
 * 打开（点卡片即进面板）, 不再做「历史」聚合。 */
let _saOpenAgent = null;   // 侧栏当前展示的 agent_id
let _saOpenCard = null;    // 对应卡片引用: 关闭/搬回按引用走, 不按会话查表（切会话后查表会找错卡片）

function saTabLabel(card, agentId) {
  const zh = SUB_TYPE_LABEL[card.dataset.saType] || card.dataset.saType || "";
  const desc = (card.querySelector(".tdesc") || {}).textContent || "";
  const text = (desc || agentId).trim();
  // tdesc 本身已是 "类型 · 描述"（upgradeToSubagentCard 写入）: 已带前缀
  // 就不重复拼; 兜底路径（无 tdesc）才拼类型
  const labeled = zh && text.startsWith(zh + " · ");
  return labeled ? text : (zh ? zh + " · " : "") + text;
}

/* 重建侧栏选项卡。
 * 分组策略: 运行中的子代理平铺成 tab; 已完成的不聚合、不平铺——
 * 它们的入口是主消息流里的卡片（点卡片打开面板后以「当前打开」
 * tab 出现）。tab 顺序不随点击重排: 始终 运行中 → 当前打开。 */
function saTabSortKey(card, agentId) {
  if (card && card.dataset.state === "run") return "1-" + agentId;
  return "2-" + agentId;
}
function saRenderTabs(run) {
  const tabs = $("sa-tabs");
  tabs.innerHTML = "";
  const map = run.subagents || {};
  const shown = [];
  for (const [agentId, card] of Object.entries(map)) {
    if (!card || !card.isConnected) continue;
    if (card.dataset.state === "run" || agentId === _saOpenAgent) shown.push([agentId, card]);
  }
  // 排序: 运行中（保持登记序）→ 其余（当前打开的已完成代理）
  shown.sort((a, b) => saTabSortKey(a[1], a[0]).localeCompare(saTabSortKey(b[1], b[0])));
  const mkTab = (agentId, card) => {
    const full = saTabLabel(card, agentId.slice(0, 8));
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sa-tab" + (agentId === _saOpenAgent ? " on" : "") +
      (card.classList.contains("sa-done-ok") ? " done-ok" :
       card.classList.contains("sa-done-err") ? " done-err" :
       card.dataset.state === "run" ? " running" : "");
    const dot = document.createElement("span");
    dot.className = "sa-dot";
    const label = document.createElement("span");
    label.className = "sa-tab-label";
    // 不设 title: 全局 tooltip 会接管原生 title, 加上 data-tip 风格的
    // 自绘气泡会出现两个悬浮框; 截断省略 + 面板内容本身已可识别
    // 两段式: 类型前缀弱化 + 摘要主体（无类型时整段都是主体）
    const zh = SUB_TYPE_LABEL[card.dataset.saType] || card.dataset.saType || "";
    if (zh && full.startsWith(zh + " · ")) {
      const t = document.createElement("span");
      t.className = "sa-tab-type";
      t.textContent = zh + " · ";
      label.appendChild(t);
      label.appendChild(document.createTextNode(full.slice(zh.length + 3)));
    } else {
      label.textContent = full;
    }
    b.appendChild(dot);
    b.appendChild(label);
    b.dataset.agent = agentId;
    // 点 tab 只做切换: 点当前已打开的不再关闭面板（收起走 ✕）
    b.onclick = () => openSaPanel(agentId, card);
    return b;
  };
  for (const [aid, card] of shown) tabs.appendChild(mkTab(aid, card));
}

function saPlaceCol(card, attach) {
  const col = saColOf(card);
  if (!col) return;
  if (attach) {
    const host = $("sa-body");
    if (col.parentElement !== host) {
      host.appendChild(col);
      col.classList.add("hosted");   // 面板内去定宽缩进, 全宽渲染
    }
  } else {
    col.classList.remove("hosted");
    col.remove();   // 游离停泊: 节点保活在 card._saStream, 事件照常累积
  }
}

/* 面板滚动跟随: 与主列同一套"贴底跟随/上翻让位"语义。此前
 * onSubagentEvent 无条件拽底, 子agent流式输出期间面板完全锁死。 */
let saNearBottom = true;
$("sa-body").addEventListener("scroll", () => {
  const el = $("sa-body");
  saNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  $("sa-scroll-btn").classList.toggle("show", !saNearBottom);
});
$("sa-body").addEventListener("wheel", ev => {
  if (ev.deltaY >= 0) return;
  saNearBottom = false;
  $("sa-scroll-btn").classList.add("show");
}, { passive: true });
$("sa-scroll-btn").onclick = () => {
  saNearBottom = true;
  $("sa-scroll-btn").classList.remove("show");
  $("sa-body").scrollTo({ top: $("sa-body").scrollHeight, behavior: "smooth" });
};

function openSaPanel(agentId, cardRef) {
  const card = cardRef || saCardOf(runOf(state.sessionId), agentId);
  if (!card || !card.isConnected) return;
  if (_saOpenAgent !== null && _saOpenAgent !== agentId &&
      _saOpenCard && _saOpenCard.isConnected) {
    saPlaceCol(_saOpenCard, false);          // 换 tab: 先把上一个流搬回卡片
    _saOpenCard.classList.remove("sa-open-in-panel");
  }
  _saOpenAgent = agentId;
  _saOpenCard = card;
  const pane = $("pane");
  pane.classList.add("sa-open");
  pane.classList.remove("plan-open");   // 侧栏互斥: 打开子代理面板则收起计划面板
  saPlaceCol(card, true);
  card.classList.add("sa-open-in-panel");
  // 历史会话的流内容已由 replaySubagentStreams 重建(_saStream 存在),
  // 面板直接展示; 旧会话(无持久化流)面板为空——不再做 manifest 摘要
  // 回填(/api/agents 已随摘要机制一并移除)。
  saRenderTabs(runOf(state.sessionId));
  saNearBottom = true;                       // 打开即看最新: 重置贴底态
  $("sa-scroll-btn").classList.remove("show");
  const body = $("sa-body");
  body.scrollTop = body.scrollHeight;   // 打开即看最新
}

function closeSaPanel() {
  const card = _saOpenCard;
  _saOpenAgent = null;
  _saOpenCard = null;
  $("pane").classList.remove("sa-open");
  if (card && card.isConnected) {
    saPlaceCol(card, false);
    card.classList.remove("sa-open-in-panel");
  }
  if (state.sessionId) saRenderTabs(runOf(state.sessionId));
}

$("sa-close").onclick = () => closeSaPanel();

/* 切会话时同步侧栏: 面板开着 → 先把列搬回原卡片（卡片留在原会话的
 * 消息流里, 事件照常写入）, 面板收起; 切回该会话后用户可再点开。 */
function syncSaPanelForActiveSession() {
  if (_saOpenAgent) closeSaPanel();
}

/* agent_tool 工具卡 → 子智能体卡片升级: 建 head/body/stream 结构,
 * 登记 agent_id 路由。入口有二: 实时 subagent_started 事件（onSubagentStarted,
 * 时序最早）; completeToolCard 的 spawn 回执收口（历史回放 / started 丢失的
 * 兜底, 2026-10-20 前回放场景永不升级、回执原文整段外显）。 */
function setSaDesc(card, zh, descText) {
  // 描述两段式: 类型词强调色可点（开侧栏）, 描述正文弱色跟随
  const desc = card.querySelector(".tdesc");
  if (!desc) return;
  desc.textContent = "";
  if (zh) {
    const t = document.createElement("span");
    t.className = "sa-type";
    t.textContent = zh;
    t.onclick = (ev) => {
      ev.stopPropagation();               // 行点击也是开面板: 不必冒泡
      openSaPanel(card._saAgentId, card);
    };
    desc.appendChild(t);
    desc.appendChild(document.createTextNode(" · " + descText));
  } else {
    desc.textContent = descText;
  }
}

function upgradeToSubagentCard(card, agentId, sid) {
  if (!card || card._saAgentId) return;
  card._saAgentId = agentId;
  card.classList.add("sa-card");
  // 保留图标位但换成机器人图标: 与同组的"等待子代理"等普通工具行
  // 左端对齐（原先摘掉图标, 文字起点比别的行凸出, 视觉错位）
  const meta = card.querySelector(".t-ico");
  if (meta) meta.innerHTML = ICON_BOT;
  const desc = card.querySelector(".tdesc");
  const input = card.dataset.input || "";
  try {
    const d = JSON.parse(input);
    if (d && typeof d.subagent_type === "string") card.dataset.saType = d.subagent_type;
    if (desc && d && typeof d.subagent_type === "string") {
      const zh = SUB_TYPE_LABEL[d.subagent_type] || d.subagent_type;
      setSaDesc(card, zh, d.description || "");
    }
  } catch (e) { /* 非法 JSON: 保留原描述 */ }
  // 无内联降级视图: 卡片只是入口, 子代理执行流一律走右侧面板。
  // 嵌套列由 saColFor 惰性建为游离节点（card._saStream 持引用）,
  // 面板没开也照常累积事件, 打开即完整。
  card.classList.add("sa-toggle");
  card.onclick = (ev) => {
    if (ev.target.closest("button, a")) return;   // 不挡卡内交互
    if (_saOpenAgent === agentId) { closeSaPanel(); return; }
    openSaPanel(agentId);
  };
  // 登记进正确的 run: 实时事件用事件所属会话(sid); 历史回放（分片渲染
  // 期间 pinnedRun 置位）登记进被回放会话的 run——否则后台会话的卡
  // 写进前台会话的路由表, 后续 event/done 按 sid 找不到卡
  // (2026-10-21 现场: 切走期间完成的子代理永久"运行中")。
  registerSubagentCard(pinnedRun || runOf(sid || state.sessionId), agentId, card);
}

function registerSubagentCard(run, agentId, card) {
  if (!run.subagents) run.subagents = {};
  const prev = run.subagents[agentId];
  if (prev && prev !== card && prev.isConnected) return;   // 已登记别卡: 不抢
  run.subagents[agentId] = card;
  // 归属登记: agent_id -> 卡片。saColFor 据此把伪会话流路由到正确
  // 的卡片——此前它只查 runOf(state.sessionId), 后台会话的子代理
  // 事件(切走期间照常到达)解析到别的会话的 run, 找不到卡,
  // user_message 气泡/流全部落进顶层兜底隐藏列, 面板打开是空的。
  card._saRun = run;
  _saCardOwner.set(agentId, card);
}

function saCardOf(run, agentId) {
  if (!run) return null;
  if (!run.subagents) run.subagents = {};
  let card = run.subagents[agentId];
  if (card && !card.isConnected) card = run.subagents[agentId] = null;
  return card || null;
}

/* agent_id -> 卡片的全局归属表: 伪会话 id("sub:"+agent_id)不携带
 * 会话信息, saColFor 需要跨会话定位卡片。卡片从 DOM 摘除时由
 * saCardOf 的 isConnected 判定自然失效, 这里同表冗余一查。 */
const _saCardOwner = new Map();

/* subagent_started: 兜底建卡。正常时序里 spawn 的 agent_tool 工具卡先
 * 出现、tool_result 登记路由; 这里处理事件先于工具卡到达的乱序——
 * 主列没有卡时直接建一张完整卡片, agent_tool 的工具卡稍后到达时因
 * registerSubagentCard 的"不抢"规则不会覆盖。 */
function onSubagentStarted(msg, sid) {
  const run = runOf(sid);
  const existing = saCardOf(run, msg.agent_id);
  if (existing) return;
  // 优先吸收: started 常比 agent_tool 的 tool_result 先到（后端在
  // spawn 点火前就广播, 而工具结果要等 Leader 回合走完）——此时
  // onToolUseStarted 已建了"接收参数中…"的占位卡。直接把它升级成
  // 子智能体卡, 否则兜底新建的第二张卡会永远等不到自己的
  // tool_result, 挂在运行中拖住工具组计数（"运行中 x/12"不落账）。
  let card = null;
  for (const [tid, c] of Object.entries(run.liveToolCards || {})) {
    if (c.dataset.tool === "agent_tool" && !c._saAgentId) {
      card = c;
      delete run.liveToolCards[tid];
      // 记下被吸收的 tool id: 稍后真正的 spawn tool_result 到达时直接
      // 吞掉（onToolResult 配不上卡会兜底新建, 又是一张原始卡）
      (run.saAbsorbedToolIds = run.saAbsorbedToolIds || new Set()).add(tid);
      if (run.activeToolCard === c) run.activeToolCard = null;
      break;
    }
  }
  if (!card) {
    card = addToolCard({ id: "sa-" + msg.agent_id, name: "agent_tool",
      input: JSON.stringify({ subagent_type: msg.subagent_type,
                              description: msg.description }) }, colOf(sid));
  }
  upgradeToSubagentCard(card, msg.agent_id, sid);
  // started 已带全量描述, 工具卡描述不再等 tool_use 事件来补
  setSaDesc(card, SUB_TYPE_LABEL[msg.subagent_type] || msg.subagent_type || "",
            msg.description || "");
  // 生命周期状态归 subagent_done 翻转: started 只置"运行中"(从占位卡
  // 吸收来的卡此前已被 setToolState(run), 兜底新建的也走 run)。
  // 旧代码在这里就置"ok"——子代理刚开始就被标"已完成", 而 worker
  // 还在跑、agent_wait 还在等(2026-10-20 现场: 两张卡全绿但仍在执行)。
  setToolState(card, "run");
  // 面板开着: 新代理立即出现在选项卡里
  if (sid === state.sessionId && _saOpenAgent) saRenderTabs(runOf(sid));
}

/* 子代理内部事件 → 伪会话 id 复用现有渲染管线。colOf(伪 id) 被 app.js
 * 分流到 saColFor(): 节点直接落进卡片的嵌套流列。 */
function onSubagentEvent(msg, sid) {
  const run = runOf(sid);
  const card = saCardOf(run, msg.agent_id);
  if (!card) return;   // 乱序兜底: started 会建卡; 没卡就丢（子代理结果仍经 agent_wait 可见）
  const inner = msg.event || {};
  const pseudo = "sub:" + msg.agent_id;
  switch (inner.type) {
    case "user_message":       // 任务输入: 子代理对话流以用户气泡开头
      addSaTaskBubble(String(inner.text || ""), colOf(pseudo)); break;
    case "thinking_start":     onThinkingStart(inner, pseudo); break;
    case "thinking_delta":     onThinkingDelta(inner, pseudo); break;
    case "thinking_end":       onThinkingEnd(inner, pseudo); break;
    case "text_delta":         onTextDelta(inner, pseudo); break;
    case "tool_use_started":   onToolUseStarted(inner, pseudo); break;
    case "tool_use":           onToolUse(inner, pseudo); break;
    case "tool_result":        onToolResult(inner, pseudo); break;
    default: return;
  }
  if (card.classList.contains("sa-open")) scrollToBottom();   // 面板停泊时跟随主列滚动（防御性: 现已无内联展开路径）
  // 侧栏模式: 用户贴底时才跟随(上翻让位, 交给 wheel/scroll 监听切换)
  if (_saOpenAgent === msg.agent_id && sid === state.sessionId && saNearBottom) {
    const body = $("sa-body");
    window.tipIgnoreNextScroll?.(120);   // 对齐主列 scrollToBottom: 程序化滚动不误杀 tooltip
    body.scrollTop = body.scrollHeight;
  }
}

/* 伪会话 id → 消息列: 惰性建为游离节点（不挂 DOM）, 由 card._saStream
 * 持引用; 面板打开时 saPlaceCol 整体搬进 #sa-body, 事件路由零改动。
 * 游离期间 colOf(伪 id) 返回同一节点, 流式内容/工具卡照常累积, 不丢。 */
function saColFor(pseudo) {
  const agentId = pseudo.slice(4);
  // 优先按卡片归属找: 后台会话的子代理流切走期间照常到达, 按
  // state.sessionId 找会把事件写错桶(找不到卡 → 顶层隐藏列, 面板
  // 空白)。card._saRun 由 registerSubagentCard 登记; 无归属(极老
  // 数据/异常路径)再退回当前会话兜底。
  let card = null;
  const owner = _saCardOwner.get(agentId);
  if (owner && owner.isConnected) card = owner;
  if (!card) card = saCardOf(runOf(state.sessionId), agentId);
  if (!card) return colOf(pseudo);   // 兜底: 顶层隐藏列, 事件不丢
  let col = card._saStream;
  if (!col) {
    col = document.createElement("div");
    col.className = "sa-stream";
    card._saStream = col;
  }
  return col;
}

/* ---------- 任务输入气泡折叠 ----------
 * subagent 的任务提示往往极长（几百上千字的调研指令）, 一进来就把
 * 侧栏/嵌套流顶满一屏, 真正想看的子代理执行过程被挤到视野外。
 * 折叠实现（判定阈值/渐隐/展开胶囊）已提取为 bubbles.js 的
 * applyTextFold, 且 addUserBubble 已内建调用——这里直接建气泡即可。
 * 内容长度判定而非像素测量的原因（游离列无布局盒, scrollHeight 恒
 * 0, "量高度定折叠"永远判短, 2026-10-20 现场: 整段 prompt 满屏展开）
 * 见 applyTextFold 注释。 */
function addSaTaskBubble(text, col) {
  return addUserBubble(text, null, col);
}

function onSubagentDone(msg, sid) {
  const run = runOf(sid);
  const card = saCardOf(run, msg.agent_id);
  if (!card) return;
  card.classList.remove("sa-running");
  const ok = msg.status === "completed";
  card.classList.add(ok ? "sa-done-ok" : "sa-done-err");
  const spin = card.querySelector(".sa-spin");
  if (spin) spin.remove();
  // 状态走 setToolState: dataset.state + .tstate 文本 + 工具组头部计数
  // 一起翻转(旧代码手改 .tstate, dataset.state 留在 "run", 组头永远
  // 数着一张运行中的行)。耗时由 done 事件的 duration_s 提供(口径:
  // spawn 点火起算), 覆盖 _t0 避免与真实执行时长打架。
  setToolState(card, ok ? "ok" : "err");
  // 子代理卡用语沿用"已完成/失败"(通用工具是"出错"): 只覆写显示文本,
  // dataset.state/组头计数已由 setToolState 正确翻转
  const stEl = card.querySelector(".tstate");
  if (stEl) stEl.textContent = ok ? t("ws_handlers.052") : t("ws_handlers.053");
  if (typeof msg.duration_s === "number") {
    const dur = card.querySelector(".t-dur");
    if (dur) dur.textContent = msg.duration_s >= 1
      ? Math.round(msg.duration_s) + t("ws_handlers.054") : t("ws_handlers.055");
  }
  const desc = card.querySelector(".tdesc");
  if (desc && !ok && msg.error) {
    desc.textContent = desc.textContent + " — " + String(msg.error).slice(0, 80);
  }
  // 侧栏开着: 选项卡状态点同步翻转（当前 tab 着色）
  if (sid === state.sessionId) saRenderTabs(runOf(sid));
  // 嵌套流收口: sweep 悬空的内部工具卡（子代理崩溃时结果事件永远不来）
  sweepPendingToolCards(runOf("sub:" + msg.agent_id));
  // 悬空的思考行/正文气泡同样要收口——worker 撞预算/崩溃被掐时
  // WireThinkingEnd 与正文收尾事件不会到来, 伪会话的"思考中…"实时行
  // 会永远冻在动画态, 而卡片头部已显示"已完成"（2026-10-19 现场:
  // 探索面板最后一帧停在"思考中…"）。与 endTurnUiReset 同款兜底:
  // 客户端起止计时, 半截正文气泡保留（与部分结果交付同精神）。
  const pseudo = "sub:" + msg.agent_id;
  const pr = runOf(pseudo);
  flushAssistantBubble(pr);
  collapseFinishedToolGroups(saColOf(card));
  if (pr.curThinking) onThinkingEnd({}, pseudo);
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
  // 后台列收口: 常驻敲击类一并摘除(syncThinkingIndicator 只管前台列)
  colOf(sid).querySelectorAll(".tool-group.hammering")
    .forEach(g => g.classList.remove("hammering"));
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
  txt.textContent = rule ? t("ws_handlers.056", { p0: rule }) : t("ws_handlers.057");
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
      toast(t("ws_handlers.058", { p0: (data.rules || []).slice(-1)[0] || rule }));
      if (typeof renderAllowlistSettings === "function") renderAllowlistSettings();
    } catch (e) {
      btn.disabled = false;
      toast(t("ws_handlers.059") + e.message);
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
  txt.textContent = rule ? t("ws_handlers.060", { p0: rule }) : t("ws_handlers.061");
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
      toast(t("ws_handlers.062", { p0: rule || "该命令" }));
    } catch (e) {
      btn.disabled = false;
      toast(t("ws_handlers.063") + e.message);
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
  txt.textContent = dir ? t("ws_handlers.064", { p0: dir }) : t("ws_handlers.065");
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
      toast(t("ws_handlers.066", { p0: dir }));
    } catch (e) {
      btn.disabled = false;
      toast(t("ws_handlers.067") + e.message);
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

  const meta = toolMeta(msg.tool_name);
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
  hint.innerHTML = t("ws_handlers.068");
  head.appendChild(ico); head.appendChild(title); head.appendChild(hint);
  row.appendChild(head);

  const body = describeInput(msg.input, msg.name) || t("ws_handlers.069");
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

  row.appendChild(buildPermChoices(msg.request_id, sid2, t("ws_handlers.070"), t("ws_handlers.071")));
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

  // 审批卡紧跟它所属的工具行（进分组、组若折叠则展开并保持）:
  // 追加在列尾会落在"工作中"转圈/新内容之后, 同一条命令读起来像凭空
  // 重复了一条、顺序错乱。工具卡还没建（理论少见）才退回列尾。
  const anchor = (run.activeToolCard && run.activeToolCard.isConnected)
    ? run.activeToolCard : null;
  if (anchor) {
    const grp = anchor.closest(".tool-group");
    if (grp && grp.classList.contains("collapsed")) {
      grp.classList.remove("collapsed");   // 等审批的分组必须可见
      grp._userOpen = true;                // 且不随运行中收起
    }
    anchor.insertAdjacentElement("afterend", row);
  } else {
    colOf(sid2).appendChild(row);
  }
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
  actions.appendChild(buildPermChoices(reqId, sid, t("ws_handlers.072"), t("ws_handlers.073")));
  const s = state.sessions.find(x => x.id === sid);
  $("plan-title").textContent = t("ws_handlers.074") + (s ? " · " + displayTitle(s) : "");
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
    t("ws_handlers.075") +
    t("ws_handlers.076") +
    (active ? t("ws_handlers.077") : "") + '</span>';
  card.appendChild(head);
  card.appendChild(buildPermChoices(msg.request_id, sid2, t("ws_handlers.078"), t("ws_handlers.079")));
  attachPlanCardReopen(card, planTextOf(msg.input));
  colOf(sid2).appendChild(card);
  if (active) scrollToBottom();
}

$("plan-close").onclick = () => $("pane").classList.remove("plan-open");

/* ---------- 历史计划: 像子代理会话一样可再次点开 ----------
 * 计划弹卡时服务端已持久化（~/.aulos/plans/ + /api/plans 系列）。
 * 这里提供两个入口: ① 面板头部"历史"按钮 → 跨会话列表 → 点条目看全文;
 * ② 历史回放/已定格的聊天流计划卡可点击 → 面板重开渲染全文。
 * 历史计划只读: 面板按钮区隐藏, 不挂审批按钮。 */

function openPlanInPanel(planText, titleSuffix) {
  const pane = $("pane");
  const body = $("plan-body");
  _planSource = planText;
  body.innerHTML = renderMd(planText);
  decorateCode(body);
  decorateTables(body);
  body.classList.remove("stale");
  $("plan-actions").innerHTML = "";   // 只读查看: 不挂审批按钮
  delete $("plan-actions").dataset.reqId;
  delete $("plan-actions").dataset.reqSession;
  $("plan-title").textContent = t("ws_handlers.074") + (titleSuffix ? " · " + titleSuffix : "");
  pane.classList.add("plan-open");
}

function planStatusBadge(status) {
  const map = {
    pending:    ['pl-st-pending',    t("ws_handlers.072")],
    approved:   ['pl-st-approved',   t("ws_handlers.085")],
    rejected:   ['pl-st-rejected',   t("ws_handlers.086")],
    completed:  ['pl-st-completed',  t("ws_handlers.118")],
  };
  const [cls, label] = map[status] || map.pending;
  return '<span class="pl-st ' + cls + '">' + label + '</span>';
}

function fmtPlanTs(ts) {
  try {
    const d = new Date(Number(ts));
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) { return ""; }
}

let _planHistPrev = "";   // 最近一次从历史打开的全文（返回键恢复用）

async function showPlanHistory() {
  const body = $("plan-body");
  let items = [];
  try {
    const r = await fetch("/api/plans");
    if (r.ok) items = await r.json() || [];
  } catch (e) { /* 接口不可用: 显示空列表, 不炸 */ }
  _planHistPrev = _planSource;   // 返回时恢复上一份内容
  body.innerHTML = "";
  const head = document.createElement("div");
  head.className = "pl-hist-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "pl-hist-back";
  back.textContent = "← " + t("ws_handlers.074");
  back.onclick = () => {
    const prev = _planHistPrev || "";
    openPlanInPanel(prev, "");
    if (!prev) $("pane").classList.remove("plan-open");
  };  head.appendChild(back);
  body.appendChild(head);
  const list = document.createElement("div");
  list.className = "pl-hist-list";
  if (!items.length) {
    const none = document.createElement("div");
    none.className = "pl-hist-empty";
    none.textContent = "—";
    list.appendChild(none);
  }
  for (const it of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pl-hist-item";
    row.innerHTML = '<div class="pl-hist-meta">' +
      '<span class="pl-hist-ts">' + fmtPlanTs(it.ts) + '</span>' +
      planStatusBadge(it.status) +
      (it.session_id ? '<span class="pl-hist-sid">' + String(it.session_id).slice(0, 8) + '</span>' : '') +
      '</div><div class="pl-hist-prev"></div>';
    row.querySelector(".pl-hist-prev").textContent = (it.preview || "").slice(0, 120) || "…";
    row.onclick = async () => {
      try {
        const r = await fetch("/api/plans/" + encodeURIComponent(it.plan_id));
        if (!r.ok) throw new Error("http " + r.status);
        const rec = await r.json();
        _planHistPrev = rec.plan_markdown || "";
        openPlanInPanel(_planHistPrev, fmtPlanTs(it.ts));
      } catch (e) { /* 详情拉取失败: 静默, 列表仍在 */ }
    };
    list.appendChild(row);
  }
  body.appendChild(list);
  $("plan-actions").innerHTML = "";
  delete $("plan-actions").dataset.reqId;
  delete $("plan-actions").dataset.reqSession;
  $("plan-title").textContent = t("ws_handlers.074") + " · " + t("index.t021b");
  $("pane").classList.add("plan-open");
}

$("plan-hist").onclick = () => showPlanHistory();


/* 聊天流计划卡: 点击卡片头重开面板看全文。
 * 只对已决议（allowed/denied）的卡生效——待批卡的面板本来开着且挂着
 * 审批按钮, 点进只读态会把按钮藏起来造成困惑（终审 Minor #3）。 */
function attachPlanCardReopen(card, planText) {
  const head = card.querySelector(".plan-head");
  if (!head) return;
  head.addEventListener("click", ev => {
    if (ev.target.closest("button")) return;   // 按钮照常
    if (!card.classList.contains("allowed") && !card.classList.contains("denied")
        && !card.classList.contains("plan-hist")) return;   // 待批卡不进只读态
    card.classList.add("plan-viewable");
    openPlanInPanel(planText, "");
  });
}

/* 历史回放: present_plan 的 tool_use 块 → 可点击计划卡（不用通用工具卡,
 * 那种卡只有 input 截断描述、点不开全文）。仍登记 toolResultIndex 以便
 * 与 tool 角色的结果块配对, completeToolCard 只更新状态徽标。 */
function renderHistoryPlanCard(block, run) {
  const card = document.createElement("div");
  card.className = "plan-card plan-hist";
  card.dataset.tool = "present_plan";
  const head = document.createElement("div");
  head.className = "plan-head";
  head.innerHTML = '<span class="pr-ico">' + ICON_MODE_PLAN + '</span>' +
    t("ws_handlers.075") + t("ws_handlers.076") +
    '<span class="pl-hist-hint">' + t("ws_handlers.074") + '</span>';
  card.appendChild(head);
  const planText = planTextOf(
    typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}));
  head.addEventListener("click", () => openPlanInPanel(planText, ""));
  return card;
}

/* 计划全文复制: 复制 markdown 源文（renderPlanCard 存于 _planSource）,
 * 粘贴到文档/issue 语法结构完好; 按钮短暂显示"已复制"后回弹 */
let _planSource = "";
$("plan-copy").onclick = async () => {
  if (!_planSource) return;
  await copyText(_planSource);
  const btn = $("plan-copy");
  btn.innerHTML = CHECK_SVG + t("ws_handlers.080");
  setTimeout(() => { btn.innerHTML = COPY_SVG + t("ws_handlers.081"); }, 1400);
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
        ? (card.classList.contains("plan-card") ? t("ws_handlers.082") : t("ws_handlers.083"))
        : t("ws_handlers.084"),
      approved));
  };
  colOf(sid).querySelectorAll(
    `.perm-row[data-req-id="${requestId}"], .plan-card[data-req-id="${requestId}"]`
  ).forEach(markCard);
  // 右侧面板脚注同步定格（面板正显示这份计划且属于本会话才动——
  // 面板可能已被另一会话的计划占用; 已定格过（如过期路径先到）不覆盖）
  const pa = $("plan-actions");
  if (pa.dataset.reqId === requestId && pa.dataset.reqSession === sid
      && !pa.querySelector(".pr-mark")) {
    pa.innerHTML = "";
    pa.appendChild(makePrMark(approved ? t("ws_handlers.085") : t("ws_handlers.086"), approved));
  }
  renderSessionList();   // 批复即重绘: 侧栏"待批计划"徽标立刻熄灭（本地批复与广播共用此口）
}

/* 计划实施完成终态: 服务端 turn 正常收口后广播 plan_completed
 * {plan_id, request_id, session_id}。把已批准的计划卡推进"已完成"——
 * 此前卡停在"已批准 · 开始实施", 实施进度再无回执, 历史面板也
 * 无法区分"实施中/已完成"。幂等: 已定格 completed 的不重复。 */
function onPlanCompleted(msg, sid) {
  const rid = msg.request_id;
  if (!rid) return;
  colOf(sid).querySelectorAll(`.plan-card[data-req-id="${rid}"]`).forEach(card => {
    if (!card.classList.contains("allowed")) return;   // 只推进已批准的卡
    card.classList.remove("expired");
    card.classList.add("completed");
    const old = card.querySelector(".pr-mark");
    if (old) old.remove();
    card.appendChild(makePrMark(t("ws_handlers.118"), true));
  });
  // 右侧面板: 显示的正是这份计划（且属本会话）→ 脚注推进"已完成"
  const pa = $("plan-actions");
  if (pa.dataset.reqId === rid && pa.dataset.reqSession === sid) {
    pa.innerHTML = "";
    pa.appendChild(makePrMark(t("ws_handlers.118"), true));
    $("plan-body").classList.remove("stale");
  }
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
      card.appendChild(makePrMark(t("ws_handlers.087"), false));
    }
    // 右侧计划面板若正显示这份计划（且属于本会话）: 按钮区一并定格, 不留死按钮
    if (run.pendingPerms[rid]?.tool_name === "present_plan"
        && $("plan-actions").dataset.reqId === rid
        && $("plan-actions").dataset.reqSession === sid) {
      const pa = $("plan-actions");
      pa.innerHTML = "";
      pa.appendChild(makePrMark(t("ws_handlers.088"), false));
      $("plan-body").classList.add("stale");
    }
  }
  run.pendingPerms = {};
}

function respondPermission(requestId, approved, sid) {
  const run = runOf(sid);
  if (!run || !run.pendingPerms[requestId]) {
    // 请求已随轮次收口/已在别处批复, 登记已清: 残留的可点击卡就地定格,
    // 不留"看着能点、点了没反应"的死卡（markPermResolved 幂等——已定格
    // 的卡原样保留; 无卡场合纯 no-op, 也不向服务端发注定错配的响应）
    markPermResolved(sid, requestId, approved);
    return;
  }
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
  addNoteBubble("warn", t("ws_handlers.089", { p0: msg.max_concurrent }));
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
  run.stopping = false;      // 接力轮开跑: 旧轮的停止窗口旗作废
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
  if (inp) parts.push(t("ws_handlers.090") + inp);
  if (out) parts.push(t("ws_handlers.091") + out);
  if (cin) parts.push(t("ws_handlers.092") + cin);
  if (cred) parts.push(t("ws_handlers.093") + cred);
  addNoteBubble("usage", t("ws_handlers.094") + parts.join(" · "));
}

/* 「已停止」终态标签: 挂在本轮思考行的胶囊里; 本轮没思考过（工具/正文
 * 阶段打断）才落成独立提示行（落在该会话自己的列, 后台会话不进前台）。
 * stopTagged = 本轮已提前定格过: turn_done 到达时据此去重（一次性消费,
 * 不受收束期尾部思考行换锚点/接力轮 turn_started 影响）。 */
function markStoppedTag(run, sid) {
  if (!run) return;
  const cur = run.stoppedTagEl;
  if (cur && cur.isConnected && run.stopTagged) return;   // 本轮已定格: 去重
  const row = run.lastThinkRow;
  let el;
  if (row && row.isConnected) {
    el = document.createElement("span");
    el.className = "t-stopped";
    el.textContent = t("ws_handlers.095");
    row.appendChild(el);
  } else {
    el = document.createElement("div");
    el.className = "note stopped";
    el.textContent = t("ws_handlers.096");
    colOf(sid).appendChild(el);
  }
  run.stoppedTagEl = el;
}

/* 停止点恰逢轮次自然完成的 race: turn_done 说没被打断, 撤掉提前挂的标签 */
function removeStoppedTag(run) {
  if (run && run.stoppedTagEl) {
    run.stoppedTagEl.remove();
    run.stoppedTagEl = null;
  }
  if (run) run.stopTagged = false;
}

function onTurnDone(msg) {
  const run = curRun();
  const early = !!(run && run.stopping);   // 提前定格过: 收束窗口已被前端走过
  // 窗口内已续聊/接力轮在跑 → 只定格标签, 不重跑收口（busy 复位/胶囊
  // 关闭会踢翻新轮）; 否则正常收口（endTurnUiReset 幂等, 重跑无害）
  const relayRunning = !!(run && (run.busy || run.queued));
  if (run) run.stopping = false;           // 权威收口: 窗口旗清零
  if (early && relayRunning) {
    markStoppedTag(run, state.sessionId);  // 旧轮 usage 已 partial, 跳过
    if (run) run.stopTagged = false;       // 本轮收口完毕: 去重旗复位
  } else {
    endTurnUiReset();
    if (msg.interrupted) markStoppedTag(run, state.sessionId);
    else if (early) removeStoppedTag(run); // 停止点恰逢自然完成: 撤提前标签
    if (run) run.stopTagged = false;       // 本轮收口完毕: 去重旗复位
    addUsageNote(msg.usage);
    if (!msg.interrupted && msg.budget_exhausted) addBudgetNote(msg.usage);
    else if (!msg.interrupted && msg.iterations_exhausted) {
      addNoteBubble("warn", t("ws_handlers.097", { p0: msg.iterations }));
    }
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
  div.textContent = t("ws_handlers.098")
    + (out ? t("ws_handlers.099", { p0: out }) : "") + t("ws_handlers.100");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "note-act";
  btn.textContent = t("ws_handlers.101");
  btn.onclick = () => { btn.disabled = true; sendFixedText(t("ws_handlers.102")); };
  div.appendChild(btn);
  msgCol().appendChild(div);
  scrollToBottom();
}

/* 固定文本直接开一轮: 与 sendCurrent 的非草稿、非忙碌路径同构（turn_done
 * 之后必然处于该状态）, 不经过输入框, 不动用户正在打的草稿。 */
function sendFixedText(text) {
  const run = curRun();
  if (!run || !run.ws || run.ws.readyState !== 1) {
    toast(t("ws_handlers.103"));
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
  // 命名完成（在 turn_done 之后异步到达）: 事件自带权威标题, 就地更新
  // 后立即重绘——不依赖 loadSessions 的网络往返（旧实现丢掉 msg.title
  // 只重新 fetch, turn_done 时刻的旧列表响应可能晚到把标题盖回未命名,
  // 表现为"第一轮结束后侧栏仍是未命名, 第二次发消息才显形"）。
  const s = (state.sessions || []).find(x => x.id === msg.session_id);
  if (s && msg.title) s.title = msg.title;
  renderSessionList();
  refreshDocTitle();
  // 后台仍同步一次: 顺带刷新消息数/排序等其余字段（竞态由 loadSessions 序号防护）
  loadSessions().catch(() => { });
}

function onSessionUnarchived(msg) {
  // 给归档会话发消息触发自动恢复: 重新拉列表（archived 翻转已落盘）
  (async () => { await loadSessions(); })();
}

function onError(msg) {
  // 错误也是本轮结束: 不复位 busy 的话输入框会永久锁死，看起来像卡死
  endTurnUiReset();
  const run = curRun();
  if (run) run.stopping = false;   // 错误也是权威收口: 停止窗口旗一并清零
  addNoteBubble("err", msg.message || t("ws_handlers.104"));
}

function addNoteBubble(kind, text) {
  const div = document.createElement("div");
  div.className = "note " + kind;
  div.textContent = (kind === "err" ? "✗ " : kind === "warn" ? "⚠ " : "") + text;
  msgCol().appendChild(div);
  scrollToBottom();
  return div;
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
  div.textContent = (live ? t("ws_handlers.105") : t("ws_handlers.106"))
    + t("ws_handlers.107");
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
    t("ws_handlers.108", { p0: Math.round(msg.delay_s), p1: msg.attempt, p2: msg.max_retries });
  if (sid === state.sessionId) scrollToBottom();
}

function clearRateLimitNote(run) {
  if (run && run.rlNote) {
    run.rlNote.remove();
    run.rlNote = null;
  }
}

/* ---------- 打断受理反馈 ----------
 * reason=user_stop（用户手动停止）: 后端 request_stop 只置标志位, 真正的
 * 收束（杀进程树/修历史/落盘）在原工作线程里秒级完成。前端不等它——
 * 本地提前收口（endTurnUiReset + 「已停止」终态标签）, 让停止的观感
 * 瞬时; 用户继续对话时 sendCurrent 自然走空闲分支 = 平时的发送体验,
 * 消息进后端 pending, 收束完自动接力。迟到的 turn_done 只做标签去重,
 * 绝不重跑收口踢翻可能在跑的新轮。
 * reason=promote（排队插队）: 收束后待发送消息立即接力开跑, 不是终止——
 * 保持"正在中断"过程提示, 不提前定格。 */
function onTurnInterrupting(msg, sid) {
  const run = runOf(sid);
  if (msg.reason === "user_stop") {
    run.stopping = true;
    if (sid === state.sessionId) {
      endTurnUiReset();   // 与真收口完全同款: 关气泡/思考行、扫尾工具卡、指示灯灭
    } else {
      settleBackgroundTurnEnd(run, sid);
    }
    markStoppedTag(run, sid);
    run.stopTagged = true;   // 本轮已定格: 迟到的 turn_done 按此去重
    return;
  }
  let el = run.rlNote;
  if (!el || !el.isConnected) {
    el = document.createElement("div");
    el.className = "note stopped rl-note";
    colOf(sid).appendChild(el);
    run.rlNote = el;
  }
  el.textContent = t("ws_handlers.109");
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
  btn.dataset.tip = stop ? t("ws_handlers.110") : t("ws_handlers.111");
}
function setBusyUi(busy) {
  // 草稿态没有"前序"可修改: 占位符提示描述任务; 忙碌态对齐 Claude.ai: 提示可以直接继续排队
  $("input").placeholder = state.draft ? t("ws_handlers.112")
    : busy ? t("ws_handlers.113") : t("ws_handlers.114");
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
    el.innerHTML = t("ws_handlers.115");
  }
  const run = curRun();
  const show = !!(run && run.busy);
  el.style.display = show ? "flex" : "none";
  if (state.sessionId) {
    // 锤子敲击与转圈同周期: 轮次运行期间, 本列最后一个工具分组持续敲击;
    // 组与组之间、工具与工具的间隙不再经历 run 状态翻转带来的"停-重启"
    // (CSS 动画在同一个元素上不换名就不会归零) —— 修闪一下;
    // 轮次收口后 show=false, 类摘除, 敲击停。后台列靠 :has(.tg-sum.run) 兜底。
    const hgroups = colOf(state.sessionId).querySelectorAll(".tool-group");
    const hlast = hgroups.length ? hgroups[hgroups.length - 1] : null;
    hgroups.forEach(g => g.classList.toggle("hammering", show && g === hlast));
    // 已在当前列尾就绝不动节点: appendChild 对已连接节点 = 移除+重插,
    // CSS 旋转动画被取消并从头重播。本函数每条 text_delta 都会调,
    // 无条件挪节点曾让流式期间转圈反复归零——"转得不顺畅"的根因。
    const col = colOf(state.sessionId);
    if (el.parentNode !== col || col.lastElementChild !== el) {
      col.appendChild(el);
      if (show) scrollToBottom();   // 挂到列尾会撑高内容: 贴底时跟着滚, 别让转圈悬在视口外
    }
  }
}

async function sendCurrent() {
  const input = $("input");
  const text = input.value.trim();
  const attachments = attachDraftOf().slice();   // 发送快照, 与草稿解耦
  if (!text && !attachments.length) return;   // 只发图不打字也允许
  // 归属先定死: 草稿态在第一个 await 之前同步收编, 之后一律用局部 sid,
  // 绝不在 await 之后重读 state.sessionId——否则发送途中切会话, 消息会从
  // 别的会话的 WS 发出去(串会话)或因转正块被跳过而静默丢弃(2026-10-10 事故)
  const wasDraft = !!state.draft;
  let sid = state.sessionId;
  let firstWorkdir = "";
  let draftMode = null, draftPlan = null;
  if (wasDraft) {
    firstWorkdir = state.draftDir || "";
    draftMode = state.draftMode;
    draftPlan = state.draftPlan;
    state.draft = false;         // 同步收编: POST 期间切走/再开新草稿都不会与本流程交错(防双开)
    state.draftDir = null;       // 已转正: 预选项目用完即清
    state.draftMode = null;
    state.draftPlan = null;
  }
  const run = curRun();
  const busy = !!(run && run.busy);
  if (!wasDraft && (!run || !run.ws || run.ws.readyState !== 1)) return;
  // 草稿态: 此刻才向服务端要 id 建会话条目；失败则恢复草稿态留在原地
  if (wasDraft) {
    try {
      const r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workdir: firstWorkdir }),   // 创建即绑定项目, 列表立刻归组
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      sid = (await r.json()).id;
    } catch (e) {
      state.draft = true;          // 输入框内容没动过, 用户可直接重试
      state.draftDir = firstWorkdir || null;
      state.draftMode = draftMode;
      state.draftPlan = draftPlan;
      toast(t("ws_handlers.116") + e.message);
      return;
    }
  }
  // 唯一的 await 已过, 以下全同步。adopted = POST 期间无人打断（没点别的
  // 会话、没再开新草稿）→ 视图跟随新会话; 否则本条转入后台, 不抢前台
  const adopted = wasDraft && !state.draft && state.sessionId === null;
  if (adopted) state.sessionId = sid;
  const foreground = state.sessionId === sid;
  if (wasDraft && foreground) {
    // 草稿列先转正, 再碰任何 colOf(sid): 否则 colOf(sid) 先造出一个新的
    // 空列, 可见的旧草稿列(带着欢迎空态)随后也改名成同一 id——DOM 出现
    // 重复 id, 流式事件按 id 解析回旧列插在欢迎页下面, 气泡却在另一列
    colOf("__draft__").id = "msg-col-" + sid;
  }
  if (foreground) {
    colOf(sid).querySelector(".empty-state")?.remove();
    $("pane").classList.remove("empty-view");   // 有内容了: 输入卡落回底部
    nearBottom = true;
    scrollToBottom(true);   // 发送是用户主动行为: 无论滚到哪里, 立刻回到底部看最新消息
  }
  if (adopted) {
    $("ws-dock").innerHTML = "";                // 草稿态的工作区条/建议 chips 一并撤下
    $("sug-dock").innerHTML = "";
  }
  skillMenuDestroy();   // 发送即收起斜杠补全（排队/插队路径同样覆盖）
  const qid = genQid();   // 本地生成: 排队卡片与服务端排队区按同一 qid 配对
  // 计划审批挂起时追加 = 否决计划并立刻接力: 不进待发送卡（否则要手动点
  // "立即"才发得上）, 乐观加气泡 + 就地定格旧计划, 服务端打断当前轮后
  // 以这条消息为下一棒开跑（turn_started 回执按 qid 去重, 不重复加气泡）
  if (busy && isAwaitingPlan(runOf(sid))) {
    const pr = runOf(sid);
    addUserBubble(text, attachments, colOf(sid), null, qid);
    input.value = "";
    setAttachDraft([]);          // 已发送: 清空本会话的附件草稿
    autoGrow(input);
    saveCurrentInput();          // 已发送: 清空本会话的输入草稿
    updateSendBtn();             // 输入已清空: 圆钮切回"停止"形态, 随时可中断
    expirePlanCard(pr, sid, t("ws_handlers.117"));
    sendWs({ type: "user", text, attachments, qid }, sid);
    return;
  }
  // 本轮在跑: 消息进入输入框上方的待发送卡片, 轮到它时才出现在消息列
  if (busy) {
    runOf(sid).queue.push({ qid, text, attachments });
    input.value = "";
    setAttachDraft([]);          // 已发送: 清空本会话的附件草稿
    autoGrow(input);
    saveCurrentInput();          // 已发送: 清空本会话的输入草稿
    updateSendBtn();             // 输入已清空: 圆钮切回"停止"形态
    renderQueueCards();
    sendWs({ type: "user", text, attachments, qid }, sid);
    return;
  }
  addUserBubble(text, attachments, colOf(sid), null, qid);
  // 草稿存档清掉: 旧实现在草稿态尚存活时经 setAttachDraft/saveCurrentInput
  // 顺手清档; 现在草稿态入口即收编, 这两份存档必须显式清——否则已发出的
  // 文本/附件会在下一个新草稿里幽灵恢复
  state.draftInput = "";
  state.draftAttach = [];
  if (foreground) {
    input.value = "";
    setAttachDraft([]);          // 已发送: 清空本会话的附件草稿
    autoGrow(input);
    saveCurrentInput();          // 已发送: 清空本会话的输入草稿
    updateSendBtn();             // 输入已清空: 忙碌态下圆钮切回"停止"形态
  }
  const myRun = runOf(sid);
  myRun.busy = true;
  myRun.awaiting = false;
  myRun.lastThinkRow = null;   // 新一轮开始: 打断标记只属于当前轮的思考行
  beginOptimisticThinking(myRun, sid, colOf(sid));   // 乐观胶囊: 发送瞬间即有反馈
  if (foreground) {
    syncThinkingIndicator();
    setBusyUi(true);
  }
  renderSessionList();   // 立即显示运行状态（转圈图标）
  if (wasDraft) {
    myRun.loaded = true;   // 草稿列里的气泡就是全部内容, 无需再拉历史
    if (foreground) {
      renderQueueCards();   // 草稿转正: 现在挂在具体会话上（新会话队列必为空, 清掉草稿态可能的残留）
      // 列名转正已在上方 foreground 判定处完成(必须先于一切 colOf(sid))
    }
    connectWs(sid);
    // WS 建立期间消息进 pendingSends, onopen 后按序冲刷。列表刷新退到
    // 发送之后后台跑: 旧实现在 connectWs 前 await loadSessions(), 那扇
    // await 窗口正是串会话事故的第二案发地; 现在发送不再等列表
    loadSessions().then(() => {
      renderSessionList();   // 新条目此刻才入库; 后台发出的也要在侧栏可见
      if (state.sessionId === sid) {
        markActiveSession();
        refreshDocTitle();
      }
    });
  }
  // 草稿态预选的权限模式/计划开关: 先于首条消息冲进 pendingSends/WS,
  // onopen 按序发送保证服务端在建会话首条消息前就切好模式
  if (draftMode || draftPlan != null) {
    const base = draftMode || "prompt";
    const plan = !!draftPlan;
    myRun.permissionMode = mkModeValue(base, plan);
    myRun.planActive = plan;
    sendWs({ type: "set_permission_mode", mode: base, plan }, sid);
  }
  sendWs({ type: "user", text, attachments, workdir: firstWorkdir, qid }, sid);
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
/* 归档视图开关: 归档态再点即退出（与 X/Esc 等效） */
$("tab-archive").onclick = () => setArchiveView(!state.archiveView);

function openSearch() {
  $("search-box").classList.add("open");
  $("search-input").focus();
}
/* 叉号可见性跟着内容走（程序清空不会触发 input 事件, 各改动 .value 的
 * 地方统一调这个收口） */
function syncSearchClear() {
  $("search-box").classList.toggle("has-value", !!$("search-input").value);
}
function closeSearch() {
  $("search-box").classList.remove("open");
  $("search-input").value = "";
  syncSearchClear();
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

$("search-input").addEventListener("input", () => { syncSearchClear(); renderSessionList(); scheduleFulltextSearch(); });
$("search-input").addEventListener("keydown", ev => {
  if (ev.key === "Escape") closeSearch();
});
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape" && state.archiveView) setArchiveView(false);
});
/* 一键清除: 只清内容、保留搜索框展开与焦点（和 Esc/再点搜索钮的"收起"
 * 区分开）; 清空后走与打字清空相同的收口——标题过滤重绘 + 全文态清除 */
$("search-clear").onclick = () => {
  const input = $("search-input");
  if (!input.value) return;
  input.value = "";
  syncSearchClear();
  state.fulltext = null;
  clearTimeout(_ftsTimer);
  renderSessionList();
  input.focus();
};

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
