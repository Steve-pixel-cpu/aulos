/* ============================================================
 * msg-extras.js — 消息区周边交互: 滚动跟随 · minimap · 斜杠补全 · 划词工具条
 *
 * 从 app.js 外迁的功能域 (拆分路线见 README「代码组织与拆分路线」)。
 * 经典脚本, 由 index.html 在 app.js 之后 defer 加载:
 *   - scrollToBottom / scrollToBottomIfNear 等被核心渲染链路调用,
 *     运行时解引用, 加载序安全;
 *   - minimap 零外部函数依赖 (自带 rebuild/update/fountain);
 *   - 斜杠补全只读 state + 输入框, 接受后写回 input;
 *   - 划词工具条只依赖 DESKTOP 判定与选区 API。
 *
 * 读的前置全局: state / $ / DESKTOP / curRun / autoGrow / saveCurrentInput /
 *               updateSendBtn / refreshSkillCache 数据 (state.skillCache)
 * 暴露的全局:   scrollToBottom / updateMsgThumb / mmScheduleRebuild /
 *               mmRebuild / mmUpdateActive / skillMenuDestroy / hideSelBar
 * ============================================================ */
/* ============================================================
 * 滚动: 贴底自动跟随; 用户上翻时不拽人, 悬浮钮一键回底
 * ============================================================ */
let nearBottom = true;
$("messages").addEventListener("scroll", () => {
  const el = $("messages");
  nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  $("scroll-btn").classList.toggle("show", !nearBottom);
  updateMsgThumb();
  mmUpdateActive();
});
$("scroll-btn").onclick = () => {
  nearBottom = true;
  $("messages").scrollTo({ top: $("messages").scrollHeight, behavior: "smooth" });
};
function scrollToBottom(force) {
  if (!force && !nearBottom) return;
  const el = $("messages");
  el.scrollTop = el.scrollHeight;
}

/* ---------- 自绘固定长度滚动条(消息区) ----------
 * 原生滑块长度随内容比例缩放, 无法恒定; 这里隐藏原生条,
 * 滑块固定 64px, 位置按滚动比例映射。拖拽/点轨道反算 scrollTop。 */
const MSG_THUMB_H = 64;
const msgThumb = $("msg-scrollbar");
const msgThumbBar = msgThumb.querySelector(".thumb");

function updateMsgThumb() {
  const el = $("messages");
  const sh = el.scrollHeight, ch = el.clientHeight;
  if (sh - ch <= 2) { msgThumb.hidden = true; return; }   // 不可滚动
  msgThumb.hidden = false;
  /* 轨道与消息区盒子对齐(上下有文档头/输入卡, 不能直接铺满 pane) */
  msgThumb.style.top = el.offsetTop + "px";
  msgThumb.style.height = el.clientHeight + "px";
  const track = msgThumb.clientHeight - MSG_THUMB_H;      // 可移动范围(轨道高-滑块长)
  const max = sh - ch;
  const top = el.scrollTop >= max - 2 ? track             // 贴底判定: 完整显示
    : Math.min(track, Math.round(el.scrollTop / max * track));
  msgThumbBar.style.top = top + "px";
}

/* 内容尺寸变化(流式输出/切会话/窗口变化)时同步滑块 */
new ResizeObserver(() => { updateMsgThumb(); mmScheduleRebuild(); }).observe($("messages"));
window.addEventListener("resize", updateMsgThumb);

/* 拖拽滑块: 按位移比例反算 scrollTop */
msgThumbBar.addEventListener("pointerdown", ev => {
  ev.preventDefault();
  msgThumb.classList.add("dragging");
  msgThumbBar.setPointerCapture(ev.pointerId);
  const el = $("messages");
  const startY = ev.clientY;
  const startScroll = el.scrollTop;
  const track = msgThumb.clientHeight - MSG_THUMB_H;
  const max = el.scrollHeight - el.clientHeight;
  const onMove = e2 => {
    if (track <= 0 || max <= 0) return;
    el.scrollTop = startScroll + (e2.clientY - startY) / track * max;
  };
  const onUp = () => {
    msgThumb.classList.remove("dragging");
    msgThumbBar.removeEventListener("pointermove", onMove);
    msgThumbBar.removeEventListener("pointerup", onUp);
  };
  msgThumbBar.addEventListener("pointermove", onMove);
  msgThumbBar.addEventListener("pointerup", onUp);
});

