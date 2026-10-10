/* ============================================================
 * ui-dialogs.js — 轻提示 / 确认弹窗 / 输入弹窗 / 剪贴板 / HTML 转义
 *
 * 从 app.js 外迁的功能域 (拆分路线见 README「代码组织与拆分路线」)。
 * 经典脚本, 与 app.js 共享全局作用域; 由 index.html 在 app.js 之前
 * defer 加载——本文件只定义函数, 不在加载期调用任何 app.js 符号。
 *
 * 读的前置全局: $ (app.js 的 getElementById 包装; 仅 toast 运行时解引用,
 *               defer 顺序下必然已定义) — 其余自包含
 * 暴露的全局:   escapeHtml / copyText / toast / confirmDialog /
 *               promptDialog (后三者另挂 window.* 供 music.js 等复用)
 * ============================================================ */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e2) { /* ignore */ }
    ta.remove();
    return ok;
  }
}

/* ============================================================
 * 轻提示
 * ============================================================ */
let toastTimer = null;
function toast(text, ms = 1600) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
window.aulosToast = toast;   // 摸鱼电台(music.js)共用同一枚轻提示

/* ============================================================
 * 确认弹窗 — 替代原生 confirm(): WebView2 的 confirm 顶着
 * "127.0.0.1:8000 显示" 的源地址头, 丑且不可定制。
 * 用法: if (await confirmDialog("删除会话「x」？", { title: "删除会话", okText: "删除", danger: true })) ...
 * ============================================================ */
function confirmDialog(msg, { title = "确认操作", okText = "确定", danger = false } = {}) {
  return new Promise(resolve => {
    const ov = document.createElement("div");
    ov.id = "confirm-overlay";
    ov.style.display = "flex";
    ov.innerHTML =
      '<div id="confirm-modal" role="alertdialog" aria-modal="true">' +
        '<div id="confirm-title">' +
          (danger ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>' : "") +
          '<span>' + escapeHtml(title) + '</span>' +
        '</div>' +
        '<div id="confirm-msg">' + escapeHtml(msg) + '</div>' +
        '<div id="confirm-actions">' +
          '<button type="button" data-act="cancel">取消</button>' +
          '<button type="button" data-act="ok"' + (danger ? ' class="danger"' : '') + '>' + escapeHtml(okText) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onEsc);
      ov.remove();
      resolve(v);
    };
    const onEsc = e => { if (e.key === "Escape") finish(false); };
    document.addEventListener("keydown", onEsc);
    ov.querySelector("[data-act='ok']").onclick = () => finish(true);
    ov.querySelector("[data-act='cancel']").onclick = () => finish(false);
    ov.addEventListener("mousedown", e => { if (e.target === ov) finish(false); });
    ov.querySelector("[data-act='ok']").focus();
  });
}
window.confirmDialog = confirmDialog;   // 摸鱼电台(music.js)复用

/* ============================================================
 * 输入弹窗 — 替代原生 prompt(): Tauri/WebView2 不支持 prompt
 * （返回 null, 调用方当成"取消"静默退出, 功能看着就是"点了没反应"）。
 * 用法: const name = await promptDialog("歌单名称", { title: "存为歌单", value: "默认值" });
 * ============================================================ */
function promptDialog(msg, { title = "输入", value = "", placeholder = "", okText = "确定" } = {}) {
  return new Promise(resolve => {
    const ov = document.createElement("div");
    ov.id = "confirm-overlay";
    ov.style.display = "flex";
    ov.innerHTML =
      '<div id="confirm-modal" role="dialog" aria-modal="true">' +
        '<div id="confirm-title"><span>' + escapeHtml(title) + '</span></div>' +
        '<div id="confirm-msg">' + escapeHtml(msg) + '</div>' +
        '<input id="confirm-input" type="text" spellcheck="false" autocomplete="off">' +
        '<div id="confirm-actions">' +
          '<button type="button" data-act="cancel">取消</button>' +
          '<button type="button" data-act="ok">' + escapeHtml(okText) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    const input = ov.querySelector("#confirm-input");
    input.value = value;
    input.placeholder = placeholder;
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      input.removeEventListener("keydown", onEnter);
      document.removeEventListener("keydown", onEsc);
      ov.remove();
      resolve(v);
    };
    const onEnter = e => {
      e.stopPropagation();            // 别漏进全局快捷键
      if (e.key === "Enter") finish(input.value.trim());
    };
    const onEsc = e => { if (e.key === "Escape") finish(null); };
    input.addEventListener("keydown", onEnter);
    document.addEventListener("keydown", onEsc);
    ov.querySelector("[data-act='ok']").onclick = () => finish(input.value.trim());
    ov.querySelector("[data-act='cancel']").onclick = () => finish(null);
    setTimeout(() => input.focus(), 0);
  });
}
