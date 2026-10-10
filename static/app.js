"use strict";
/* 桌面态判定: 壳注入的标记优先, URL 参数 desktop=1 兜底——
 * initialization_script 偶发不注入时菜单/标题栏照常工作 */
const DESKTOP = window.aulosDesktop
  || new URLSearchParams(location.search).has("desktop");
/* ============================================================
 * 入口守卫: 网页入口已关闭, 仅允许 aulos 桌面壳打开
 * （桌面壳注入 window.aulosDesktop 标记或 URL 带 desktop=1;
 *   浏览器直接访问 127.0.0.1:8000 只会看到提示, 应用不初始化）
 * ============================================================ */
if (!DESKTOP) {
  document.documentElement.innerHTML =
    '<head><meta charset="UTF-8"><title>Aulos</title></head>' +
    '<body style="margin:0;background:#101014">' +
    '<div style="height:100vh;display:flex;flex-direction:column;gap:10px;' +
    'align-items:center;justify-content:center;font-family:system-ui,' +
    '"Microsoft YaHei",sans-serif;color:#a0a1ab;font-size:15px">' +
    '<img src="/api/icon" alt="" style="width:56px;height:56px;' +
    'border-radius:14px;object-fit:cover">' +
    "<div>请通过 Aulos 桌面应用打开</div></div></body>";
  throw new Error("Aulos: 网页入口已关闭, 请使用桌面应用");
}
if (DESKTOP) document.documentElement.classList.add("aulos-desktop");
/* ============================================================
 * 状态
 * ============================================================ */
const $ = id => document.getElementById(id);
const state = {
  sessionId: null,          // 当前"可见"的会话 id（null = 草稿/无）
  sessions: [],             // 全量会话列表（loadSessions 填充）
  sideTab: "project",       // 侧栏列表模式: project | group
  draft: false,             // 草稿态: 已点"新建"但还没发首条消息（不建条目）
  draftAttach: [],          // 草稿态未发送的附件（跟随会话切换）
  draftInput: "",           // 草稿态未发送的输入（跟随会话切换）
  draftDir: null,           // 草稿态预选的项目目录（侧栏项目行 + 进入时带上）
  draftMode: null,          // 草稿态预选的权限模式: 建会话后先于首条消息下发
  draftPlan: null,          // 草稿态预选的计划开关（与 draftMode 配对下发）
  serverWorkspace: null,    // 服务进程工作区名（无会话目录时的兜底展示）
  // 三设置的全局默认值（loadSettings 从 /api/settings 填充）: 无自己覆盖值的
  // 会话/草稿态, 下拉框回落到这里——否则会残留上一个会话的显示值,
  // 与该会话实际用的值不一致（用户看到的"串值"大多是这条路径）
  globalDefaults: { permissionMode: "prompt", permissionPlan: false, thinkingLevel: null, modelKey: null },
  runs: {},                 // sessionId → 运行态（多会话并行: 各自 WS/流式指针/审批）
  fulltext: null,           // 全文搜索态: { query, hits, pending, seq }（null = 无）
};

/* 一个会话的运行态。多会话并行的核心: 每个会话有自己的 WebSocket、
   流式 DOM 指针、权限审批、未读数。切换会话只是换"可见"的 id,
   后台会话的 WS 与轮次照常跑; 回到前台时按需重拉历史对齐。 */
function runOf(id) {
  if (!state.runs[id]) {
    state.runs[id] = {
      ws: null,               // 该会话的 WebSocket
      busy: false,            // 一轮对话进行中（含排队等待槽位）
      queued: false,          // 在全局并发队列中等待槽位
      pendingPerms: {},       // 待审批的 permission_request: request_id → msg
      activeToolCard: null,   // 当前流式中的工具卡片（配对 tool_result）
      liveToolCards: {},      // 流式中全部待完成工具卡: tool_use id → 卡片（防乱序/丢事件漏配）
      curBubble: null,        // 当前流式中的正文气泡
      curThinking: null,      // 当前流式中的思考行 { el, t0 }
      toolResultIndex: {},    // 历史回放: tool_use id → 卡片（等结果块配对）
      reconnectTimer: null,   // WS 断线重连定时器
      reconnectAttempts: 0,   // 连续重连次数（成功后归零）
      currentWorkdir: null,   // 该会话的工作目录（messages 接口返回）
      pendingSends: [],       // WS 建立期间待发的消息（onopen 后冲刷）
      queue: [],              // 待发送消息（本轮进行中追加, 停在输入框上方卡片）
      unread: 0,              // 后台完成/待审批的未读计数
      permissionMode: null,   // 该会话生效的权限模式（mode_changed / 切会话回显）
      planActive: false,      // 该会话的计划开关（与基础模式独立叠加）
      thinkingLevel: null,    // 该会话生效的思考等级（thinking_changed / 切会话回显）
      modelKey: null,         // 该会话生效的模型 "provider_id|model_id"（model_changed / 切会话回显）
      loaded: false,          // 历史是否已加载过（首次切入必拉）
      loading: false,         // 历史加载进行中（防并发重复拉取）
      everConnected: false,   // 该会话 WS 是否成功连过（区分首次连接与断线重连）
      reconnected: false,     // 当前连接是否重连（busy_sync 的 busy=false 校正只信重连）
      rlNote: null,           // 限流退避提示行（原地更新, 轮次有进展/收口即撤）
      awaiting: false,        // 忙碌中且正处于等待模型输出的空窗（await_output 起止）
    };
  }
  return state.runs[id];
}
const curRun = () => (state.sessionId ? runOf(state.sessionId) : null);

/* 手动添加的项目 / 项目折叠状态: localStorage 持久化 */
state.customProjects = JSON.parse(localStorage.getItem("xc-projects") || "[]");
state.collapsedProjects = new Set(JSON.parse(localStorage.getItem("xc-collapsed") || "[]"));
state.collapsedTasks = localStorage.getItem("xc-collapsed-tasks") === "1";   // 「任务」区块折叠态
state.draftInput = "";   // 草稿态未发送的输入
state.skillCache = null; // 当前工作目录的技能清单（refreshSkillCache 填充, 斜杠补全数据源）

/* 输入框内容跟随会话: 切走前保存, 切回后恢复 */
function saveCurrentInput() {
  const v = $("input").value;
  const atts = attachDraftOf();
  if (state.draft) {
    state.draftInput = v;
    state.draftAttach = atts;
  } else if (state.sessionId) {
    const run = runOf(state.sessionId);
    run.inputDraft = v;
    run.attachDraft = atts;
  }
}
function restoreCurrentInput() {
  const v = state.draft ? state.draftInput
    : (state.sessionId ? runOf(state.sessionId).inputDraft : "");
  const atts = state.draft ? state.draftAttach
    : (state.sessionId ? runOf(state.sessionId).attachDraft : null);
  $("input").value = v || "";
  setAttachDraft(atts || []);
  autoGrow($("input"));
  updateSendBtn();
}

/* ============================================================
 * 附件（图片 / 文本文件）: 暂存 → 预览 → 随 user 消息内联发送。
 * 本地不做任何图像识别: 图片经 Canvas 压缩后 base64 内联在 WS 消息里,
 * 后端包成 Anthropic image 内容块, 由视觉模型在服务端看图。
 * ============================================================ */
const ATTACH_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/* 文本附件扩展白名单: 命中才读入内容, 其余类型 toast 拒绝 */
const ATTACH_TEXT_EXTS = [
  "txt", "md", "markdown", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "json", "csv", "tsv", "log", "xml", "yml", "yaml", "html", "htm", "css",
  "scss", "less", "sh", "bash", "bat", "cmd", "ps1", "sql", "ini", "toml",
  "cfg", "conf", "env", "java", "c", "h", "cpp", "hpp", "go", "rs", "rb",
  "php", "swift", "kt", "vue", "svg", "diff", "patch",
];
const ATTACH_MAX_IMAGES = 8;
const ATTACH_MAX_FILES = 8;
const ATTACH_MAX_FILE_CHARS = 512 * 1024;   // 与后端 _parse_attachments 上限对齐

/* 附件草稿读写: 与输入文字同一节奏（切会话保存/恢复, 发送后清空） */
function attachDraftOf() {
  return state.draft ? state.draftAttach
    : (state.sessionId ? (runOf(state.sessionId).attachDraft || []) : []);
}
function setAttachDraft(list) {
  if (state.draft) state.draftAttach = list;
  else if (state.sessionId) runOf(state.sessionId).attachDraft = list;
  renderAttachPreview();
  updateSendBtn();
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/* 本地排队 qid: 与后端排队区对齐, 接力/立即/删除都按它配对 */
function genQid() {
  return "q-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });
}
function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsText(file);
  });
}
function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = src;
  });
}

/* Canvas 压缩: 长边 >2000px 或体积 >1MB 时缩放并重编码 webp(quality 0.85);
 * gif 重编码会丢动画帧, 恒走原图; 解码/编码任何一步失败都回退原图。
 * 输出 {kind:"image", name, media_type, data(base64 无头)} */
async function compressImage(file) {
  const dataUrl = await readAsDataURL(file);
  const strip = s => s.slice(s.indexOf(",") + 1);
  const keep = () => ({
    kind: "image", name: file.name,
    media_type: ATTACH_IMAGE_TYPES.includes(file.type) ? file.type : "image/png",
    data: strip(dataUrl),
  });
  if (file.type === "image/gif") return keep();   // 动图不重编码
  let img;
  try { img = await loadImageEl(dataUrl); } catch (e) { return keep(); }
  const longSide = Math.max(img.naturalWidth, img.naturalHeight);
  if (longSide <= 2000 && file.size <= 1024 * 1024) return keep();
  try {
    const scale = longSide > 2000 ? 2000 / longSide : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    let out = canvas.toDataURL("image/webp", 0.85);
    let media = "image/webp";
    if (!out.startsWith("data:image/webp")) {
      // 浏览器不支持 webp 编码时 toDataURL 静默回退 png
      out = canvas.toDataURL("image/png");
      media = "image/png";
    }
    return { kind: "image", name: file.name, media_type: media, data: strip(out) };
  } catch (e) {
    return keep();   // 编码失败: 回退原图
  }
}

/* 附件批量入口: 📎 / 拖拽 / 粘贴 三个入口都汇到这里。
 * 白名单外类型 toast 拒绝; 超 个数/大小 限制时提示并跳过。 */
async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const draft = attachDraftOf();
  let added = 0;
  for (const f of files) {
    const ext = extOf(f.name);
    if (ATTACH_IMAGE_TYPES.includes(f.type)) {
      if (draft.filter(a => a.kind === "image").length >= ATTACH_MAX_IMAGES) {
        toast("图片最多 " + ATTACH_MAX_IMAGES + " 张");
        break;
      }
      try { draft.push(await compressImage(f)); added++; }
      catch (e) { toast("图片读取失败: " + f.name); }
    } else if (ATTACH_TEXT_EXTS.includes(ext)) {
      if (draft.filter(a => a.kind === "file").length >= ATTACH_MAX_FILES) {
        toast("文本附件最多 " + ATTACH_MAX_FILES + " 个");
        break;
      }
      try {
        const text = await readAsText(f);
        if (text.length > ATTACH_MAX_FILE_CHARS) {
          toast("文件过大（内容超 512KB）: " + f.name);
          continue;
        }
        draft.push({ kind: "file", name: f.name, text });
        added++;
      } catch (e) { toast("文件读取失败: " + f.name); }
    } else {
      toast("不支持的文件类型: " + f.name);
    }
  }
  if (added) {
    setAttachDraft(draft);
    saveCurrentInput();
  }
}

function removeAttachment(idx) {
  const draft = attachDraftOf().slice();
  draft.splice(idx, 1);
  setAttachDraft(draft);
  saveCurrentInput();
}

