// tests/web/scroll-follow.test.js — 流式输出期间滚动不被拽底(主列 + 子agent面板)
//
// 契约:
//   1. 主列: wheel 上滚立即置 nearBottom=false, 下一个流式 delta 不拽底;
//   2. 主列: 贴底状态下 delta 照常跟随(scrollTop 被写回最大值);
//   3. 主列: 拖拽自绘滑块期间(scrollInteracting) delta 不抢滚动位置;
//   4. 面板: 子agent事件仅在面板贴底(saNearBottom)时跟随;
//   5. 面板: wheel 上滚后子agent事件不再拽底;
//   6. 面板: openSaPanel 打开即重置贴底态并滚到底。
//
// jsdom 没有布局: scrollHeight/clientHeight 恒为 0, scrollTop 写入不产生
// 视觉滚动。测试用 Object.defineProperty 在实例上遮蔽这三个属性, 断言
// 代码对 scrollTop 的写入(拽底 = 写成当时的 scrollHeight)。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["i18n/zh.js", "i18n/en.js", "i18n/i18n.js", "ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
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

/* 给容器实例遮蔽几何属性: 可控的 scrollHeight/clientHeight +
 * 记录每次 scrollTop 写入。返回 { setGeom, writes } */
function instrument(el) {
  const writes = [];
  let sh = 2000, ch = 500, top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => sh });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => ch });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: v => { top = v; writes.push(v); },
  });
  return {
    /* 直接改几何(不记为程序拽底) */
    setGeom(nextSh, nextCh, nextTop) { sh = nextSh; ch = nextCh; top = nextTop; },
    get top() { return top; },
    writes,
  };
}

function fireWheel(el, deltaY) {
  el.dispatchEvent(new el.ownerDocument.defaultView.WheelEvent("wheel", { deltaY, bubbles: true }));
}

function setup(sid) {
  const w = loadApp();
  w.__state().sessionId = sid;
  w.runOf(sid).busy = true;
  return w;
}

test("主列: wheel 上滚后流式 delta 不再拽底", () => {
  const w = setup("s-scroll");
  const msgs = w.document.getElementById("messages");
  const inst = instrument(msgs);
  inst.setGeom(2000, 500, 1500);   // 贴底(2000-500=1500)

  w.onTextDelta({ text: "hello" }, "s-scroll");
  assert.equal(inst.top, 2000, "贴底时 delta 跟随到底");
  inst.writes.length = 0;

  inst.setGeom(3000, 500, 2600);   // 内容长高, 仍贴底
  fireWheel(msgs, -120);           // 用户上滚一格
  inst.setGeom(3000, 500, 2480);   // 上滚生效
  w.onTextDelta({ text: " world" }, "s-scroll");
  assert.equal(inst.writes.length, 0, "上滚后 delta 不写 scrollTop(不拽底)");
  assert.equal(inst.top, 2480, "滚动位置保持在用户停留处");
});

test("主列: 贴底状态流式 delta 照常跟随", () => {
  const w = setup("s-scroll2");
  const msgs = w.document.getElementById("messages");
  const inst = instrument(msgs);
  inst.setGeom(2000, 500, 1500);
  inst.writes.length = 0;

  w.onTextDelta({ text: "跟随" }, "s-scroll2");
  assert.ok(inst.writes.includes(2000), "delta 把 scrollTop 写到底部");
});

test("主列: 拖拽滑块期间 delta 不抢滚动位置", () => {
  const w = setup("s-scroll3");
  const msgs = w.document.getElementById("messages");
  const inst = instrument(msgs);
  inst.setGeom(2000, 500, 1500);

  const bar = w.document.querySelector("#msg-scrollbar .thumb");
  bar.dispatchEvent(new w.PointerEvent("pointerdown", {
    bubbles: true, clientY: 300, pointerId: 7,
  }));
  w.onTextDelta({ text: "流式中" }, "s-scroll3");
  assert.equal(inst.writes.filter(v => v > 1500).length, 0,
    "滑块按下未放期间 delta 不拽底");
  bar.dispatchEvent(new w.PointerEvent("pointerup", {
    bubbles: true, pointerId: 7,
  }));
});

/* ---------- 子agent面板 ---------- */

/* 建会话 + 子代理卡 + 伪会话列(模拟 subagent started 链路的最小集):
 * 卡片须挂在消息列里(saCardOf 按 isConnected 校验), 经 registerSubagentCard
 * 官方入口登记路由。 */
function makeAgent(w, sid, agentId) {
  const run = w.runOf(sid);
  const card = w.document.createElement("div");   // 最小工具卡
  w.colOf(sid).appendChild(card);                 // isConnected: true
  w.registerSubagentCard(run, agentId, card);
  return card;
}

test("面板: 子agent事件仅贴底时跟随, wheel 上滚后不再拽底", () => {
  const w = setup("s-sa");
  makeAgent(w, "s-sa", "agent-1");
  const body = w.document.getElementById("sa-body");
  const inst = instrument(body);

  // 面板打开: 打开即看最新(重置贴底态)
  w.openSaPanel("agent-1");
  inst.writes.length = 0;

  // 面板贴底 → 子agent正文 delta 跟随
  inst.setGeom(2000, 400, 1600);   // 2000-400=1600 贴底
  w.onSubagentEvent({ agent_id: "agent-1", event: { type: "text_delta", text: "hi" } }, "s-sa");
  assert.equal(inst.writes.filter(v => v === 2000).length, 1, "贴底时面板跟随到底");

  // 用户上滚 → 不再拽底
  inst.setGeom(3000, 400, 2400);
  fireWheel(body, -120);
  inst.setGeom(3000, 400, 2280);
  inst.writes.length = 0;
  w.onSubagentEvent({ agent_id: "agent-1", event: { type: "text_delta", text: " there" } }, "s-sa");
  assert.equal(inst.writes.length, 0, "上滚后子agent事件不拽面板的底");
  assert.equal(inst.top, 2280, "面板位置保持在用户停留处");
});

test("面板: openSaPanel 重置贴底态并滚到底", () => {
  const w = setup("s-sa2");
  makeAgent(w, "s-sa2", "agent-2");
  const body = w.document.getElementById("sa-body");
  const inst = instrument(body);

  // 先上滚脱离贴底
  inst.setGeom(2000, 400, 100);
  fireWheel(body, -120);
  // 关闭再打开: 应重置贴底态并贴底
  w.openSaPanel("agent-2");
  assert.ok(inst.writes.includes(2000), "openSaPanel 把面板滚到底");
});
