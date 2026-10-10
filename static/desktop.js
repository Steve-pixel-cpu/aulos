/* ============================================================
 * desktop.js — 桌面壳专属: 自绘标题栏 / 右键菜单 / 自动更新 / 侧栏拖宽
 *
 * 从 app.js 外迁的功能域 (拆分路线见 README「代码组织与拆分路线」)。
 * 经典脚本, 与 app.js 共享全局作用域; 由 index.html 在 app.js 之后
 * defer 加载——四个块都在加载期自执行 (绑 DOM/挂监听), 依赖 app.js
 * 已就绪的 $ / DESKTOP / toast / escapeHtml / state。
 * 浏览器形态 (DESKTOP=false): 标题栏/右键菜单/更新检查整体跳过,
 * 仅侧栏拖宽生效 (纯 DOM 能力, 无壳依赖)。
 *
 * 读的前置全局: $ / DESKTOP / state / toast / escapeHtml (app.js/ui-dialogs.js)
 *               window.aulosDesktopUpdater / window.__TAURI_INTERNALS__ (壳注入)
 * 暴露的全局:   checkForUpdates / initUpdateCheck / applyColWidth (测试用)
 * ============================================================ */
/* ============================================================
 * 侧栏拖拽调宽: 左会话栏(--side-w) / 右计划面板(--plan-w)
 * 拖边实时改 CSS 变量, 松手存 localStorage, 双击手柄复位默认值
 * ============================================================ */
const SIDE_W = { min: 200, max: 480, reserve: 420, key: "xc-side-w", prop: "--side-w" };
const PLAN_W = { min: 300, max: 720, reserve: 420, key: "xc-plan-w", prop: "--plan-w" };

function applyColWidth(pref, px) {
  const clamped = Math.max(pref.min,
    Math.min(px, pref.max, window.innerWidth - pref.reserve));
  document.documentElement.style.setProperty(pref.prop, Math.round(clamped) + "px");
  return Math.round(clamped);
}
function restoreColWidth(pref) {
  const saved = Number(localStorage.getItem(pref.key));
  if (saved >= pref.min) {
    document.documentElement.style.setProperty(pref.prop, saved + "px");
  }
}
function attachColResize(handle, panel, pref, dir) {
  if (!handle || !panel) return;   // loading 页等无此结构
  handle.addEventListener("dblclick", () => {
    localStorage.removeItem(pref.key);
    document.documentElement.style.removeProperty(pref.prop);
  });
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    handle.classList.add("dragging");
    document.body.classList.add("col-resizing");
    const move = (ev) =>
      applyColWidth(pref, startW + (ev.clientX - startX) * dir);
    const up = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      localStorage.setItem(pref.key, String(
        panel.getBoundingClientRect().width));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}
restoreColWidth(SIDE_W);
restoreColWidth(PLAN_W);
attachColResize($("side-resize"), $("sidebar"), SIDE_W, +1);
attachColResize($("plan-resize"), $("plan-panel"), PLAN_W, -1);

/* ============================================================
 * 自动更新（仅桌面壳, 经 window.aulosDesktopUpdater 桥调 Rust 命令）:
 *  - 启动后静默检查一次（check_update）; 发现新版本 → 版本徽标加红点 + toast 提示
 *  - 点标题栏版本徽标 = 有更新则打开更新弹窗, 无更新则手动检查一次
 *  - 立即更新 → install_update, 前端 300ms 轮询 update_status 画进度条;
 *    下载完自动拉起 NSIS 安装器（passive）, 壳重启到新版本
 * 失败可见性: 手动检查失败必提示; 启动静默检查失败不弹（可能只是没网）。
 * ============================================================ */
const UPD = {
  checking: false,
  info: null,        // check_update 返回 { hasUpdate, currentVersion, version, notes }
  pollTimer: null,
};

function fmtMB(n) {
  if (!n) return "?";
  return (n / 1048576).toFixed(1) + " MB";
}