/* 文件 chip（名 + 可选大小）: 预览行 / 用户气泡共用 */
function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
function fileChipEl(name, sizeBytes) {
  const chip = document.createElement("span");
  chip.className = "file-chip";
  chip.innerHTML = ICON_FILE + '<span class="fc-name"></span>'
    + (sizeBytes ? '<span class="fc-size"></span>' : "");
  chip.querySelector(".fc-name").textContent = name;
  const sizeEl = chip.querySelector(".fc-size");
  if (sizeEl) sizeEl.textContent = fmtBytes(sizeBytes);
  return chip;
}

/* 预览行: 图片缩略图 + 文件 chip, 每项带 × 删除钮 */
function renderAttachPreview() {
  const box = $("attach-preview");
  if (!box) return;
  box.innerHTML = "";
  const draft = attachDraftOf();
  const imgAtts = draft.filter(a => a.kind === "image");   // 传整组给灯箱, 支持左右切换
  draft.forEach((att, idx) => {
    const item = document.createElement("div");
    item.className = "att-item";
    if (att.kind === "image") {
      const img = document.createElement("img");
      img.className = "att-thumb";
      img.alt = att.name || "";
      img.title = "点击查看大图";
      img.src = "data:" + (att.media_type || "image/png") + ";base64," + att.data;
      img.onclick = () => openLightbox(imgAtts, imgAtts.indexOf(att));
      item.appendChild(img);
    } else {
      item.classList.add("att-file");
      item.appendChild(fileChipEl(att.name, att.text ? att.text.length : 0));
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "att-del";
    del.innerHTML = "&#215;";
    del.dataset.tip = "移除";
    del.onclick = () => removeAttachment(idx);
    item.appendChild(del);
    box.appendChild(item);
  });
}

/* ============================================================
 * 会话消息列: 每个会话一个常驻 DOM 列, 切换会话只做显隐。
 * 后台会话的流式事件继续写进自己的隐藏列, 切回原样恢复——
 * 不再"回前台重拉历史", 流式进行中的回复也不丢字、不冻结。
 * ============================================================ */
let pinnedCol = null;   // 历史回放期间固定写入列（JS 单线程, 用完置回）
let pinnedRun = null;   // 回放期间 toolResultIndex 写入的目标 run

function colOf(id) {
  let col = document.getElementById("msg-col-" + id);
  if (!col) {
    col = document.createElement("div");
    col.id = "msg-col-" + id;
    col.className = "msg-col";
    $("messages").appendChild(col);
  }
  return col;
}
function showCol(id) {
  document.querySelectorAll("#messages .msg-col").forEach(c => {
    c.classList.toggle("on", c.id === "msg-col-" + id);
  });
  // 列显隐不影响 #messages 自身盒尺寸, ResizeObserver 不会触发;
  // 必须显式重建, 否则 minimap 留着上一个会话的刻度
  mmScheduleRebuild();
}

/* ============================================================
 * 主题: dark | light | system（跟随系统），localStorage 持久化
 * ============================================================ */
const THEME_KEY = "xc-theme";
const mqDark = window.matchMedia("(prefers-color-scheme: dark)");
function themePref() { return localStorage.getItem(THEME_KEY) || "system"; }
function resolvedTheme() {
  const pref = themePref();
  return pref === "system" ? (mqDark.matches ? "dark" : "light") : pref;
}
/* 背景图开关状态: 启动早期就会经 syncBgLayers 读到, 必须先于此初始化 */
const BG_KEY = "xc-bg";
let bgVer = 0;
function applyFx() {
  syncBgLayers();
}
function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}
// 跟随系统时, 系统深浅切换实时生效
mqDark.addEventListener("change", () => {
  if (themePref() === "system") { applyTheme(); syncBgLayers(); }
});
applyTheme();
applyFx();

/* ============================================================
 * markdown 渲染: marked.js 优先，加载失败降级为转义纯文本;
 * 代码块外加语言标签/复制按钮，hljs 可用时做语法高亮
 * ============================================================ */
function renderMd(text) {
  if (window.marked && window.marked.parse) {
    try {
      let src = text;
      // 1) 保护代码段（围栏/行内）: 公式解析不碰 `$` 出现在代码里的情况
      const codeSlots = [];
      src = src.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, m => {
        codeSlots.push(m);
        return "\u0000CODE" + (codeSlots.length - 1) + "\u0000";
      });
      // 2) 抽出公式（$$...$$ 块级 / $...$ 行内）为占位符, 免遭 markdown 转义
      const mathSlots = [];
      if (src.includes("$")) {
        src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
          mathSlots.push({ tex: tex.trim(), display: true });
          return "\u0000MATH" + (mathSlots.length - 1) + "\u0000";
        });
        src = src.replace(/\$([^\s$][^$\n]*?)\$/g, (_, tex) => {
          mathSlots.push({ tex: tex.trim(), display: false });
          return "\u0000MATH" + (mathSlots.length - 1) + "\u0000";
        });
      }
      // 3) 还原代码段, 交给 marked 正常解析
      src = src.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeSlots[+i]);
      let html = window.marked.parse(src, { breaks: true, gfm: true });
      // 4) 解析完成后用 KaTeX 还原公式（KaTeX 未加载/解析失败则回退原文）
      html = html.replace(/\u0000MATH(\d+)\u0000/g, (_, i) => {
        const slot = mathSlots[+i];
        if (!window.katex) return "$" + slot.tex + "$";
        try {
          return window.katex.renderToString(slot.tex, {
            displayMode: slot.display, throwOnError: false,
          });
        } catch (e) {
          return "$" + slot.tex + "$";
        }
      });
      return html;
    } catch (e) { /* 落到降级 */ }
  }
  return "<p>" + escapeHtml(text).replace(/\n/g, "<br>") + "</p>";
}

const COPY_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>';
const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>';

function decorateCode(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll("pre:not([data-dec])").forEach(pre => {
    pre.setAttribute("data-dec", "1");
    const code = pre.querySelector("code");
    let lang = "";
    if (code) {
      const m = /language-([\w+-]+)/.exec(code.className || "");
      if (m) lang = m[1];
      if (window.hljs && pre.textContent.length < 60000) {
        try { window.hljs.highlightElement(code); } catch (e) { /* 高亮失败静默 */ }
      }
    }
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    const head = document.createElement("div");
    head.className = "code-head";
    head.innerHTML =
      '<span class="code-lang"></span>' +
      '<button class="code-copy" type="button">' + COPY_SVG + '<span>复制</span></button>';
    head.querySelector(".code-lang").textContent = lang || "代码";
    pre.replaceWith(wrap);
    wrap.appendChild(head);
    wrap.appendChild(pre);
  });
}

/* 表格外包滚动容器: 宽表(时间线/对比表)不再撑破气泡, 窄表不受影响。
 * data-dec 幂等, 流式重渲染重复调用不会套双层 wrapper */
function decorateTables(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll("table:not([data-dec])").forEach(tb => {
    if (tb.closest(".table-wrap")) return;   // 双保险
    tb.setAttribute("data-dec", "1");
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    tb.replaceWith(wrap);
    wrap.appendChild(tb);
  });
}


/* ============================================================
 * 工作目录（项目）: 草稿态选择 + 顶栏标签展示
 * ============================================================ */
function dirName(p) { return p ? p.split(/[\\/]/).filter(Boolean).pop() : null; }

function refreshWorkdirTag() {
  // 顶栏标签: 草稿 → 预选项目; 会话 → 其运行态里的工作目录。
  // 任务类会话（无工作目录）不显示标签——服务进程的目录名与会话无关
  const wd = state.draft ? state.draftDir
    : (curRun() ? curRun().currentWorkdir : null);
  const name = dirName(wd);
  $("ws-tag").style.display = name ? "" : "none";
  if (name) $("ws-tag-text").textContent = name;
}

const dirPop = $("dir-pop");
let dirBrowsePath = null;

async function browseDir(path) {
  const err = $("dir-err");
  err.classList.remove("show");
  try {
    const q = path ? "?path=" + encodeURIComponent(path) : "";
    const r = await fetch("/api/dirs" + q);
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.detail || r.status);
    }
    const data = await r.json();
    dirBrowsePath = data.path;
    $("dir-path-input").value = data.path;
    const list = $("dir-list");
    list.innerHTML = "";
    if (!data.dirs.length) {
      list.innerHTML = '<div class="dir-empty">此目录下没有子目录</div>';
      return;
    }
    for (const name of data.dirs) {
      const it = document.createElement("div");
      it.className = "dir-item";
      it.innerHTML = FOLDER_SVG + '<span></span>';
      it.querySelector("span").textContent = name;
      it.onclick = () => browseDir(dirBrowsePath.replace(/[\\/]+$/, "") + "\\" + name);
      list.appendChild(it);
    }
  } catch (e) {
    err.textContent = "无法读取: " + e.message;
    err.classList.add("show");
  }
}

function openDirPop(anchor = $("btn-add-project")) {
  const r = anchor.getBoundingClientRect();
  dirPop.classList.add("open");
  const left = Math.max(10, Math.min(r.left, window.innerWidth - 352));
  dirPop.style.left = left + "px";
  dirPop.style.top = "auto";
  dirPop.style.bottom = (window.innerHeight - r.top + 8) + "px";
  browseDir("");
}
function closeDirPop() { dirPop.classList.remove("open"); }

$("dir-up").onclick = () => {
  const parts = (dirBrowsePath || "").split(/[\\/]/).filter(Boolean);
  if (!parts.length) return;
  parts.pop();
  if (!parts.length) return;
  // 只剩盘符（如 "D:"）时补上根斜杠，避免 Path("D:") 落到盘符当前目录
  browseDir(parts.length === 1 && /^[a-zA-Z]:$/.test(parts[0]) ? parts[0] + "\\" : parts.join("\\"));
};
function goDirInput() { browseDir($("dir-path-input").value.trim()); }
$("dir-go").onclick = goDirInput;
$("dir-path-input").addEventListener("keydown", ev => {
  ev.stopPropagation();
  if (ev.key === "Enter") goDirInput();
});
$("dir-pick").onclick = () => {
  if (!dirBrowsePath) return;
  addProject(dirBrowsePath);
  if (state.draft) {   // 从欢迎页打开: 选中的目录同时作为草稿的工作区
    state.draftDir = dirBrowsePath;
    showEmptyState();
  }
  closeDirPop();
};
document.addEventListener("click", ev => {
  if (!dirPop.classList.contains("open")) return;
  const addBtn = $("btn-add-project");
  if (!dirPop.contains(ev.target)
      && !(addBtn && addBtn.contains(ev.target))) closeDirPop();
});

/* 顶栏标题点击重命名（Notion 式） */
$("doc-title").onclick = () => {
  if (state.draft || !state.sessionId) return;   // 草稿态没有可命名的会话
  if ($("doc-title").querySelector("input")) return;
  const cur = state.sessions.find(s => s.id === state.sessionId);
  if (!cur) return;
  const input = makeInlineEditor(
    displayTitle(cur),
    val => renameSession(state.sessionId, val),
    () => refreshDocTitle(),   // 取消/完成后恢复标题文本（提交后 rename 也会刷新）
  );
  $("doc-title").textContent = "";
  $("doc-title").appendChild(input);
};

/* ============================================================
 * 会话切换 / 新建 / 历史回放
 * ============================================================ */
/* 拉取并渲染会话历史。首次切入与断线重同步共用:
 * 重同步会替换整列 DOM, 旧的流式指针一并作废——
 * 断连窗口内丢掉的事件以服务端落盘的历史为准。 */
