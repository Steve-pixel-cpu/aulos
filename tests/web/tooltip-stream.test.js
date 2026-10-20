// tests/web/tooltip-stream.test.js — 流式输出期间悬浮提示 (tooltip) 不被程序化滚动杀死
//
// 契约:
//   1. 基线: 悬停带 data-tip 的元素 350ms 后 #tip 弹出并显示文案;
//   2. 回归保护: 无抑制时 scroll 事件隐藏已显示的 tooltip / 清掉挂起中的计时器;
//   3. 核心: 程序化滚动 (scrollToBottom 贴底跟随) 在抑制窗口内产生的 scroll
//      事件不杀 tooltip——既不清挂起计时器, 也不隐藏已弹出的气泡;
//   4. 抑制窗口过期后 scroll 恢复"即滚即隐";
//   5. scrollToBottom 在写 scrollTop 前注册抑制窗口;
//   6. 思考流贴尾 (scrollLeft) 同样注册抑制窗口。
//
// 回归背景: 2026-10-20 — tooltip.js 对 document 挂 capture 级 scroll 监听
// 无条件 tipHide(); 流式期间每个 text_delta 都 scrollToBottom() → 贴底跟随
// 每个 delta 都产生 scroll 事件 → 350ms 计时器永远跑不满, 全站悬浮提示
// 整个流式期间无法弹出。修复: 程序化滚动前调用 tipIgnoreNextScroll(120)
// 开抑制窗口, 窗口内的 scroll 事件忽略; 手动滚动行为不变。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
// = index.html 完整 defer 序 (tooltip.js 按真实顺序插在 ui-dialogs 之后)
const FILES = ["i18n/zh.js", "i18n/en.js", "i18n/i18n.js", "ui-dialogs.js", "tooltip.js",
  "notify.js", "app.js", "settings-extras.js", "desktop.js", "bubbles.js",
  "msg-extras.js", "ws-handlers.js", "sidebar.js", "settings-page.js"];

function setup() {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__state = () => state;");
  return window;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const tipEl = w => w.document.getElementById("tip");
const messages = w => w.document.getElementById("messages");

function hover(w, el) {
  el.dispatchEvent(new w.MouseEvent("mouseover", { bubbles: true }));
}

/* 把锚点移到无提示元素上: tooltip.js 对同一锚点的重复 mouseover 早退不重挂计时器 */
function hoverAway(w) {
  messages(w).dispatchEvent(new w.MouseEvent("mouseover", { bubbles: true }));
}

test("基线: 悬停 data-tip 元素 350ms 后气泡弹出且文案正确", async () => {
  const w = setup();
  const btn = w.document.getElementById("btn-send");
  hover(w, btn);
  assert.equal(tipEl(w).classList.contains("show"), false, "350ms 内不弹");
  await wait(380);
  assert.equal(tipEl(w).classList.contains("show"), true, "350ms 后弹出");
  assert.equal(tipEl(w).textContent, btn.getAttribute("data-tip"), "文案取自 data-tip");
});

test("回归保护: 无抑制时 scroll 即隐, 挂起计时器被清", async () => {
  const w = setup();
  const btn = w.document.getElementById("btn-send");

  hover(w, btn);
  await wait(380);
  assert.equal(tipEl(w).classList.contains("show"), true);
  messages(w).dispatchEvent(new w.Event("scroll"));
  assert.equal(tipEl(w).classList.contains("show"), false, "scroll 隐藏已显示气泡");

  // 挂起中 (<350ms) 的计时器同样被清: 移锚 → 重挂 → 100ms 时来 scroll
  hoverAway(w);
  hover(w, btn);
  await wait(100);
  messages(w).dispatchEvent(new w.Event("scroll"));
  await wait(320);
  assert.equal(tipEl(w).classList.contains("show"), false, "计时器被 scroll 清掉, 不再弹出");
});

test("核心: 流式贴底滚动 (scrollToBottom) 不杀气泡、不清挂起计时器", async () => {
  const w = setup();
  const btn = w.document.getElementById("btn-send");

  // 场景 A: 气泡已显示, 流式贴底跟随连续滚动 (每个 delta 一次)
  hover(w, btn);
  await wait(380);
  assert.equal(tipEl(w).classList.contains("show"), true);
  for (let i = 0; i < 3; i++) {
    w.scrollToBottom();   // 生产路径: 非 force, nearBottom 默认 true
    messages(w).dispatchEvent(new w.Event("scroll"));
  }
  assert.equal(tipEl(w).classList.contains("show"), true, "流式贴底滚动不隐藏气泡");

  // 场景 B: 计时器挂起期间来 delta, 计时器不被清, 到点照常弹出
  hoverAway(w);
  const btn2 = w.document.getElementById("btn-pet");
  hover(w, btn2);
  await wait(100);
  w.scrollToBottom();
  messages(w).dispatchEvent(new w.Event("scroll"));
  await wait(320);   // hover 后 420ms > 350ms
  assert.equal(tipEl(w).classList.contains("show"), true, "挂起计时器不被程序化滚动清掉");
  assert.equal(tipEl(w).textContent, btn2.getAttribute("data-tip"));
});

test("抑制窗口过期后 scroll 恢复即滚即隐", async () => {
  const w = setup();
  const btn = w.document.getElementById("btn-send");
  hover(w, btn);
  await wait(380);
  assert.equal(tipEl(w).classList.contains("show"), true);
  w.tipIgnoreNextScroll(30);
  await wait(60);   // 窗口已过期
  messages(w).dispatchEvent(new w.Event("scroll"));
  assert.equal(tipEl(w).classList.contains("show"), false, "窗口过期后 scroll 正常隐藏");
});

test("scrollToBottom 在写 scrollTop 前注册抑制窗口", () => {
  const w = setup();
  const calls = [];
  w.tipIgnoreNextScroll = ms => calls.push(ms);   // 桩: 实现须按 window 属性查找
  w.scrollToBottom(true);
  assert.ok(calls.length >= 1, "scrollToBottom 调用了 tipIgnoreNextScroll");
});

test("思考流贴尾 (scrollLeft) 同样注册抑制窗口", () => {
  const w = setup();
  w.__state().sessionId = "s-tip";
  w.runOf("s-tip").busy = true;
  w.onThinkingStart({}, "s-tip");
  w.onThinkingDelta({ text: "第一段" }, "s-tip");   // 建 live 行 (此步走 scrollToBottom)
  const calls = [];
  w.tipIgnoreNextScroll = ms => calls.push(ms);
  w.onThinkingDelta({ text: "第二段" }, "s-tip");   // 此步只走 textContent + scrollLeft 贴尾
  assert.ok(calls.length >= 1, "贴尾滚动前注册了抑制窗口");
});
