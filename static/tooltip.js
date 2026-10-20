/* ============================================================
 * tooltip.js — 统一悬浮提示(接管原生 title) + 侧栏标题跑马灯
 *
 * 从 app.js 外迁的功能域 (拆分路线见 README「代码组织与拆分路线」)。
 * 经典脚本, 与 app.js 共享全局作用域; 由 index.html 在 app.js 之前
 * defer 加载——两个块都在加载期自挂 document/window 监听并自建 DOM,
 * 不依赖 app.js 的任何符号 (反向: app.js 动态创建的节点天然被覆盖)。
 *
 * 读的前置全局: 无
 * 暴露的全局:   tipShow / tipHide / tipIgnoreNextScroll (供程序化滚动方调用)
 * ============================================================ */
/* ============================================================
 * 统一悬浮提示: 接管原生 title（系统白框提示又慢又丑, 也无法换肤）
 * 悬停带 title 的元素时显示玻璃小气泡; 悬浮期间临时摘掉原生 title
 * ============================================================ */
const tip = document.createElement("div");
tip.id = "tip";
document.body.appendChild(tip);
let tipTimer = null, tipAnchor = null, tipSaved = null;

function tipShow(el) {
  const nativeTitle = el.getAttribute("title");
  const text = nativeTitle || el.getAttribute("data-tip") || "";
  if (!text) return;
  tipSaved = { el, title: nativeTitle || null };   // 仅原生 title 需要压住/还原;
  if (nativeTitle) el.removeAttribute("title");    // data-tip 不能回写 title, 否则动态
  tip.textContent = text;                          // 改文案后会被旧 title 永远盖住
  tip.classList.add("show");
  const r = el.getBoundingClientRect();
  const x = Math.max(8, Math.min(r.left + r.width / 2 - tip.offsetWidth / 2, window.innerWidth - tip.offsetWidth - 8));
  // 默认在元素上方; data-tip-pos="below" 强制朝下（贴窗口顶缘的按钮,
  // 上方是系统标题栏按钮区, 朝上会叠上去）; 顶部放不下也自动翻下方
  const below = el.getAttribute("data-tip-pos") === "below";
  let y = below ? r.bottom + 7 : r.top - tip.offsetHeight - 7;
  if (y < 8) y = r.bottom + 7;            // 顶部放不下: 移到下方
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
function tipHide() {
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
  tip.classList.remove("show");
  if (tipSaved) {
    if (tipSaved.title) tipSaved.el.setAttribute("title", tipSaved.title);
    tipSaved = null;
  }
}
/* 程序化滚动抑制窗口: scrollToBottom 贴底跟随 / 思考流贴尾这类自动滚动
 * 每个 delta 都产生 scroll 事件, capture 监听会连人带计时器一起杀——流式
 * 期间全站 tooltip 永远弹不出 (2026-10-20 事故)。程序化滚动前调用本函数
 * 开一个小窗口, 窗口内的 scroll 事件忽略; 用户手动滚动 (wheel/拖滑块) 不
 * 经过此路径, 即滚即隐的行为保持不变。窗口取短时效顺延制: 滚动方按各自
 * delta 节奏续期, 流一停 ≤ 时效即恢复原判。 */
let tipScrollIgnoreUntil = 0;
window.tipIgnoreNextScroll = function (ms) {
  tipScrollIgnoreUntil = Date.now() + Math.max(0, ms | 0);
};
document.addEventListener("mouseover", ev => {
  const el = ev.target.closest("[title], [data-tip]");
  if (el === tipAnchor) return;   // 在同一元素内移动: 不重置计时
  // 移到当前锚点内部没有提示的子元素: 保持现状, 避免"摘title/还原"抖动给原生提示钻空子
  if (!el && tipAnchor && tipAnchor.contains(ev.target)) return;
  tipAnchor = el;
  tipHide();
  if (!el) return;
  tipTimer = setTimeout(() => { tipTimer = null; tipShow(el); }, 350);
});
document.addEventListener("mousedown", () => { tipAnchor = null; tipHide(); }, true);
window.addEventListener("blur", tipHide);
document.addEventListener("scroll", () => {
  if (Date.now() < tipScrollIgnoreUntil) return;   // 程序化滚动窗口内: 不杀气泡/计时器
  tipHide();
}, true);