/* 点击轨道空白: 跳到对应位置(与原生行为一致) */
msgThumb.addEventListener("pointerdown", ev => {
  if (ev.target === msgThumbBar) return;   // 滑块自身走拖拽
  const el = $("messages");
  const track = msgThumb.clientHeight - MSG_THUMB_H;
  const max = el.scrollHeight - el.clientHeight;
  if (track <= 0 || max <= 0) return;
  const y = ev.clientY - msgThumb.getBoundingClientRect().top - MSG_THUMB_H / 2;
  el.scrollTop = Math.max(0, Math.min(track, y)) / track * max;
});

/* ============================================================
 * minimap: 用户消息快速定位
 * 右缘一列刻度, 每条用户消息一个; 固定间距排成一簇、整簇在轨道
 * 垂直居中(消息多到放不下时才摊满整条轨道)。
 * 悬停刻度弹预览卡(摘要 + 相对时间), 点击平滑滚动定位;
 * 滚动时高亮视口中线以上最近的一条。数据源是 addUserBubble
 * 挂在行元素上的 _text/_ts, 无需额外后端结构。
 * ============================================================ */
const mm = $("msg-minimap");
const mmPop = $("mm-pop");
let mmTimer = null;

function mmScheduleRebuild() {
  clearTimeout(mmTimer);
  mmTimer = setTimeout(mmRebuild, 150);
}

function mmRebuild() {
  const el = $("messages");
  mmPop.hidden = true;
  mm.textContent = "";
  // 只收集当前可见会话列的用户气泡: #messages 下常驻着每个会话一个的
  // .msg-col（切会话仅显隐、不销毁）, 若全局 querySelectorAll 会把隐藏
  // 会话的气泡一并收进来——display:none 行的 offsetTop 恒为 0, 刻度全部
  // 堆到轨道顶部并连锁挤乱本会话刻度, 预览/跳转也会指到别的会话。
  const col = el.querySelector(".msg-col.on");
  const rows = col ? [...col.querySelectorAll(".msg.user")] : [];
  const scrollable = el.scrollHeight - el.clientHeight > 2;
  if (!rows.length || !scrollable) { mm.hidden = true; return; }
  mm.hidden = false;
  // 轨道按消息区可视范围垂直居中: 高度收窄到 70%, 上下各留 15%
  const trackH = Math.round(el.clientHeight * 0.7);
  mm.style.top = el.offsetTop + Math.round((el.clientHeight - trackH) / 2) + "px";
  mm.style.height = trackH + "px";
  const H = mm.clientHeight;
  const frag = document.createDocumentFragment();
  // 固定间距排成一簇、整簇垂直居中; 超过轨道容纳量时退化为等距摊满。
  const step = 10;
  const span = (rows.length - 1) * step;
  const gap = rows.length > 1
    ? (span < H ? step : H / (rows.length - 1))
    : 0;
  const top0 = rows.length > 1 ? (H - (rows.length - 1) * gap) / 2 : H / 2;
  rows.forEach((row, i) => {
    const tick = document.createElement("button");
    tick.className = "mm-tick";
    tick.type = "button";
    tick.style.top = (top0 + i * gap) + "px";
    tick._row = row;
    tick._text = mmSummary(row);
    tick._time = mmRelTime(row._ts);
    frag.appendChild(tick);
  });
  mm.appendChild(frag);
  mmUpdateActive();
}

