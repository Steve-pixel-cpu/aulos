// tests/web/subagent-background.test.js — 后台会话的子智能体事件分派与路由
//
// 契约:
//   1. handleServerMessage 的后台分支(sid !== state.sessionId)必须分派
//      subagent_started/event/done——切走期间完成的子代理状态要正确翻转,
//      不能永远停在"运行中";
//   2. user_message(任务 prompt 镜像)落进该代理自己卡片的嵌套列
//      (card._saStream), 不是当前会话的兜底隐藏列;
//   3. saColFor("sub:"+agent_id) 跨会话按归属表路由到正确卡片。
//
// 回归背景(2026-10-21 现场): 后台分支吞掉 subagent_* → 切走期间完成的
// 子代理卡片永久"运行中"; user_message 气泡丢失 → 面板没有任务 prompt。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

// 同一词法环境末尾导出内部符号(顶层 const/函数不挂 window)
const EXPORT = 'window.__api = { get state() { return state; }, runOf, colOf, ' +
  'handleServerMessage, onSubagentStarted, onSubagentEvent, onSubagentDone, saColFor };';

function setup(foregroundSid) {
  const { window } = loadApp(EXPORT);
  const api = window.__api;
  api.state.sessionId = foregroundSid;
  return { window, api };
}

test("后台分支分派 subagent_*: 切走期间 started/event/done 全部生效", () => {
  const { api } = setup("s-front");          // 前台是别的会话, s-back 在后台

  // 子代理在后台会话 s-back 里派出并跑完
  api.handleServerMessage({ type: "subagent_started", agent_id: "bg1",
    subagent_type: "explore", description: "后台调查" }, "s-back");
  const card = api.runOf("s-back").subagents.bg1;
  assert.ok(card, "started 在后台会话建卡并登记路由");
  assert.equal(card.dataset.state, "run", "started 后运行中");

  // 任务 prompt 镜像: 落进自己卡片的嵌套列
  api.handleServerMessage({ type: "subagent_event", agent_id: "bg1",
    event: { type: "user_message", text: "请调查 X" } }, "s-back");
  assert.ok(card._saStream, "卡片持有嵌套流列");
  const bubble = card._saStream.textContent;
  assert.match(bubble, /请调查 X/, "任务 prompt 气泡落在嵌套列里");

  // 完成: 状态翻转, 不再"运行中"
  api.handleServerMessage({ type: "subagent_done", agent_id: "bg1",
    status: "completed", duration_s: 4 }, "s-back");
  assert.equal(card.dataset.state, "ok", "done 后状态=ok(卡在后台也翻)");
  assert.equal(card.querySelector(".tstate").textContent, "已完成");
});

test("saColFor 跨会话按归属路由: 后台代理的流不落错桶", () => {
  const { api } = setup("s-front2");
  

  api.onSubagentStarted({ agent_id: "bg2", subagent_type: "general",
    description: "干活" }, "s-back2");
  const card = api.runOf("s-back2").subagents.bg2;
  assert.ok(card, "后台会话的卡已建");

  // 伪会话 id 在"前台是另一会话"时也要解析到 bg2 自己的嵌套列
  const col = api.saColFor("sub:bg2");
  assert.equal(col, card._saStream, "伪会话列 === 该卡的嵌套流列");
  // 写入路径复用 onSubagentEvent: 气泡文本出现在嵌套列
  api.onSubagentEvent({ type: "subagent_event", agent_id: "bg2",
    event: { type: "user_message", text: "任务全文" } }, "s-back2");
  assert.match(card._saStream.textContent, /任务全文/);
});

test("前台会话(对照): 同一批事件在原路径仍工作", () => {
  const { api } = setup("s-front3");
  
  api.handleServerMessage({ type: "subagent_started", agent_id: "f1",
    subagent_type: "explore", description: "前台调查" }, "s-front3");
  const card = api.runOf("s-front3").subagents.f1;
  assert.ok(card && card.dataset.state === "run");
  api.handleServerMessage({ type: "subagent_done", agent_id: "f1",
    status: "completed", duration_s: 1 }, "s-front3");
  assert.equal(card.dataset.state, "ok");
});
