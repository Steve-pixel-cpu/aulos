/* ============================================================
 * settings-page.js — 设置弹窗: 外观/通知/桌宠/模型/行为/MCP 配置节
 *
 * 从 app.js 外迁的功能域 (拆分路线见 README「代码组织与拆分路线」)。
 * 与 app.js 双向但都运行时解引用:
 *   - app.js 的入口绑定 (js-open-settings) 与 loadSettings() 调本文件;
 *   - 本文件调 app.js 的 applyTheme/syncBgLayers/makeDropdown/state。
 *   都是用户手势后才执行 —— app.js 之后 defer 加载即安全。
 *
 * 读的前置全局: state / $ / DESKTOP / makeDropdown / applyTheme /
 *               syncBgLayers / themePref / mqDark / escapeHtml / applyFx
 * 暴露的全局:   openSettings / closeSettings / renderProviderSettings /
 *               refreshAutoAccent / accentAutoOn 及本文件内全部设置节
 *               渲染与事件绑定
 * ============================================================ */
/* ============================================================
 * 设置弹窗: 主题外观（深色 / 浅色 / 跟随系统）
 * ============================================================ */
const THEME_ITEMS = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
];
const themeDd = makeDropdown($("sel-theme"), {
  items: THEME_ITEMS, value: themePref(),
  onChange: v => {
    localStorage.setItem(THEME_KEY, v);
    applyTheme();
    applyFx();
    applyAccentVars();   // 自定义色的派生令牌跟随深浅主题
    syncAccentInput();
    syncMica();          // 云母明暗跟随深浅主题
  },
});

/* ---------- 界面风格: 默认 / Fluent · 系统云母 ---------- */
const STYLE_KEY = "xc-style";
function stylePref() {
  const v = localStorage.getItem(STYLE_KEY);
  // 老值迁移: 纯 Fluent Design 选项已删, 存过 "fluent" 的自动升级为云母
  if (v === "fluent") return "fluent-mica";
  return v === "fluent-mica" ? v : "default";
}
function applyStyle() {
  const de = document.documentElement;
  // 云母模式复用 fluent 基座(字体/令牌/圆角), 其上再叠 data-mica 让出系统云母
  if (stylePref() === "fluent-mica") de.dataset.style = "fluent";
  else delete de.dataset.style;
}
/* 云母模式: Tauri 壳 (DWM 命令) 或 Electron 壳 (aulosSetMica 桥) 都可开真
 * 系统云母 (DWM 壁纸采样垫底)。前端只挂 data-mica 标记 + 通知壳; CSS 把
 * 大面积区域转透明让出底层, 内容卡片转实底——Win11 原生应用"实卡坐云母"
 * 的语言。确认制: 壳回传"确实开了"才挂标记——浏览器 / 老系统 / 无壳环境
 * 拿不到确认 → 纯 CSS Fluent 观感, 不残留半透明发白。
 * syncMica 幂等, 深浅主题切换时重申（壳侧明暗要跟随）。 */
function tauriInvoke(cmd, payload) {
  const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!inv) return Promise.reject(new Error("no tauri"));
  return inv(cmd, payload);
}
function syncMica() {
  const de = document.documentElement;
  const want = stylePref() === "fluent-mica";
  const dark = resolvedTheme() === "dark";
  if (!want) {
    delete de.dataset.mica;
    tauriInvoke("set_mica", { on: false, dark }).catch(() => {});
    if (window.aulosSetMica) window.aulosSetMica(false).catch(() => {});
    return;
  }
  // 确认制: 壳真开成功才挂 data-mica——浏览器/老系统拿不到确认,
  // 前端保持纯 CSS Fluent(半透明 acrylic), 不会出现"半透明但无云母"的发白态
  // 两壳互斥(不可能同时存在), 按在场的桥走
  const confirmP = window.__TAURI_INTERNALS__
    ? tauriInvoke("set_mica", { on: true, dark }).catch(() => false)
    : window.aulosSetMica
      ? window.aulosSetMica(true).catch(() => false)
      : Promise.resolve(false);
  confirmP.then((ok) => {
    if (ok) de.dataset.mica = "1";
    else delete de.dataset.mica;
  });
}
const STYLE_ITEMS = [
  { value: "default", label: "默认" },
  { value: "fluent-mica", label: "Fluent · 系统云母" },
];
const styleDd = makeDropdown($("sel-style"), {
  items: STYLE_ITEMS, value: stylePref(),
  onChange: v => {
    localStorage.setItem(STYLE_KEY, v);
    applyStyle();
    syncMica();
  },
});
applyStyle();
syncMica();

/* ---------- 代码高亮主题: 默认跟随深浅主题, 或指定一套预设配色 ---------- */
const HL_KEY = "xc-hl";
function hlPref() { return localStorage.getItem(HL_KEY) || "auto"; }
function applyHl() {
  const de = document.documentElement, v = hlPref();
  if (v === "auto") delete de.dataset.hl;
  else de.dataset.hl = v;
}
const HL_ITEMS = [
  { value: "auto", label: "跟随主题" },
  { value: "onedark", label: "One Dark" },
  { value: "dracula", label: "Dracula" },
  { value: "monokai", label: "Monokai" },
  { value: "github-light", label: "GitHub Light" },
  { value: "solarized-light", label: "Solarized Light" },
];
const hlDd = makeDropdown($("sel-hl"), {
  items: HL_ITEMS, value: hlPref(),
  onChange: v => { localStorage.setItem(HL_KEY, v); applyHl(); },
});
applyHl();