function mmSummary(row) {
  const text = (row._text || "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 140 ? text.slice(0, 140) + "…" : text;
  if (row.querySelector(".u-imgs")) return "[图片]";
  if (row.querySelector(".file-chip")) return "[文件]";
  return "[消息]";
}

function mmRelTime(ts) {
  const t = ts ? new Date(ts) : null;
  if (!t || isNaN(t)) return "";
  const diff = (Date.now() - t.getTime()) / 1000;
  if (diff < 90) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + "分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + "小时前";
  if (diff < 172800) return "1天前";
  if (diff < 604800) return Math.floor(diff / 86400) + "天前";
  return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
}

/* 激活态: 视口中线以上最近的一条用户消息 */
function mmUpdateActive() {
  if (mm.hidden) return;
  const el = $("messages");
  const mid = el.scrollTop + el.clientHeight / 2;
  let best = null;
  for (const tick of mm.children) {
    if (tick._row && tick._row.offsetTop <= mid) best = tick;
  }
  for (const tick of mm.children) tick.classList.toggle("active", tick === best);
}

/* 刻度交互: 悬停出预览卡(刻度右侧, 视口内钳位), 点击平滑定位;
 * 喷泉波纹: 以指针所指刻度为中心, 向上下两侧递减拉长——
 * 展开量随 |i - h| 每远 1 个刻度衰减 1/3, 3 档外归零;
 * 复位用 removeProperty(不能写内联 0, 会盖掉 .active 的类规则 --f:1) */
const mmText = mmPop.querySelector(".mm-text");
const mmTime = mmPop.querySelector(".mm-time");
function mmFountain(hoverIdx) {
  [...mm.children].forEach((t, i) => {
    if (hoverIdx == null) {
      t.style.removeProperty("--f");
      return;
    }
    const f = Math.max(0, 1 - Math.abs(i - hoverIdx) / 3);
    t.style.setProperty("--f", f.toFixed(3));
  });
}
function mmTickFromEvent(e) {
  const r = mm.getBoundingClientRect();
  const y = e.clientY - r.top;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < mm.children.length; i++) {
    const d = Math.abs(parseFloat(mm.children[i].style.top) - y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD <= 12 ? best : null;   // 稍微离轨也认, 出范围即收回
}
/* 预览卡延迟弹出: 停留 250ms 才显示, 划过不闪卡; 波纹始终实时跟随。
 * 时序关键: "已显示这条"的早退必须在 clearTimeout 之前——卡可见只说明
 * 显示着上一条的内容, 此时往往还有一条指向新刻度的定时器挂起; 若先
 * clear 再早退会把它误杀, 卡片内容就永远停在上一条, 直到鼠标离开重进 */
let mmPopTimer = null, mmPopIdx = null;
function mmPopArm(idx) {
  if (idx == null) {
    clearTimeout(mmPopTimer);
    mmPopIdx = null;
    mmPop.hidden = true;
    return;
  }
  if (idx === mmPopIdx && !mmPop.hidden) return;   // 已显示/已挂起这条: 不动定时器
  clearTimeout(mmPopTimer);
  mmPopIdx = idx;
  mmPopTimer = setTimeout(() => {
    const tick = mm.children[mmPopIdx];
    if (!tick) return;
    mmText.textContent = tick._text || "";
    mmTime.textContent = tick._time || "";
    mmPop.hidden = false;
    const r = tick.getBoundingClientRect();
    const pr = mmPop.getBoundingClientRect();
    let top = r.top + r.height / 2 - pr.height / 2;
    top = Math.max(8, Math.min(window.innerHeight - pr.height - 8, top));
    mmPop.style.top = top + "px";
    mmPop.style.left = (r.right + 12) + "px";
  }, 250);
}
mm.addEventListener("pointermove", e => {
  if (mm.hidden) return;
  const idx = mmTickFromEvent(e);
  mmFountain(idx);
  mmPopArm(idx);
});
mm.addEventListener("pointerleave", () => {
  mmFountain(null);
  clearTimeout(mmPopTimer);
  mmPopIdx = null;
  mmPop.hidden = true;
});
mm.addEventListener("pointerdown", e => {
  // 点击走就近吸附判定(与 hover 同源): 刻度只有 2px 高, e.target 精确
  // 命中率太低; 12px 吸附半径内都算点到, 也与当前波纹所指保持一致
  const idx = mmTickFromEvent(e);
  const tick = idx != null ? mm.children[idx] : null;
  if (!tick || !tick._row) return;
  const row = tick._row;
  $("messages").scrollTo({
    top: Math.max(0, row.offsetTop - $("messages").clientHeight / 2 + row.offsetHeight / 2),
    behavior: "smooth",
  });
});

/* ============================================================
 * 斜杠技能补全: 输入 /xx 时在输入卡上方列出匹配技能, 键盘/鼠标选用。
 * 仅当整段输入是 " /词 "（命令是消息的第一个词）时出现; 出现空格+正文即隐藏。
 * 数据源 = 当前工作目录的技能清单（安装/卸载/切会话时刷新）。
 * ============================================================ */
let skillCacheDir = null;      // skillCache 对应的工作目录（变了才重新拉取）
async function refreshSkillCache() {
  // 草稿 → 预选项目; 会话 → 其工作目录（历史接口给出）。无目录 = 服务 cwd。
  const wd = state.draft ? state.draftDir
    : (curRun() ? curRun().currentWorkdir : null);
  if (skillCacheDir === (wd || "") && state.skillCache) return state.skillCache;
  skillCacheDir = wd || "";
  try {
    const q = wd ? "?workdir=" + encodeURIComponent(wd) : "";
    const r = await fetch("/api/skills" + q);
    state.skillCache = r.ok ? (await r.json()).skills || [] : [];
  } catch (e) {
    state.skillCache = [];
  }
  return state.skillCache;
}

const skillMenu = {
  el: null,
  items: [],      // [{ name, desc, source }]
  idx: -1,        // 键盘高亮项
  empty: false,   // true = "暂无技能" 提示态（不可选）
};
const SLASH_MENU_MAX = 8;

function skillMenuDestroy() {
  if (skillMenu.el) { skillMenu.el.remove(); skillMenu.el = null; }
  skillMenu.items = [];
  skillMenu.idx = -1;
  skillMenu.empty = false;
}

function skillMenuHighlight() {
  if (!skillMenu.el) return;
  skillMenu.el.querySelectorAll(".sk-opt").forEach((o, i) => {
    o.classList.toggle("on", i === skillMenu.idx);
  });
  const on = skillMenu.el.querySelectorAll(".sk-opt")[skillMenu.idx];
  if (on) on.scrollIntoView({ block: "nearest" });
}

function skillMenuRender(query) {
  const q = (query || "").toLowerCase();
  const all = state.skillCache || [];
  const hits = q ? all.filter(s => s.name.toLowerCase().startsWith(q)) : all;
  skillMenu.items = hits.slice(0, SLASH_MENU_MAX);
  if (!skillMenu.items.length) { skillMenuDestroy(); return; }

  const first = !skillMenu.el;
  if (first) {
    skillMenu.el = document.createElement("div");
    skillMenu.el.id = "skill-menu";
    $("input-card").appendChild(skillMenu.el);   // 输入卡是定位父级, 菜单贴其上沿
  }
  skillMenu.el.innerHTML = skillMenu.items.map((s, i) =>
    '<button type="button" class="sk-opt' + (i === skillMenu.idx ? " on" : "") + '" data-i="' + i + '">'
    + '<span class="sk-name">/' + escapeHtml(s.name) + '</span>'
    + '<span class="sk-src">' + (s.source === "project" ? "项目级" : "用户级") + '</span>'
    + (s.description ? '<span class="sk-desc"></span>' : '')
    + "</button>"
  ).join("") + '<div class="sk-hint">↑↓ 选择 · Enter/Tab 补全 · Esc 关闭</div>';
  const descEl = skillMenu.el.querySelectorAll(".sk-desc");
  skillMenu.items.forEach((s, i) => {
    if (s.description && descEl[i]) descEl[i].textContent = s.description;
    const btn = skillMenu.el.querySelector(`.sk-opt[data-i="${i}"]`);
    btn.onclick = () => skillMenuAccept(i);
    btn.onmouseenter = () => { skillMenu.idx = i; skillMenuHighlight(); };
  });
}

function skillMenuUpdate() {
  const v = $("input").value;
  const m = /^\/([A-Za-z0-9_-]*)$/.exec(v);   // 整段输入恰为一个 /词 才弹
  if (!m) { skillMenuDestroy(); return; }
  refreshSkillCache().then(() => {
    // 拉取期间输入可能已变, 以当前值为准再判一次
    const cur = /^\/([A-Za-z0-9_-]*)$/.exec($("input").value);
    if (!cur) { skillMenuDestroy(); return; }
    const all = state.skillCache || [];
    if (!all.length) {
      // 无技能: 提示去哪里装, 不可选
      if (!skillMenu.el) {
        skillMenu.el = document.createElement("div");
        skillMenu.el.id = "skill-menu";
        $("input-card").appendChild(skillMenu.el);
      }
      skillMenu.el.innerHTML = '<div class="sk-none">暂无技能 — 到 设置 → Skills 从 GitHub 仓库安装</div>';
      skillMenu.items = [];
      skillMenu.idx = -1;
      skillMenu.empty = true;
      return;
    }
    skillMenu.empty = false;
    skillMenu.idx = 0;
    skillMenuRender(cur[1]);
  });
}

function skillMenuAccept(i) {
  const it = skillMenu.items[i];
  if (!it) return;
  $("input").value = "/" + it.name + " ";
  autoGrow($("input"));
  saveCurrentInput();
  skillMenuDestroy();
  $("input").focus();
}

function skillMenuActive() {
  return !!(skillMenu.el && skillMenu.items.length);
}

/* 键盘接管: 菜单开着时 ↑↓ 移动高亮, Enter/Tab 选用（Enter 不发送）, Esc 关闭 */
$("input").addEventListener("keydown", ev => {
  if (!skillMenuActive()) return;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const n = skillMenu.items.length;
    skillMenu.idx = ev.key === "ArrowDown"
      ? (skillMenu.idx + 1) % n : (skillMenu.idx - 1 + n) % n;
    skillMenuHighlight();
  } else if (ev.key === "Enter" || ev.key === "Tab") {
    ev.preventDefault();
    skillMenuAccept(skillMenu.idx);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();   // 只关菜单, 别顺带触发全局 Esc 逻辑
    skillMenuDestroy();
  }
});
document.addEventListener("click", ev => {
  // 点击输入卡以外区域关闭（点击候选项走自身的 onclick, 不经过这里）
  if (skillMenu.el && !skillMenu.el.contains(ev.target)
      && ev.target !== $("input")) skillMenuDestroy();
});

/* ---------- 附件入口 1: 📎 按钮 + 隐藏文件选择框 ---------- */
$("btn-attach").onclick = () => $("file-input").click();
$("file-input").addEventListener("change", () => {
  addFiles($("file-input").files);
  $("file-input").value = "";   // 允许重复选择同一文件
});

/* ---------- 附件入口 2: 拖拽到输入卡（dragover 高亮 + drop） ---------- */
const inputCard = $("input-card");
inputCard.addEventListener("dragover", ev => {
  ev.preventDefault();
  inputCard.classList.add("dragging");
});
inputCard.addEventListener("dragleave", () => inputCard.classList.remove("dragging"));
inputCard.addEventListener("drop", ev => {
  ev.preventDefault();
  inputCard.classList.remove("dragging");
  if (ev.dataTransfer && ev.dataTransfer.files.length) addFiles(ev.dataTransfer.files);
});

/* ---------- 附件入口 3: 粘贴剪贴板里的图片 ---------- */
$("input").addEventListener("paste", ev => {
  const files = ev.clipboardData && ev.clipboardData.files;
  if (files && files.length) {
    ev.preventDefault();
    addFiles(files);
  }
});

/* ============================================================
 * 划词工具条: 选中聊天文本后浮出
 *   添加到当前任务 → 选中文本预填进当前会话输入框
 *   复制仍走浏览器原生: 选中后右键"复制"或 Ctrl+C
 * ============================================================ */
const selBar = document.createElement("div");
selBar.className = "sel-bar";
selBar.innerHTML = '<button type="button" data-act="task">添加到当前任务</button>';
selBar.style.display = "none";
document.body.appendChild(selBar);

function hideSelBar() { selBar.style.display = "none"; }
function selectionInMessages() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  if (!$("messages").contains(sel.getRangeAt(0).commonAncestorContainer)) return "";
  return sel.toString().trim();
}
function moveSelBar() {
  const text = selectionInMessages();
  if (!text) { hideSelBar(); return; }
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) { hideSelBar(); return; }
  selBar.style.display = "flex";
  const bw = selBar.offsetWidth, bh = selBar.offsetHeight;
  let left = rect.left + rect.width / 2 - bw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  let top = rect.top - bh - 8;              // 默认浮在选区上方
  if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - bh - 8);
  selBar.style.left = left + "px";
  selBar.style.top = top + "px";
}
document.addEventListener("selectionchange", () => {
  clearTimeout(moveSelBar._t);
  moveSelBar._t = setTimeout(moveSelBar, 120);   // 拖选过程轻微防抖
});
window.addEventListener("scroll", hideSelBar, true);
window.addEventListener("resize", hideSelBar);
selBar.addEventListener("mousedown", ev => ev.preventDefault());   // 点击按钮不丢选区
selBar.addEventListener("click", ev => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  const text = selectionInMessages();
  hideSelBar();
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  if (!text) return;
  $("input").value = text;
  autoGrow($("input"));
  updateSendBtn();
  $("input").focus();
});

