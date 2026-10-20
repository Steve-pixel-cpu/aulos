// tests/web/conn-state.test.js — 连接指示器: 合成「WS 层 × LLM 层」显示语义
//
// 语义矩阵（优先级: WS 层断开/错误/重连失败 > LLM 层状态）:
//   草稿 / 无 ws            → 灰 未连接
//   readyState 0            → 黄 连接中…
//   open + llm ok=true      → 绿 已连接
//   open + llm ok=false     → 红 模型服务连接异常（title = detail）
//   open + llm ok=null      → 灰 未连接（尚未验证/探测中）
//   closed                  → 灰 已断开
//   error                   → 红 连接错误
//   gaveup                  → 红 重连失败
// llm_status 服务端事件更新 state.llmStatus 并立即重渲染（含后台会话收到时）。
const { test } = require("node:test");
const assert = require("node:assert");
const { loadApp } = require("./helpers");

function setup(t) {
  // app.js 顶层 const 不挂 window: 通过同一词法环境末尾的导出行取出
  const { window } = loadApp(
    'window.__api = { get state() { return state; }, runOf, renderConn, handleServerMessage, t };');
  const api = window.__api;
  const doc = window.document;
  const conn = () => doc.getElementById("conn-state");
  const text = () => doc.getElementById("conn-text").textContent;
  const cls = () => conn().className;
  const title = () => conn().title;
  // 当前会话 + 运行态
  api.state.sessionId = "s1";
  return { window, api, doc, conn, text, cls, title };
}

test("草稿态: 灰 未连接", () => {
  const { api, cls, text, title } = setup();
  api.state.draft = true;
  api.renderConn();
  assert.strictEqual(cls(), "");
  assert.strictEqual(text(), api.t("app.055"));
  assert.strictEqual(title(), "");
});

test("无 WS: 灰 未连接", () => {
  const { api, cls, text } = setup();
  api.renderConn();
  assert.strictEqual(cls(), "");
  assert.strictEqual(text(), api.t("app.055"));
});

test("WS 连接中(readyState 0): 黄 连接中…", () => {
  const { api, cls, text } = setup();
  api.runOf("s1").ws = { readyState: 0 };
  api.renderConn();
  assert.strictEqual(cls(), "wait");
  assert.strictEqual(text(), api.t("app.027"));
});

test("WS open + LLM ok: 绿 已连接", () => {
  const { api, cls, text, title } = setup();
  const run = api.runOf("s1");
  run.ws = { readyState: 1 };
  run.wsState = "open";
  api.state.llmStatus = { ok: true, detail: "" };
  api.renderConn();
  assert.strictEqual(cls(), "on");
  assert.strictEqual(text(), api.t("app.026"));
  assert.strictEqual(title(), "");
});

test("WS open + LLM 失败: 红 异常 + title=原因", () => {
  const { api, cls, text, title } = setup();
  const run = api.runOf("s1");
  run.ws = { readyState: 1 };
  run.wsState = "open";
  api.state.llmStatus = { ok: false, detail: "认证失败: bad key" };
  api.renderConn();
  assert.strictEqual(cls(), "err");
  assert.strictEqual(text(), api.t("app.160"));
  assert.strictEqual(title(), "认证失败: bad key");
});

test("WS open + LLM 未验证: 灰 未连接", () => {
  const { api, cls, text } = setup();
  const run = api.runOf("s1");
  run.ws = { readyState: 1 };
  run.wsState = "open";
  api.state.llmStatus = { ok: null, detail: "" };
  api.renderConn();
  assert.strictEqual(cls(), "");
  assert.strictEqual(text(), api.t("app.055"));
});

test("WS closed: 灰 已断开（优先于 LLM 层状态）", () => {
  const { api, cls, text } = setup();
  const run = api.runOf("s1");
  run.wsState = "closed";
  api.state.llmStatus = { ok: true, detail: "" };
  api.renderConn();
  assert.strictEqual(cls(), "");
  assert.strictEqual(text(), api.t("app.057"));
});

test("WS error: 红 连接错误", () => {
  const { api, cls, text } = setup();
  api.runOf("s1").wsState = "error";
  api.renderConn();
  assert.strictEqual(cls(), "err");
  assert.strictEqual(text(), api.t("app.058"));
});

test("WS gaveup: 红 重连失败", () => {
  const { api, cls, text } = setup();
  api.runOf("s1").wsState = "gaveup";
  api.renderConn();
  assert.strictEqual(cls(), "err");
  assert.strictEqual(text(), api.t("app.059"));
});

test("llm_status 事件: 更新 state.llmStatus 并重渲染指示器", () => {
  const { api, cls, text, title } = setup();
  const run = api.runOf("s1");
  run.ws = { readyState: 1 };
  run.wsState = "open";
  api.handleServerMessage({ type: "llm_status", ok: false, detail: "无法连接: timeout" }, "s1");
  // 跨 eval realm 的对象原型不同, 逐字段断言
  assert.strictEqual(api.state.llmStatus.ok, false);
  assert.strictEqual(api.state.llmStatus.detail, "无法连接: timeout");
  assert.strictEqual(cls(), "err");
  assert.strictEqual(title(), "无法连接: timeout");
  // 恢复成功
  api.handleServerMessage({ type: "llm_status", ok: true, detail: "" }, "s1");
  assert.strictEqual(cls(), "on");
  assert.strictEqual(title(), "");
});

test("llm_status 事件来自后台会话: 同样生效（全局态）", () => {
  const { api, cls } = setup();
  const run = api.runOf("s1");
  run.ws = { readyState: 1 };
  run.wsState = "open";
  // 以后台会话 sid 派发: llm_status 是全局态, 不受会话分支拦截
  api.handleServerMessage({ type: "llm_status", ok: true, detail: "" }, "s2");
  assert.strictEqual(cls(), "on");
});
