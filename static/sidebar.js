/* ============================================================
 * sidebar.js — 侧栏会话列表: 项目/分组两种模式 + 搜索 + 快捷键
 *
 * 从 app.js 外迁的功能域 (拆分路线见 README「代码组织与拆分路线」)。
 * 双向引用均为运行时解引用, app.js 之后 defer 加载即安全:
 *   - ws-handlers 的流式事件/会话改名/未读累计 调 renderSessionList 等;
 *   - 本文件调 app.js 的 startDraft/state/petTaskSid 与工作目录域。
 * 无顶层立即执行 (加载期只定义)。
 *
 * 读的前置全局: state / $ / startDraft / petTaskSid / refreshWorkdirTag /
 *               closeWs / openDirPop / dirName / escapeHtml / TRASH_SMALL_SVG
 * 暴露的全局:   renderSessionList / loadSessions / refreshDocTitle /
 *               markActiveSession / addProject / projectDisplayName /
 *               scheduleFulltextSearch / FOLDER_SVG
 * ============================================================ */
/* ============================================================
 * 侧栏会话列表（项目 / 分组 两种模式 + 搜索过滤）
 * ============================================================ */
function sessionDate(id) {
  // 会话 id 是 %Y%m%d-%H%M%S 的 UTC 时间戳（可能有 "w" 后缀防撞），
  // 必须按 UTC 解析再转本地，否则所有会话都会显示成多出时区差的"旧"会话
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
function relativeTime(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  if (!m) return "";
  const then = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const diff = (Date.now() - then.getTime()) / 1000;
  if (diff < 90) return t("sidebar.001");
  if (diff < 3600) return Math.floor(diff / 60) + t("sidebar.002");
  if (diff < 86400) return Math.floor(diff / 3600) + t("sidebar.003");
  if (diff < 172800) return t("sidebar.004");
  if (diff < 604800) return Math.floor(diff / 86400) + t("sidebar.005");
  return `${+m[2]}/${+m[3]}`;
}
function sessionBucket(id) {
  const d = sessionDate(id);
  if (!d) return 3;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.floor((today - d) / 86400000);
  if (days <= 0) return 0;      // 今天
  if (days === 1) return 1;     // 昨天
  if (days < 7) return 2;       // 7 天内
  return 3;                     // 更早
}
const BUCKET_LABELS = () => [t("sidebar.006"), t("sidebar.007"), t("sidebar.008"), t("sidebar.009")];   // 工厂: 现取, 热切换后即时换语言
const FOLDER_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>';
const PLUS_SMALL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const UNTITLED_TITLE = () => t("sidebar.010");   // 工厂: 现取

function displayTitle(s) {
  return (!s || s.title === t("sidebar.011")) ? UNTITLED_TITLE() : s.title;
}

async function loadSessions() {
  try {
    const r = await fetch("/api/sessions");
    const data = await r.json();
    state.sessions = data.sessions;
    // 会话列表同源回填: 顶栏工作区胶囊读 run.currentWorkdir, 而它只在
    // 首次切入会话时从 /messages 填充一次——发送首条消息落盘 workdir、
    // 或已开会话被移动项目后若不刷新, 胶囊与侧栏分组会各说各话。
    for (const s of data.sessions) {
      const run = state.runs?.[s.id];
      if (run) run.currentWorkdir = s.workdir || null;
    }
    renderSessionList();
    refreshWorkdirTag();
  } catch (e) { console.error("加载会话列表失败", e); }
}

const TRASH_SMALL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9.5 7V5h5v2M6.5 7l1 13h9l1-13"/></svg>';
/* 归档 = 追加式记录, 只在列表视图隐藏, 数据不丢; 恢复即回主列表 */
const ARCHIVE_BOX_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 002 2h10a2 2 0 002-2V8M10 12h4"/></svg>';
const UNARCHIVE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 016 6v4"/></svg>';
const MORE_SMALL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
const CLOSE_SMALL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/* 归档/恢复: POST 后原地更新 state 并重绘（失败 toast, 不动列表） */
async function setSessionArchived(id, archived) {
  try {
    const r = await fetch(`/api/sessions/${id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.status);
    }
    const s = state.sessions.find(x => x.id === id);
    if (s) s.archived = archived;
    renderSessionList();
    toast(archived ? t("sidebar.012") : t("sidebar.013"));
  } catch (e) {
    toast(archived ? t("sidebar.014") : t("sidebar.015") + e.message);
  }
}

/* 批量归档: days 为正整数（弹层输入或预设档）, 结果 toast 计数后刷新 */
async function batchArchive(days) {
  try {
    const r = await fetch("/api/sessions/batch-archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.status);
    }
    const body = await r.json();
    await loadSessions();
    toast(body.archived
      ? t("sidebar.016", { p0: body.archived })
        + (body.skipped_busy ? t("sidebar.017", { p0: body.skipped_busy }) : "")
      : t("sidebar.018"));
  } catch (e) {
    toast(t("sidebar.019") + e.message);
  }
}

/* 全部删除归档任务: 危险操作, confirmDialog 后走批量删除接口 */
async function deleteAllArchived() {
  const n = state.sessions.filter(s => s.archived).length;
  if (!n) { toast(t("sidebar.020")); return; }
  const ok = await confirmDialog(
    t("sidebar.021", { p0: n }),
    { title: t("sidebar.022"), okText: t("sidebar.023"), danger: true });
  if (!ok) return;
  try {
    const r = await fetch("/api/sessions/batch-delete-archived", { method: "POST" });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.status);
    }
    const body = await r.json();
    await loadSessions();
    toast(body.deleted.length
      ? t("sidebar.024", { p0: body.deleted.length })
        + (body.skipped_busy ? t("sidebar.025", { p0: body.skipped_busy }) : "")
      : t("sidebar.026"));
  } catch (e) {
    toast(t("sidebar.027") + e.message);
  }
}

/* 归档视图开关: 不持久化, 刷新回主列表（X/Esc/再点归档钮都可退出） */
function setArchiveView(on) {
  state.archiveView = on;
  $("side-tabs-row").classList.toggle("archive-mode", on);
  const btn = $("tab-archive");
  if (btn) btn.classList.toggle("on", on);
  renderSessionList();
}
const PENCIL_SMALL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-1L20 7.5 16.5 4 5 15.5 4 20z"/></svg>';
/* 会话状态图标: 运行中转圈 / 未读红点 / 空闲对话气泡 */
const SPINNER_SVG = '<svg class="s-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 11-9-9"/></svg>';
const CHAT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 01-8.5 8.5c-1.6 0-3.1-.4-4.3-1.2L3 20l1.2-5.2A8.5 8.5 0 1121 11.5z"/></svg>';
const DOT_RED_SVG = '<svg width="9" height="9" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>';
function sessionStateIcon(s) {
  const run = state.runs[s.id];
  if (run && run.busy) return SPINNER_SVG;               // 运行中
  if (run && isAwaitingPlan(run)) return ICON_MODE_PLAN; // 卡在计划审批
  if (run && run.unread > 0) return DOT_RED_SVG;         // 有未读
  return CHAT_SVG;                                        // 空闲
}

async function renameSession(id, title) {
  try {
    const r = await fetch(`/api/sessions/${id}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.status);
    }
    const s = state.sessions.find(x => x.id === id);
    if (s) s.title = title;
    renderSessionList();
    if (id === state.sessionId) refreshDocTitle();
  } catch (e) {
    toast(t("sidebar.028") + e.message);
  }
}