/* ---------- 右键菜单兜底: 选中文字后右键 → "复制" ---------- */
/* Electron 里由主进程弹原生菜单（userAgent 含 Electron 时跳过）,
   普通浏览器/内嵌预览没有原生菜单, 用这个页面内菜单兜底 */
const ctxMenu = document.createElement("div");
ctxMenu.className = "ctx-menu";
ctxMenu.innerHTML = '<button type="button" data-act="copy">复制</button>';
ctxMenu.style.display = "none";
document.body.appendChild(ctxMenu);
function hideCtxMenu() { ctxMenu.style.display = "none"; }
document.addEventListener("contextmenu", ev => {
  hideCtxMenu();
  if (DESKTOP) return;   // 桌面端: 自建右键菜单已挂, 浏览器版弹层不用
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0
      || !$("messages").contains(sel.getRangeAt(0).commonAncestorContainer)) {
    return;   // 没有聊天区选区: 走浏览器默认菜单（输入框的粘贴等）
  }
  ev.preventDefault();
  hideSelBar();
  ctxMenu.style.display = "block";
  ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - 140) + "px";
  ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - 50) + "px";
});
ctxMenu.addEventListener("mousedown", e => e.preventDefault());   // 不丢选区
ctxMenu.addEventListener("click", ev => {
  const btn = ev.target.closest("button[data-act='copy']");
  if (!btn) return;
  const sel = window.getSelection();
  const text = sel ? sel.toString() : "";
  hideCtxMenu();
  if (sel) sel.removeAllRanges();
  copyText(text).then(ok => toast(ok ? "已复制" : "复制失败"));
});
window.addEventListener("scroll", hideCtxMenu, true);
document.addEventListener("click", ev => {
  if (!ctxMenu.contains(ev.target)) hideCtxMenu();
});
