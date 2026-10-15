// tests/web/thinking-live.test.js — "思考中…"胶囊同一行的实时思考文本（框外右格）
//
// 契约:
//   1. thinking_delta 首个增量把胶囊就地包进 .think-live-wrap(flex 行):
//      左格胶囊、右格 .think-live 文本——文本在胶囊框外、同一行;
//   2. OpenAI 线（reasoning_content 只有 delta 没有 start）→ 懒建思考行再包装;
//   3. 正文已开流时迟到的 delta 被忽略, 不污染正文;
//   4. thinking_end 收口: 包装行拆除、胶囊归位定格为耗时文案、文本消失;
//   5. 超长累计被裁剪到尾部窗口（防长思考吃内存）;
//   6. 乐观胶囊被撤（正文/工具先到）时, 文本与包装行一起消失、胶囊一并移除。
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

test("thinking_delta 与胶囊同一行: 胶囊在左、文本在右(框外), 文本累计", () => {
  const w = setup("s-live");
  const col = w.colOf("s-live");
  w.onThinkingStart({}, "s-live");
  const row = col.querySelector(".think-row.thinking");
  w.onThinkingDelta({ text: "先看" }, "s-live");
  w.onThinkingDelta({ text: "看目录" }, "s-live");
  const wrap = col.querySelector(".think-live-wrap");
  assert.ok(wrap, "出现同一行的包装层");
  assert.equal(wrap.children.length, 2, "包装层 = 胶囊 + 文本两格");
  assert.equal(wrap.children[0], row, "左格是胶囊(位置就地不变)");
  const live = wrap.children[1];
  assert.equal(live.className, "think-live", "右格是实时文本");
  assert.equal(row.querySelector(".think-live"), null, "文本不在胶囊框内");
  assert.equal(live.textContent, "先看看目录");
});

test("OpenAI 线: 只有 delta 没有 start → 懒建思考行并与文本同一行", () => {
  const w = setup("s-oai");
  const col = w.colOf("s-oai");
  w.onThinkingDelta({ text: "想一下" }, "s-oai");
  const wrap = col.querySelector(".think-live-wrap");
  assert.ok(wrap, "delta 自建思考行并包进行");
  assert.ok(wrap.children[0].classList.contains("think-row"), "左格思考行");
  assert.equal(wrap.children[1].textContent, "想一下");
  assert.equal(w.runOf("s-oai").curThinking.el, wrap.children[0],
    "行句柄登记进 curThinking");
});

test("正文已开流: 迟到 delta 忽略, 不建思考行也不碰正文", () => {
  const w = setup("s-late");
  const col = w.colOf("s-late");
  const run = w.runOf("s-late");
  run.curBubble = w.addAssistantBubble("", "", col);
  run.curBubble._raw = "正文";
  w.onThinkingDelta({ text: "不该出现" }, "s-late");
  assert.equal(col.querySelector(".think-live"), null);
  assert.equal(col.querySelector(".think-row"), null);
  assert.equal(run.curBubble._raw, "正文");
});

test("thinking_end 收口: 拆包装行、胶囊归位定格耗时文案、文本消失", () => {
  const w = setup("s-end");
  const col = w.colOf("s-end");
  w.onThinkingStart({}, "s-end");
  w.onThinkingDelta({ text: "想想想" }, "s-end");
  w.onThinkingEnd({ duration_ms: 3200 }, "s-end");
  assert.equal(col.querySelector(".think-live-wrap"), null, "包装行拆除");
  assert.equal(col.querySelector(".think-live"), null, "实时文本随收口清除");
  const row = col.querySelector(".think-row");
  assert.equal(row.parentNode, col, "胶囊归位回消息列");
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

test("thinking_end 缺失兜底: 正文先到 → 悬空真思考行就地收口(客户端计时)", () => {
  // GLM 兼容层偶发整条流不发 content_block_stop → thinking_end 永远不来,
  // 前端"思考中…"+实时文本冻在正文上方(20261014 现场)。正文/工具即思考
  // 结束的实证: 就地按客户端计时收口, 胶囊定格为耗时文案。
  const w = setup("s-dangling-text");
  const col = w.colOf("s-dangling-text");
  w.onThinkingStart({}, "s-dangling-text");
  w.onThinkingDelta({ text: "想完这一步" }, "s-dangling-text");
  w.onTextDelta({ text: "正文来了" }, "s-dangling-text");
  assert.equal(col.querySelector(".think-live"), null, "实时文本已撤");
  assert.equal(col.querySelector(".think-live-wrap"), null, "包装行拆除");
  const row = col.querySelector(".think-row");
  assert.ok(row, "胶囊保留定格, 不像乐观胶囊那样整个移除");
  assert.ok(!row.classList.contains("thinking"), "退出动画态");
  assert.match(row.textContent, /思考 · 持续了/);
});

test("thinking_end 缺失兜底: 工具先到 → 悬空真思考行就地收口", () => {
  const w = setup("s-dangling-tool");
  const col = w.colOf("s-dangling-tool");
  w.onThinkingStart({}, "s-dangling-tool");
  w.onThinkingDelta({ text: "想想" }, "s-dangling-tool");
  w.onToolUseStarted({ id: "t1", name: "read_file" }, "s-dangling-tool");
  assert.equal(col.querySelector(".think-live-wrap"), null, "包装行拆除");
  const row = col.querySelector(".think-row");
  assert.ok(row, "胶囊保留定格");
  assert.match(row.textContent, /思考 · 持续了/);
});

test("乐观胶囊被撤（正文先到）: 文本与包装行一起消失, 胶囊一并移除", () => {
  const w = setup("s-drop");
  const col = w.colOf("s-drop");
  const run = w.runOf("s-drop");
  w.beginOptimisticThinking(run, "s-drop", col);   // 发送瞬间的乐观胶囊
  w.onThinkingDelta({ text: "抢先想了一句" }, "s-drop");
  assert.ok(col.querySelector(".think-live"), "前置: 实时文本已挂上");
  w.onTextDelta({ text: "正文" }, "s-drop");       // 正文先到 → 撤乐观胶囊
  assert.equal(col.querySelector(".think-live"), null, "实时文本随胶囊一起撤");
  assert.equal(col.querySelector(".think-live-wrap"), null, "包装行不留孤儿");
  assert.equal(col.querySelector(".think-row"), null, "胶囊本体已移除");
});
