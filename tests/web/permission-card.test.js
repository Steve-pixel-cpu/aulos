// tests/web/permission-card.test.js — 工具审批卡: 归位 / 定格 / 死卡兜底
//
// 2026-10-11 用户实测两连:
//   1. 审批卡孤悬列尾（落在"工作中"转圈之后）, 同一条命令读起来像
//      凭空重复了一条、顺序错乱 → 契约: 卡紧跟其工具行（进分组、组
//      若折叠自动展开保持）。
//   2. 打断/别处批复后残留"待确认"卡, 按钮看着能点、点了没反应
//      → 契约: 服务端 permission_resolved 广播统一定格;
//        respondPermission 对已收口请求也把残留卡就地定格（幂等）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
  "desktop.js", "bubbles.js", "msg-extras.js", "ws-handlers.js",
  "sidebar.js", "settings-page.js"];   // = index.html 完整 defer 序

// 本文件会注册会话并渲染会话列表, 渲染链启动的常驻刷新器（时间戳轮询等）
// 留下活句柄钉死事件循环——测试进程不退出, node --test 挂到超时。
// afterEach 统一关窗释放句柄; 单测子进程模式跑整个文件时同样受益。
// 关窗瞬间 jsdom 内部尚有排队定时器回调引用已置 null 的窗口（'_origin'
// 噪音）: 先让一拍宏任务排空再关, 漏网的走 unhandledRejection 吸收。
process.on("unhandledRejection", (e) => {
  if (String(e && e.message).includes("'_origin'")) return;   // jsdom 关窗噪音
  console.error("unhandledRejection:", e);
});
const bootedWindows = [];
test.afterEach(async () => {
  await new Promise(r => setImmediate(r));   // 排空已入队的 jsdom 回调
  while (bootedWindows.length) {
    try { bootedWindows.pop().close(); } catch (e) { /* 已关: 忽略 */ }
  }
  await new Promise(r => setImmediate(r));   // 关窗后残余回调落地
});

function boot() {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  bootedWindows.push(window);
  window.fetch = async () => { throw new TypeError("no backend in tests"); };
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__api = { get state() { return state; }, runOf, onToolUseStarted, onPermissionRequest, onPermissionResolved, respondPermission };");
  return window;
}

const PERM = (rid, cmd) => ({
  type: "permission_request", request_id: rid, tool_name: "bash",
  input: JSON.stringify({ command: cmd || "ls /d" }),
  current_mode: "workspace-write", required_mode: "danger-full-access",
  detail: "命令点名操作敏感路径: /d/", escalation: "sensitive",
});

test("审批卡紧跟工具行进分组, 折叠的分组自动展开", () => {
  const window = boot();
  const api = window.__api;
  api.state.sessions.push({ id: "s1", title: "t" });
  api.state.sessionId = "s1";
  api.runOf("s1").busy = true;

  api.onToolUseStarted({ id: "tu-1", name: "bash" }, "s1");
  const toolRow = api.runOf("s1").activeToolCard;
  assert.ok(toolRow && toolRow.isConnected, "工具卡已建");
  const grp = toolRow.closest(".tool-group");
  assert.ok(grp.classList.contains("collapsed"), "前置: 新组默认折叠");

  api.onPermissionRequest(PERM("perm-1"), "s1");
  const card = window.document.querySelector('.perm-row[data-req-id="perm-1"]');
  assert.ok(card, "审批卡已建");
  assert.equal(card.previousElementSibling, toolRow, "审批卡紧跟工具行");
  assert.equal(card.closest(".tool-group"), grp, "审批卡在工具所在分组内");
  assert.equal(grp.classList.contains("collapsed"), false, "等审批的组已展开");
  assert.equal(grp._userOpen, true, "且不随运行中自动收起");
  assert.ok(card.querySelector(".pr-choices"), "待确认态有可点按钮");
});

