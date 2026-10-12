// tests/web/thinking-live.test.js — "思考中…"胶囊的实时思考文本（滚动窗口）
//
// 契约:
//   1. thinking_delta 追加到思考行的 .t-live 容器, 文本累计;
//   2. OpenAI 线（reasoning_content 只有 delta 没有 start）→ 懒建思考行;
//   3. 正文已开流时迟到的 delta 被忽略, 不污染正文;
//   4. thinking_end 收口重建 innerHTML, .t-live 随之消失;
//   5. 超长累计被裁剪到尾部窗口（防长思考吃内存）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
  "desktop.js", "bubbles.js", "msg-extras.js", "ws-handlers.js",
  "sidebar.js", "settings-page.js"];   // = index.html 完整 defer 序

function loadApp() {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__state = () => state;");
  return window;
}

function setup(sid) {
  const w = loadApp();
  w.__state().sessionId = sid;
  w.runOf(sid).busy = true;
  return w;
}

test("thinking_delta 累计进 .t-live, 思考行仍保持 thinking 态", () => {
  const w = setup("s-live");
  const col = w.colOf("s-live");
  w.onThinkingStart({}, "s-live");
  w.onThinkingDelta({ text: "先看" }, "s-live");
  w.onThinkingDelta({ text: "看目录" }, "s-live");
  const live = col.querySelector(".think-row.thinking .t-live");
  assert.ok(live, "思考行里出现 .t-live");
  assert.equal(live.textContent, "先看看目录");
});

test("OpenAI 线: 只有 delta 没有 start → 懒建思考行并挂上列尾", () => {
  const w = setup("s-oai");
  const col = w.colOf("s-oai");
  w.onThinkingDelta({ text: "想一下" }, "s-oai");
  const row = col.querySelector(".think-row.thinking");
  assert.ok(row, "delta 自建思考行");
  assert.equal(row.querySelector(".t-live").textContent, "想一下");
  assert.equal(w.runOf("s-oai").curThinking.el, row, "行句柄登记进 curThinking");
});

test("正文已开流: 迟到 delta 忽略, 不建思考行也不碰正文", () => {
  const w = setup("s-late");
  const col = w.colOf("s-late");
  const run = w.runOf("s-late");
  run.curBubble = w.addAssistantBubble("", "", col);
  run.curBubble._raw = "正文";
  w.onThinkingDelta({ text: "不该出现" }, "s-late");
  assert.equal(col.querySelector(".t-live"), null);
  assert.equal(run.curBubble._raw, "正文");
});

test("thinking_end 收口: .t-live 消失, 行定格为耗时文案", () => {
  const w = setup("s-end");
  const col = w.colOf("s-end");
  w.onThinkingStart({}, "s-end");
  w.onThinkingDelta({ text: "想想想" }, "s-end");
  w.onThinkingEnd({ duration_ms: 3200 }, "s-end");
  const row = col.querySelector(".think-row");
  assert.equal(row.querySelector(".t-live"), null, "实时文本随收口清除");
  assert.ok(!row.classList.contains("thinking"), "退出动画态");
  assert.match(row.textContent, /思考 · 持续了 3 秒/);
});

test("超长思考: raw 裁剪到窗口上限, 显示只留尾部", () => {
  const w = setup("s-big");
  w.onThinkingStart({}, "s-big");
  const chunk = "x".repeat(5000);
  for (let i = 0; i < 6; i++) w.onThinkingDelta({ text: chunk }, "s-big");
  const run = w.runOf("s-big");
  assert.ok(run.curThinking.raw.length <= 20000, "raw 封顶 20000");
  assert.equal(run.curThinking.live.textContent.length, 4000, "显示窗口只留尾 4000");
});