async function loadSessionHistory(id) {
  const run = runOf(id), col = colOf(id);
  run.loading = true;
  col.innerHTML = '<div class="empty-state"><h2>加载中…</h2></div>';
  run.toolResultIndex = {};
  try {
    const r = await fetch(`/api/sessions/${id}/messages`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    run.currentWorkdir = data.workdir || null;
    flushAssistantBubble(run);
    run.curBubble = null;
    run.curThinking = null;
    run.activeToolCard = null;
    run.liveToolCards = {};
    pinnedCol = col; pinnedRun = run;
    col.innerHTML = "";
    for (const m of data.messages) renderHistoryMessage(m);
    // 悬空 tool_use 收口: 轮次早已结束的, 结果永远来不了;
    // 仍在跑的轮次保留"运行中", 等活动流的 tool_result 按 id 配对闭合
    if (!run.busy) {
      col.querySelectorAll('.tool-row[data-state="run"]').forEach(el => setToolState(el, "stopped"));
    }
    collapseFinishedToolGroups(col);   // 历史回放: 已结束的分组回到默认折叠
    pinnedCol = null; pinnedRun = null;
    run.loaded = true;
  } catch (e) {
    col.innerHTML = "";
    pinnedCol = col; pinnedRun = run;
    addNoteBubble("err", "加载历史失败: " + e.message);
    pinnedCol = null; pinnedRun = null;
  } finally {
    run.loading = false;
  }
}

async function selectSession(id) {
  saveCurrentInput();           // 切走前保存当前会话的未发送输入
  state.draft = false;
  state.draftMode = null;       // 草稿态预选的模式/计划作废: 不带到别的会话
  state.draftPlan = null;
  state.sessionId = id;
  localStorage.setItem("xc-cur-session", id);   // 桌宠悬浮窗直连 WS 回退时用
  $("pane").classList.remove("empty-view");   // 真实会话: 输入卡回到常规底部布局
  renderDraftChrome();                        // 顺带清掉草稿态的工作区条/建议 chips
  const run = runOf(id);
  markActiveSession();
  refreshDocTitle();
  renderSessionList();          // 未读标识切换
  connectWs(id);                // 已有连接则复用; 旧会话的 WS 原样保留, 后台继续跑
  colOf(id);   // 确保该会话的消息列已创建（惰性建列）
  showCol(id);
  // 历史只在首次切入时拉一次; 之后切换不再重拉——流式 DOM 一直活着,
  // 后台轮次的内容就写在本列里, 切回即所见
  if (!run.loaded && !run.loading) await loadSessionHistory(id);
  run.unread = 0;               // 回到前台看完了, 未读清零
  renderSessionList();
  refreshWorkdirTag();
  setBusyUi(run.busy);
  renderQueueCards();   // 待发送卡片跟随会话: 重绘为本会话的排队（无则清掉上个会话的残留）
  syncPlanPanelForActiveSession();   // 切回的会话若有未决计划: 恢复面板弹窗
  // 三设置回显: 会话运行值 → 会话列表缓存（/api/sessions 每项都带持久值/
  // 全局默认）→ 全局默认值。必须无条件 setValue: 否则下拉框残留上一个
  // 会话的显示值, 与本会话实际用的值不一致（"跟随全局"的会话尤其如此）。
  // 权限下拉 value 编码 "base|plan"（splitModeValue 解析）; 会话自己的
  // plan 态在 run.planActive（mode_changed 维护）, 列表缓存在 s.plan_active
  {
    const s = state.sessions.find(x => x.id === id);
    const gd = state.globalDefaults;
    const base = run.permissionMode ? splitModeValue(run.permissionMode)[0]
      : (s && s.permission_mode) || gd.permissionMode;
    const plan = run.permissionMode ? splitModeValue(run.permissionMode)[1]
      : (s && s.plan_active) || gd.permissionPlan || false;
    modeDd.setValue(mkModeValue(base, plan));
    thinkDd.setValue(run.thinkingLevel || (s && s.thinking_level) || gd.thinkingLevel || "medium");
    const mKey = run.modelKey
      || (s && s.model_provider && s.model_id ? s.model_provider + "|" + s.model_id : null)
      || gd.modelKey;
    if (mKey) modelDd.setValue(mKey);
  }
  syncThinkingIndicator();   // 切会话必须重算: 转圈只属于"正在等待输出的那个会话"
  setConn(run.ws && run.ws.readyState === 1 ? "on" : "", run.ws ? (run.ws.readyState === 1 ? "已连接" : "连接中…") : "未连接");
  restoreCurrentInput();        // 输入框恢复成该会话未发送的内容
  skillMenuDestroy();           // 切会话收起斜杠菜单; 目录变了下次输入自动重拉
  skillCacheDir = null;         // 会话可能换项目: 强制下次输入重拉技能清单
  scrollToBottom(true);
}

const SUGGESTIONS = [
  "帮我看看这个项目的整体结构",
  "解释一下核心模块的实现思路",
  "跑一下全部测试并总结结果",
];

function showEmptyState() {
  $("pane").classList.add("empty-view");   // 欢迎态: 输入卡随欢迎内容垂直居中
  const col = msgCol();
  const h = new Date().getHours();
  const greet = h < 6 ? "夜深了" : h < 12 ? "上午好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  col.innerHTML =
    "<div class='empty-state welcome'>" +
    "<img class='watermark' src='" + iconUrl() + "' alt=''>" +
    "<h2>" + greet + "呀，有什么想让我帮忙的吗</h2>" +
    "</div>";
  renderDraftChrome();   // 工作区条/建议 chips 挂在输入卡上下, 不随消息列重绘
}

/* 草稿态: 工作区选择条贴输入卡顶部, 建议 chips 挂输入卡下方; 非草稿态清空 */
function renderDraftChrome() {
  const dock = $("ws-dock"), sug = $("sug-dock");
  if (!state.draft) {
    dock.innerHTML = "";
    sug.innerHTML = "";
    return;
  }
  dock.innerHTML = "<button class='ws-chip' id='ws-chip'></button>";
  renderWsChip();
  sug.innerHTML = SUGGESTIONS.map(s => `<button class='sug-chip'>${escapeHtml(s)}</button>`).join("");
  sug.querySelectorAll(".sug-chip").forEach(chip => {
    chip.onclick = () => {
      $("input").value = chip.textContent;
      autoGrow($("input"));
      $("input").focus();
    };
  });
}

/* ---------- 工作区 chip + 下拉: 选了文件夹归项目, 不选归独立任务 ---------- */
const WS_CHEV = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

function renderWsChip() {
  const chip = $("ws-chip");
  if (!chip) return;
  if (state.draftDir) {
    chip.classList.add("on");
    chip.innerHTML = FOLDER_SVG + "<span class='ws-name'></span>" +
      "<span class='ws-x' data-tip='清除, 作为独立任务'>×</span>" + WS_CHEV;
    chip.querySelector(".ws-name").textContent = projectDisplayName(state.draftDir);
    chip.title = state.draftDir;
    chip.querySelector(".ws-x").onclick = ev => {
      ev.stopPropagation();
      state.draftDir = null;
      renderWsChip();
    };
  } else {
    chip.classList.remove("on");
    chip.innerHTML = FOLDER_SVG + "<span>选择工作区</span>" + WS_CHEV;
    chip.title = "";
  }
  chip.onclick = ev => { ev.stopPropagation(); openWsPop(chip); };
}

function knownWorkspaces() {
  const set = new Set(state.customProjects);
  for (const s of state.sessions) if (s.workdir) set.add(s.workdir);
  return [...set];
}

function openWsPop(anchor) {
  closeWsPop();
  const known = knownWorkspaces();
  const pop = document.createElement("div");
  pop.id = "ws-pop";
  pop.innerHTML = "<input class='ws-search' placeholder='搜索工作区'><div class='ws-list'></div>" +
    "<div class='ws-item ws-act' data-act='browse'>" + FOLDER_SVG + "<span>打开文件夹…</span></div>" +
    "<div class='ws-item ws-act' data-act='none'>" + FOLDER_SVG + "<span>不在项目中工作</span></div>";
  document.body.appendChild(pop);
  const list = pop.querySelector(".ws-list");
  const renderList = q => {
    const items = known.filter(w => !q || w.toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = items.length
      ? items.map(w =>
          `<div class="ws-item${w === state.draftDir ? " on" : ""}">` +
          FOLDER_SVG + "<span>" + escapeHtml(projectDisplayName(w)) + "</span>" +
          (w === state.draftDir ? "<span class='ws-check'>✓</span>" : "") + "</div>").join("")
      : '<div class="list-empty" style="margin:8px 10px">没有匹配的工作区</div>';
    const els = list.querySelectorAll(".ws-item");
    items.forEach((w, i) => {
      els[i].onclick = () => {
        state.draftDir = w;
        closeWsPop();
        renderWsChip();
      };
    });
  };
  renderList("");
  pop.querySelector(".ws-search").addEventListener("input", ev => renderList(ev.target.value));
  pop.querySelector("[data-act='browse']").onclick = async () => {
    closeWsPop();
    if (window.aulosPickFolder) {   // 桌面端: 原生文件夹对话框
      const dir = await pickNativeFolder();
      if (dir) { addProject(dir); state.draftDir = dir; renderWsChip(); }
      return;
    }
    openDirPop(anchor);             // 浏览器/预览: 页面内目录浏览兜底
  };
  pop.querySelector("[data-act='none']").onclick = () => {
    state.draftDir = null;
    closeWsPop();
    renderWsChip();
  };
  // 定位: chip 下方优先, 放不下翻到上方; 两向都放不下时限高让列表内滚
  const r = anchor.getBoundingClientRect();
  pop.style.visibility = "hidden";
  requestAnimationFrame(() => {
    const W = pop.offsetWidth, H = pop.offsetHeight;
    const left = Math.max(10, Math.min(r.left, window.innerWidth - W - 10));
    const M = 10;                                   // 视口安全边距
    const below = r.bottom + 6;
    const fitsBelow = below + H <= window.innerHeight - M;
    const fitsAbove = r.top - 6 - H >= M;
    let top = below;
    if (!fitsBelow && fitsAbove) {
      top = r.top - 6 - H;                          // 上方空间更充裕: 翻转
    } else if (below + H > window.innerHeight - M) {
      // 两向都放不下: 就地限高, 搜索框和操作项固定, 列表内部滚动
      const avail = Math.max(160, window.innerHeight - below - M);
      pop.style.maxHeight = avail + "px";
      pop.style.display = "flex";
      pop.style.flexDirection = "column";
      const lst = pop.querySelector(".ws-list");
      lst.style.flex = "1";
      lst.style.minHeight = "0";
      lst.style.maxHeight = "none";
    }
    pop.style.left = left + "px";
    pop.style.top = Math.max(M, top) + "px";
    pop.style.visibility = "";
    pop.querySelector(".ws-search").focus();
  });
}
function closeWsPop() { const p = $("ws-pop"); if (p) p.remove(); }
document.addEventListener("click", ev => {
  const pop = $("ws-pop");
  if (!pop) return;
  const chip = $("ws-chip");
  if (!pop.contains(ev.target) && !(chip && chip.contains(ev.target))) closeWsPop();
});

function startDraft(draftDir = null) {
  saveCurrentInput();          // 离开原会话: 保存其未发送输入
  state.draft = true;
  state.sessionId = null;
  state.draftDir = draftDir;   // 侧栏项目行 + 进入: 首条消息据此把会话归入该项目
  markActiveSession();
  refreshDocTitle();
  const col = colOf("__draft__");
  col.innerHTML = "";
  showCol("__draft__");
  showEmptyState();
  setBusyUi(false);
  renderQueueCards();   // 草稿态没有会话队列: 清掉上个会话残留的待发送卡片
  syncPlanPanelForActiveSession();   // 草稿态没有未决计划: 收起面板
  syncThinkingIndicator();     // 草稿态没有 run: 收掉从原会话带来的"思考中"转圈
                                 // （切走瞬间原会话正在 prefill 空窗, 否则没人再碰这个 DOM,
                                 //   后台轮次的空窗事件都带 sid 守卫, 不会点亮这里）
  setConn("", "未连接");
  skillMenuDestroy();           // 切草稿收起斜杠菜单; 预选项目变了下次输入自动重拉
  skillCacheDir = null;
  // 草稿态下拉 = 新会话将用的全局默认值。必须显式重置: 否则残留上一个
  // 会话的显示值, 而首条消息实际按全局默认起跑 → 显示与实际不一致
  {
    const gd = state.globalDefaults;
    // 草稿预选优先（模式+计划对）; 都没有才回落全局默认
    modeDd.setValue(state.draftMode || state.draftPlan != null
      ? mkModeValue(state.draftMode || "prompt", !!state.draftPlan)
      : mkModeValue(gd.permissionMode, !!gd.permissionPlan));
    thinkDd.setValue(gd.thinkingLevel || "medium");
    if (gd.modelKey) modelDd.setValue(gd.modelKey);
  }
  restoreCurrentInput();       // 恢复草稿态自己的输入
  $("input").focus();
}

/* 历史消息回放: role + blocks（text / tool_use / tool_result） */
function renderHistoryMessage(m) {
  if (m.role === "user") {
    const text = m.blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
    // 旧版压缩持久化的续接指令: 模型专用文本, 渲染为一行提示卡而非气泡
    if (text && isCompactNotice(text)) { addCompactNotice(); return; }
    // [System note] 内部导向文案（收束提醒/预算耗尽/截断恢复等）:
    // 仅供模型读取, 对用户不可行动——直接不渲染
    if (text && isSystemNote(text)) return;
    // 附件块转成与 WS 同形状: image 拼缩略图网格, file 渲染文件 chip
    const atts = m.blocks
      .filter(b => b.type === "image" || b.type === "file")
      .map(b => b.type === "image"
        ? { kind: "image", media_type: b.media_type, data: b.data }
        : { kind: "file", name: b.name, text: b.text });
    if (text || atts.length) addUserBubble(text, atts, null, m.ts);
    return;
  }
  if (m.role === "assistant") {
    // text 与 tool_use 交替出现: text → 气泡, tool_use → 卡片（登记待配对）
    let buf = [];
    const flush = () => {
      if (buf.length) { addAssistantBubble(buf.join("")); buf = []; }
    };
    const run = pinnedRun || curRun();
    for (const b of m.blocks) {
      if (b.type === "text") {
        buf.push(renderMd(b.text));
      } else if (b.type === "tool_use") {
        flush();
        const card = addToolCard({ id: b.id, name: b.name, input: b.input });
        run.toolResultIndex[b.id] = card;   // 等 tool 角色的结果块配对
      }
    }
    flush();
    return;
  }
  if (m.role === "tool") {
    const run = pinnedRun || curRun();
    for (const b of m.blocks) {
      if (b.type !== "tool_result") continue;
      const card = run.toolResultIndex[b.id];
      if (card) {
        completeToolCard(card, { output: b.output, is_error: b.is_error,
                                 denied: false, result_meta: b.result_meta });
      } else {
        // 配不上对（旧数据/截断）: 独立卡片兜底
        addToolCard({ id: b.id, name: b.name, input: "(—)",
                      result: { output: b.output, is_error: b.is_error,
                                denied: false, result_meta: b.result_meta } });
      }
    }
  }
}

/* ============================================================
 * WebSocket
 * ============================================================ */
function setConn(cls, text) {
  $("conn-state").className = cls;
  $("conn-text").textContent = text;
}

function connectWs(id) {
  if (!id) return;
  const run = runOf(id);
  // 已连接或连接中就不动——切换会话不再断开后台会话的 WS
  if (run.ws && (run.ws.readyState === 0 || run.ws.readyState === 1)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/${id}`);
  run.ws = ws;

  ws.onopen = () => {
    if (id === state.sessionId) setConn("on", "已连接");
    run.reconnectAttempts = 0;
    // 首连/重连标记: busy_sync 校正只信重连——首连的快照早于在途的乐观
    // 发送（草稿首发先置忙碌再建连）, 快照 false 不能否掉本地忙碌
    const reconnected = run.everConnected;
    run.reconnected = reconnected;
    run.everConnected = true;
    // 首条消息在 WS 建立期间入队，连接好了统一发出
    const pending = run.pendingSends;
    run.pendingSends = [];
    for (const p of pending) ws.send(JSON.stringify(p));
    // 断线重连后的重同步: 断连窗口内的工具/正文事件已丢,
    // 重拉历史替换整列, 丢配的卡片不会以"运行中"僵住。
    // 仅在重连时做——草稿首发是"先画乐观气泡再 connectWs",
    // 而 turn 落盘只在结束时, 首连就重拉会拿空历史把用户消息抹掉
    if (reconnected && run.loaded && !run.loading) loadSessionHistory(id);
  };
  ws.onclose = () => {
    if (id === state.sessionId) setConn("", "已断开");
    if (run.ws === ws) run.ws = null;
    scheduleReconnect(id);
  };
  ws.onerror = () => { if (id === state.sessionId) setConn("err", "连接错误"); };
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg, id);
  };
}

function closeWs(id) {
  const run = id ? state.runs[id] : null;
  if (run) {
    if (run.reconnectTimer) { clearTimeout(run.reconnectTimer); run.reconnectTimer = null; }
    if (run.ws) {
      const ws = run.ws;
      run.ws = null;
      ws.onclose = null;   // 防止触发断连提示
      ws.close();
    }
  }
}

/* 断线自动重连（服务重启 / 网络闪断）: 指数退避至 10s, 最多 40 次。
 * 恢复后的历史对齐在 ws.onopen 里做——丢掉的事件以落盘历史为准。 */
function scheduleReconnect(id) {
  const run = runOf(id);
  if (run.reconnectTimer) return;
  if (++run.reconnectAttempts > 40) {
    if (id === state.sessionId) setConn("err", "重连失败, 切换会话可重试");
    return;
  }
  const delay = Math.min(2500 * run.reconnectAttempts, 10000);
  run.reconnectTimer = setTimeout(() => {
    run.reconnectTimer = null;
    if (run.ws) return;   // 已被 selectSession / 手动重连抢先
    connectWs(id);
  }, delay);
}

/* ============================================================
 * 设置（输入卡片内的下拉）
 * ============================================================ */
function prettyModel(name) {
  // glm-5.3-flash → GLM 5.3 Flash（首段全大写，其余词首字母大写）
  if (!name) return "模型";
  return name.split("-").map((w, i) => {
    if (/^\d/.test(w)) return w;
    return i === 0 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}

/* 自定义下拉组件: 触发按钮 + 定位弹层（输入卡片贴底, 默认向上弹出）。
   程序侧 setValue 只改显示不触发 onChange; 用户点选才回调。 */
function makeDropdown(trigger, opts) {
  let items = opts.items;
  let value = opts.value;
  let pop = null, onDocClick = null, onKey = null;

  function syncLabel() {
    // labelFor 钩子（modeDd 的组合态文案）: value 是复合编码
    // "基础档|计划态", 不对应任何单一菜单项, 文案由调用方组合渲染
    if (opts.labelFor) {
      trigger.querySelector(".dd-label").textContent = opts.labelFor(value);
      return;
    }
    // items 可为函数（modeDd 的动态菜单）: label 由调用方的渲染器给出
    const view = typeof items === "function" ? items(value) : items;
    const it = view.find(i => i.value === value);
    // 未命中时显示键的 model 段而非原始 provider|model（值被改名/删除后
    // 的过渡态）: 前半段是内部供应商 id, 整段铺出来用户看到的就是"乱码"
    const text = it ? it.label
      : (typeof value === "string" && value.includes("|")
        ? value.slice(value.indexOf("|") + 1)
        : String(value ?? ""));
    trigger.querySelector(".dd-label").textContent = text;
  }
  function close() {
    if (!pop) return;
    pop.remove(); pop = null;
    trigger.classList.remove("open");
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function choose(v) {
    const changed = v !== value;
    value = v; syncLabel(); close();
    if (changed && opts.onChange) opts.onChange(v);
  }
  function renderPop() {
    // 返回本次弹层的菜单项视图: modeDd 传入动态函数——计划开关行显示
    // 当前会话/草稿态的 plan 状态（勾号 + 文案）, 基础模式行打基础勾
    return typeof items === "function" ? items(value) : items;
  }
  function open() {
    if (pop) { close(); return; }
    const view = renderPop();
    pop = document.createElement("div");
    pop.className = "dd-pop" + (view.some(i => i.desc) ? " rich" : "");
    for (const it of view) {
      if (it.sep) {
        const s = document.createElement("div");
        s.className = "dd-sep";
        pop.appendChild(s);
        continue;
      }
      const o = document.createElement("button");
      o.type = "button";
      o.className = "dd-opt" + (it.desc ? " rich" : "") + (it.on ? " on" : "");
      o.innerHTML = '<span class="dd-check">' + CHECK_SVG + '</span>'
        + (it.icon ? '<span class="dd-ico">' + it.icon + '</span>' : '')
        + '<span class="dd-col"><span class="dd-txt"></span>'
        + (it.desc ? '<span class="dd-desc"></span>' : '')
        + '</span>';
      o.querySelector(".dd-txt").textContent = it.label;
      if (it.desc) o.querySelector(".dd-desc").textContent = it.desc;
      o.onclick = () => choose(it.value);
      pop.appendChild(o);
    }
    document.body.appendChild(pop);
    const r = trigger.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
    let top = r.top - ph - 8;   // 输入卡片贴底: 默认向上弹
    if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - ph - 8);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    trigger.classList.add("open");
    onDocClick = ev => {
      if (!pop.contains(ev.target) && !trigger.contains(ev.target)) close();
    };
    onKey = ev => { if (ev.key === "Escape") close(); };
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey, true);
  }
  trigger.addEventListener("click", ev => { ev.stopPropagation(); open(); });
  syncLabel();
  return {
    setValue(v) { value = v; syncLabel(); },
    getValue: () => value,
    setItems(newItems, newValue) {
      items = newItems;
      if (newValue !== undefined) value = newValue;
      syncLabel();
    },
    close,
  };
}

/* 权限模式: 富菜单（图标 + 名称 + 描述, 当前项打勾） */
const ICON_MODE_EYE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_MODE_HAND = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V5.5a1.5 1.5 0 013 0V11m0-5.5v-1a1.5 1.5 0 013 0V11m0-4.5a1.5 1.5 0 013 0V12m-9 .5l-2.4-2.2c-.9-.8-2.2-.4-2.5.8-.1.5 0 1 .3 1.4L10 19c1 1.3 2.3 2 4.2 2 3.2 0 4.8-2 4.8-5v-3.5"/></svg>';
const ICON_MODE_PENCIL = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-1L20 7.5 16.5 4 5 15.5 4 20z"/></svg>';
const ICON_MODE_SHIELD = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 2.8v5.4c0 4.4-2.9 7.8-7 9.8-4.1-2-7-5.4-7-9.8V5.8L12 3z"/></svg>';
// 基础权限模式: 三档。"计划"不是档位而是叠加开关（顶部分隔的开关行）,
// 生效时表现为只读 + 计划工作流, 批准后回落基础档。
const MODE_ITEMS = [
  { value: "prompt", label: "每次询问", icon: ICON_MODE_HAND,
    desc: "改动前先征求我的意见。" },
  { value: "workspace-write", label: "自动编辑", icon: ICON_MODE_PENCIL,
    desc: "自动编辑工作区内的文件。" },
  { value: "danger-full-access", label: "完全访问", icon: ICON_MODE_SHIELD,
    desc: "减少确认次数，放开全部权限。" },
  // allow 不提供: 后端拒绝从设置/会话进入（连将来需要问的工具也一并放行,
  // 只允许 CLI REPL /mode allow 临时开启）
];
const BASE_MODE_LABELS = { "prompt": "每次询问", "workspace-write": "自动编辑",
  "danger-full-access": "完全访问" };
// 触发按钮文案: 计划开 → 「计划 · <基础档>」; 关 → 纯基础档名
function modeLabel(base, plan) {
  return plan ? "计划 · " + (BASE_MODE_LABELS[base] || base)
              : (BASE_MODE_LABELS[base] || base);
}
// 动态菜单视图: items 为函数时, open() 每次展开重新取——计划行的
// 勾号/文案反映当下 plan 状态, 基础模式行打基础勾（两态独立）。
// 每行 value 都用复合编码保住当前计划态: 点基础档行只换基础档,
// 不会把计划开关悄悄带成 false。
function modeMenuItems(value) {
  const [base, plan] = splitModeValue(value);
  return [
    { value: mkModeValue(base, !plan), label: plan ? "计划模式（开）" : "计划模式",
      icon: ICON_MODE_PLAN, on: plan,
      desc: "先研究并给出计划，批准后回到基础模式。" },
    { sep: true },
    ...MODE_ITEMS.map(it => ({
      ...it, value: mkModeValue(it.value, plan), on: it.value === base,
    })),
  ];
}
// 下拉框的 value 编码: "prompt|1" = 基础档 prompt + 计划开。
// 单字符串模式名是旧形态（无计划态）, splitModeValue 兼容。
function mkModeValue(base, plan) { return base + (plan ? "|1" : "|0"); }
function splitModeValue(v) {
  if (typeof v === "string" && v.includes("|")) {
    const [b, p] = v.split("|");
    return [b, p === "1"];
  }
  return [v, false];
}
const modeDd = makeDropdown($("sel-mode"), {
  items: modeMenuItems, value: "prompt|0",
  // 触发按钮文案: value 是复合编码（"prompt|1"）, 不对应单一菜单项,
  // 走组合渲染——「计划 · 每次询问」/「每次询问」。没有这个钩子,
  // syncLabel 会落到 provider|model 的兜底分支, 把计划态显示成 "0"
  labelFor: v => modeLabel(...splitModeValue(v)),
  onChange: v => {
    // 会话级: 切的是当前会话的模式（全局默认值在设置页改, 是新会话初值）。
    // 菜单两行互不相扰: 点计划行 = 翻转 plan、基础档不变; 点基础档行 =
    // 换基础档、plan 不变（服务端同语义: mode/plan 字段缺省 = 不变）
    const [base, plan] = splitModeValue(v);
    const run = curRun();
    if (run) {
      const [curBase, curPlan] = splitModeValue(run.permissionMode || "prompt|0");
      const patch = {};
      if (base !== curBase) patch.mode = base;
      if (plan !== curPlan) patch.plan = plan;
      run.permissionMode = v;
      if (Object.keys(patch).length) {
        sendWs({ type: "set_permission_mode", ...patch });
      }
    } else {
      // 草稿态: 暂存, 建会话后先于首条消息下发（sendCurrent）
      state.draftMode = base;
      state.draftPlan = plan;
    }
  },
});
const THINK_ITEMS = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "max", label: "最高" },
];
function onModeChanged(msg, sid) {
  const run = runOf(sid);
  // 服务端回包: 基础模式 + plan 开关双状态, 编码进下拉框 value
  run.permissionMode = mkModeValue(msg.permission_mode, !!msg.plan_active);
  run.planActive = !!msg.plan_active;
  // 列表缓存同步: 否则下次 renderSessionList/loadSessions 会用旧值,
  // 切会话时下拉框停留在别的会话的模式上（看起来像串了）
  const s = state.sessions.find(x => x.id === sid);
  if (s) {
    s.permission_mode = msg.permission_mode;
    s.plan_active = !!msg.plan_active;
  }
  if (sid === state.sessionId) {
    modeDd.setValue(run.permissionMode);
    if (typeof renderDraftChrome === "function") renderDraftChrome();   // 草稿条随 plan 态刷新
  }
}
const thinkDd = makeDropdown($("sel-thinking"), {
  items: THINK_ITEMS, value: "medium",
  onChange: v => {
    // 会话级: 有会话切本会话; 草稿态（无会话）切全局默认（新会话初值）
    const run = curRun();
    if (run) {
      run.thinkingLevel = v;
      sendWs({ type: "set_thinking_level", level: v });
    } else {
      saveSettings({ thinking_level: v });
    }
  },
});
function onThinkingChanged(msg, sid) {
  const run = runOf(sid);
  run.thinkingLevel = msg.thinking_level;
  const s = state.sessions.find(x => x.id === sid);
  if (s) s.thinking_level = msg.thinking_level;
  if (sid === state.sessionId) thinkDd.setValue(msg.thinking_level);
}
/* 模型下拉: 选项来自所有启用供应商的模型（loadProviders 后填充） */
const modelDd = makeDropdown($("sel-model"), {
  items: [], value: "",
  onChange: v => {
    const [provider_id, model_id] = v.split("|");
    // 会话级: 有会话切本会话; 草稿态（无会话）切全局 active（新会话初值）
    const run = curRun();
    if (run) {
      run.modelKey = v;
      sendWs({ type: "set_model", provider_id, model_id });
    } else {
      saveSettings({ provider_id, model_id });
    }
  },
});
function onModelChanged(msg, sid) {
  const run = runOf(sid);
  const key = msg.provider_id + "|" + msg.model_id;
  run.modelKey = key;
  const s = state.sessions.find(x => x.id === sid);
  if (s) { s.model_provider = msg.provider_id; s.model_id = msg.model_id; }
  if (sid === state.sessionId) modelDd.setValue(key);
}

async function loadSettings() {
  try {
    const [r, pr] = await Promise.all([fetch("/api/settings"), fetch("/api/providers")]);
    const s = await r.json();
    state.providerCfg = await pr.json();
    loadUtilityProvider();   // side-call 小模型设置（下拉项依赖供应商列表）
    syncModelDropdown(s.provider_id, s.model_id);
    modeDd.setValue(mkModeValue(s.permission_mode || "prompt", !!s.permission_plan));
    thinkDd.setValue(s.thinking_level);
    // 全局默认值快照: 供切会话/草稿态回显兜底（见 state.globalDefaults 注释）
    state.globalDefaults = {
      permissionMode: s.permission_mode || "prompt",
      permissionPlan: !!s.permission_plan,
      thinkingLevel: s.thinking_level || null,
      modelKey: s.provider_id && s.model_id ? s.provider_id + "|" + s.model_id : null,
    };
    if (s.max_iterations != null) {
      state.serverMaxIter = s.max_iterations;
      $("set-max-iter").value = String(s.max_iterations);
    }
    if (s.workspace) $("ws-tag-text").textContent = s.workspace;
    state.serverWorkspace = s.workspace || null;
    state.configured = s.configured !== false;   // 旧服务端无此字段时视为已配置
    state.defaultModel = s.model || null;
    refreshWorkdirTag();
    if (s.icon_ver) { iconVer = s.icon_ver; applyIconEverywhere(iconUrl()); }
    if (s.bg_ver) { bgVer = s.bg_ver; syncBgLayers(); }
    else syncBgLayers();   // 服务端无壁纸: 走一遍以清掉本地残留标记的效果
    // 标题栏版本徽标: 桌面壳优先（打包后的后端不带 pyproject.toml, 服务端读不到）,
    // 服务端值兜底（浏览器/源码运行）。都拿不到就藏着, 不留空壳。
    const ver = $("tb-version");
    let v = null;
    if (window.aulosAppVersion) {
      try { v = await window.aulosAppVersion(); } catch (_) { /* 壳异常 → 兜底 */ }
    }
    if (!v) v = s.app_version || null;
    if (ver && v) { ver.textContent = "v" + v; ver.hidden = false; }
  } catch (e) { console.error("加载设置失败", e); }
}

/* ---------- 应用图标: 设置 → 外观 可上传替换, 服务端落盘 ~/.aulos/appearance/icon.png ---------- */
let iconVer = 0;   // 图标文件版本（mtime）: 用 ?v= 穿透浏览器缓存
const iconUrl = () => "/api/icon" + (iconVer ? `?v=${iconVer}` : "");
function applyIconEverywhere(src) {
  document.querySelectorAll("img.mark, img.avatar").forEach(el => { el.src = src; });
  const fav = document.querySelector('link[rel="icon"]');
  if (fav) fav.href = src;
  const prev = $("icon-preview");
  if (prev) prev.src = src;
}

/* ---------- 模型供应商配置: 渲染 / 编辑 / 保存 ---------- */
function modelItems() {
  const items = [];
  for (const p of (state.providerCfg?.providers || [])) {
    if (p.enabled === false) continue;
    for (const m of (p.models || [])) {
      items.push({
        value: p.id + "|" + m.id,
        label: m.name || prettyModel(m.id),   // 只显示模型名, 不带供应商前缀
      });
    }
  }
  return items;
}
function syncModelDropdown(pid, mid) {
  modelDd.setItems(modelItems(), pid && mid ? pid + "|" + mid : undefined);
}
async function loadProviders() {
  try {
    state.providerCfg = await fetch("/api/providers").then(r => r.json());
  } catch (e) { console.error("加载供应商配置失败", e); }
}
/* 左栏当前选中的供应商（仅前端内存, 切换只是换右侧表单, 不丢未保存修改） */
let provSelectedId = null;
function provById(id) {
  return (state.providerCfg?.providers || []).find(p => p.id === id);
}
/* 左栏列表项: 名称 + 启用状态圆点（绿=启用, 灰=停用） */
function buildProvItem(p) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "prov-item" + (p.id === provSelectedId ? " on" : "");
  item.dataset.id = p.id;
  const name = document.createElement("span");
  name.className = "prov-item-name";
  name.textContent = p.name || "未命名供应商";
  const dot = document.createElement("i");
  dot.className = "dot" + (p.enabled !== false ? " on" : "");
  item.append(name, dot);
  item.onclick = () => {
    if (provSelectedId === p.id) return;
    provSelectedId = p.id;
    document.querySelectorAll("#prov-list .prov-item")
      .forEach(x => x.classList.toggle("on", x === item));
    renderProvDetail();
  };
  return item;
}
/* 右侧详情: 无选中时给空态提示 */
function renderProvDetail() {
  const wrap = $("prov-detail");
  if (!wrap) return;
  wrap.innerHTML = "";
  const p = provById(provSelectedId);
  if (!p) {
    const empty = document.createElement("div");
    empty.className = "prov-empty";
    empty.textContent = "左侧选择供应商，或点击「＋ 添加供应商」";
    wrap.appendChild(empty);
    return;
  }
  wrap.appendChild(buildProviderCard(p));
}
function renderProviderSettings() {
  const list = $("prov-list");
  if (!list) return;
  const ps = state.providerCfg?.providers || [];
  // 选中项校验: 空或已被删除时回退到第一个供应商
  if (!ps.some(p => p.id === provSelectedId)) provSelectedId = ps[0]?.id ?? null;
  list.innerHTML = "";
  for (const p of ps) list.appendChild(buildProvItem(p));
  renderProvDetail();
}
/* 左栏单项就地同步（名称/圆点）, 不重绘整栏以免打断输入焦点 */
function syncProvItem(p) {
  const item = document.querySelector(`#prov-list .prov-item[data-id="${CSS.escape(p.id)}"]`);
  if (!item) return;
  item.querySelector(".prov-item-name").textContent = p.name || "未命名供应商";
  item.querySelector(".dot").classList.toggle("on", p.enabled !== false);
}
function buildProviderCard(p) {
  const card = document.createElement("div");
  card.className = "prov-card";

  /* 头部: 行内名称 / 启用开关 / 删除 */
  const head = document.createElement("div");
  head.className = "prov-head";
  const name = document.createElement("input");
  name.className = "prov-name";
  name.value = p.name || "";
  name.placeholder = "供应商名称";
  name.addEventListener("input", () => { p.name = name.value; syncProvItem(p); scheduleProvSave(); });
  const en = document.createElement("label");
  en.className = "prov-switch";
  const enBox = document.createElement("input");
  enBox.type = "checkbox";
  enBox.checked = p.enabled !== false;
  enBox.addEventListener("change", () => { p.enabled = enBox.checked; syncProvItem(p); scheduleProvSave(); });
  const track = document.createElement("i");
  track.className = "track";
  en.append(enBox, track, document.createTextNode("已启用"));
  const del = document.createElement("button");
  del.type = "button";
  del.className = "prov-del";
  del.innerHTML = TRASH_SMALL_SVG;
  del.dataset.tip = "删除供应商";
  del.onclick = async () => {
    if (!await confirmDialog(`删除供应商「${p.name}」？其模型将从下拉中移除。`,
        { title: "删除供应商", okText: "删除", danger: true })) return;
    state.providerCfg.providers = state.providerCfg.providers.filter(x => x !== p);
    if (state.providerCfg.active && state.providerCfg.active.provider === p.id) {
      state.providerCfg.active = {};
    }
    if (provSelectedId === p.id) provSelectedId = null;   // 回退逻辑在 renderProviderSettings 里
    renderProviderSettings();
    scheduleProvSave();   // 删除也自动保存
  };
  head.append(name, en, del);
  card.appendChild(head);

  /* 连接配置: Base URL / API KEY / 接口协议 三列 */
  const grid = document.createElement("div");
  grid.className = "prov-grid";
  const urlField = document.createElement("div");
  urlField.className = "prov-field";
  urlField.innerHTML = "<label>BASE URL</label>";
  const url = document.createElement("input");
  url.className = "set-input mono";
  url.value = p.base_url || "";
  // 占位示例按协议切换: 两个端点形状不同, 配错是 403/404 的常见根源
  const URL_HINTS = {
    anthropic: "https://open.bigmodel.cn/api/anthropic",
    openai: "https://open.bigmodel.cn/api/coding/paas/v4",
  };
  url.placeholder = URL_HINTS[p.protocol || "anthropic"] || "https://...";
  url.addEventListener("input", () => { p.base_url = url.value; scheduleProvSave(); });
  urlField.appendChild(url);
  const protoField = document.createElement("div");
  protoField.className = "prov-field";
  protoField.innerHTML = "<label>接口协议</label>";
  const proto = document.createElement("select");
  proto.className = "set-input";
  proto.title = "anthropic: Claude/Messages 协议端点; openai: OpenAI Chat Completions 协议端点";
  for (const [val, label] of [
    ["anthropic", "Anthropic（Claude 协议）"],
    ["openai", "OpenAI（Chat Completions）"],
  ]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    proto.appendChild(opt);
  }
  proto.value = p.protocol || "anthropic";
  proto.addEventListener("change", () => {
    p.protocol = proto.value;
    url.placeholder = URL_HINTS[proto.value] || "https://...";
    scheduleProvSave();
  });
  protoField.appendChild(proto);
  const keyField = document.createElement("div");
  keyField.className = "prov-field";
  keyField.innerHTML = "<label>API KEY</label>";
  const keyRow = document.createElement("div");
  keyRow.className = "key-row";
  const key = document.createElement("input");
  key.type = "password";
  key.className = "set-input mono";
  key.value = p.api_key || "";
  key.addEventListener("input", () => { p.api_key = key.value; scheduleProvSave(); });
  const eye = document.createElement("button");
  eye.type = "button";
  eye.className = "key-eye";
  eye.textContent = "👁";
  eye.onclick = () => { key.type = key.type === "password" ? "text" : "password"; };
  keyRow.append(key, eye);
  keyField.appendChild(keyRow);
  grid.append(urlField, protoField, keyField);
  card.appendChild(grid);

  /* 模型列表: 列头 + 行 */
  const mField = document.createElement("div");
  mField.className = "prov-models";
  mField.innerHTML =
    '<div class="prov-models-label">模型列表</div>' +
    '<div class="model-cols"><span>显示名</span><span>模型 ID</span><span>标签</span><span></span></div>';
  const rows = document.createElement("div");
  rows.className = "model-rows";
  const buildModelRow = m => {
    const row = document.createElement("div");
    row.className = "model-row";
    const nm = document.createElement("input");
    nm.className = "set-input m-name";
    nm.value = m.name || "";
    nm.placeholder = "显示名";
    nm.addEventListener("input", () => { m.name = nm.value; scheduleProvSave(); });
    const id = document.createElement("input");
    id.className = "set-input m-id mono";
    id.value = m.id || "";
    id.placeholder = "模型 ID（API 名）";
    id.addEventListener("input", () => { m.id = id.value; scheduleProvSave(); });
    const tg = document.createElement("input");
    tg.className = "set-input m-tags";
    tg.value = (m.tags || []).join(",");
    tg.placeholder = "标签（逗号分隔，如 视觉,1M）";
    tg.addEventListener("input", () => {
      m.tags = tg.value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
      scheduleProvSave();
    });
    const delB = document.createElement("button");
    delB.type = "button";
    delB.className = "m-del";
    delB.textContent = "✕";
    delB.dataset.tip = "删除模型";
    delB.onclick = () => {
      p.models = p.models.filter(x => x !== m);
      row.remove();
      scheduleProvSave();
    };
    row.append(nm, id, tg, delB);
    return row;
  };
  for (const m of (p.models || [])) rows.appendChild(buildModelRow(m));
  mField.appendChild(rows);
  const addM = document.createElement("button");
  addM.type = "button";
  addM.className = "m-add";
  addM.textContent = "＋ 添加模型";
  addM.onclick = () => {
    const m = { id: "", name: "", tags: [] };
    p.models.push(m);
    rows.appendChild(buildModelRow(m));
    scheduleProvSave();   // 新行落盘; 模型 id 允许为空, 服务端只校验列表存在
  };
  mField.appendChild(addM);
  card.appendChild(mField);
  return card;
}

$("btn-add-provider").onclick = () => {
  const id = "prov-" + Date.now().toString(36);
  const p = {
    id, name: "新供应商", base_url: "", api_key: "", enabled: true,
    protocol: "anthropic",
    models: [{ id: "", name: "", tags: [] }],
  };
  state.providerCfg.providers.push(p);
  provSelectedId = id;   // 新增即选中
  renderProviderSettings();
  const name = $("prov-detail").querySelector(".prov-name");
  if (name) { name.focus(); name.select(); }
  scheduleProvSave();   // 新增即自动保存; 缺 Base URL 时红字提示, 填好自动补存
};

/* ---------- 设置 → 外观: 背景图片（壁纸） ----------
 * 与应用图标同模式: POST /api/bg 落盘 ~/.aulos/appearance/bg-user.png, localStorage 只存
 * 启用标记（xc-bg=1）。应用方式: <html data-bg="1"> 让遮罩/半透明令牌生效
 * （预绘制脚本抢在首帧前设置, 避免闪烁）; 壁纸本体由 syncBgLayers 预加载
 * 成功后再写到 body 内联背景上, 避免解码期间半成品闪烁。 */
const bgUrl = () => "/api/bg" + (bgVer ? `?v=${bgVer}` : "");
function bgPref() { return localStorage.getItem(BG_KEY) === "1"; }

function syncBgLayers() {
  const on = bgPref() && bgVer > 0;
  const bi = $("bg-bright"); if (bi) bi.disabled = !on;   // 无壁纸时滑块无意义
  if (on) document.documentElement.dataset.bg = "1";
  else delete document.documentElement.dataset.bg;
  if (!on) {
    document.body.style.backgroundImage = "";
    return;
  }
  const img = new Image();
  img.onload = () => {
    if (!bgPref()) return;               // 加载期间被清除了
    document.body.style.backgroundImage = `url("${bgUrl()}")`;
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundPosition = "center";
  };
  img.src = bgUrl();
}
/* 启动装载: 本地标记开启才发请求拿壁纸（版本号稍后由 /api/settings 校准,
 * 校准值若不同, loadSettings 里会再跑一遍本函数换新地址） */
syncBgLayers();
/* 自动取色: localStorage 只有 hex 无图（持久化的原始图不落前端）,
 * 开关开启且缺 hex 时拉一次壁纸现算。setTimeout 延到脚本求值完成后:
 * ACCENT_AUTO_* 常量声明在文件后部, 此处直接引用会踩 TDZ */
setTimeout(() => {
  // accentAutoOn/refreshAutoAccent 随设置弹窗域外迁 settings-page.js
  // (同批 defer 在本文件之后) —— setTimeout(0) 可能抢在其求值前触发,
  // 守卫跳过本轮: loadSettings 校准壁纸版本后会再跑一遍本函数
  if (typeof accentAutoOn !== "function") return;
  if (accentAutoOn() && bgPref() && bgVer > 0 && !localStorage.getItem(ACCENT_AUTO_HEX_KEY)) {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext("2d").drawImage(img, 0, 0);
      try { refreshAutoAccent(cv.toDataURL("image/png")); } catch (e) { /* 同源外图片: 静默 */ }
    };
    img.src = bgUrl();
  }
}, 0);

$("btn-bg-upload").onclick = () => $("bg-file").click();
$("bg-file").addEventListener("change", () => {
  const file = $("bg-file").files[0];
  $("bg-file").value = "";   // 清空: 允许重复选择同一文件
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast("图片过大（限 20MB）"); return; }
  const rd = new FileReader();
  rd.onload = async () => {
    const data = String(rd.result || "");
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(data)) {
      toast("仅支持 PNG / JPEG / WebP");
      return;
    }
    try {
      const r = await fetch("/api/bg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || "HTTP " + r.status);
      bgVer = (await r.json()).ver;
      localStorage.setItem(BG_KEY, "1");   // 上传即启用
      syncBgLayers();
      if (accentAutoOn()) refreshAutoAccent(data);   // 壁纸自动取色
      toast("背景已更新");
    } catch (e) { toast("背景更新失败: " + e.message); }
  };
  rd.readAsDataURL(file);
});
$("btn-bg-clear").onclick = async () => {
  try {
    const r = await fetch("/api/bg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: null }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || "HTTP " + r.status);
    bgVer = 0;
    localStorage.removeItem(BG_KEY);
    syncBgLayers();
    refreshAutoAccent(null);   // 壁纸已清: 自动取色失效, 回落手动强调色
    toast("已清除背景图");
  } catch (e) { toast("清除失败: " + e.message); }
};

/* ---------- 设置 → 外观: 应用图标上传 / 恢复默认 ---------- */
$("btn-icon-upload").onclick = () => $("icon-file").click();
$("icon-file").addEventListener("change", () => {
  const file = $("icon-file").files[0];
  $("icon-file").value = "";   // 清空: 允许重复选择同一文件
  if (!file) return;
  if (file.size > 384 * 1024) { toast("图片过大（限 384KB）"); return; }
  const rd = new FileReader();
  rd.onload = async () => {
    const data = String(rd.result || "");
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(data)) {
      toast("仅支持 PNG / JPEG / WebP");
      return;
    }
    try {
      const r = await fetch("/api/icon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || "HTTP " + r.status);
      iconVer = (await r.json()).ver;
      applyIconEverywhere(data);   // dataURL 即时生效, 无缓存问题
      toast("图标已更新");
    } catch (e) { toast("图标更新失败: " + e.message); }
  };
  rd.readAsDataURL(file);
});
$("btn-icon-reset").onclick = async () => {
  try {
    const r = await fetch("/api/icon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: null }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || "HTTP " + r.status);
    iconVer = (await r.json()).ver;
    applyIconEverywhere(iconUrl());
    toast("已恢复默认图标");
  } catch (e) { toast("恢复失败: " + e.message); }
};

/* ---------- 设置 → 行为: 每轮最大迭代次数（新会话的默认值） ---------- */
function maxIterValid(v) { return Number.isInteger(v) && v >= 1 && v <= 10000; }
function currentMaxIter() {
  const v = parseInt($("set-max-iter").value, 10);
  return maxIterValid(v) ? v : null;
}
{
  const inp = $("set-max-iter");
  const submit = async () => {
    const cur = state.serverMaxIter;
    if (inp.value.trim() === "") {   // 清空 = 放弃编辑, 回显当前值
      if (cur != null) inp.value = String(cur);
      inp.classList.remove("invalid");
      return;
    }
    const v = parseInt(inp.value, 10);
    if (!maxIterValid(v)) { inp.classList.add("invalid"); return; }
    inp.classList.remove("invalid");
    await saveSettings({ max_iterations: v });
    toast("已保存，对新会话生效");
  };
  inp.addEventListener("blur", submit);
  inp.addEventListener("keydown", ev => {
    ev.stopPropagation();   // 别让 Enter/Esc 冒泡成全局快捷键
    if (ev.key === "Enter") ev.target.blur();
  });
}

/* ---------- 设置 → 模型: 辅助模型（utilityProvider） ----------
 * 压缩摘要/会话记忆摘要/自动命名等"整理型"调用专用。独立端点读写原始
 * 设置（不含供应商 key），保存后服务端即时重建 utility client。
 * 供应商下拉复用 makeDropdown（与记忆分类/权限模式同款弹层）。 */
const utProviderDd = makeDropdown($("ut-provider"), {
  items: [{ value: "", label: "不使用（跟主模型）" }],
  value: "",
  onChange() { scheduleUtilitySave(); },
});
async function loadUtilityProvider() {
  try {
    state.utilityCfg = await fetch("/api/utility-provider").then(r => r.json());
    syncUtilityControls();
  } catch (e) { console.error("加载辅助模型配置失败", e); }
}
function syncUtilityControls() {
  const items = [{ value: "", label: "不使用（跟主模型）" }];
  for (const p of (state.providerCfg?.providers || [])) {
    items.push({ value: p.id, label: p.name || p.id });
  }
  utProviderDd.setItems(items, state.utilityCfg?.provider || "");
  $("ut-model").value = state.utilityCfg?.model || "";
  renderUtilityStatus();
}
function renderUtilityStatus() {
  const s = state.utilityCfg;
  const el = $("ut-status");
  if (!s || !el) return;
  el.classList.remove("err");
  if (!s.provider) el.textContent = "当前：跟主模型";
  else if (s.valid) el.textContent = `当前：起名/摘要等后台任务用 ${s.effective_model || s.model || "主对话模型"}`;
  else { el.textContent = "已配置但不可用（供应商被禁用或缺 key），暂跟主模型"; el.classList.add("err"); }
}
let utSaveTimer = null;
function scheduleUtilitySave() {
  clearTimeout(utSaveTimer);
  utSaveTimer = setTimeout(saveUtilityProvider, 800);   // 与供应商表单同一防抖口径
}
async function saveUtilityProvider() {
  clearTimeout(utSaveTimer);
  utSaveTimer = null;
  try {
    state.utilityCfg = await fetch("/api/utility-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: utProviderDd.getValue(),
        model: $("ut-model").value.trim(),
      }),
    }).then(async r => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      return r.json();
    });
    renderUtilityStatus();
  } catch (e) {
    const el = $("ut-status");
    if (el) { el.textContent = "保存失败: " + e.message; el.classList.add("err"); }
  }
}
{
  const model = $("ut-model");
  model.addEventListener("input", scheduleUtilitySave);
  model.addEventListener("keydown", ev => {
    ev.stopPropagation();   // 别让 Enter/Esc 冒泡成全局快捷键
    if (ev.key === "Enter") saveUtilityProvider();
  });
}