/* ---------- 聊天密度: 缩放聊天区垂直间距（--density 令牌） ---------- */
const DENSITY_KEY = "xc-density";
function densityPref() { return localStorage.getItem(DENSITY_KEY) || "comfortable"; }
function applyDensity() {
  const de = document.documentElement, v = densityPref();
  if (v === "comfortable") delete de.dataset.density;
  else de.dataset.density = v;
}
const DENSITY_ITEMS = [
  { value: "compact", label: "紧凑" },
  { value: "comfortable", label: "舒适" },
  { value: "cozy", label: "宽松" },
];
const densityDd = makeDropdown($("sel-density"), {
  items: DENSITY_ITEMS, value: densityPref(),
  onChange: v => { localStorage.setItem(DENSITY_KEY, v); applyDensity(); },
});
applyDensity();

/* ---------- 气泡风格: AI 回复文档流（默认）或包进卡片 ---------- */
const MSGSTYLE_KEY = "xc-msgstyle";
function msgstylePref() { return localStorage.getItem(MSGSTYLE_KEY) || "document"; }
function applyMsgstyle() {
  const de = document.documentElement, v = msgstylePref();
  if (v === "document") delete de.dataset.msgstyle;
  else de.dataset.msgstyle = v;
}
const MSGSTYLE_ITEMS = [
  { value: "document", label: "文档流" },
  { value: "bubble", label: "气泡卡片" },
];
const msgstyleDd = makeDropdown($("sel-msgstyle"), {
  items: MSGSTYLE_ITEMS, value: msgstylePref(),
  onChange: v => { localStorage.setItem(MSGSTYLE_KEY, v); applyMsgstyle(); },
});
applyMsgstyle();

/* ---------- 禅模式: 隐藏侧栏专注对话; 左缘热区悬停临时唤出侧栏 ---------- */
const ZEN_KEY = "xc-zen";
function zenPref() { return localStorage.getItem(ZEN_KEY) === "1"; }
function applyZen() {
  const de = document.documentElement;
  if (zenPref()) de.dataset.zen = "1";
  else { delete de.dataset.zen; $("sidebar").classList.remove("zen-peek"); }
  syncZenUi();
}
/* 禅模式的入口与回显: 按钮仅聊天视图显示（设置页有自己的开关下拉）,
 * 悬浮态 zen-peek 由热区悬停驱动, 与持久化开关互不影响 */
function syncZenUi() {
  const view = $("pane").dataset.view;
  $("btn-zen").style.display = (view !== "settings" && view !== "onboarding") ? "" : "none";
  if (window.__zenDd) window.__zenDd.setValue(zenPref() ? "1" : "0");
}
const zenDd = makeDropdown($("sel-zen"), {
  items: [{ value: "0", label: "关" }, { value: "1", label: "开" }],
  value: zenPref() ? "1" : "0",
  onChange: v => {
    localStorage.setItem(ZEN_KEY, v === "1" ? "1" : "0");
    applyZen();
  },
});
window.__zenDd = zenDd;
$("btn-zen").onclick = () => {
  localStorage.setItem(ZEN_KEY, zenPref() ? "0" : "1");
  applyZen();
};
/* 左缘热区: 悬停弹出真实侧栏（zen-peek 悬浮态）, 移出侧栏延时收回。
 * 延时防误关: 指针从侧栏滑向其内的弹层/滚动条时不立即消失。 */
(() => {
  const hz = $("zen-hotzone"), sb = $("sidebar");
  let hideTimer = null;
  hz.addEventListener("mouseenter", () => {
    clearTimeout(hideTimer);
    if (zenPref()) sb.classList.add("zen-peek");
  });
  sb.addEventListener("mouseleave", () => {
    if (!zenPref()) return;
    hideTimer = setTimeout(() => sb.classList.remove("zen-peek"), 260);
  });
})();
/* 全局快捷键 Ctrl+Alt+Z 切换禅模式 */
document.addEventListener("keydown", ev => {
  if ((ev.ctrlKey || ev.metaKey) && ev.altKey && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    localStorage.setItem(ZEN_KEY, zenPref() ? "0" : "1");
    applyZen();
  }
});
applyZen();

/* ---------- 通知: 完成提示音 + 桌面通知, 开关即时生效并持久化 ---------- */
const ONOFF_ITEMS = [{ value: "1", label: "开启" }, { value: "0", label: "关闭" }];
const writeBoolPref = key => v => localStorage.setItem(key, v);
const soundDd = makeDropdown($("sel-notify-sound"), {
  items: ONOFF_ITEMS, value: notifySoundPref() ? "1" : "0",
  onChange: writeBoolPref(NOTIFY_SOUND_KEY),
});
const desktopDd = makeDropdown($("sel-notify-desktop"), {
  items: ONOFF_ITEMS, value: notifyDesktopPref() ? "1" : "0",
  onChange: v => {
    writeBoolPref(NOTIFY_DESKTOP_KEY)(v);
    if (v === "1") {
      // 用户手势上下文里才申请权限（浏览器禁止静默弹权限框）
      if (ensureNotifyPermission() !== "granted") toast("浏览器未授予通知权限，弹窗将不生效");
    }
  },
});
$("btn-notify-test").onclick = () => {
  playChime();
  // 桌面壳: 直接发一条原生 toast, 让用户当场验证系统通知链路通不通
  if (DESKTOP) {
    nativeNotify("Aulos 桌面通知测试", "收到这条说明原生通知链路正常");
    toast("已播放提示音并发送系统通知");
    return;
  }
  // 未授权时回落 toast, 让用户立刻知道桌面弹窗这条路通不通
  if ("Notification" in window && Notification.permission !== "granted") {
    ensureNotifyPermission();
    toast("已播放提示音；桌面通知未授权" +
      (Notification.permission === "denied" ? "（被浏览器拒绝）" : "，可再点一次确认授权"));
  }
};