/* 通用行内编辑框: Enter/失焦提交，Esc 取消；onDone 无论提交与否都会回调 */
function makeInlineEditor(initial, onCommit, onDone) {
  const input = document.createElement("input");
  input.className = "inline-rename";
  input.maxLength = 60;
  input.value = initial;
  const finish = commit => {
    if (input._done) return;
    input._done = true;
    const val = input.value.trim();
    input.remove();
    if (commit && val && val !== initial) onCommit(val);
    if (onDone) onDone(commit);
  };
  input.onclick = ev => ev.stopPropagation();
  input.onkeydown = ev => {
    ev.stopPropagation();   // 别让按键冒泡成全局快捷键
    if (ev.key === "Enter") finish(true);
    else if (ev.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return input;
}

function makeSessionItem(s) {
  const item = document.createElement("div");
  const unnamed = s.title === t("sidebar.029");
  item.className = "session-item"
    + (s.id === state.sessionId ? " active" : "")
    + (unnamed ? " unnamed" : "");
  item.dataset.id = s.id;
  const archivedView = !!state.archiveView;
  /* 普通视图: 改名+归档; 归档视图: 行内不带操作钮——恢复/删除在子行,
   * 主行保持 标题+时间 两元素, 与 mock 一致 */
  item.innerHTML = '<span class="s-ico">' + sessionStateIcon(s) + '</span>'
    + '<span class="s-unread"></span>'
    + t("sidebar.030")
    + '<span class="title"></span><span class="meta"></span>'
    + '<div class="s-snippet"></div>'
    + (archivedView ? "" :
        t("sidebar.031") + ARCHIVE_BOX_SVG + '</button>'
        + t("sidebar.032") + PENCIL_SMALL_SVG + '</button>');
  item.querySelector(".title").textContent = displayTitle(s);
  item.querySelector(".meta").textContent = relativeTime(s.id);
  // 全文命中摘录: 标题也命中时同样展示（"正文"前缀区分命中来源）。
  // 高亮用大小写不敏感正则逐段 append 文本节点/mark 节点——不用
  // innerHTML 拼接, 工具输出里的 HTML 片段不会被当标记解析
  const fts = state.fulltext;
  const q = ($("search-input").value || "").trim().toLowerCase();   // renderSessionList 的局部 q 不在本作用域, 自行读取
  const snipEl = item.querySelector(".s-snippet");
  const hitSnips = (q && fts && fts.query === q && fts.hits && fts.hits[s.id]) || null;
  if (hitSnips && hitSnips.length) {
    snipEl.textContent = "";
    const tag = document.createElement("span");
    tag.className = "snip-tag";
    tag.textContent = t("sidebar.033");
    snipEl.appendChild(tag);
    const text = document.createElement("span");
    const re = new RegExp(fts.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    let last = 0, m;
    while ((m = re.exec(hitSnips[0])) !== null) {
      if (m.index > last) text.appendChild(document.createTextNode(hitSnips[0].slice(last, m.index)));
      const mark = document.createElement("mark");
      mark.textContent = m[0];
      text.appendChild(mark);
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;   // 防空匹配死循环
    }
    if (last < hitSnips[0].length) text.appendChild(document.createTextNode(hitSnips[0].slice(last)));
    snipEl.appendChild(text);
  }
  const run = state.runs[s.id];
  if (run && run.busy) item.classList.add("running");
  // 卡在计划审批: 元信息让位给"待批计划"徽标, 错过弹窗也能从侧栏看出
  // 这个会话在等用户批准; 图标同步换成计划徽标（sessionStateIcon）
  const awaitingPlan = !!(run && isAwaitingPlan(run));
  if (awaitingPlan) item.classList.add("awaiting-plan");
  if (run && run.unread > 0) {
    item.classList.add("unread");
    item.querySelector(".s-unread").textContent = run.unread > 99 ? "99+" : run.unread;
  }
  item.onclick = () => selectSession(s.id);
  /* 归档视图: workdir 子行（第二行, 无项目显示 default）; 恢复/删除悬停
   * 出现在子行右侧——上下两行, 主行保持标题+时间的干净布局 */
  if (archivedView) {
    const wd = document.createElement("div");
    wd.className = "s-workdir";
    wd.innerHTML = FOLDER_SVG + '<span></span>'
      + t("sidebar.034") + UNARCHIVE_SVG + '</button>'
      + t("sidebar.035") + TRASH_SMALL_SVG + '</button>';
    wd.querySelector("span").textContent = s.workdir ? projectDisplayName(s.workdir) : "default";
    item.appendChild(wd);
  }
  const arcBtn = item.querySelector(".s-arc");
  if (arcBtn) arcBtn.onclick = ev => {
    ev.stopPropagation();
    setSessionArchived(s.id, true);
  };
  const unarcBtn = item.querySelector(".s-unarc");
  if (unarcBtn) unarcBtn.onclick = ev => {
    ev.stopPropagation();
    setSessionArchived(s.id, false);
  };
  const renBtn = item.querySelector(".s-ren");
  if (renBtn) renBtn.onclick = ev => {
    ev.stopPropagation();
    if (item.classList.contains("renaming")) return;
    item.classList.add("renaming");   // 编辑期间隐藏标题/时间/按钮
    const input = makeInlineEditor(
      displayTitle(s),
      val => renameSession(s.id, val),
      () => item.classList.remove("renaming"),
    );
    item.appendChild(input);
  };
  const delBtn = item.querySelector(".s-del");
  if (delBtn) delBtn.onclick = ev => {
    ev.stopPropagation();
    deleteSession(s.id);
  };
  return item;
}

async function deleteSession(id) {
  const run = state.runs[id];
  if (run && run.busy) {
    toast(t("sidebar.036"));
    return;
  }
  const cur = state.sessions.find(s => s.id === id);
  if (!await confirmDialog(t("sidebar.037", { p0: displayTitle(cur) }),
      { title: t("sidebar.038"), okText: t("sidebar.039"), danger: true })) return;
  try {
    const r = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.status);
    }
    state.sessions = state.sessions.filter(s => s.id !== id);
    closeWs(id);                 // 断掉该会话的 WS
    delete state.runs[id];       // 运行态一并清理
    const col = document.getElementById("msg-col-" + id);
    if (col) col.remove();       // 消息列一并清理
    renderSessionList();
    if (id === state.sessionId) {
      // 删的是当前会话: 自动切到最近的会话，没有则回草稿态
      state.sessionId = null;
      const next = state.sessions[0];
      if (next) await selectSession(next.id);
      else startDraft();
    }
    toast(t("sidebar.040"));
  } catch (e) {
    toast(t("sidebar.041") + e.message);
  }
}

/* 桌宠专属会话 id(悬浮输入框任务的载体): 列表渲染/启动选中都要跳过它。
 * 读 localStorage 而非文件尾的 petTaskSid 变量——init 渲染可能早于其执行 */
function petTaskSidSaved() {
  return localStorage.getItem("xc-pet-task-sid") || "";
}

function renderSessionList() {
  const list = $("session-list");
  const booting = !list.dataset.booted;   // 首次渲染播一次入场动画
  if (booting) list.classList.add("boot");
  list.innerHTML = "";
  if (booting) {   // 两帧后摘标记: 本次渲染的节点播完入场, 后续重绘不再播
    requestAnimationFrame(() => requestAnimationFrame(() => list.classList.remove("boot")));
    list.dataset.booted = "1";
  }
  const q = ($("search-input").value || "").trim().toLowerCase();
  // 全文搜索态: { query, hits: {sid: [摘录...]}, seq } —— 输入框有词且
  // 全文接口已返回时非空; 标题本地过滤即时反馈, 全文结果异步叠加
  const fts = state.fulltext;
  const ftsActive = q && fts && fts.query === q && fts.hits;
  // 桌宠专属会话不进任务列表: 它是悬浮输入框的对话载体, 混在用户
  // 任务里只会越积越长。会话本体照常存在(WS/轮次/落盘), 仅列表不渲染
  const petSid = petTaskSidSaved();
  // 归档视图: 只渲染已归档会话; 主视图: 过滤掉已归档的
  // （字段缺省视为未归档——旧响应/旧会话零迁移）
  let sessions = state.sessions.filter(s => s.id !== petSid && !!s.archived === (state.archiveView === true));
  sessions = sessions.filter(
    s => !q
      || (s.title || "").toLowerCase().includes(q)
      || (s.workdir || "").toLowerCase().includes(q));
  // 全文命中但标题没命中的会话也要显示（追加到过滤结果后面, 去重）
  if (ftsActive) {
    const seen = new Set(sessions.map(s => s.id));
    for (const s of state.sessions) {
      if (s.id !== petSid && !seen.has(s.id) && fts.hits[s.id]) sessions.push(s);
    }
  }
  if (q && !sessions.length && ftsActive && !Object.keys(fts.hits).length && !fts.pending) {
    const e = document.createElement("div");
    e.className = "list-empty";
    e.textContent = t("sidebar.042");
    list.appendChild(e);
    return;
  }
  const addLabel = text => {
    const l = document.createElement("div");
    l.className = "list-label";
    l.textContent = text;
    list.appendChild(l);
  };
  /* ---- 归档视图: 排序 + 批量归档 + …菜单(全部删除) 工具行 ---- */
  if (state.archiveView) {
    /* 工具行始终渲染——空列表时批量归档正是入口
     * （把主列表的老会话收进来）, 不能只剩一句空态文案 */
    const toolRow = document.createElement("div");
    toolRow.className = "list-label-row archived-tools";
    toolRow.innerHTML = t("sidebar.043");
    const mkBtn = (tip, svg) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "icon-btn";
      b.dataset.tip = tip;
      b.innerHTML = svg;
      return b;
    };
    /* 排序: 更新时间(mtime) / 创建时间(id 前缀), 持久化; 图标即当前档位 */
    const sortBtn = mkBtn(
      t("sidebar.044") + (archiveSortMode() === "updated" ? t("sidebar.045") : t("sidebar.046")),
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>');
    sortBtn.onclick = ev => {
      ev.stopPropagation();
      if (sortBtn._pop) { sortBtn._pop.close(); sortBtn._pop = null; return; }   // 再点 = 关
      const pop = anchoredPop(sortBtn, "dd-pop");
      sortBtn._pop = pop;
      const origClose = pop.close;
      pop.close = () => { origClose(); sortBtn._pop = null; };
      const mkOpt = (label, mode) => {
        const o = document.createElement("button");
        o.type = "button";
        o.className = "dd-opt" + (archiveSortMode() === mode ? " on" : "");
        o.innerHTML = '<span class="dd-check">' + CHECK_SVG + '</span><span class="dd-txt"></span>';
        o.querySelector(".dd-txt").textContent = label;
        o.onclick = () => { setArchiveSort(mode); pop.close(); };
        pop.appendChild(o);
      };
      mkOpt(t("sidebar.047"), "updated");
      mkOpt(t("sidebar.048"), "created");
    };
    /* 批量归档 */
    const batch = mkBtn(t("sidebar.049"), ARCHIVE_BOX_SVG);
    batch.onclick = async ev => {
      ev.stopPropagation();
      if (batch._pop) { batch._pop.close(); batch._pop = null; return; }   // 再点 = 关
      const days = await pickBatchDays(batch, p => { batch._pop = p; });
      batch._pop = null;
      if (days) batchArchive(days);
    };
    /* …菜单: 全部删除 */
    const more = mkBtn(t("sidebar.050"), MORE_SMALL_SVG);
    more.onclick = ev => {
      ev.stopPropagation();
      if (more._pop) { more._pop.close(); more._pop = null; return; }   // 再点 = 关
      const n = state.sessions.filter(s => s.archived).length;
      const pop = anchoredPop(more, "dd-pop");
      more._pop = pop;
      const origClose = pop.close;
      pop.close = () => { origClose(); more._pop = null; };
      const cnt = document.createElement("div");
      cnt.className = "dd-opt plain dd-head";
      cnt.textContent = n + t("sidebar.051");
      pop.appendChild(cnt);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "dd-opt danger";
      del.innerHTML = '<span class="dd-ico">' + TRASH_SMALL_SVG + '</span><span class="dd-txt"></span>';
      del.querySelector(".dd-txt").textContent = t("sidebar.052");
      del.onclick = () => { pop.close(); deleteAllArchived(); };
      pop.appendChild(del);
    };
    toolRow.appendChild(sortBtn);
    toolRow.appendChild(batch);
    toolRow.appendChild(more);
    list.appendChild(toolRow);
    if (!sessions.length) {
      /* 空态跟随搜索语境: 搜索中是"没有匹配", 平时引导去批量归档。
       * 必须用 appendChild——innerHTML += 会销毁重建整个容器,
       * 工具行按钮的事件绑定随旧元素一起被抹掉（点击无反应） */
      const emptyEl = document.createElement("div");
      emptyEl.className = "list-empty";
      emptyEl.textContent = q ? t("sidebar.053") : t("sidebar.054");
      list.appendChild(emptyEl);
      return;
    }
    const sortMode = archiveSortMode();
    const sorted = [...sessions].sort((a, b) => sortMode === "updated"
      ? (b.mtime || 0) - (a.mtime || 0) || b.id.localeCompare(a.id)
      : b.id.localeCompare(a.id));
    for (const s of sorted) {
      const it = makeSessionItem(s);
      it.classList.add("in-project", "archived-item");
      list.appendChild(it);
    }
    return;
  }
  if (state.sideTab === "group") {
    if (!sessions.length) {
      list.innerHTML = '<div class="list-empty">' + (q ? t("sidebar.055") : t("sidebar.056")) + "</div>";
      return;
    }
    // 会话按时间倒序，分组标签自然按 今天→更早 顺序出现
    let bucket = -1;
    for (const s of sessions) {
      const b = sessionBucket(s.id);
      if (b !== bucket) { bucket = b; addLabel(BUCKET_LABELS()[b]); }
      list.appendChild(makeSessionItem(s));
    }
    return;
  }

  /* ---- 项目视图: 可折叠项目组 + 任务(未选择文件夹的会话) ---- */
  const headRow = document.createElement("div");
  headRow.className = "list-label-row";
  headRow.innerHTML = t("sidebar.057");
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "icon-btn";
  addBtn.id = "btn-add-project";
  addBtn.dataset.tip = t("sidebar.058");
  addBtn.innerHTML = PLUS_SMALL_SVG;
  addBtn.onclick = async ev => {
    ev.stopPropagation();
    // 桌面端: 系统原生"选择文件夹"对话框; 浏览器/预览: 页面内目录选择兜底
    if (window.aulosPickFolder) {
      const dir = await pickNativeFolder();
      if (dir) addProject(dir);
      return;
    }
    openDirPop();
  };
  headRow.appendChild(addBtn);
  list.appendChild(headRow);

  if (!sessions.length && (q || !state.customProjects.length)) {
    const e = document.createElement("div");
    e.className = "list-empty";
    e.textContent = q ? t("sidebar.059") : t("sidebar.060");
    list.appendChild(e);
  }

  // 项目目录 = 会话的 workdir ∪ 手动添加的项目
  const groups = new Map();
  for (const s of sessions) {
    if (!s.workdir) continue;
    if (!groups.has(s.workdir)) groups.set(s.workdir, []);
    groups.get(s.workdir).push(s);
  }
  for (const wd of state.customProjects) {
    if (!groups.has(wd)) groups.set(wd, []);
  }
  const named = [...groups.entries()];
  named.sort((a, b) => (b[1][0]?.id ?? "").localeCompare(a[1][0]?.id ?? ""));  // 组间按最新会话
  const chev = '<svg class="p-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  for (const [wd, items] of named) {
    const collapsed = state.collapsedProjects.has(wd) && !q;   // 搜索时强制展开
    const header = document.createElement("div");
    header.className = "project-item" + (collapsed ? " collapsed" : "");
    header.innerHTML = FOLDER_SVG + '<span class="p-name"></span>'
      + '<span class="p-count"></span>'
      + t("sidebar.061") + PLUS_SMALL_SVG + '</button>'
      + t("sidebar.062") + TRASH_SMALL_SVG + '</button>'
      + chev;
    header.querySelector(".p-name").textContent = projectDisplayName(wd);
    header.querySelector(".p-count").textContent = items.length ? String(items.length) : "";
    header.querySelector(".p-add").onclick = ev => {
      ev.stopPropagation();   // 别触发折叠/展开
      startDraft(wd);
    };
    header.querySelector(".p-del").onclick = ev => {
      ev.stopPropagation();   // 别触发折叠/展开
      removeProject(wd, items.length);
    };
    header.onclick = () => toggleProject(wd);
    list.appendChild(header);
    if (collapsed) continue;
    for (const s of items) {
      const it = makeSessionItem(s);
      it.classList.add("in-project");
      list.appendChild(it);
    }
  }

  // 任务 = 没有选择文件夹的会话; 标题行带 + 与项目分组一致
  // 标题行可点: 折叠/展开整个区块（与项目组折叠交互一致; 搜索时强制展开）
  const taskCollapsed = state.collapsedTasks && !q;
  const loose = sessions.filter(s => !s.workdir);
  const taskRow = document.createElement("div");
  taskRow.className = "list-label-row" + (loose.length ? " tappable" : "")
    + (taskCollapsed ? " collapsed" : "");
  if (loose.length) taskRow.dataset.tip = t("sidebar.063");
  taskRow.innerHTML = t("sidebar.064")
    + (loose.length ? '<svg class="t-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' : "");
  const taskAdd = document.createElement("button");
  taskAdd.type = "button";
  taskAdd.className = "icon-btn";
  taskAdd.dataset.tip = t("sidebar.065");
  taskAdd.innerHTML = PLUS_SMALL_SVG;
  taskAdd.onclick = ev => { ev.stopPropagation(); startDraft(); };
  taskRow.appendChild(taskAdd);
  if (loose.length) {
    taskRow.onclick = ev => {
      if (ev.target.closest(".icon-btn")) return;   // 点 + 不触发折叠
      state.collapsedTasks = !state.collapsedTasks;
      localStorage.setItem("xc-collapsed-tasks", state.collapsedTasks ? "1" : "0");
      renderSessionList();
    };
  }
  list.appendChild(taskRow);
  if (!loose.length) {
    const e = document.createElement("div");
    e.className = "list-empty";
    e.textContent = t("sidebar.066");
    list.appendChild(e);
  } else if (taskCollapsed) {
    // 折叠态: 一行占位概要「N 个任务」, 点击同样展开
    const ph = document.createElement("div");
    ph.className = "task-collapsed-ph";
    ph.textContent = loose.length + t("sidebar.067");
    ph.onclick = () => {
      state.collapsedTasks = false;
      localStorage.setItem("xc-collapsed-tasks", "0");
      renderSessionList();
    };
    list.appendChild(ph);
  } else {
    for (const s of loose) list.appendChild(makeSessionItem(s));
  }
}

