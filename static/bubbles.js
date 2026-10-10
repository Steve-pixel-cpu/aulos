/* ============================================================
 * bubbles.js — 气泡工厂: 用户/AI 气泡 · 图片灯箱 · 排队卡片
 *
 * 从 app.js 外迁的功能域 (拆分路线见 README「代码组织与拆分路线」)。
 * 经典脚本, 由 index.html 在 app.js 之后 defer 加载: 渲染层只**被**
 * 核心调用 (addUserBubble/addAssistantBubble/renderQueueCards 从
 * WS 分派与发送链路进来), 自己不反向驱动核心 —— 运行时解引用,
 * 加载序天然安全。
 *
 * 读的前置全局: state / $ / colOf / scrollToBottom / decorateCode /
 *               decorateTables / sendWs / curRun / attachDraftOf /
 *               setAttachDraft / saveCurrentInput / autoGrow /
 *               updateSendBtn / fileChipEl / iconUrl / mmScheduleRebuild
 * 暴露的全局:   msgCol / addUserBubble / addAssistantBubble /
 *               openLightbox / renderQueueCards / editQueued / removeQueued
 * ============================================================ */
/* ============================================================
 * 气泡工厂
 * ============================================================ */
function msgCol() {
  if (pinnedCol) return pinnedCol;   // 历史回放: 固定写入目标列
  const id = (state.draft || !state.sessionId) ? "__draft__" : state.sessionId;
  return colOf(id);
}

function addUserBubble(text, attachments, col, ts, qid) {
  // 兼容旧签名 addUserBubble(text, col): 第二参传的是列元素
  if (attachments instanceof HTMLElement) { col = attachments; attachments = null; }
  const div = document.createElement("div");
  div.className = "msg user";
  div._text = text;
  div._qid = qid || null;                     // 计划接力: turn_started 回放按 qid 去重
  // 去重选择器查的是 DOM 属性: JS 字段不会自动映射, 必须显式 setAttribute
  if (qid) div.setAttribute("_qid", qid);
  div._ts = ts || new Date().toISOString();   // minimap 相对时间用（历史回放传落盘 ts）
  const b = document.createElement("div");
  b.className = "bubble";
  if (text) {
    const t = document.createElement("div");
    t.className = "u-text";
    t.textContent = text;   // 用户输入永远纯文本
    b.appendChild(t);
  }
  // 附件: 图片缩略图网格 + 文件 chip
  const atts = attachments || [];
  const imgs = atts.filter(a => a.kind === "image");
  const files = atts.filter(a => a.kind === "file");
  if (imgs.length) {
    const grid = document.createElement("div");
    grid.className = "u-imgs" + (imgs.length === 1 ? " solo" : "");   // 单图放大展示
    imgs.forEach((im, i) => {
      const thumb = document.createElement("img");
      thumb.className = "u-img";
      thumb.alt = im.name || "";
      thumb.title = "点击查看大图";
      thumb.loading = "lazy";
      thumb.src = "data:" + (im.media_type || "image/png") + ";base64," + (im.data || "");
      thumb.onclick = () => openLightbox(imgs, i);   // 传整组: 灯箱内可 ←/→ 切换
      grid.appendChild(thumb);
    });
    b.appendChild(grid);
  }
  for (const f of files) b.appendChild(fileChipEl(f.name));
  div.appendChild(b);
  (col || msgCol()).appendChild(div);
  mmScheduleRebuild();
  scrollToBottom();
  return b;
}