function updateBadgeMark(on, verText) {
  const badge = $("tb-version");
  if (!badge) return;
  badge.classList.toggle("up", !!on);
  badge.title = on ? `发现新版本 v${verText}, 点击更新` : "检查更新";
}

async function checkForUpdates(manual = false) {
  if (!window.aulosDesktopUpdater || UPD.checking) return null;
  UPD.checking = true;
  try {
    const info = await window.aulosDesktopUpdater.check();
    UPD.info = info;
    if (info && info.hasUpdate) {
      updateBadgeMark(true, info.version);
      if (manual) openUpdateDialog();
      else toast(`发现新版本 v${info.version}, 点击标题栏版本号更新`, 3600);
    } else {
      updateBadgeMark(false);
      if (manual) toast(`已是最新版本（v${info.currentVersion}）`);
    }
    return info;
  } catch (e) {
    if (manual) toast("检查更新失败: " + (e?.message || e));
    return null;
  } finally {
    UPD.checking = false;
  }
}

function initUpdateCheck() {
  if (!window.aulosDesktopUpdater) return;   // 浏览器/源码运行: 无壳
  const badge = $("tb-version");
  if (badge) badge.addEventListener("click", () => {
    if (UPD.info && UPD.info.hasUpdate) openUpdateDialog();
    else checkForUpdates(true);
  });
  checkForUpdates(false);   // 启动静默检查
}

function openUpdateDialog() {
  const info = UPD.info;
  if (!info || !info.hasUpdate || $("update-overlay")) return;
  const ov = document.createElement("div");
  ov.id = "update-overlay";
  ov.style.display = "flex";
  ov.innerHTML =
    '<div id="update-modal" role="alertdialog" aria-modal="true">' +
      '<div id="update-title">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg>' +
        '<span>发现新版本</span>' +
      '</div>' +
      '<div id="update-versions">v' + escapeHtml(info.currentVersion || "?") +
        ' <span class="upd-arrow">→</span> v' + escapeHtml(info.version || "?") + '</div>' +
      '<div id="update-notes">' + (info.notes ? escapeHtml(info.notes) : "") + '</div>' +
      '<div id="update-progress" hidden><div id="update-progress-bar"></div></div>' +
      '<div id="update-status-text"></div>' +
      '<div id="update-actions">' +
        '<button type="button" data-act="cancel">以后再说</button>' +
        '<button type="button" data-act="ok">立即更新</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  const onEsc = e => {
    // 下载中不允许关（Rust 侧无取消接口, 关了下载还在跑只会更困惑）
    if (e.key === "Escape" && !ov.dataset.busy) closeUpdateDialog(ov);
  };
  ov._onEsc = onEsc;
  document.addEventListener("keydown", onEsc);
  ov.addEventListener("mousedown", e => { if (e.target === ov && !ov.dataset.busy) closeUpdateDialog(ov); });
  ov.querySelector("[data-act='cancel']").onclick = () => { if (!ov.dataset.busy) closeUpdateDialog(ov); };
  ov.querySelector("[data-act='ok']").onclick = () => startUpdateInstall(ov);
  ov.querySelector("[data-act='ok']").focus();
}

function closeUpdateDialog(ov) {
  if (UPD.pollTimer) { clearInterval(UPD.pollTimer); UPD.pollTimer = null; }
  document.removeEventListener("keydown", ov._onEsc || (() => {}));
  ov.remove();
}

function updateInstallFail(ov, msg) {
  if (UPD.pollTimer) { clearInterval(UPD.pollTimer); UPD.pollTimer = null; }
  delete ov.dataset.busy;
  const st = ov.querySelector("#update-status-text");
  st.textContent = "更新失败: " + msg;
  st.classList.add("upd-err");
  // 允许关掉重试（下次点徽标重新检查）
  const actions = ov.querySelector("#update-actions");
  actions.hidden = false;
  actions.querySelector("[data-act='ok']").hidden = true;
  actions.querySelector("[data-act='cancel']").textContent = "关闭";
}

