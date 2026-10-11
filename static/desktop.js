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
 *  - 点标题栏版本徽标 / 设置→关于的检查更新按钮 = 有更新则打开更新弹窗,
 *    无更新则手动检查一次
 *  - 立即更新 → install_update（只下载）, 全局 poller 驱动标题栏进度 pill
 *    与弹窗进度条; 下载期间可关弹窗继续使用应用（后台下载）
 *  - 下载完（phase=4）→ pill 变「更新已就绪 · 点击安装」+ toast; 点安装
 *    → apply_update 拉起 NSIS 安装器（passive）, 壳重启到新版本
 * 失败可见性: 手动检查失败必提示; 启动静默检查失败不弹（可能只是没网）。
 * ============================================================ */
const UPD = {
  checking: false,
  info: null,        // check_update 返回 { hasUpdate, currentVersion, version, notes }
  pollTimer: null,   // 全局 poller: 下载期间驱动 pill + 弹窗（若有）
  dlg: null,         // 当前打开的更新弹窗 root（#update-overlay）, 无则 null
  readyShown: false, // phase=4 的 toast 只弹一次
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

/* ---------- 标题栏进度 pill: 下载中/已就绪/失败 三态 ---------- */
function setUpdatePill(mode, text) {
  const pill = $("tb-update-dl");
  if (!pill) return;
  if (!mode) { pill.hidden = true; pill.classList.remove("err", "ready"); return; }
  pill.hidden = false;
  pill.classList.toggle("err", mode === "err");
  pill.classList.toggle("ready", mode === "ready");
  pill.textContent = text;
}

/* ---------- 全局 poller: 下载期间 300ms 轮询, 驱动 pill + 弹窗 ---------- */
function startUpdatePolling() {
  if (UPD.pollTimer) return;
  UPD.readyShown = false;
  UPD.pollTimer = setInterval(async () => {
    let st;
    try {
      if (!window.aulosDesktopUpdater) return stopUpdatePolling();
      st = await window.aulosDesktopUpdater.status();
    } catch (_) { return; }
    if (st.phase === 1) {
      if (st.total > 0) {
        const pct = Math.min(100, Math.round((st.received / st.total) * 100));
        setUpdatePill("dl", `更新下载中 ${pct}%`);
        if (UPD.dlg) syncUpdateDialog(st, pct);
      } else {
        setUpdatePill("dl", "正在连接…");
        if (UPD.dlg) syncUpdateDialog(st, 0);
      }
    } else if (st.phase === 4) {
      stopUpdatePolling();
      setUpdatePill("ready", "更新已就绪 · 点击安装");
      if (!UPD.readyShown) {
        UPD.readyShown = true;
        toast("更新包已下载完成, 点击标题栏进度条安装", 4200);
        syncAboutStatus("更新包已就绪, 点击安装");
      }
      if (UPD.dlg) renderUpdateReady(UPD.dlg);
    } else if (st.phase === 3) {
      stopUpdatePolling();
      setUpdatePill("err", "更新下载失败 · 点击重试");
      syncAboutStatus("下载失败, 可点击标题栏进度条重试");
      if (UPD.dlg) updateInstallFail(UPD.dlg, "下载出错（详见 ~/.aulos/boot.log）");
    } else if (st.phase === 2) {
      // apply_update 进行中（拉安装器/重启）, pill 显示过渡态
      setUpdatePill("dl", "正在启动安装…");
    }
  }, 300);
}
function stopUpdatePolling() {
  if (UPD.pollTimer) { clearInterval(UPD.pollTimer); UPD.pollTimer = null; }
}

/* ---------- 弹窗进度同步（弹窗开着就刷） ---------- */
function syncUpdateDialog(st, pct) {
  const ov = UPD.dlg;
  if (!ov) return;
  const fill = ov.querySelector("#update-progress-bar");
  const status = ov.querySelector("#update-status-text");
  if (fill) fill.style.width = pct + "%";
  if (status) status.textContent = `下载中 ${pct}%（${fmtMB(st.received)} / ${fmtMB(st.total)}）· 可关闭窗口, 后台继续`;
}

/* pill 当前状态: null=隐藏 "dl"=下载中 "ready"=已就绪 "err"=失败 */
function pillMode() {
  const p = $("tb-update-dl");
  if (!p || p.hidden) return null;
  if (p.classList.contains("ready")) return "ready";
  if (p.classList.contains("err")) return "err";
  return "dl";
}

/* ---------- phase=4: 弹窗切到「安装就绪」态 ---------- */
function renderUpdateReady(ov) {
  const bar = ov.querySelector("#update-progress");
  const fill = ov.querySelector("#update-progress-bar");
  const status = ov.querySelector("#update-status-text");
  const actions = ov.querySelector("#update-actions");
  delete ov.dataset.busy;
  if (fill) fill.style.width = "100%";
  if (bar) bar.hidden = true;
  if (status) { status.textContent = "更新包已就绪"; status.classList.remove("upd-err"); }
  if (actions) {
    actions.hidden = false;
    const ok = actions.querySelector("[data-act='ok']");
    ok.hidden = false;
    ok.textContent = "立即安装";
    ok.onclick = () => applyUpdateNow(ov);
    actions.querySelector("[data-act='cancel']").textContent = "以后再说";
  }
}

async function checkForUpdates(manual = false) {
  if (!window.aulosDesktopUpdater || UPD.checking) return null;
  UPD.checking = true;
  try {
    const info = await window.aulosDesktopUpdater.check();
    UPD.info = info;
    if (info && info.hasUpdate) {
      updateBadgeMark(true, info.version);
      syncAboutStatus(`发现新版本 v${info.version}`);
      if (manual) openUpdateDialog();
      else toast(`发现新版本 v${info.version}, 点击标题栏版本号更新`, 3600);
    } else {
      updateBadgeMark(false);
      syncAboutStatus(info ? `已是最新版本（v${info.currentVersion}）` : "未检查");
      if (manual) toast(`已是最新版本（v${info.currentVersion}）`);
    }
    return info;
  } catch (e) {
    syncAboutStatus("检查失败: " + (e?.message || e));
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
  // 标题栏 pill: 就绪态=安装; 失败态=重试(重新下载); 下载中=重开弹窗
  const pill = $("tb-update-dl");
  if (pill) pill.addEventListener("click", async () => {
    if (pill.classList.contains("ready")) {
      if (UPD.dlg) { UPD.dlg.remove(); UPD.dlg = null; }
      applyUpdateNow(null);
    } else if (pill.classList.contains("err")) {
      pill.hidden = true;
      pill.classList.remove("err");
      retryUpdateDownload();
    } else if (UPD.dlg) {
      // 下载中点击 = 聚焦到弹窗（若被关掉则重开一个)
    } else {
      openUpdateDialog();
    }
  });
  checkForUpdates(false);   // 启动静默检查
}

async function retryUpdateDownload() {
  try {
    await window.aulosDesktopUpdater.install();
    startUpdatePolling();
  } catch (e) {
    setUpdatePill("err", "更新下载失败 · 点击重试");
    toast("重试失败: " + (e?.message || e));
  }
}

async function applyUpdateNow(ov) {
  try {
    if (ov) {
      const actions = ov.querySelector("#update-actions");
      const status = ov.querySelector("#update-status-text");
      if (status) status.textContent = "正在启动安装程序…";
      if (actions) actions.hidden = true;
    }
    setUpdatePill("dl", "正在启动安装…");
    await window.aulosDesktopUpdater.apply();
    // 成功 = 壳重启中; 什么都不用做
  } catch (e) {
    setUpdatePill("ready", "更新已就绪 · 点击安装");
    toast("安装失败: " + (e?.message || e));
    if (ov) renderUpdateReady(ov);
  }
}

function openUpdateDialog() {
  const info = UPD.info;
  const ready = pillMode() === "ready";
  if ((!info || !info.hasUpdate) && !ready) return;
  if ($("update-overlay")) return;
  const ov = document.createElement("div");
  ov.id = "update-overlay";
  ov.style.display = "flex";
  ov.innerHTML =
    '<div id="update-modal" role="alertdialog" aria-modal="true">' +
      '<div id="update-title">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg>' +
        '<span>发现新版本</span>' +
      '</div>' +
      '<div id="update-versions">v' + escapeHtml(info?.currentVersion || "?") +
        ' <span class="upd-arrow">→</span> v' + escapeHtml(info?.version || "?") + '</div>' +
      '<div id="update-notes">' + (info?.notes ? escapeHtml(info.notes) : "") + '</div>' +
      '<div id="update-progress" hidden><div id="update-progress-bar"></div></div>' +
      '<div id="update-status-text"></div>' +
      '<div id="update-actions">' +
        '<button type="button" data-act="cancel">以后再说</button>' +
        '<button type="button" data-act="ok">' + (ready ? "立即安装" : "立即更新") + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  const onEsc = e => {
    // 后台下载模式: 弹窗随时可关（下载在壳侧继续）, ESC 不再有豁免期
    if (e.key === "Escape") closeUpdateDialog(ov);
  };
  ov._onEsc = onEsc;
  document.addEventListener("keydown", onEsc);
  ov.addEventListener("mousedown", e => { if (e.target === ov) closeUpdateDialog(ov); });
  ov.querySelector("[data-act='cancel']").onclick = () => closeUpdateDialog(ov);
  const okBtn = ov.querySelector("[data-act='ok']");
  if (ready) { okBtn.onclick = () => applyUpdateNow(ov); renderUpdateReady(ov); }
  else okBtn.onclick = () => startUpdateInstall(ov);
  okBtn.focus();
  UPD.dlg = ov;
  // 弹窗重开时若下载已在后台进行（pill 显示中）, 立即把进度画上
  if (pillMode() === "dl") {
    ov.querySelector("#update-progress").hidden = false;
    ov.querySelector("#update-actions").hidden = true;
    ov.querySelector("#update-status-text").textContent = "正在连接更新服务器…";
    window.aulosDesktopUpdater?.status?.().then(st => {
      if (st.phase === 1 && st.total > 0) syncUpdateDialog(st,
        Math.min(100, Math.round((st.received / st.total) * 100)));
    }).catch(() => {});
  }
}

/* phase=4 且包还在（poller 已停的场景, 重开弹窗/点 pill 前查询一次） */
function isUpdateReady() {
  return pillMode() === "ready";
}

function closeUpdateDialog(ov) {
  document.removeEventListener("keydown", ov._onEsc || (() => {}));
  if (UPD.dlg === ov) UPD.dlg = null;
  ov.remove();
}

function updateInstallFail(ov, msg) {
  delete ov.dataset.busy;
  const st = ov.querySelector("#update-status-text");
  st.textContent = "更新失败: " + msg;
  st.classList.add("upd-err");
  // 允许关掉重试（下次点徽标重新检查）
  const actions = ov.querySelector("#update-actions");
  actions.hidden = false;
  const ok = actions.querySelector("[data-act='ok']");
  ok.hidden = true;
  actions.querySelector("[data-act='cancel']").textContent = "关闭";
}

async function startUpdateInstall(ov) {
  const bar = ov.querySelector("#update-progress");
  const status = ov.querySelector("#update-status-text");
  const actions = ov.querySelector("#update-actions");
  actions.hidden = true;
  bar.hidden = false;
  ov.querySelector("#update-progress-bar").style.width = "0%";
  status.textContent = "正在连接更新服务器…";
  try {
    await window.aulosDesktopUpdater.install();
  } catch (e) {
    return updateInstallFail(ov, (e?.message || e) || "无法启动下载");
  }
  // install_update 立即返回（Rust 侧后台任务在跑）; 全局 poller 驱动
  // pill 与本弹窗（UPD.dlg 仍指向 ov）——此时弹窗已可随意关闭
  startUpdatePolling();
}

/* ---------- 设置 → 关于 ---------- */
function syncAboutStatus(text) {
  const el = $("about-update-status");
  if (el) el.textContent = text;
}

function initAboutSection() {
  const verEl = $("about-version");
  if (verEl) {
    verEl.textContent = window.__AULOS_VERSION__
      ? `Aulos v${window.__AULOS_VERSION__}（桌面版）`
      : "Aulos（浏览器运行）";
  }
  const btn = $("btn-about-check");
  if (!btn) return;
  if (!window.aulosDesktopUpdater) return;   // 浏览器模式: 按钮保持 hidden
  btn.hidden = false;
  btn.onclick = () => {
    if (isUpdateReady()) { openUpdateDialog(); return; }
    syncAboutStatus("正在检查…");
    checkForUpdates(true);
  };
}

/* ============================================================
 * 桌面端右键菜单 — 复制/粘贴, 只显示当前可用的项:
 * 有选中文字 → 复制; 右键输入框/可编辑区 → 粘贴; 都没有 → 不弹。
 * 自注册 contextmenu 监听（松开右键时触发, 与原生菜单同时机）:
 * Electron 壳无原生右键菜单, preventDefault 只是拦掉默认行为作双保险。
 * 复制走 execCommand（复制用户当前选区, 无需剪贴板写权限）;
 * 粘贴: 文本经壳桥读剪贴板后 insertText（编辑命令栈——可撤销,
 * 正常触发 input 事件）; 纯图片（系统截图等）转附件, 与 Ctrl+V 同管线。
 * ============================================================ */

// 剪贴板图片 → 附件。dataUrl 可为 data: 或 blob: URL——统一 fetch 成
// Blob 再包 File（name 须带 .png 等扩展名, addFiles 靠它认文本类附件）。
// addFiles 由 app.js 提供（附件管线: 压缩/数量上限/缩略图/随消息上传）,
// 与 Ctrl+V 的 paste 事件、拖拽入口共用同一条路。
async function pasteImageAsAttachment(url) {
  try {
    const blob = await (await fetch(url)).blob();
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    if (!blob.type.startsWith("image/")) throw new Error("not an image");
    const ext = blob.type === "image/jpeg" ? "jpg"
      : blob.type === "image/webp" ? "webp"
      : blob.type === "image/gif" ? "gif" : "png";
    await addFiles([new File([blob], "clipboard." + ext, { type: blob.type })]);
  } catch (e) {
    toast("粘贴失败: 图片读取异常");
  }
}

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
      // 有壳（Electron/Tauri）: 经桥读系统剪贴板——渲染层 execCommand('paste')
      // 受浏览器安全模型限制不可用; 无壳浏览器: 退回 async Clipboard API。
      // 文本走 insertText（编辑命令栈——可撤销, 正常触发 input 事件）;
      // 剪贴板是纯图片（系统截图 Win+Shift+S 等）时读文本会失败/为空,
      // 转读图片 → File → addFiles(), 与 Ctrl+V 贴图同一附件管线。
      try {
        const text = await (window.aulosReadClipboard
          ? window.aulosReadClipboard()
          : navigator.clipboard.readText().catch(() => "")).catch(() => "") || "";
        if (text) {
          editable.focus();
          if (!document.execCommand("insertText", false, text)) toast("粘贴失败");
          return;
        }
        // 文本为空: 可能是纯图片剪贴板。有桥问壳, 浏览器走 read()
        if (window.aulosReadClipboardImage) {
          const dataUrl = await window.aulosReadClipboardImage().catch(() => null);
          if (dataUrl) return void pasteImageAsAttachment(dataUrl);
        } else if (navigator.clipboard.read) {
          const items = await navigator.clipboard.read().catch(() => []);
          const type = items[0]?.types?.find(t => t.startsWith("image/"));
          if (type) {
            const blob = await items[0].getType(type);
            return void pasteImageAsAttachment(URL.createObjectURL(blob));
          }
        }
        toast("剪贴板是空的");
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
  // 徽标(.tb-ver)/更新 pill(.tb-update-dl) 可点击, 必须与 .tb-btn 一样排除
  // 在拖拽外——否则 mousedown 触发 start_drag_main 进入系统拖拽循环,
  // click 永远不触发
  const TB_INTERACTIVE = ".tb-btn, .tb-ver, .tb-update-dl";
  tbar.addEventListener("mousedown", e => {
    if (e.button !== 0 || e.target.closest(TB_INTERACTIVE)) return;
    tbInvoke("start_drag_main");
  });
  tbar.addEventListener("dblclick", e => {
    if (e.target.closest(TB_INTERACTIVE)) return;
    tbInvoke("toggle_maximize_main");
  });
}

/* ---------- 设置 → 关于: 版本号 + 检查更新入口 ---------- */
initAboutSection();
// 设置页首次进入关于节时同步一次状态（poller 之外的静态场景）
document.addEventListener("click", e => {
  const item = e.target.closest?.("#side-settings .nav-item[data-section='about']");
  if (!item) return;
  if (isUpdateReady()) syncAboutStatus("更新包已就绪, 点击标题栏进度条安装");
  else if (UPD.info?.hasUpdate) syncAboutStatus(`发现新版本 v${UPD.info.version}, 点击检查更新`);
  else if (!UPD.info) syncAboutStatus("未检查");
}, true);
