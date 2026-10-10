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
  if (diff < 90) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + "分钟";
  if (diff < 86400) return Math.floor(diff / 3600) + "小时";
  if (diff < 172800) return "1天";
  if (diff < 604800) return Math.floor(diff / 86400) + "天";
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
const BUCKET_LABELS = ["今天", "昨天", "7 天内", "更早"];
const FOLDER_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>';
const PLUS_SMALL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const UNTITLED_TITLE = "未命名任务";

function displayTitle(s) {
  return (!s || s.title === "(未命名)") ? UNTITLED_TITLE : s.title;
}

async function loadSessions() {
  try {
    const r = await fetch("/api/sessions");
    const data = await r.json();
    state.sessions = data.sessions;
    renderSessionList();
  } catch (e) { console.error("加载会话列表失败", e); }
}

const TRASH_SMALL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9.5 7V5h5v2M6.5 7l1 13h9l1-13"/></svg>';
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
    toast("重命名失败: " + e.message);
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
  const unnamed = s.title === "(未命名)";
  item.className = "session-item"
    + (s.id === state.sessionId ? " active" : "")
    + (unnamed ? " unnamed" : "");
  item.dataset.id = s.id;
  item.innerHTML = '<span class="s-ico">' + sessionStateIcon(s) + '</span>'
    + '<span class="s-unread"></span>'
    + '<span class="s-plan">待批计划</span>'
    + '<span class="title"></span><span class="meta"></span>'
    + '<div class="s-snippet"></div>'
    + '<button class="s-ren" data-tip="重命名">' + PENCIL_SMALL_SVG + '</button>'
    + '<button class="s-del" data-tip="删除会话">' + TRASH_SMALL_SVG + '</button>';
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
    tag.textContent = "正文";
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
  item.querySelector(".s-ren").onclick = ev => {
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
  item.querySelector(".s-del").onclick = ev => {
    ev.stopPropagation();
    deleteSession(s.id);
  };
  return item;
}

async function deleteSession(id) {
  const run = state.runs[id];
  if (run && run.busy) {
    toast("该会话本轮对话进行中，暂不能删除");
    return;
  }
  const cur = state.sessions.find(s => s.id === id);
  if (!await confirmDialog(`删除会话「${displayTitle(cur)}」？删除后不可恢复。`,
      { title: "删除会话", okText: "删除", danger: true })) return;
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
    toast("会话已删除");
  } catch (e) {
    toast("删除失败: " + e.message);
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
  const sessions = state.sessions.filter(
    s => s.id !== petSid
      && (!q
        || (s.title || "").toLowerCase().includes(q)
        || (s.workdir || "").toLowerCase().includes(q)));
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
    e.textContent = "标题和正文都没有匹配的会话";
    list.appendChild(e);
    return;
  }
  const addLabel = text => {
    const l = document.createElement("div");
    l.className = "list-label";
    l.textContent = text;
    list.appendChild(l);
  };
  if (state.sideTab === "group") {
    if (!sessions.length) {
      list.innerHTML = '<div class="list-empty">' + (q ? "没有匹配的会话" : "还没有会话") + "</div>";
      return;
    }
    // 会话按时间倒序，分组标签自然按 今天→更早 顺序出现
    let bucket = -1;
    for (const s of sessions) {
      const b = sessionBucket(s.id);
      if (b !== bucket) { bucket = b; addLabel(BUCKET_LABELS[b]); }
      list.appendChild(makeSessionItem(s));
    }
    return;
  }

  /* ---- 项目视图: 可折叠项目组 + 任务(未选择文件夹的会话) ---- */
  const headRow = document.createElement("div");
  headRow.className = "list-label-row";
  headRow.innerHTML = '<span class="list-label">项目</span>';
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "icon-btn";
  addBtn.id = "btn-add-project";
  addBtn.dataset.tip = "添加项目";
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
    e.textContent = q ? "没有匹配的会话" : "还没有项目，点上方 + 添加";
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
      + '<button class="p-add" data-tip="在此项目新建任务">' + PLUS_SMALL_SVG + '</button>'
      + '<button class="p-del" data-tip="移除项目">' + TRASH_SMALL_SVG + '</button>'
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
  const taskRow = document.createElement("div");
  taskRow.className = "list-label-row";
  taskRow.innerHTML = '<span class="list-label">任务</span>';
  const taskAdd = document.createElement("button");
  taskAdd.type = "button";
  taskAdd.className = "icon-btn";
  taskAdd.dataset.tip = "新建任务";
  taskAdd.innerHTML = PLUS_SMALL_SVG;
  taskAdd.onclick = ev => { ev.stopPropagation(); startDraft(); };
  taskRow.appendChild(taskAdd);
  list.appendChild(taskRow);
  const loose = sessions.filter(s => !s.workdir);
  if (!loose.length) {
    const e = document.createElement("div");
    e.className = "list-empty";
    e.textContent = "还没有任务";
    list.appendChild(e);
  } else {
    for (const s of loose) list.appendChild(makeSessionItem(s));
  }
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
  toast("已添加项目：" + dirName(wd));
}

/* 移除项目: 空项目仅从侧栏消失; 有会话的项目先解绑其下会话
 * （会话保留为独立"任务", 磁盘文件不动）, 再清手动添加记录。 */
async function removeProject(wd, count) {
  const name = projectDisplayName(wd);
  if (count > 0) {
    const ok = await confirmDialog(
      `移除项目「${name}」？其下 ${count} 个会话将保留为独立任务（不删除）, 磁盘文件不受影响。`,
      { title: "移除项目", okText: "移除", danger: true });
    if (!ok) return;
  } else {
    const ok = await confirmDialog(`移除项目「${name}」？仅从侧栏移除, 不影响磁盘文件。`,
      { title: "移除项目", okText: "移除", danger: true });
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
    toast(`${failed} 个会话解绑失败（可能对话进行中）, 项目保留`);
    return;
  }
  state.customProjects = state.customProjects.filter(w => w !== wd);
  localStorage.setItem("xc-projects", JSON.stringify(state.customProjects));
  state.collapsedProjects.delete(wd);
  localStorage.setItem("xc-collapsed", JSON.stringify([...state.collapsedProjects]));
  renderSessionList();
  toast("已移除项目：" + name);
}

/* 桌面端选文件夹统一入口（侧栏「添加项目」与工作区「打开文件夹…」共用）。
 * 失败不再静默: reject（ACL/IPC/桥缺失/对话框崩溃）→ console.error + toast 上屏;
 * 用户取消（桥返回 null）静默返回 null——只有真实失败才打扰用户。 */
async function pickNativeFolder() {
  try {
    return await window.aulosPickFolder();
  } catch (e) {
    console.error("[aulos] 打开文件夹失败:", e);
    toast("打开文件夹失败：" + (e && e.message ? e.message : e), 4000);
    return null;
  }
}

/* 项目分组的组标题: 与顶栏 ws-tag 一致取目录名(末段), 空路径兜底 */
function projectDisplayName(wd) {
  return dirName(wd) || "未设置项目";
}

function markActiveSession() {
  document.querySelectorAll(".session-item").forEach(el => {
    el.classList.toggle("active", el.dataset.id === state.sessionId);
  });
}

function refreshDocTitle() {
  const cur = state.sessions.find(s => s.id === state.sessionId);
  $("doc-title").textContent = cur ? displayTitle(cur) : UNTITLED_TITLE;
  refreshWorkdirTag();
}