/* ---------- 设置 → 配置文件: 用系统默认编辑器打开 settings.json ---------- */
$("btn-open-config").onclick = async () => {
  try {
    const r = await fetch("/api/open-config", { method: "POST" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "HTTP " + r.status);
    toast("已打开配置文件");
  } catch (e) { toast("打开失败: " + e.message); }
};
/* ---------- 自动保存: 脏标记 + 800ms 防抖, 合并连续输入为一次请求 ----------
 * 编辑只改内存 state.providerCfg; 防抖窗口内反复触发只重置计时器, 停顿后才
 * 真正 POST。启用的供应商缺 Base URL 属无效中间态: 置脏但不发请求, 红字提示,
 * 待填好停顿后自动补存 —— 打字/粘贴中途绝不打扰后端。 */
let provSaveTimer = null;
let provDirty = false;
const PROV_SAVE_DELAY = 800;
function provStatus(text, isErr = false) {
  const el = $("prov-save-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("err", isErr);
}
function scheduleProvSave() {
  provDirty = true;
  provStatus("未保存…");
  clearTimeout(provSaveTimer);
  provSaveTimer = setTimeout(persistProviders, PROV_SAVE_DELAY);
}
async function persistProviders() {
  clearTimeout(provSaveTimer);
  provSaveTimer = null;
  if (!provDirty || !state.providerCfg) return;
  // 接口地址必填: 留空会回退到错误的服务端点, 是 403 类问题的根源。
  // 无效中间态不落盘, 等用户填好后的下一次防抖自动保存。
  for (const p of (state.providerCfg.providers || [])) {
    if (p.enabled !== false && !(p.base_url || "").trim()) {
      provStatus(`「${p.name || "未命名供应商"}」缺少 Base URL, 暂未保存`, true);
      return;
    }
  }
  provStatus("保存中…");
  try {
    const r = await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.providerCfg),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      provStatus("保存失败: " + (err.detail || r.status), true);
      toast("保存失败: " + (err.detail || r.status));
      return;
    }
    const saved = await r.json();
    provDirty = false;
    /* 不重绘表单（重建 DOM 会丢输入焦点）: 只把服务端归一化后的
     * base_url / protocol 按 id 原位写回现有对象, 保持引用不变,
     * 输入框闭包依旧生效; 名称等非归一化字段以本地为准, 避免覆盖正在输入的内容 */
    for (const sp of (saved.providers || [])) {
      const lp = (state.providerCfg.providers || []).find(x => x.id === sp.id);
      if (!lp) continue;
      lp.base_url = sp.base_url;
      lp.protocol = sp.protocol;
    }
    provStatus("已保存");
    syncUtilityControls();   // 供应商改名/增删后刷新 side-call 下拉选项
    // 刷新 composer 模型下拉。模型改名/删除（防抖自动保存期间是常态）会让
    // 当前显示的键从列表里消失, syncLabel 找不到就把原始 provider|model 键
    // 铺在界面上（用户看到的"乱码"）。按会话显示链回填第一个仍存在的键,
    // 全部失效才走 loadSettings（同步全局 active）; active 也可能刚被改名,
    // 最后兜底选列表第一项——任何路径都不留裸键。
    const cur = modelDd.getValue();
    modelDd.setItems(modelItems(), cur);
    if (cur && !modelItems().some(i => i.value === cur)) {
      const run = curRun();
      const s = state.sessions.find(x => x.id === state.sessionId);
      const gd = state.globalDefaults;
      const candidates = [
        run ? run.modelKey : null,
        s && s.model_provider && s.model_id
          ? s.model_provider + "|" + s.model_id : null,
        gd.modelKey,
      ].filter(Boolean);
      const kept = candidates.find(k => modelItems().some(i => i.value === k));
      if (kept) {
        modelDd.setValue(kept);
      } else {
        await loadSettings();
        if (!modelItems().some(i => i.value === modelDd.getValue())) {
          const first = modelItems()[0];
          if (first) modelDd.setValue(first.value);
        }
        // loadSettings 已把 state.providerCfg 换成新对象图: 开着未关的供应商
        // 表单还握着旧图的闭包, 继续编辑会写进脱钩对象, 防抖保存发的是新图
        // （改动静默丢失、状态栏却报"已保存"）。此刻防抖已结束、无输入在途,
        // 重渲染表单对齐新配置, 焦点丢失可接受。
        renderProviderSettings();
      }
    }
  } catch (e) {
    provStatus("保存失败: " + e.message, true);
    toast("保存失败: " + e.message);
  }
}