/* ---------- 图片灯箱: 缩放 / 拖动 / 多图切换, 点遮罩关闭, Esc 退出 ---------- */
let _lightbox = null;
function openLightbox(list, index) {
  // 兼容旧签名 openLightbox(att): 单对象 → 包成数组
  const single = !Array.isArray(list) ? list : null;
  const imgs = single ? [single] : (list || []);
  if (!imgs.length) return;
  let idx = Math.max(0, Math.min(single ? 0 : (index || 0), imgs.length - 1));
  if (_lightbox) _lightbox.remove();

  const ov = document.createElement("div");
  ov.id = "img-lightbox";
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  const cap = document.createElement("div");
  cap.className = "lb-cap";
  ov.append(img, cap);

  // 视图状态: scale 为相对适配尺寸的倍率; tx/ty 平移像素。切图即重置。
  let scale = 1, tx = 0, ty = 0;
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "lb-zoom";
  const apply = () => {
    img.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
    zoomLabel.textContent = Math.round(scale * 100) + "%";
  };
  const clampScale = v => Math.max(0.2, Math.min(v, 8));
  // 平移范围: 图像中心最多拖出「自身半径 + 半个视口」, 保证总能拖回来
  const clampPan = () => {
    const r = img.getBoundingClientRect();
    const mx = r.width / 2 + innerWidth / 2;
    const my = r.height / 2 + innerHeight / 2;
    tx = Math.max(-mx, Math.min(mx, tx));
    ty = Math.max(-my, Math.min(my, ty));
  };
  const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };
  // 以视口点 (cx,cy)(相对图片中心) 为锚点缩放, 鼠标下的像素保持不动
  const zoomTo = (ns, cx, cy) => {
    const os = scale;
    scale = clampScale(ns);
    if (cx !== undefined && scale !== os) {
      tx = (tx - cx) * (scale / os) + cx;
      ty = (ty - cy) * (scale / os) + cy;
    }
    clampPan(); apply();
  };

  const SVG = {
    minus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    reset: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    prev: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    next: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>'
  };

  const mkBtn = (svg, tip, fn, cls) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lb-btn" + (cls ? " " + cls : "");
    btn.innerHTML = svg;
    btn.dataset.tip = tip;
    btn.onclick = e => { e.stopPropagation(); fn(); };
    return btn;
  };

  // 顶部工具条: − / 百分比 / ＋ / 重置
  const toolbar = document.createElement("div");
  toolbar.className = "lb-tools";
  toolbar.append(
    mkBtn(SVG.minus, "缩小 (−)", () => zoomTo(scale / 1.25)),
    zoomLabel,
    mkBtn(SVG.plus, "放大 (+)", () => zoomTo(scale * 1.25)),
    mkBtn(SVG.reset, "重置 (双击图片)", reset)
  );

  // 多图切换钮: 单图隐藏
  const multi = imgs.length > 1;
  const nav = d => { idx = (idx + d + imgs.length) % imgs.length; show(); };
  const prevBtn = mkBtn(SVG.prev, "上一张 (←)", () => nav(-1), "lb-nav prev");
  const nextBtn = mkBtn(SVG.next, "下一张 (→)", () => nav(1), "lb-nav next");
  if (!multi) { prevBtn.style.display = "none"; nextBtn.style.display = "none"; }

  const show = () => {
    const att = imgs[idx];
    reset();
    img.src = "data:" + (att.media_type || "image/png") + ";base64," + (att.data || "");
    img.alt = att.name || "";
    cap.textContent = (multi ? (idx + 1) + "/" + imgs.length + " · " : "") + (att.name || "");
  };

  // 滚轮缩放(锚点=鼠标); Ctrl+滚轮留给浏览器缩放
  ov.addEventListener("wheel", e => {
    if (e.ctrlKey) return;
    e.preventDefault();
    const r = img.getBoundingClientRect();
    zoomTo(
      scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15),
      e.clientX - (r.left + r.width / 2),
      e.clientY - (r.top + r.height / 2)
    );
  }, { passive: false });

  // 拖动平移; 未移动的纯点击(遮罩/图片/标题)关闭, 按钮除外
  let drag = null;
  ov.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest(".lb-btn")) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx, ty, moved: false };
    try { ov.setPointerCapture(e.pointerId); } catch (_) {}
  });
  ov.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    tx = drag.tx + dx; ty = drag.ty + dy;
    clampPan(); apply();
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    if (!moved && !e.target.closest(".lb-btn")) close();
  };
  ov.addEventListener("pointerup", endDrag);
  ov.addEventListener("pointercancel", () => { drag = null; });

  // 双击图片: 1x ↔ 2x(以双击点为中心)
  img.addEventListener("dblclick", e => {
    const r = img.getBoundingClientRect();
    if (scale !== 1) reset();
    else zoomTo(2, e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
  });

  const onEsc = e => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft" && multi) nav(-1);
    else if (e.key === "ArrowRight" && multi) nav(1);
    else if (e.key === "+" || e.key === "=") zoomTo(scale * 1.25);
    else if (e.key === "-") zoomTo(scale / 1.25);
    else if (e.key === "0") reset();
  };
  const onResize = () => { clampPan(); apply(); };
  const close = () => {
    document.removeEventListener("keydown", onEsc);
    window.removeEventListener("resize", onResize);
    ov.remove();
    _lightbox = null;
  };

  document.addEventListener("keydown", onEsc);
  window.addEventListener("resize", onResize);
  ov.append(toolbar, prevBtn, nextBtn);
  document.body.appendChild(ov);
  _lightbox = ov;
  show();
}