/* 归档视图排序: "created" | "updated"（持久化, 重开归档视图保留选择） */
function archiveSortMode() {
  return localStorage.getItem("xc-archive-sort") || "created";
}
function setArchiveSort(mode) {
  localStorage.setItem("xc-archive-sort", mode);
  renderSessionList();
}

/* 通用小弹层: 锚定 trigger（默认下方, 空间不足翻上方）, 点击外部关闭 */
function anchoredPop(trigger, className) {
  const pop = document.createElement("div");
  pop.className = className;
  document.body.appendChild(pop);
  const r = trigger.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
  let top = r.bottom + 6;                       // 默认向下弹（侧栏工具行）
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  const onDoc = ev => {
    // 点触发钮本体的 mousedown 不关: 让后续 click 事件走 toggle 逻辑,
    // 否则外点关闭后 click 再打开 = 再点一次弹窗不消失
    if (pop.contains(ev.target)) return;
    if (ev.target === trigger || trigger.contains(ev.target)) return;
    close();
  };
  const onKey = ev => { if (ev.key === "Escape") close(); };
  function close() {
    pop.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
  }
  document.addEventListener("mousedown", onDoc, true);
  document.addEventListener("keydown", onKey, true);
  pop.close = close;
  return pop;
}

/* 批量归档弹层: 预设 7/30/90 + 自定义天数输入, 锚定触发按钮。
 * onOpen(pop) 让调用方拿到引用, 供"再点一次关闭"的 toggle 用 */
