// tests/web/terminal-live.test.js — 终端工具行"运行中可展开"
//
// 此前终端工具行在运行中点击无响应（点击开关里有 state==="run" 守卫,
// 且终端块要等 tool_result 才渲染）——长命令摘要被 90 字截断, 用户想
// 看完整命令只能干等。契约:
//   1. 终端工具参数到齐即预插 .to-term.closed 块（$ 命令全文 + 运行中占位）,
//      紧邻工具行之后——分组折叠的 CSS 例外选择器依赖这个兄弟关系
//   2. 运行中点击行即展开/收起（去掉 run 守卫）
//   3. tool_result 落地: 占位就地替换为真实输出, 不重复建块; 成功不自动
//      展开, 出错自动展开; 中断/拒绝时占位改口不留"运行中…"死文案
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

/* 造一个终端工具卡（运行中）: 走真实事件路径 tool_use → 卡片 */
function addRunningTerminalCard(w, sid, cmd) {
  w.__state().sessionId = sid;
  const run = w.runOf(sid);
  const msg = { id: "tu-live-1", name: "bash",
    input: JSON.stringify({ command: cmd }) };
  w.onToolUse(msg, sid);
  const card = run.liveToolCards[msg.id];
  assert.ok(card, "tool_use 后卡片已登记");
  assert.equal(card.dataset.state, "run", "卡片处于运行中");
  return card;
}

test("运行中: 终端命令参数到齐即预插收起的终端块, 含命令全文与运行中占位", () => {
  const w = loadApp();
  const sid = "s-live";
  const cmd = "npm run test:web > /tmp/weball3.log 2>&1; echo \"web exit=$?\"; grep -aE \"^\\s+\\(tests|pass|fail\" /tmp/weball3.log | tail -40; node --test tests/web/terminal-live.test.js";
  const card = addRunningTerminalCard(w, sid, cmd);

  const term = card.nextElementSibling;
  assert.ok(term, "终端块已预插在工具行后（兄弟关系, 折叠组 CSS 例外依赖它）");
  assert.equal(term.classList.contains("to-term"), true);
  assert.equal(term.classList.contains("closed"), true, "默认收起: 不自动撑高消息流");
  assert.equal(term.querySelector(".tt-cmd").textContent, "$ " + cmd,
    "命令全文可见（不被 90 字摘要截断）");
  const runEl = term.querySelector(".tt-run");
  assert.ok(runEl, "有运行中占位");
  assert.match(runEl.textContent, /运行中/);
});

test("运行中: 点击工具行展开终端块, 再点收起", () => {
  const w = loadApp();
  const sid = "s-click";
  const card = addRunningTerminalCard(w, sid, "sleep 30");

  card.click();
  const term = card.nextElementSibling;
  assert.equal(term.classList.contains("closed"), false, "点击后展开");
  assert.equal(card.classList.contains("open"), true, "行有展开标记");
  card.click();
  assert.equal(term.classList.contains("closed"), true, "再点收起");
  assert.equal(card.classList.contains("open"), false);
});

test("tool_result 落地: 占位替换为真实输出, 无重复块, 成功不自动展开", () => {
  const w = loadApp();
  const sid = "s-ok";
  const card = addRunningTerminalCard(w, sid, "echo hi");

  w.onToolResult({ id: "tu-live-1", output: "hi\nbye" }, sid);
  assert.equal(card.dataset.state, "ok");
  const terms = card.parentElement.querySelectorAll(".to-term");
  assert.equal(terms.length, 1, "不重复建块");
  const term = card.nextElementSibling;
  assert.equal(term.querySelector(".tt-out").textContent, "hi\nbye");
  assert.ok(!term.querySelector(".tt-run"), "运行中占位已撤");
  assert.equal(term.classList.contains("closed"), true, "成功默认收起");
});

test("tool_result 出错: 自动展开", () => {
  const w = loadApp();
  const sid = "s-err";
  const card = addRunningTerminalCard(w, sid, "make bot foul");

  w.onToolResult({ id: "tu-live-1", output: "ERROR: boom", is_error: true }, sid);
  const term = card.nextElementSibling;
  assert.equal(card.dataset.state, "err");
  assert.equal(term.classList.contains("closed"), false, "出错自动展开");
});

test("中断 (stopped): 占位改口为无输出, 不留运行中文案", () => {
  const w = loadApp();
  const sid = "s-stop";
  const card = addRunningTerminalCard(w, sid, "sleep 100");

  w.sweepPendingToolCards(w.runOf(sid));
  assert.equal(card.dataset.state, "stopped");
  const term = card.nextElementSibling;
  assert.ok(term, "终端块仍在");
  const runEl = term.querySelector(".tt-run");
  assert.ok(!runEl, "运行中占位已撤");
  assert.equal(term.querySelector(".tt-none").textContent, "（无输出）");
});

test("历史回放路径: completeToolCard 直接出单块, 无占位残留", () => {
  const w = loadApp();
  const sid = "s-replay";
  w.__state().sessionId = sid;
  const card = w.addToolCard({ id: "tu-h-1", name: "bash",
    input: JSON.stringify({ command: "ls -la" }),
    result: { output: "total 1" } }, w.colOf(sid));

  assert.equal(card.dataset.state, "ok");
  const terms = card.parentElement.querySelectorAll(".to-term");
  assert.equal(terms.length, 1);
  assert.ok(!terms[0].querySelector(".tt-run"), "无占位残留");
  assert.equal(terms[0].querySelector(".tt-out").textContent, "total 1");
});