/* ---------- 待发送卡片: ↑立即(插队) / 编辑(放回输入框) / 删除 ---------- */
const Q_PROMOTE_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>';

function renderQueueCards() {
  const box = $("queue-cards");
  if (!box) return;
  box.innerHTML = "";
  const run = curRun();
  const items = run ? run.queue : [];
  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "q-card";
    const t = document.createElement("span");
    t.className = "q-text";
    t.textContent = item.text || "(仅附件)";
    t.dataset.tip = item.text || "(仅附件)";   // 悬停看全文
    card.appendChild(t);
    // 附件 badge: 🖼2 / 📄1
    const atts = item.attachments || [];
    const nImg = atts.filter(a => a.kind === "image").length;
    const nFile = atts.filter(a => a.kind === "file").length;
    if (nImg || nFile) {
      const badge = document.createElement("span");
      badge.className = "q-badge";
      badge.textContent =
        (nImg ? "\uD83D\uDDBC" + nImg : "")
        + (nImg && nFile ? " " : "")
        + (nFile ? "\uD83D\uDCC4" + nFile : "");
      card.appendChild(badge);
    }
    const promote = document.createElement("button");
    promote.type = "button";
    promote.className = "q-promote";
    promote.innerHTML = Q_PROMOTE_SVG + "<span>立即</span>";
    promote.dataset.tip = "打断当前回复, 待发送的全部消息合并立即发送";
    promote.onclick = () => {
      card.classList.add("promoting");   // 已登记插队, 等当前回复收尾
      sendWs({ type: "queue_promote", qid: item.qid });
    };
    card.appendChild(promote);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "q-ico";
    edit.innerHTML = PENCIL_SMALL_SVG;
    edit.dataset.tip = "编辑";
    edit.onclick = () => editQueued(item.qid);
    card.appendChild(edit);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "q-ico q-del";
    del.innerHTML = TRASH_SMALL_SVG;
    del.dataset.tip = "删除";
    del.onclick = () => removeQueued(item.qid);
    card.appendChild(del);
    box.appendChild(card);
  });
}

function editQueued(qid) {
  const run = curRun();
  if (!run) return;
  const idx = run.queue.findIndex(it => it.qid === qid);
  if (idx < 0) return;
  const [item] = run.queue.splice(idx, 1);
  sendWs({ type: "queue_remove", qid });
  const input = $("input");
  input.value = input.value ? input.value + "\n" + (item.text || "") : (item.text || "");
  autoGrow(input);
  input.focus();
  // 附件放回附件草稿, 不丢
  const atts = item.attachments || [];
  if (atts.length) setAttachDraft(attachDraftOf().concat(atts));
  saveCurrentInput();
  updateSendBtn();
  renderQueueCards();
}

function removeQueued(qid) {
  const run = curRun();
  if (!run) return;
  const idx = run.queue.findIndex(it => it.qid === qid);
  if (idx < 0) return;
  run.queue.splice(idx, 1);
  sendWs({ type: "queue_remove", qid });
  renderQueueCards();
}

function addAssistantBubble(html, raw, col) {
  const div = document.createElement("div");
  div.className = "msg assistant";
  const avatar = document.createElement("img");
  avatar.className = "avatar";
  avatar.src = iconUrl();
  avatar.alt = "";
  const b = document.createElement("div");
  b.className = "bubble";
  b.innerHTML = html || "";
  decorateCode(b);
  decorateTables(b);
  div.appendChild(avatar);
  div.appendChild(b);
  (col || msgCol()).appendChild(div);
  scrollToBottom();
  return b;
}