async function saveSettings(patch) {
  try {
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      toast("设置失败: " + (err.detail || r.status));
      await loadSettings();   // 回显真实值
      return;
    }
    const s = await r.json();
    thinkDd.setValue(s.thinking_level);
    // 草稿态: 无会话, 显示全局默认（基础模式 + 计划开关双状态）
    if (!state.sessionId) {
      modeDd.setValue(mkModeValue(s.permission_mode || "prompt", !!s.permission_plan));
    }
    // 草稿态下 REST 修改的全局默认, 同步进快照（切会话/下次进草稿的兜底值）
    if (s.thinking_level != null) state.globalDefaults.thinkingLevel = s.thinking_level;
    if (s.permission_mode) state.globalDefaults.permissionMode = s.permission_mode;
    if (s.permission_plan != null) state.globalDefaults.permissionPlan = !!s.permission_plan;
    if (s.max_iterations != null) $("set-max-iter").value = String(s.max_iterations);
    if (s.provider_id && s.model_id) {
      state.globalDefaults.modelKey = s.provider_id + "|" + s.model_id;
      if (!state.sessionId) modelDd.setValue(state.globalDefaults.modelKey);
    }
    return s;
  } catch (e) { toast("设置失败: " + e.message); }
}

/* ============================================================
 * 初始化引导页: 无可用供应商配置时弹出, 填 API Key 后立即可用
 * ============================================================ */