async function startUpdateInstall(ov) {
  const bar = ov.querySelector("#update-progress");
  const fill = ov.querySelector("#update-progress-bar");
  const status = ov.querySelector("#update-status-text");
  const actions = ov.querySelector("#update-actions");
  actions.hidden = true;          // 下载不可取消, 也不许 ESC/点遮罩关
  bar.hidden = false;
  ov.dataset.busy = "1";
  try {
    await window.aulosDesktopUpdater.install();
  } catch (e) {
    return updateInstallFail(ov, (e?.message || e) || "无法启动下载");
  }
  // install_update 立即返回（Rust 侧异步任务在跑）, 进度靠轮询
  UPD.pollTimer = setInterval(async () => {
    let st;
    try { st = await window.aulosDesktopUpdater.status(); } catch (_) { return; }
    if (st.phase === 3) return updateInstallFail(ov, "下载或安装出错（详见 ~/.aulos/boot.log）");
    if (st.phase === 2) {
      fill.style.width = "100%";
      status.textContent = "下载完成, 正在启动安装程序…";
      return;
    }
    if (st.total > 0) {
      const pct = Math.min(100, Math.round((st.received / st.total) * 100));
      fill.style.width = pct + "%";
      status.textContent = `下载中 ${pct}%（${fmtMB(st.received)} / ${fmtMB(st.total)}）`;
    } else {
      status.textContent = "正在连接更新服务器…";
    }
  }, 300);
}

/* ============================================================
 * 桌面端右键菜单 — 复制/粘贴, 只显示当前可用的项:
 * 有选中文字 → 复制; 右键输入框/可编辑区 → 粘贴; 都没有 → 不弹。
 * 自注册 contextmenu 监听（松开右键时触发, 与原生菜单同时机）:
 * Electron 壳无原生右键菜单, preventDefault 只是拦掉默认行为作双保险。
 * 复制走 execCommand（复制用户当前选区, 无需剪贴板写权限）;
 * 粘贴经 preload 桥在主进程读系统剪贴板, insertText 走编辑
 * 命令栈——可撤销, 且正常触发 input 事件。
 * ============================================================ */
function closeCtxMenu() {
  const pop = $("ctx-pop");
  if (pop) pop.remove();
  document.removeEventListener("mousedown", onCtxAway, true);
  document.removeEventListener("keydown", onCtxEsc, true);
}
function onCtxAway(e) {
  if (!e.target.closest || !e.target.closest("#ctx-pop")) closeCtxMenu();
}
function onCtxEsc(e) {
  if (e.key === "Escape") closeCtxMenu();
}