/* ---------- 强调颜色: 预设色板 + 自定义调色盘, 覆盖 --accent 令牌 ---------- */
const ACCENT_KEY = "xc-accent";
const ACCENT_CUSTOM_KEY = "xc-accent-custom";
const ACCENTS = [
  { id: "gray",   name: "浅灰", dark: "#b9bec7", light: "#757b85" },
  { id: "blue",   name: "蓝色", dark: "#6aa6ff", light: "#2f6fd6" },
  { id: "violet", name: "靛紫", dark: "#8b80f9", light: "#6a5be0" },
  { id: "green",  name: "翠绿", dark: "#4ade80", light: "#17803b" },
  { id: "orange", name: "暖橙", dark: "#f97316", light: "#e5622a" },
  { id: "rose",   name: "玫红", dark: "#fb7185", light: "#cf3a5c" },
];
function accentPref() { return localStorage.getItem(ACCENT_KEY) || "gray"; }
function customAccent() { return localStorage.getItem(ACCENT_CUSTOM_KEY) || "#8b80f9"; }

function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return { r: 139, g: 128, b: 249 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function mixHex(a, b, w) {   // w = b 的权重
  const A = hexToRgb(a), B = hexToRgb(b);
  const ch = (x, y) => Math.round(x + (y - x) * w);
  return "#" + [ch(A.r, B.r), ch(A.g, B.g), ch(A.b, B.b)]
    .map(v => v.toString(16).padStart(2, "0")).join("");
}
/* 由主色派生 deep/soft/border 令牌（纯函数, 自定义色与壁纸自动色共用） */
function deriveAccentTokens(hex, isDark) {
  const { r, g, b } = hexToRgb(hex);
  return {
    "--accent": hex,
    "--accent-deep": mixHex(hex, "#000000", isDark ? 0.16 : 0.2),
    "--accent-soft": isDark
      ? `rgba(${r}, ${g}, ${b}, .13)`
      : mixHex(hex, "#ffffff", 0.9),
    "--accent-border": isDark
      ? `rgba(${r}, ${g}, ${b}, .36)`
      : mixHex(hex, "#ffffff", 0.74),
  };
}
/* 自定义颜色: 由主色派生 deep/soft/border（深浅主题各自规则），内联覆盖令牌 */
function applyAccentVars() {
  const st = document.documentElement.style;
  const hex = effectiveAccentHex();
  if (!hex) {   // 无自定义色（预设/默认灰）: 移除内联, 让 CSS 预设生效
    ["--accent", "--accent-deep", "--accent-soft", "--accent-border"]
      .forEach(p => st.removeProperty(p));
    return;
  }
  const isDark = document.documentElement.dataset.theme === "dark";
  const tokens = deriveAccentTokens(hex, isDark);
  for (const k in tokens) st.setProperty(k, tokens[k]);
}
/* 当前生效的自定义主色: 壁纸自动色（开启且可用）优先于手动自定义 */
function effectiveAccentHex() {
  if (accentAutoOn()) {
    const auto = localStorage.getItem(ACCENT_AUTO_HEX_KEY);
    if (auto) return auto;
  }
  return accentPref() === "custom" ? customAccent() : null;
}
/* ---------- 壁纸自动取色: canvas 采样 + 色相桶统计, 与手动强调色并存 ---------- */
const ACCENT_AUTO_KEY = "xc-accent-auto";
const ACCENT_AUTO_HEX_KEY = "xc-accent-auto-hex";
function accentAutoOn() { return localStorage.getItem(ACCENT_AUTO_KEY) === "1"; }
/* 从 dataURL 提取代表色: 72px 缩样 → 按 24 个色相桶统计
 * 得分 = 像素量 × 饱和度²（偏爱浓色, 压制灰底）, 滤掉近黑/近白/近灰,
 * 取最高分桶的代表色并整定到舒适明度/饱和度。失败返回 null。 */
function extractAccentFromDataUrl(dataUrl, cb) {
  try {
    const img = new Image();
    img.onload = () => {
      try {
        const S = 72;
        const cv = document.createElement("canvas");
        cv.width = S; cv.height = S;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        if (!ctx) return cb(null);
        ctx.drawImage(img, 0, 0, S, S);
        const d = ctx.getImageData(0, 0, S, S).data;
        const buckets = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          const v = mx / 255, s = mx ? (mx - mn) / mx : 0;
          if (v < .16 || v > .94 || s < .18) continue;   // 近黑/近白/近灰不要
          let h = 0;
          if (mx !== mn) {
            const df = mx - mn;
            if (mx === r) h = ((g - b) / df + 6) % 6;
            else if (mx === g) h = (b - r) / df + 2;
            else h = (r - g) / df + 4;
          }
          const idx = Math.min(23, Math.floor(h * 4));
          const bk = buckets[idx];
          bk.w += s * s; bk.r += r; bk.g += g; bk.b += b;
        }
        let best = -1, bestW = 0;
        buckets.forEach((bk, i) => { if (bk.w > bestW) { bestW = bk.w; best = i; } });
        if (best < 0 || bestW <= 0) return cb(null);
        const bk = buckets[best];
        let { r, g, b } = { r: bk.r / bk.w, g: bk.g / bk.w, b: bk.b / bk.w };
        // RGB → HSL 整定: 饱和度钳到 .45-.8, 明度按深浅主题定档
        const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
        const l0 = (mx + mn) / 2, s0 = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l0 - 1));
        const h = bkToHue(best);
        const s = Math.min(.8, Math.max(.45, s0));
        const dark = document.documentElement.dataset.theme === "dark";
        const l = dark ? Math.min(.72, Math.max(.58, l0)) : Math.min(.48, Math.max(.34, l0));
        cb(hslToHex(h, s, l));
      } catch (e) { cb(null); }
    };
    img.onerror = () => cb(null);
    img.src = dataUrl;
  } catch (e) { cb(null); }
}
function bkToHue(idx) { return (idx + .5) / 24 * 360; }
function hslToHex(h, s, l) {
  const f = n => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return "#" + f(0) + f(8) + f(4);
}
/* 上传壁纸后重取色; 清壁纸后失效回落手动色 */
function refreshAutoAccent(dataUrl) {
  if (!dataUrl) { localStorage.removeItem(ACCENT_AUTO_HEX_KEY); applyAccentVars(); syncAccentSwatch(); return; }
  extractAccentFromDataUrl(dataUrl, hex => {
    if (!hex) return;   // 提取失败静默回落手动色
    localStorage.setItem(ACCENT_AUTO_HEX_KEY, hex);
    applyAccentVars();
    syncAccentSwatch();
  });
}
const accentAutoChk = $("accent-auto-chk");
accentAutoChk.checked = accentAutoOn();
accentAutoChk.addEventListener("change", () => {
  localStorage.setItem(ACCENT_AUTO_KEY, accentAutoChk.checked ? "1" : "0");
  applyAccentVars();
  syncAccentSwatch();
  syncAccentInput();
  toast(accentAutoChk.checked
    ? (localStorage.getItem(ACCENT_AUTO_HEX_KEY) ? "已启用壁纸取色" : "已开启, 上传或更换壁纸后自动取色")
    : "已改回手动强调色");
});
function applyAccent() {
  const v = accentPref();
  if (v === "gray") delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = v;
  applyAccentVars();
}
function renderAccentDots() { }   // 已由 16 进制输入框取代（保留空实现防旧调用）
function syncAccentInput() {
  const inp = $("accent-hex-input");
  if (!inp) return;
  const v = accentPref();
  if (v === "custom") {
    inp.value = customAccent();
  } else {
    const a = ACCENTS.find(x => x.id === v);
    inp.value = a ? (document.documentElement.dataset.theme === "dark" ? a.dark : a.light) : "";
  }
  inp.classList.remove("invalid");
  syncAccentSwatch();
}
/* 色块预览: 取当前生效的 --accent 计算值（预设主题与自定义色都适用） */
function syncAccentSwatch() {
  const sw = $("accent-swatch");
  if (!sw) return;
  const c = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const hex = /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : "#8b80f9";
  sw.style.background = hex;
  sw.dataset.hex = hex;
}
$("accent-swatch").addEventListener("click", () => {
  const picker = $("accent-color-picker");
  const sw = $("accent-swatch");
  // Chrome 的取色弹层锚定在 input 自身位置: 先把它挪到色块旁, 否则会飞到页面左上角
  const r = sw.getBoundingClientRect();
  picker.style.left = r.left + "px";
  picker.style.top = (r.bottom + 6) + "px";
  const typed = $("accent-hex-input").value.trim();
  picker.value = /^#[0-9a-fA-F]{6}$/.test(typed) ? typed
    : (sw.dataset.hex || "#8b80f9");
  picker.click();
});
$("accent-color-picker").addEventListener("input", ev => {
  const v = ev.target.value.toLowerCase();
  localStorage.setItem(ACCENT_CUSTOM_KEY, v);
  localStorage.setItem(ACCENT_KEY, "custom");
  applyAccent();
  syncAccentInput();
});
$("accent-hex-input").addEventListener("input", () => {
  const inp = $("accent-hex-input");
  let v = inp.value.trim();
  if (v && !v.startsWith("#")) v = "#" + v;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    inp.classList.remove("invalid");
    localStorage.setItem(ACCENT_CUSTOM_KEY, v.toLowerCase());
    localStorage.setItem(ACCENT_KEY, "custom");
    applyAccent();
    syncAccentSwatch();
  } else {
    inp.classList.add("invalid");
  }
});
$("accent-hex-input").addEventListener("keydown", ev => {
  ev.stopPropagation();   // 别让 Enter/Esc 冒泡成全局快捷键
  if (ev.key === "Enter") ev.target.blur();
});
applyAccent();
mqDark.addEventListener("change", () => {
  applyAccentVars();   // 系统深浅切换: 自定义色的派生令牌跟随
  syncAccentInput();
});