function openOnboarding() {
  $("pane").dataset.view = "onboarding";
  setTimeout(() => $("ob-key").focus(), 50);
}
/* 初始化页: 协议切换 → Base URL 默认值联动（智谱 Coding Plan 三端点中
 * aulos 用得到两个; /api/v1 是 OpenAI Response 协议, 供 Codex, 不适用）。
 * 只改"用户还没手动输入过"的值, 避免覆盖用户粘贴的地址。 */
const OB_BASE_DEFAULTS = {
  anthropic: "https://open.bigmodel.cn/api/anthropic",
  openai: "https://open.bigmodel.cn/api/coding/paas/v4",
};
let _ob_base_touched = false;
$("ob-proto").addEventListener("change", () => {
  const baseInput = $("ob-base");
  if (!_ob_base_touched) baseInput.value = OB_BASE_DEFAULTS[$("ob-proto").value];
});
$("ob-base").addEventListener("input", () => { _ob_base_touched = true; });

async function saveOnboarding() {
  const key = $("ob-key").value.trim();
  const base = $("ob-base").value.trim();
  const model = $("ob-model").value.trim();
  const proto = $("ob-proto").value;
  const err = $("ob-err");
  err.textContent = "";
  if (!key) { err.textContent = "请填写 API Key"; return; }
  if (!base) { err.textContent = "请填写接口地址 Base URL"; return; }
  if (!model) { err.textContent = "请填写默认模型"; return; }   // 不发明默认值
  const btn = $("ob-save");
  btn.disabled = true;
  try {
    // 合并进现有配置: 只更新/追加 id=default 的供应商, 不动用户已配的其他条目
    const cfg = state.providerCfg || { providers: [], active: {} };
    const providers = [...(cfg.providers || [])];
    let prov = providers.find(p => p.id === "default");
    if (prov) {
      prov.api_key = key;
      prov.enabled = true;
      if (base) prov.base_url = base;
      prov.protocol = proto;   // 协议变化时覆盖旧值（init 页是显式选择）
      prov.models = prov.models || [];
      if (!prov.models.some(m => m.id === model)) prov.models.push({ id: model, name: model, tags: [] });
    } else {
      providers.push({
        id: "default", name: "默认供应商",
        base_url: base, api_key: key, enabled: true,
        protocol: proto,
        models: [{ id: model, name: model, tags: [] }],
      });
    }
    const r = await fetch("/api/providers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers, active: { provider: "default", model } }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    state.providerCfg = await r.json();
    state.configured = true;
    syncModelDropdown("default", model);
    $("pane").dataset.view = "chat";
    startDraft();   // 配置完成: 跳转新任务欢迎页
    $("input").focus();
  } catch (e) {
    err.textContent = "保存失败: " + e.message;
  } finally {
    btn.disabled = false;
  }
}
$("ob-save").onclick = saveOnboarding;
$("ob-key").addEventListener("keydown", ev => {
  ev.stopPropagation();
  if (ev.key === "Enter") saveOnboarding();
});
/* 设置导航项切换（当前只有"外观"一节, 结构预留多节扩展） */
document.querySelectorAll("#side-settings .nav-item").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("#side-settings .nav-item")
      .forEach(x => x.classList.toggle("on", x === b));
    document.querySelectorAll("#settings-page .sp-section-body").forEach(s => {
      s.style.display = s.dataset.section === b.dataset.section ? "" : "none";
    });
  };
});
document.addEventListener("keydown", ev => {
  if ($("pane").dataset.view !== "settings") return;
  if (ev.key === "Escape") { ev.preventDefault(); closeSettings(); }
});


