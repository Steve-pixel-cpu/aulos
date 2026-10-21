// tests/web/plan-card.test.js — 计划卡（present_plan）: 镜像工具卡收口 / 等待态隐藏
//
// 2026-10-21 用户实测: 计划批准并实施完成后, 聊天流里仍挂着两处"运行中":
//   1. present_plan 的工具镜像卡（addToolCard, state=run）: 它的 tool_result
//      走 completeToolCard 的 present_plan 特判——该分支为历史回放计划卡
//      (.plan-card, 有 .plan-head) 写, 对 .tool-row 镜像卡只加了 allowed
//      class 就提前 return, 不调 setToolState → "运行中"状态字永远不清,
//      分组头"运行中"也跟着滞留。
//      契约: 特判分支按卡的形态分流——.tool-row 镜像卡必须 setToolState 收口。
//   2. 计划卡头行"等待确认"（pr-dot 脉动）: CSS 只对 .perm-row 隐藏
//      .pr-hint, .plan-card.allowed/.denied 没有对应规则 → 批准后脉动残留。
//      契约: .plan-card 定格态隐藏 .pr-hint, 与 .perm-row 对齐。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["i18n/zh.js", "i18n/en.js", "i18n/i18n.js", "ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
  "desktop.js", "bubbles.js", "msg-extras.js", "ws-handlers.js",
  "sidebar.js", "settings-page.js"];   // = index.html 完整 defer 序

process.on("unhandledRejection", (e) => {
  if (String(e && e.message).includes("'_origin'")) return;   // jsdom 关窗噪音
  console.error("unhandledRejection:", e);
});
const bootedWindows = [];
test.afterEach(async () => {
  await new Promise(r => setImmediate(r));
  while (bootedWindows.length) {
    try { bootedWindows.pop().close(); } catch (e) { /* 已关: 忽略 */ }
  }
  await new Promise(r => setImmediate(r));
});

function boot() {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  bootedWindows.push(window);
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__api = { get state() { return state; }, runOf, onToolUseStarted, onPermissionRequest, onPermissionResolved, onToolResult, handleServerMessage, planStatusBadge };");
  return window;
}

const PLAN_PERM = (rid) => ({
  type: "permission_request", request_id: rid, tool_name: "present_plan",
  input: JSON.stringify({ plan: "# 计算器实现计划\n## 目标\n创建单文件网页计算器" }),
  current_mode: "plan", required_mode: "workspace-write",
});

test("批准后 tool_result 到达: present_plan 镜像工具卡收口, 不再滞留运行中", () => {
  const window = boot();
  const api = window.__api;
  api.state.sessions.push({ id: "s1", title: "t" });
  api.state.sessionId = "s1";
  const run = api.runOf("s1");
  run.busy = true;

  // 服务端顺序: tool_use(镜像卡, run) → permission_request(计划卡) → 批准
  api.onToolUseStarted({ id: "tu-plan-1", name: "present_plan" }, "s1");
  api.onPermissionRequest(PLAN_PERM("perm-p1"), "s1");

  const mirror = run.liveToolCards["tu-plan-1"];
  assert.ok(mirror && mirror.isConnected, "前置: present_plan 已建镜像工具卡");
  assert.equal(mirror.dataset.state, "run", "前置: 镜像卡运行中");

  api.onPermissionResolved({ request_id: "perm-p1", approved: true }, "s1");
  api.onToolResult({ id: "tu-plan-1", output: "计划已批准" }, "s1");

  assert.equal(mirror.dataset.state, "ok", "镜像卡随 tool_result 收口（不再运行中）");
  assert.equal(mirror.querySelector(".tstate").textContent,
    window.t("ws_handlers.032"), "状态字已从运行中改为完成态");
  const grp = mirror.closest(".tool-group");
  assert.equal(grp.classList.contains("running"), false, "分组头不再显示运行中");
});

test("被批准的计划卡: 定格为 allowed, 等待确认按钮摘除", () => {
  const window = boot();
  const api = window.__api;
  api.state.sessions.push({ id: "s1", title: "t" });
  api.state.sessionId = "s1";
  api.runOf("s1").busy = true;

  api.onPermissionRequest(PLAN_PERM("perm-p2"), "s1");
  const card = window.document.querySelector('.plan-card[data-req-id="perm-p2"]');
  assert.ok(card, "前置: 计划卡已建");
  assert.ok(card.querySelector(".pr-choices"), "前置: 待确认态有可点按钮");

  api.onPermissionResolved({ request_id: "perm-p2", approved: true }, "s1");
  assert.ok(card.classList.contains("allowed"), "计划卡定格为已批准");
  assert.equal(card.querySelector(".pr-choices"), null, "按钮已摘除");
});

test("plan_completed 事件: 计划卡推进到已完成终态", () => {
  const window = boot();
  const api = window.__api;
  api.state.sessions.push({ id: "s1", title: "t" });
  api.state.sessionId = "s1";
  const run = api.runOf("s1");
  run.busy = true;

  api.onPermissionRequest(PLAN_PERM("perm-p3"), "s1");
  api.onPermissionResolved({ request_id: "perm-p3", approved: true }, "s1");
  const card = window.document.querySelector('.plan-card[data-req-id="perm-p3"]');
  assert.ok(card.classList.contains("allowed"), "前置: 已批准");

  // 服务端 turn 正常收口后广播: {type:"plan_completed", plan_id, request_id, session_id}
  window.handleServerMessage({ type: "plan_completed", plan_id: "p-1",
    request_id: "perm-p3", session_id: "s1" }, "s1");

  assert.ok(card.classList.contains("completed"), "计划卡定格已完成");
  const mark = card.querySelector(".pr-mark");
  assert.equal(mark.textContent, window.t("ws_handlers.118"), "标记文案变为已完成");
  // 徽标 map 同步: 历史面板/历史回放卡复用同一状态字典
  assert.match(window.eval('planStatusBadge("completed")'), /pl-st-completed/);
});

test("CSS 契约: .plan-card.completed 与 .pl-st-completed 存在", () => {
  const css = fs.readFileSync(path.join(STATIC, "app.css"), "utf-8");
  assert.match(css, /\.plan-card\.completed\s+\.pr-mark\s*\{/, "已完成态着色规则");
  assert.match(css, /\.pl-st-completed\s*\{/, "徽标 completed 配色");
});

test("CSS 契约: .plan-card 定格态隐藏 .pr-hint 等待提示（与 .perm-row 对齐）", () => {
  // jsdom 不计算样式, 就 app.css 原文断言选择器契约（同 permission-card 写法）
  const css = fs.readFileSync(path.join(STATIC, "app.css"), "utf-8");
  assert.match(css,
    /\.plan-card\.allowed\s+\.pr-hint[^{}]*\{[^{}]*display:\s*none/,
    ".plan-card.allowed 需隐藏 .pr-hint（批准后不留等待确认脉动）");
  assert.match(css,
    /\.plan-card\.denied\s+\.pr-hint[^{}]*\{[^{}]*display:\s*none/,
    ".plan-card.denied 同样隐藏 .pr-hint（拒绝态不留等待提示）");
});