function pickBatchDays(trigger, onOpen) {
  return new Promise(resolve => {
    const pop = anchoredPop(trigger, "dd-pop batch-pop");
    if (onOpen) onOpen(pop);
    pop.innerHTML = t("sidebar.068");
    const done = v => { pop.close(); resolve(v); };
    for (const d of [7, 30, 90]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dd-opt";
      b.textContent = d + t("sidebar.069");
      b.onclick = () => done(d);
      pop.appendChild(b);
    }
    /* 自定义: 纯选项风格的最后一档, 点开就地变行内输入 */
    const sep = document.createElement("div");
    sep.className = "dd-sep";
    pop.appendChild(sep);
    const custom = document.createElement("button");
    custom.type = "button";
    custom.className = "dd-opt";
    custom.innerHTML = '<span class="dd-ico">' + PENCIL_SMALL_SVG + '</span><span class="dd-txt"></span>';
    custom.querySelector(".dd-txt").textContent = t("sidebar.070");
    custom.onclick = () => {
      custom.style.display = "none";
      sep.style.display = "none";
      const row = document.createElement("div");
      row.className = "dd-opt plain batch-custom";
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = "1";
      inp.placeholder = t("sidebar.071");
      inp.className = "batch-days-input";
      const submit = () => {
        const v = Math.floor(Number(inp.value));
        if (v >= 1) done(v);
        else inp.focus();
      };
      inp.onkeydown = ev => {
        if (ev.key === "Enter") { ev.stopPropagation(); submit(); }
        if (ev.key === "Escape") { ev.stopPropagation(); done(null); }
      };
      row.appendChild(inp);
      pop.appendChild(row);
      setTimeout(() => inp.focus(), 0);
    };
    pop.appendChild(custom);
  });
}