/* ---------- 界面 / 聊天内容字号: 直接输入像素值, 各自独立 ----------
 * --fs-ui  界面文字（侧栏/设置/按钮等）, 基准 14px
 * --fs-chat 聊天内容（气泡正文/代码块/diff 行）, 基准 14px
 * 两个键、两个变量, 互不影响。 */
const FS_UI_KEY = "xc-fs-ui";
const FS_CHAT_KEY = "xc-fs-chat";
const FS_UI_BASE = 14;      // CSS 基准: 界面基础字号
const FS_CHAT_BASE = 14;    // CSS 基准: 聊天内容基础字号
const FS_UI_RANGE = [10, 24];
const FS_CHAT_RANGE = [10, 24];
function fsPref(key, base, range) {
  const v = parseFloat(localStorage.getItem(key));
  return Number.isFinite(v) && v >= range[0] && v <= range[1] ? v : base;
}
function fsUiPref()   { return fsPref(FS_UI_KEY, FS_UI_BASE, FS_UI_RANGE); }
function fsChatPref() { return fsPref(FS_CHAT_KEY, FS_CHAT_BASE, FS_CHAT_RANGE); }
function applyFontSize() {
  const st = document.documentElement.style;
  st.setProperty("--fs-ui", (fsUiPref() / FS_UI_BASE).toFixed(4));
  st.setProperty("--fs-chat", (fsChatPref() / FS_CHAT_BASE).toFixed(4));
}
/* 输入即时生效; 清空或非法值在失焦时回退默认并回显 */
function bindFsInput(inpId, key, base, range) {
  const inp = $(inpId);
  inp.addEventListener("input", () => {
    const v = parseFloat(inp.value.trim());
    const ok = Number.isFinite(v) && v >= range[0] && v <= range[1];
    inp.classList.toggle("invalid", !ok);
    if (ok) { localStorage.setItem(key, String(v)); applyFontSize(); }
  });
  inp.addEventListener("keydown", ev => {
    ev.stopPropagation();   // 别让 Enter/Esc 冒泡成全局快捷键
    if (ev.key === "Enter") ev.target.blur();
  });
  inp.addEventListener("blur", () => {
    const v = parseFloat(inp.value.trim());
    if (!(Number.isFinite(v) && v >= range[0] && v <= range[1])) localStorage.removeItem(key);
    inp.value = String(fsPref(key, base, range));
    inp.classList.remove("invalid");
    applyFontSize();
  });
}
bindFsInput("fs-ui-input", FS_UI_KEY, FS_UI_BASE, FS_UI_RANGE);
bindFsInput("fs-code-input", FS_CHAT_KEY, FS_CHAT_BASE, FS_CHAT_RANGE);
applyFontSize();