function showDesktopCtxMenu(ev) {
  closeCtxMenu();
  const selText = String(window.getSelection() || "");
  const t = ev.target;
  const editable = t.closest
    ? (t.closest("textarea, input") || (t.isContentEditable ? t : null))
    : null;

  const pop = document.createElement("div");
  pop.id = "ctx-pop";
  const item = (label, key, enabled, fn) => {
    const it = document.createElement("div");
    it.className = "ctx-item" + (enabled ? "" : " disabled");
    const name = document.createElement("span");
    name.textContent = label;
    const hint = document.createElement("span");
    hint.className = "ctx-key";
    hint.textContent = key;
    it.append(name, hint);
    if (enabled) {
      // mousedown 不给默认行为: 不抢焦点、不冲掉选区, 等 click 再执行
      it.addEventListener("mousedown", e => e.preventDefault());
      it.onclick = () => { closeCtxMenu(); fn(); };
    }
    pop.appendChild(it);
  };
  const sep = () => {
    const s = document.createElement("div");
    s.className = "ctx-sep";
    pop.appendChild(s);
  };

  if (editable) {
    // 输入框: 完整编辑菜单（撤销/重做 | 剪切/复制/粘贴/删除 | 全选）
    const hasSel = editable.setSelectionRange
      ? editable.selectionStart !== editable.selectionEnd
      : (() => {
          const s = window.getSelection();
          return !!s && !s.isCollapsed && editable.contains(s.anchorNode);
        })();
    const edit = cmd => () => {
      editable.focus();
      document.execCommand(cmd);
    };
    item("撤销", "Ctrl+Z", true, edit("undo"));
    item("重做", "Ctrl+Y", true, edit("redo"));
    sep();
    item("剪切", "Ctrl+X", hasSel, edit("cut"));
    item("复制", "Ctrl+C", hasSel, edit("copy"));
    item("粘贴", "Ctrl+V", true, async () => {
      try {
        // Electron: 经 preload 桥在主进程读系统剪贴板（渲染层 execCommand('paste')
        // 受浏览器安全模型限制不可用）; 旧壳无桥时退回 async Clipboard API。
        // insertText 走编辑命令栈——可撤销, 且正常触发 input 事件
        const text = (window.aulosReadClipboard
          ? await window.aulosReadClipboard()
          : await navigator.clipboard.readText()) || "";
        editable.focus();
        if (!text) { toast("剪贴板是空的"); return; }
        if (!document.execCommand("insertText", false, text)) toast("粘贴失败");
      } catch (e) { toast("粘贴失败"); }
    });
    item("删除", "Del", hasSel, edit("delete"));
    sep();
    item("全选", "Ctrl+A", true, () => {
      editable.focus();
      if (editable.select) editable.select();
      else document.execCommand("selectAll");
    });
  } else if (selText) {
    // 消息文本: 只有复制一件事可做
    item("复制", "Ctrl+C", true, () => document.execCommand("copy"));
  } else {
    return;   // 无可做的事情就不弹（原生菜单也已被抑制）
  }

  document.body.appendChild(pop);
  const W = pop.offsetWidth, H = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(ev.clientX, window.innerWidth - W - 8)) + "px";
  pop.style.top = Math.max(8, Math.min(ev.clientY, window.innerHeight - H - 8)) + "px";
  setTimeout(() => {   // 当次右键的 mouseup 不许把刚弹出的菜单关掉
    document.addEventListener("mousedown", onCtxAway, true);
    document.addEventListener("keydown", onCtxEsc, true);
  }, 0);
}

// 桌面态由 DESKTOP（注入标记或 URL 参数）直接判定, 注入时序不影响菜单
if (DESKTOP) {
  document.addEventListener("contextmenu", ev => {
    ev.preventDefault();
    showDesktopCtxMenu(ev);
  }, true);
}


/* ============================================================
 * 自绘标题栏（仅桌面壳）— 拖拽/双击最大化/窗口控制按钮
 * ============================================================ */
if (DESKTOP) {
  const tbInvoke = cmd => window.__TAURI_INTERNALS__.invoke(cmd).catch(() => {});
  $("tb-min").onclick = () => tbInvoke("minimize_main");
  $("tb-max").onclick = () => tbInvoke("toggle_maximize_main");
  $("tb-close").onclick = () => tbInvoke("close_main");
  const tbar = $("titlebar");
  // 徽标(.tb-ver)可点击打开更新弹窗, 必须与 .tb-btn 一样排除在拖拽外——
  // 否则 mousedown 触发 start_drag_main 进入系统拖拽循环, click 永远不触发
  const TB_INTERACTIVE = ".tb-btn, .tb-ver";
  tbar.addEventListener("mousedown", e => {
    if (e.button !== 0 || e.target.closest(TB_INTERACTIVE)) return;
    tbInvoke("start_drag_main");
  });
  tbar.addEventListener("dblclick", e => {
    if (e.target.closest(TB_INTERACTIVE)) return;
    tbInvoke("toggle_maximize_main");
  });
}