function toggleProject(wd) {
  state.collapsedProjects.has(wd)
    ? state.collapsedProjects.delete(wd)
    : state.collapsedProjects.add(wd);
  localStorage.setItem("xc-collapsed", JSON.stringify([...state.collapsedProjects]));
  renderSessionList();
}
function addProject(wd) {
  if (!state.customProjects.includes(wd)) {
    state.customProjects.push(wd);
    localStorage.setItem("xc-projects", JSON.stringify(state.customProjects));
  }
  renderSessionList();
  toast(t("sidebar.072") + dirName(wd));
}

/* 移除项目: 空项目仅从侧栏消失; 有会话的项目先解绑其下会话
 * （会话保留为独立"任务", 磁盘文件不动）, 再清手动添加记录。 */
async function removeProject(wd, count) {
  const name = projectDisplayName(wd);
  if (count > 0) {
    const ok = await confirmDialog(
      t("sidebar.073", { p0: name, p1: count }),
      { title: t("sidebar.074"), okText: t("sidebar.075"), danger: true });
    if (!ok) return;
  } else {
    const ok = await confirmDialog(t("sidebar.076", { p0: name }),
      { title: t("sidebar.077"), okText: t("sidebar.078"), danger: true });
    if (!ok) return;
  }
  // 有会话的项目: 逐个解绑; 失败的（如恰在对话中）跳过并提示, 项目保留
  const sessions = state.sessions.filter(s => s.workdir === wd);
  let failed = 0;
  for (const s of sessions) {
    try {
      const r = await fetch(`/api/sessions/${s.id}/workdir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workdir: null }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || r.status);
      }
      s.workdir = null;
      const run = state.runs[s.id];
      if (run) run.currentWorkdir = null;      // 顶栏标签/恢复对话不再绑回旧目录
      if (s.id === state.sessionId) refreshWorkdirTag();
    } catch (e) {
      failed++;
      console.error("[aulos] 解绑会话失败:", s.id, e);
    }
  }
  if (failed) {
    toast(t("sidebar.079", { p0: failed }));
    return;
  }
  state.customProjects = state.customProjects.filter(w => w !== wd);
  localStorage.setItem("xc-projects", JSON.stringify(state.customProjects));
  state.collapsedProjects.delete(wd);
  localStorage.setItem("xc-collapsed", JSON.stringify([...state.collapsedProjects]));
  renderSessionList();
  toast(t("sidebar.080") + name);
}

/* 桌面端选文件夹统一入口（侧栏「添加项目」与工作区「打开文件夹…」共用）。
 * 失败不再静默: reject（ACL/IPC/桥缺失/对话框崩溃）→ console.error + toast 上屏;
 * 用户取消（桥返回 null）静默返回 null——只有真实失败才打扰用户。 */
async function pickNativeFolder() {
  try {
    return await window.aulosPickFolder();
  } catch (e) {
    console.error("[aulos] 打开文件夹失败:", e);
    toast(t("sidebar.081") + (e && e.message ? e.message : e), 4000);
    return null;
  }
}

/* 项目分组的组标题: 与顶栏 ws-tag 一致取目录名(末段), 空路径兜底 */
function projectDisplayName(wd) {
  return dirName(wd) || t("sidebar.082");
}

function markActiveSession() {
  document.querySelectorAll(".session-item").forEach(el => {
    el.classList.toggle("active", el.dataset.id === state.sessionId);
  });
}

function refreshDocTitle() {
  const cur = state.sessions.find(s => s.id === state.sessionId);
  $("doc-title").textContent = cur ? displayTitle(cur) : UNTITLED_TITLE();
  refreshWorkdirTag();
}