/* ---------- 壁纸亮度: 0-100 滑块, 50=默认观感, 持久化 localStorage ----------
 * 只缩放压暗层(遮罩 alpha / 表面不透明度), 不动实底卡片:
 * --bg-dim = 2 - v/50 (v=50→1 现状, v=100→0 不压暗, v=0→2 加倍压暗)
 * --bg-surf = 1 - 0.26*clamp((v-50)/50) 限幅 (v>50 更透更亮, v<50 更实更暗;
 *   用减号: 若用加号 v=100 会算出 1.26, color-mix 份额超 100% 被归一化成全实底)
 * 注意: index.html head 预绘制脚本复制了同一套公式, 改这里必须同步改那边 */
const BG_BRIGHT_KEY = "xc-bg-bright";
const BG_BRIGHT_DEFAULT = 50;
function bgBrightPref() {
  const v = parseFloat(localStorage.getItem(BG_BRIGHT_KEY));
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : BG_BRIGHT_DEFAULT;
}
function applyBgBrightness() {
  const v = bgBrightPref();
  const st = document.documentElement.style;
  st.setProperty("--bg-dim", (2 - v / 50).toFixed(4));
  st.setProperty("--bg-surf", (1 - 0.26 * Math.max(-1, Math.min(1, (v - 50) / 50))).toFixed(4)); // 与 index.html 预绘制脚本同步
  const inp = $("bg-bright"), out = $("bg-bright-val");
  if (inp) { inp.value = String(v); out.textContent = String(v); }
}
{
  const inp = $("bg-bright");
  inp.addEventListener("input", () => {
    const v = Math.round(parseFloat(inp.value));
    localStorage.setItem(BG_BRIGHT_KEY, String(v));
    applyBgBrightness();
  });
  inp.addEventListener("keydown", ev => ev.stopPropagation()); // 别冒泡成全局快捷键
}
applyBgBrightness();

/* ---------- 设置 → MCP 服务器: 左列表 + 右表单, 防抖自动保存并热生效 ----------
 * 数据模型直接用 settings.json 的 mcpServers 原始结构（name → spec）,
 * 保存 POST /api/mcp/servers: 服务端校验 → 落盘 → 热应用（连接新服务器、
 * 断开删除的）。连接状态来自同一响应, 显示在每个列表项与表单头部。 */
let mcpCfg = { mcpServers: {} };   // 工作副本（编辑只动内存, 停顿后落盘）
let mcpStatuses = [];              // 最近一次服务端返回的连接状态
let mcpSelected = null;            // 左栏选中的服务器名
let mcpSaveTimer = null;
let mcpDirty = false;
const MCP_SAVE_DELAY = 800;
/* 显示名 → JSON key: 首次创建时用。key 决定工具名前缀 mcp__<key>__*, 只在
 * 建名时约束; 后续改名 = 删除旧服务器 + 新建, 不偷偷改 key（会断开重连） */
