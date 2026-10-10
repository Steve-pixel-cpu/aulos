// tests/web/thinking-indicator.test.js — "工作中"转圈的挂载纪律
//
// 转圈是 CSS 无限旋转动画 (#thinking .spin)。对已连接的节点 appendChild
// = 先移除再插回, 动画被取消并从头重播; syncThinkingIndicator 在每条
// text_delta 都会被调——若它每次都无条件挪节点, 流式期间转圈被反复归零,
// 视觉上"转得不顺畅"。契约: 已在列尾时绝不移动节点。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
  "desktop.js", "bubbles.js", "msg-extras.js", "ws-handlers.js",
  "sidebar.js", "settings-page.js"];   // = index.html 完整 defer 序

/* loadApp 不暴露 state (顶层 const 不上 window): 同一 eval 里补一行
 * 闭包 shim, 与源码共享词法环境 */
function loadApp() {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__state = () => state;");
  return window;
}

/* 统计 appendChild 调用次数的桩: 移动节点 = 动画重启的直接原因,
 * jsdom 看不到 CSS 动画, 用它做代理断言 */
function spyAppend(col) {
  const orig = col.appendChild.bind(col);
  let calls = 0;
  col.appendChild = (n) => { calls++; return orig(n); };
  return () => calls;
}

test("syncThinkingIndicator: 已在列尾时重复调用不移动节点 (动画不被重置)", () => {
  const w = loadApp();
  const sid = "s-spin";
  w.__state().sessionId = sid;
  w.runOf(sid).busy = true;
  const col = w.colOf(sid);

  w.syncThinkingIndicator();
  const count = spyAppend(col);
  w.syncThinkingIndicator();
  w.syncThinkingIndicator();
  assert.equal(count(), 0, "已在列尾: 重复调用不得 appendChild (移动=动画重播)");
  assert.equal(col.lastElementChild.id, "thinking");
});

test("syncThinkingIndicator: 被新节点盖过列尾后, 调用把它移回列尾", () => {
  const w = loadApp();
  const sid = "s-spin2";
  w.__state().sessionId = sid;
  w.runOf(sid).busy = true;
  const col = w.colOf(sid);

  w.syncThinkingIndicator();
  // 模拟新正文气泡/工具卡落到转圈之后 (col 内尾部插入)
  const bubble = w.document.createElement("div");
  bubble.className = "msg";
  col.appendChild(bubble);
  assert.notEqual(col.lastElementChild.id, "thinking", "前置: 转圈已不在列尾");

  const count = spyAppend(col);
  w.syncThinkingIndicator();
  assert.equal(count(), 1, "不在列尾: 恰好挪一次");
  assert.equal(col.lastElementChild.id, "thinking");
});

test("syncThinkingIndicator: 切换会话列时把节点挪到新列尾", () => {
  const w = loadApp();
  const sidA = "s-a", sidB = "s-b";
  w.__state().sessionId = sidA;
  w.runOf(sidA).busy = true;
  w.syncThinkingIndicator();

  w.__state().sessionId = sidB;
  w.runOf(sidB).busy = true;
  w.syncThinkingIndicator();
  assert.equal(w.colOf(sidB).lastElementChild.id, "thinking", "节点跟到新会话列尾");
  assert.equal(w.colOf(sidA).querySelector("#thinking"), null, "旧列不再持有");
});

test("syncThinkingIndicator: 空闲会话隐藏转圈", () => {
  const w = loadApp();
  const sid = "s-idle";
  w.__state().sessionId = sid;
  w.runOf(sid).busy = false;
  w.syncThinkingIndicator();
  const el = w.document.getElementById("thinking");
  assert.equal(el.style.display, "none");
});
