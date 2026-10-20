// tests/web/minimap-rebuild.test.js — 用户消息快速定位刻度 (minimap) 重建
//
// 契约:
//   1. 当前可见会话列 (.msg-col.on) 内每条 .msg.user 生成一枚 .mm-tick;
//   2. 可滚动 (scrollHeight - clientHeight > 2) 时 mm.hidden=false;
//   3. 刻度 _time 来自 mmRelTime 的本地化相对时间, 无文本消息的 _text
//      回落到附件/占位词条;
//   4. mmRebuild 全程不抛异常。
//
// 回归背景: 2026-10-20 i18n 迁移后 mmRelTime 内局部 `const t`(Date)
// 遮蔽全局 i18n 函数 t, forEach 首行即 TypeError——mm.textContent 已先
// 被清空, appendChild 永不执行, 刻度列整条"消失"。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["i18n/zh.js", "i18n/en.js", "i18n/i18n.js", "ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
  "desktop.js", "bubbles.js", "msg-extras.js", "ws-handlers.js",
  "sidebar.js", "settings-page.js"];   // = index.html 完整 defer 序

function setup() {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__state = () => state;");
  return window;
}

/* jsdom 无布局, 手动定义 #messages 的滚动量让 scrollable 判定成立 */
function fakeScrollable(w, scrollH, clientH) {
  const el = w.document.getElementById("messages");
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollH });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientH });
}

test("可滚动会话: 每条用户消息一枚刻度, 相对时间本地化且不抛异常", () => {
  const w = setup();
  const col = w.colOf("s-mm1");
  const now = Date.now();
  w.addUserBubble("第一条消息", null, col, new Date(now - 30_000).toISOString());
  w.addUserBubble("", [{ kind: "image", name: "a.png", media_type: "image/png", data: "" }],
    col, new Date(now - 3_600_000).toISOString());
  w.addUserBubble("第三条", null, col, new Date(now - 200_000).toISOString());
  col.classList.add("on");
  fakeScrollable(w, 3000, 800);

  w.mmRebuild();   // 修复前: TypeError: t is not a function, 刻度 0 枚

  const mm = w.document.getElementById("msg-minimap");
  assert.equal(mm.hidden, false, "可滚动时显示刻度列");
  assert.equal(mm.children.length, 3, "每条用户消息一枚刻度");
  const [t1, t2, t3] = mm.children;
  assert.equal(t1._time, "刚刚", "<90s → msg_extras.004");
  assert.equal(t2._time, "1小时前", "1h ≤ diff < 24h → 1 + msg_extras.006");
  assert.equal(t3._time, "3分钟前", "90s ≤ diff < 1h → 3 + msg_extras.005");
  assert.equal(t2._text, "[图片]", "无文本回落附件词条 msg_extras.001");
});

test("不可滚动(或无用户消息): 刻度列隐藏", () => {
  const w = setup();
  const col = w.colOf("s-mm2");
  w.addUserBubble("唯一一条", null, col, new Date().toISOString());
  col.classList.add("on");
  fakeScrollable(w, 800, 800);   // 无滚动余量

  w.mmRebuild();

  const mm = w.document.getElementById("msg-minimap");
  assert.equal(mm.hidden, true, "无滚动余量时隐藏");
  assert.equal(mm.children.length, 0, "不生成刻度");
});

test("非法时间戳: 兜底为空串, 刻度照常生成", () => {
  const w = setup();
  const col = w.colOf("s-mm3");
  w.addUserBubble("坏 ts 消息", null, col, "not-a-date");
  col.classList.add("on");
  fakeScrollable(w, 2000, 800);

  w.mmRebuild();

  const mm = w.document.getElementById("msg-minimap");
  assert.equal(mm.children.length, 1, "刻度仍在");
  assert.equal(mm.children[0]._time, "", "坏 ts → 空时间文案");
});