function mcpKeyFor(name) {
  const k = (name || "").trim().replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "") || "server";
  // 撞名兜底: 追加序号保证 key 唯一
  let key = k, i = 2;
  while (mcpCfg.mcpServers[key] != null) key = `${k}-${i++}`;
  return key;
}
function mcpStatusOf(name) {
  return mcpStatuses.find(s => s.name === name);
}
function mcpStatus(text, isErr = false) {
  const el = $("mcp-save-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("err", isErr);
}
function scheduleMcpSave() {
  mcpDirty = true;
  mcpStatus("未保存…");
  clearTimeout(mcpSaveTimer);
  mcpSaveTimer = setTimeout(persistMcpServers, MCP_SAVE_DELAY);
}
async function persistMcpServers() {
  clearTimeout(mcpSaveTimer);
  mcpSaveTimer = null;
  if (!mcpDirty) return;
  // 无效中间态不落盘（口径与 /api/mcp/servers 校验一致）, 红字提示待补全
  for (const [name, spec] of Object.entries(mcpCfg.mcpServers)) {
    const t = spec.type || "stdio";
    if (t === "stdio" && !(spec.command || "").trim()) {
      mcpStatus(`「${name}」缺少 command, 暂未保存`, true);
      return;
    }
    if (t !== "stdio" && !(spec.url || "").trim()) {
      mcpStatus(`「${name}」缺少 URL, 暂未保存`, true);
      return;
    }
  }
  mcpStatus("保存并连接中…");
  try {
    const r = await fetch("/api/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mcpCfg),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      mcpStatus("保存失败: " + (err.detail || r.status), true);
      toast("MCP 保存失败: " + (err.detail || r.status));
      return;
    }
    const saved = await r.json();
    mcpDirty = false;
    mcpCfg = { mcpServers: saved.mcpServers || mcpCfg.mcpServers };
    mcpStatus(saved.servers.every(s => s.status !== "connected")
      ? "已保存（无已连接服务器）" : "已保存");
    renderMcpSettings();
  } catch (e) {
    mcpStatus("保存失败: " + e.message, true);
    toast("保存失败: " + e.message);
  }
}
async function loadMcpServers() {
  try {
    const d = await fetch("/api/mcp/servers").then(r => r.json());
    mcpCfg = { mcpServers: d.mcpServers || {} };
    mcpStatuses = d.status || [];
    mcpDirty = false;
  } catch (e) { console.error("加载 MCP 配置失败", e); }
}
/* 左栏列表项: 名称 + 连接状态点（绿=已连接, 红=失败, 灰=未连） */
function buildMcpItem(name) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "prov-item" + (name === mcpSelected ? " on" : "");
  item.dataset.id = name;
  const label = document.createElement("span");
  label.className = "prov-item-name";
  label.textContent = name;
  const dot = document.createElement("i");
  const st = mcpStatusOf(name)?.status;
  dot.className = "dot" + (st === "connected" ? " on" : st === "failed" ? " bad" : "");
  if (st === "failed") {
    const err = mcpStatusOf(name)?.error || "";
    dot.title = err;
    label.title = `${name} — ${err}`;
  } else {
    dot.title = st === "connected" ? "已连接" : "未连接";
  }
  item.append(label, dot);
  item.onclick = () => {
    if (mcpSelected === name) return;
    mcpSelected = name;
    document.querySelectorAll("#mcp-list .prov-item")
      .forEach(x => x.classList.toggle("on", x === item));
    renderMcpDetail();
  };
  return item;
}
/* 单行字段: label + input（存取都走 spec 对象, 变更即标脏） */
function renderMcpDetail() {
  const wrap = $("mcp-detail");
  if (!wrap) return;
  wrap.innerHTML = "";
  const spec = mcpCfg.mcpServers[mcpSelected];
  if (!spec) {
    const empty = document.createElement("div");
    empty.className = "prov-empty";
    empty.textContent = "左侧选择服务器，或点击「＋ 添加服务器」";
    wrap.appendChild(empty);
    return;
  }
  const transport = spec.type || "stdio";
  const st = mcpStatusOf(mcpSelected);
  const card = document.createElement("div");
  card.className = "prov-card";

  /* 头部: 显示名（=key, 即工具前缀）/ 传输类型 / 连接状态 / 删除 */
  const head = document.createElement("div");
  head.className = "prov-head";
  const name = document.createElement("input");
  name.className = "prov-name";
  name.value = mcpSelected;
  name.title = "服务器名即工具前缀 mcp__<名>__*；改名等于删除后重建";
  /* 改名 = 换 key。用 input 事件实时提交（而非 change）: change 只在失焦
   * 时触发, 用户改完名直接去点其他字段时, 后续编辑会写进旧 key（实测踩过:
   * 磁盘上是 new-server, UI 显示 time, 参数改了却不落盘）。实时换 key 后
   * renderMcpDetail 重建表单, 焦点会丢——所以仅在 key 真正变化时重建,
   * 且重建后把焦点还给名字框并移光标到末尾, 打字不中断。 */
  let lastName = name.value;
  name.addEventListener("input", () => {
    const nn = name.value.trim();
    if (nn === lastName) return;
    if (!nn) return;   // 清空过程中不动 key, 留给 blur 兜底恢复
    if (mcpCfg.mcpServers[nn] != null) {   // 撞名: 回退到上一个合法名
      name.value = lastName;
      toast("同名服务器已存在");
      return;
    }
    const next = {};
    for (const [k, v] of Object.entries(mcpCfg.mcpServers)) {
      next[k === lastName ? nn : k] = v;
    }
    mcpCfg.mcpServers = next;
    const oldKey = lastName;
    lastName = nn;
    mcpSelected = nn;
    renderMcpSettings();
    const nameAgain = $("mcp-detail").querySelector(".prov-name");
    if (nameAgain) {
      nameAgain.focus();
      const L = nameAgain.value.length;
      nameAgain.setSelectionRange(L, L);
    }
    scheduleMcpSave();
  });
  name.addEventListener("blur", () => {
    // 兜底: 失焦时名字为空/非法 → 恢复成上一个合法名
    if (!name.value.trim() && lastName) {
      name.value = lastName;
      return;
    }
    if (name.value.trim() !== lastName) {
      name.value = lastName;
      mcpStatus(`名称未变化（${lastName}）`, false);
    }
  });
  const badge = document.createElement("span");
  badge.className = "mcp-badge" + (st?.status === "connected" ? " ok"
    : st?.status === "failed" ? " bad" : "");
  badge.textContent = st?.status === "connected"
    ? `已连接 · ${st.tools.length} 工具`
    : st?.status === "failed" ? "连接失败" : "未连接";
  badge.title = st?.error || badge.textContent;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "prov-del";
  del.innerHTML = TRASH_SMALL_SVG;
  del.dataset.tip = "删除服务器";
  del.onclick = async () => {
    if (!await confirmDialog(`删除 MCP 服务器「${mcpSelected}」？其工具将立即从会话中移除。`,
        { title: "删除服务器", okText: "删除", danger: true })) return;
    delete mcpCfg.mcpServers[mcpSelected];
    mcpSelected = null;
    renderMcpSettings();
    scheduleMcpSave();
  };
  head.append(name, badge, del);
  card.appendChild(head);

  /* 传输类型: stdio 本地子进程 / http streamable / sse */
  const grid = document.createElement("div");
  grid.className = "prov-grid";
  const typeField = document.createElement("div");
  typeField.className = "prov-field";
  typeField.innerHTML = "<label>传输类型</label>";
  const typeSel = document.createElement("select");
  typeSel.className = "set-input";
  for (const [val, label] of [
    ["stdio", "stdio（本地子进程）"],
    ["http", "HTTP（Streamable）"],
    ["sse", "SSE（已废弃，兼容旧服务器）"],
  ]) {
    const o = document.createElement("option");
    o.value = val; o.textContent = label;
    typeSel.appendChild(o);
  }
  typeSel.value = transport;
  typeSel.addEventListener("change", () => {
    spec.type = typeSel.value;
    renderMcpDetail();   // 字段集随类型切换（command/url 二选一）
    scheduleMcpSave();
  });
  typeField.appendChild(typeSel);
  grid.appendChild(typeField);

  const timeoutField = document.createElement("div");
  timeoutField.className = "prov-field";
  timeoutField.innerHTML = "<label>调用超时（秒）</label>";
  const timeout = document.createElement("input");
  timeout.type = "number"; timeout.min = "1"; timeout.className = "set-input";
  timeout.value = spec.timeout ?? 60;
  timeout.addEventListener("input", () => {
    const v = parseInt(timeout.value, 10);
    if (Number.isInteger(v) && v > 0) spec.timeout = v;
    scheduleMcpSave();
  });
  timeoutField.appendChild(timeout);
  grid.appendChild(timeoutField);
  card.appendChild(grid);

  if (transport === "stdio") {
    const cmdF = document.createElement("div");
    cmdF.className = "prov-field";
    cmdF.innerHTML = "<label>COMMAND</label>";
    const cmd = document.createElement("input");
    cmd.className = "set-input mono";
    cmd.placeholder = "npx / uvx / python";
    cmd.value = spec.command || "";
    cmd.addEventListener("input", () => { spec.command = cmd.value; scheduleMcpSave(); });
    cmdF.appendChild(cmd);
    card.appendChild(cmdF);

    const argsF = document.createElement("div");
    argsF.className = "prov-field";
    argsF.innerHTML = '<label>参数（JSON 数组）</label>';
    const args = document.createElement("input");
    args.className = "set-input mono";
    args.placeholder = '["-y", "@modelcontextprotocol/server-everything"]';
    args.value = JSON.stringify(spec.args ?? []);
    args.addEventListener("input", () => {
      try {
        const v = JSON.parse(args.value || "[]");
        if (Array.isArray(v)) { spec.args = v; args.classList.remove("invalid"); scheduleMcpSave(); }
        else args.classList.add("invalid");
      } catch { args.classList.add("invalid"); }
    });
    argsF.appendChild(args);
    card.appendChild(argsF);

    const envF = document.createElement("div");
    envF.className = "prov-field";
    envF.innerHTML = "<label>环境变量（JSON 对象）</label>";
    const env = document.createElement("input");
    env.className = "set-input mono";
    env.placeholder = '{"API_KEY": "${MY_KEY}"}';
    env.value = JSON.stringify(spec.env ?? {});
    env.addEventListener("input", () => {
      try {
        const v = JSON.parse(env.value || "{}");
        if (v && typeof v === "object" && !Array.isArray(v)) {
          spec.env = v; env.classList.remove("invalid"); scheduleMcpSave();
        } else env.classList.add("invalid");
      } catch { env.classList.add("invalid"); }
    });
    envF.appendChild(env);
    card.appendChild(envF);
  } else {
    const urlF = document.createElement("div");
    urlF.className = "prov-field";
    urlF.innerHTML = "<label>URL</label>";
    const url = document.createElement("input");
    url.className = "set-input mono";
    url.placeholder = "http://localhost:3000/mcp";
    url.value = spec.url || "";
    url.addEventListener("input", () => { spec.url = url.value; scheduleMcpSave(); });
    urlF.appendChild(url);
    card.appendChild(urlF);

    const hdF = document.createElement("div");
    hdF.className = "prov-field";
    hdF.innerHTML = "<label>请求头（JSON 对象）</label>";
    const hd = document.createElement("input");
    hd.className = "set-input mono";
    hd.placeholder = '{"Authorization": "Bearer ${TOKEN}"}';
    hd.value = JSON.stringify(spec.headers ?? {});
    hd.addEventListener("input", () => {
      try {
        const v = JSON.parse(hd.value || "{}");
        if (v && typeof v === "object" && !Array.isArray(v)) {
          spec.headers = v; hd.classList.remove("invalid"); scheduleMcpSave();
        } else hd.classList.add("invalid");
      } catch { hd.classList.add("invalid"); }
    });
    hdF.appendChild(hd);
    card.appendChild(hdF);
  }

  /* 连接失败原因就地显示（列表圆点 title 里也有, 这里给完整信息） */
  if (st?.status === "failed" && st.error) {
    const errLine = document.createElement("div");
    errLine.className = "mcp-error-line";
    errLine.textContent = st.error;
    card.appendChild(errLine);
  }
  wrap.appendChild(card);
}
function renderMcpSettings() {
  const list = $("mcp-list");
  if (!list) return;
  const names = Object.keys(mcpCfg.mcpServers);
  if (mcpSelected == null || !names.includes(mcpSelected)) mcpSelected = names[0] ?? null;
  list.innerHTML = "";
  for (const n of names) list.appendChild(buildMcpItem(n));
  renderMcpDetail();
}
$("btn-add-mcp").onclick = () => {
  const key = mcpKeyFor("new-server");
  mcpCfg.mcpServers[key] = { type: "stdio", command: "" };
  mcpSelected = key;
  renderMcpSettings();
  const name = $("mcp-detail").querySelector(".prov-name");
  if (name) { name.focus(); name.select(); }
  scheduleMcpSave();   // 新增即保存; 缺 command 时红字提示, 填好自动补存
};
$("btn-mcp-reload").onclick = async () => {
  // 有未保存编辑先强制落盘再重连——静默丢弃会让用户以为改好了,
  // 重连却跑在旧配置上（实测踩过: 改完参数点重连, 改动全丢）
  if (mcpDirty) await persistMcpServers();
  if (mcpSaveTimer) {   // 落盘被校验拦下(红字提示)时不再继续, 保留现场
    toast("先解决未保存的配置, 再重连");
    return;
  }
  mcpStatus("重连中…");
  try {
    const r = await fetch("/api/mcp/reload", { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || r.status);
    mcpStatuses = d.servers || [];
    mcpStatus(d.servers.every(s => s.status !== "connected")
      ? "已重连（无已连接服务器）" : "已重连");
    renderMcpSettings();
  } catch (e) {
    mcpStatus("重连失败: " + e.message, true);
    toast("重连失败: " + e.message);
  }
};

function openSettings() {
  themeDd.setValue(themePref());   // 每次打开回显当前值  $("fs-ui-input").value = String(fsUiPref());
  $("fs-code-input").value = String(fsChatPref());
  $("bg-bright").value = String(bgBrightPref());
  $("bg-bright-val").textContent = String(bgBrightPref());
  syncAccentInput();  // 迭代次数: 未加载过(服务端值未知)时留空给 placeholder 兜底, 已知则回显
  if (state.serverMaxIter != null) $("set-max-iter").value = String(state.serverMaxIter);
  loadProviders().then(renderProviderSettings);   // 拉取供应商配置并渲染
  loadMcpServers().then(renderMcpSettings);       // 拉取 MCP 配置与连接状态并渲染
  renderAllowlistSettings();                      // 拉取命令白名单并渲染
  renderDenylistSettings();                       // 拒绝清单
  renderSensitivePathsSettings();                 // 用户敏感路径
  loadSkills();                                   // 拉取已装技能并渲染
  skillStatus("");                                // 清掉上次的安装状态
  loadMemories();                                 // 拉取记忆并渲染
  $("sidebar").classList.add("settings-view");
  $("pane").dataset.view = "settings";
  syncZenUi();   // 视图切换: 禅模式按钮只在聊天视图显示
}
function closeSettings() {
  $("sidebar").classList.remove("settings-view");
  $("pane").dataset.view = "chat";
  syncZenUi();
  $("input").focus();
}
document.querySelectorAll(".js-open-settings").forEach(b => { b.onclick = openSettings; });
$("btn-settings-back").onclick = closeSettings;