/* ============================================================
 * 桌宠任务桥: 悬浮窗输入框 = 全功能任务入口(与主界面输入框同一条链路)
 * pet 发文本 → 专属会话「桌宠」(没有则建) → 完整 agent 轮次: 全局模型
 * + 工具。点歌由 music_play 工具执行(onToolResult 已接), 权限请求会顶到
 * 悬浮窗的"等你批条子"(点宠物批准)。轮次正文(text_delta)攒缓冲,
 * turn_done/error 时把最后一段回复回传给桌宠气泡。
 * 通道与桌宠状态转发同一条: xc-pet-cmd 的 storage 事件, to 字段分方向。
 * ============================================================ */
let petTaskSid = null;        // 桌宠专属会话 id(记忆在 localStorage, 失效重建)
let petReplyBuf = "";         // 本轮 assistant 正文累积
let petBridgeSeq = 0;

function petBridgeSend(cmd) {
  try {
    localStorage.setItem("xc-pet-cmd",
      JSON.stringify({ ...cmd, to: "pet", __n: ++petBridgeSeq }));
  } catch { }
}

/* 整轮正文可能多段(工具之间都有说明), 末段通常是收尾答复——取它。
 * 截 200: 聊天面板可滚动, 比气泡的 80 字宽裕 */
function petTaskReply() {
  const parts = petReplyBuf.split(/\n+/).map(s => s.trim()).filter(Boolean);
  petReplyBuf = "";
  return (parts[parts.length - 1] || "").slice(0, 200);
}