test("permission_resolved 广播: 卡定格已拒绝、按钮摘除, 迟到的点击不再发响应", () => {
  const window = boot();
  const api = window.__api;
  api.state.sessions.push({ id: "s1", title: "t" });
  api.state.sessionId = "s1";
  api.runOf("s1").busy = true;

  api.onToolUseStarted({ id: "tu-1", name: "bash" }, "s1");
  api.onPermissionRequest(PERM("perm-1"), "s1");

  // 服务端打断自动拒绝 → permission_resolved 广播
  api.onPermissionResolved({ request_id: "perm-1", approved: false }, "s1");
  const card = window.document.querySelector('.perm-row[data-req-id="perm-1"]');
  assert.equal(card.querySelector(".pr-choices"), null, "按钮已摘除");
  assert.equal(card.querySelectorAll(".pr-btn").length, 0, "记忆类按钮一并摘除");
  assert.ok(card.classList.contains("denied"), "卡定格为已拒绝");
  assert.equal(api.runOf("s1").pendingPerms["perm-1"], undefined, "登记已清");

  // 迟到的点击: 登记已清 → 走死卡兜底（幂等定格）, 不再向服务端发错配响应
  const run = api.runOf("s1");
  const sent = [];
  run.ws = { readyState: 1, send: (d) => sent.push(JSON.parse(d)) };
  api.respondPermission("perm-1", true, "s1");
  assert.equal(sent.length, 0, "已收口的请求不发 permission_response");
  assert.ok(card.classList.contains("denied"), "定格不被迟到点击翻转");
});

test("死卡兜底: 登记被清但卡未定格时, 迟到点击把卡就地定格", () => {
  const window = boot();
  const api = window.__api;
  api.state.sessions.push({ id: "s1", title: "t" });
  api.state.sessionId = "s1";
  const run = api.runOf("s1");
  run.busy = true;

  api.onPermissionRequest(PERM("perm-2", "mkdir -p /d/aulos-promo"), "s1");
  // 模拟登记被轮次收口清掉、但定格查询没找到卡的异常残态
  run.pendingPerms = {};
  const card = window.document.querySelector('.perm-row[data-req-id="perm-2"]');
  assert.ok(card.querySelector(".pr-choices"), "前置: 卡还挂着可点按钮");

  run.ws = { readyState: 1, send: () => assert.fail("死卡点击不得向服务端发响应") };
  api.respondPermission("perm-2", true, "s1");
  assert.equal(card.querySelector(".pr-choices"), null, "残留卡被就地定格");
  assert.ok(card.classList.contains("allowed"), "标记为本次点击的方向");
});

test("折叠分组隐藏组内审批卡: 定格后的审批卡随工具行一起折进组里", () => {
  // 2026-10-20 用户实测: 两条 bash 审批（允许/拒绝）批复定格后轮次收口,
  // 分组折叠但审批卡没跟着折进组——折叠隐藏清单（.tool-row/.think-row/
  // .td-wrap/.to-term/.todo-list）漏了 .perm-row, 已定格的审批卡游离在
  // 折叠头下方。契约: 折叠组隐藏组内一切过程记录, 审批卡（含定格态）
  // 与其工具行同进退。jsdom 不计算样式, 就 app.css 源文断言选择器契约。
  const css = fs.readFileSync(path.join(STATIC, "app.css"), "utf-8");
  assert.match(css,
    /\.tool-group\.collapsed[^{}]*\.perm-row[^{}]*\{[^{}]*display:\s*none/,
    "折叠隐藏清单需包含 .perm-row（组内审批卡随折叠隐藏）");
});

test("无工具卡时审批卡退回列尾（不挂分组）", () => {
  const window = boot();
  const api = window.__api;
  api.state.sessions.push({ id: "s1", title: "t" });
  api.state.sessionId = "s1";
  api.runOf("s1").busy = true;

  api.onPermissionRequest(PERM("perm-3"), "s1");
  const card = window.document.querySelector('.perm-row[data-req-id="perm-3"]');
  assert.ok(card, "审批卡已建");
  assert.equal(card.closest(".tool-group"), null, "无工具行时不进分组");
});