function petTaskObserve(msg) {
  if (msg.type === "text_delta") {
    petReplyBuf += msg.text || "";
  } else if (msg.type === "turn_done") {
    petBridgeSend({ type: "chat", text: msg.interrupted ? "已停" : petTaskReply() });
  } else if (msg.type === "error") {
    petReplyBuf = "";
    petBridgeSend({ type: "chat",
                    text: ("出错了: " + String(msg.message || "")).slice(0, 200) });
  }
}

/* 桌宠专属模型: 设置页「桌宠模型」存 xc-pet.aiProvider/aiModel, 主窗与
 * 悬浮窗同源共享。返回 "provider|model" 或空串(=跟随全局) */
function petModelKey() {
  try {
    const p = JSON.parse(localStorage.getItem("xc-pet") || "{}");
    if (p.aiProvider && p.aiModel) return `${p.aiProvider}|${p.aiModel}`;
  } catch { }
  return "";
}

/* 桌宠会话轮换上限: 单会话任务数到顶即换新——点歌/闲聊/任务全进同一个
 * 会话会无限膨胀, 压缩频繁触发、会话文件越滚越大。跨天也轮换。 */
const PET_SESSION_ROTATE_TASKS = 50;

async function petTaskRun(text) {
  // 轮换: 记住的会话跨了天 / 任务数到顶 → 弃旧建新, 旧的删掉
  // (桌宠会话不在任务列表显示, 只藏不删会纯漏盘)。删是尽力而为:
  // 失败也就是多留一个隐藏会话, 不挡新任务。
  const day = new Date().toDateString();
  let sid = localStorage.getItem("xc-pet-task-sid") || "";
  let count = parseInt(localStorage.getItem("xc-pet-task-count") || "0", 10) || 0;
  if (sid && (localStorage.getItem("xc-pet-task-day") !== day
              || count >= PET_SESSION_ROTATE_TASKS)) {
    const old = sid;
    sid = "";
    count = 0;
    localStorage.removeItem("xc-pet-task-sid");
    localStorage.removeItem("xc-pet-task-count");
    fetch(`/api/sessions/${old}`, { method: "DELETE" })
      .then(() => loadSessions()).catch(() => { });
  }
  // 会话定位: 记住的 id 还活着就复用; 会话列表尚未加载完时不误判
  // (空列表≠会话没了, 直接连, 服务端不认再重建不迟)
  const alive = sid && (state.sessions.length === 0
    || state.sessions.some(s => s.id === sid));
  if (!alive) {
    try {
      const r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // pet=true: 后端给该会话固化 danger-full-access + 关计划开关——
        // 桌宠是无人值守挂件, 权限弹卡等于故障（弹了没人批, 任务卡死）
        body: JSON.stringify({ workdir: "", pet: true }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      sid = (await r.json()).id;
    } catch (e) {
      petBridgeSend({ type: "chat", text: "任务没派出去: " + (e.message || e) });
      return;
    }
    try {
      await fetch(`/api/sessions/${sid}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "桌宠" }),
      });
    } catch { /* 命名失败不挡任务 */ }
    localStorage.setItem("xc-pet-task-sid", sid);
    loadSessions().catch(() => { });   // 侧栏立即可见, 不阻塞发送
  }
  localStorage.setItem("xc-pet-task-day", day);
  localStorage.setItem("xc-pet-task-count", String(count + 1));
  petTaskSid = sid;
  petReplyBuf = "";
  connectWs(sid);   // 后台会话也要有 WS 才能收发(已有则复用)
  // 旧桌宠会话迁移: 固化权限之前创建的会话没有权限记录（回落全局默认,
  // 可能是 prompt+plan → 播歌弹审批）。走 WS set_permission_mode 幂等
  // 补一条并同步 runtime; 新建的会话本来就带这条, 覆盖无副作用。
  // 必须在 connectWs 之后: sendWs 需要已就绪的 run.ws, 否则静默丢弃。
  sendWs({ type: "set_permission_mode",
           mode: "danger-full-access", plan: false }, sid);
  // 「桌宠」会话跟随桌宠模型: 每次派活前都 sync 一条 set_model——
  // 用户改了设置立即生效, 且后端按会话缓存 client, 等值是轻操作。
  // 配置过期的(供应商被删/禁用)本地能查就先拦下, 免得弹错误事件
  const mk = petModelKey();
  if (mk) {
    const bar = mk.indexOf("|");
    const pid = mk.slice(0, bar), mid = mk.slice(bar + 1);
    const provs = (state.providerCfg && state.providerCfg.providers) || null;
    const prov = provs && provs.find(p => p.id === pid && p.enabled !== false);
    if (!provs || (prov && (prov.models || []).some(m => m.id === mid))) {
      sendWs({ type: "set_model", provider_id: pid, model_id: mid }, sid);
    }
  }
  sendWs({ type: "user", text, qid: genQid() }, sid);
}

window.addEventListener("storage", (e) => {
  if (e.key !== "xc-pet-cmd" || !e.newValue) return;
  let cmd = null;
  try { cmd = JSON.parse(e.newValue); } catch { return; }
  if (!cmd || cmd.to !== "main") return;
  if (cmd.type === "task") {
    const text = String(cmd.text || "").trim();
    if (text) petTaskRun(text.slice(0, 2000));
  } else if (cmd.type === "music_toggle") {
    // 桌宠点击 = 开/关音乐: 结果回传, 桌宠气泡回显歌名/暂停态
    const st = window.aulosMusicToggle ? window.aulosMusicToggle() : null;
    petBridgeSend({
      type: "chat",
      text: !st ? "还没选歌, 去面板点一首吧"
        : st.playing ? "♪ " + String(st.title || "").slice(0, 40)
        : "♪ 暂停了",
    });
  }
});

/* ============================================================
 * 启动
 * ============================================================ */
(async function init() {
  await loadSettings();
  await loadSessions();
  refreshSkillCache();   // 斜杠补全数据源: 预取一次（cwd 视图; 切会话后按需重拉）
  // 默认选最近的会话（列表已倒序，第一个即最新）; 没有会话则进入草稿态。
  // 桌宠专属会话要跳过——它不在任务列表里, 却常常是最新(悬浮输入框一直
  // 在用), 不跳过的话每次重启都自动打开它
  const first = state.sessions.find(s => s.id !== petTaskSidSaved());
  if (first) await selectSession(first.id);
  else startDraft();
  if (state.configured === false) openOnboarding();   // 首次使用: 先引导配置供应商
  $("input").focus();
  initUpdateCheck();   // 桌面壳: 静默检查更新（浏览器/源码运行无桥, 内部直接跳过）
})();
(() => {
/* ===== 悬浮循环滚动(跑马灯): 侧栏被截断的项目名 / 任务标题, 悬浮时循环滚动展示全文 ===== */
  const HS_SEL = ".session-item .title, .project-item .p-name";
  const HS_SPEED = 40;    // 滚动速度 px/s
  const HS_GAP = 56;      // 首尾相接处的间距 px
  const HS_DELAY = 300;   // 悬停多久后开始滚动 ms
  let hsCur = null;       // { el, html, timer }

  if (!document.getElementById("hs-marquee-style")) {   // 一次性注入样式
    const st = document.createElement("style");
    st.id = "hs-marquee-style";
    st.textContent =
      ".hs-on{text-overflow:clip}" +
      ".hs-track{display:inline-flex;white-space:nowrap;will-change:transform;animation:hs-marquee 10s linear infinite}" +
      ".hs-track>span{flex:none;padding-right:" + HS_GAP + "px}" +
      "@keyframes hs-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}";
    document.head.appendChild(st);
  }

  const hsStop = () => {
    if (!hsCur) return;
    clearTimeout(hsCur.timer);
    const el = hsCur.el, html = hsCur.html;
    hsCur = null;
    if (!el.isConnected) return;   // 列表已重渲染, 元素已丢弃, 无需还原
    el.classList.remove("hs-on");
    el.innerHTML = html;           // 移除轨道, 还原原始内容
  };

  document.addEventListener("pointerover", e => {
    const el = e.target.closest && e.target.closest(HS_SEL);
    if (hsCur && el === hsCur.el) return;
    hsStop();
    if (!el) return;
    hsCur = { el, html: el.innerHTML, timer: setTimeout(() => {
      const dist = el.scrollWidth - el.clientWidth;
      if (!el.isConnected || dist < 3) return;   // 未截断(或已被重渲染移除)则不滚动
      const dur = Math.max(3, Math.round((el.scrollWidth + HS_GAP) / HS_SPEED));   // 一圈的秒数
      el.classList.add("hs-on");
      el.innerHTML =
        '<span class="hs-track" style="animation-duration:' + dur + 's">' +
        "<span>" + hsCur.html + "</span><span>" + hsCur.html + "</span></span>";
    }, HS_DELAY) };
  });

  document.addEventListener("pointerout", e => {
    if (hsCur && !hsCur.el.contains(e.relatedTarget)) hsStop();   // 离开该标题才停
  });
  window.addEventListener("blur", () => hsStop());
})();
