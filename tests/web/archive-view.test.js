// tests/web/archive-view.test.js — 会话归档前端: 归档视图渲染 / 主列表过滤 /
// 归档与恢复按钮 / Esc 退出 / 批量归档入口 / session_unarchived 刷新。
// fetch 全部桩掉: 断言请求走向 + DOM 渲染结果, 不起真服务。
// 数据经真实 loadSessions() 灌入（__api getter 模式在本文件不可用:
// loadApp 已 eval 过全部源码, 再 eval 会造出第二份顶层 const state）。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

function sess(id, { archived = false, workdir = null, title = null } = {}) {
  return { id, title: title || id, message_count: 1,
           workdir: workdir === null ? "D:\\w\\proj" + id : workdir,
           archived, permission_mode: "default", plan_active: false };
}

/* loadApp 后: fetch 桩记调用; GET /api/sessions 返回给定会话,
   经真实 loadSessions 灌入 state（顶层数据通道, 零旁路） */
async function bootWith(sessions, fetchCalls) {
  const { window } = loadApp();
  window.fetch = async (url, opt = {}) => {
    fetchCalls.push({ url: String(url), opt: opt || {} });
    const isList = String(url).includes("/api/sessions")
      && !(opt.method && opt.method !== "GET")
      && !String(url).includes("search");
    return { ok: true, json: async () => isList ? { sessions } : { ok: true, archived: 1, skipped_busy: 0 } };
  };
  await window.eval("loadSessions()");
  window.renderSessionList();
  return window;
}

const listHtml = w => w.document.getElementById("session-list").innerHTML;

test("主列表: 未归档会话显示, 已归档的过滤掉", async () => {
  const w = await bootWith([sess("a"), sess("b", { archived: true })], []);
  const html = listHtml(w);
  assert.ok(html.includes(">a<"));
  assert.ok(!html.includes(">b<"), "已归档会话不应出现在主列表");
});

test("归档视图: 只显示已归档, 行带恢复+删除钮, 无改名/归档钮, 带 workdir 子标签", async () => {
  const w = await bootWith([sess("a"), sess("b", { archived: true, workdir: "D:\\myproj" })], []);
  w.setArchiveView(true);
  const html = listHtml(w);
  assert.ok(html.includes(">b<"), "归档视图应显示已归档会话");
  assert.ok(!html.includes(">a<"), "未归档会话不出现在归档视图");
  assert.ok(!/data-tip="归档"/.test(html), "归档视图行不应再有归档钮");
  assert.ok(!/data-tip="重命名"/.test(html), "归档视图行不应有改名钮");
  assert.ok(/data-tip="恢复"/.test(html), "归档视图行应有恢复钮");
  assert.ok(/data-tip="删除会话"/.test(html), "归档视图行应有删除钮");
  assert.ok(html.includes("myproj"), "归档视图行应带 workdir 子标签");
});

test("普通视图: 行只带改名+归档钮, 无删除/恢复钮", async () => {
  const w = await bootWith([sess("a")], []);
  const html = listHtml(w);
  assert.ok(/data-tip="重命名"/.test(html), "普通视图行应有改名钮");
  assert.ok(/data-tip="归档"/.test(html), "普通视图行应有归档钮");
  assert.ok(!/data-tip="删除会话"/.test(html), "普通视图行不应有删除钮");
  assert.ok(!/data-tip="恢复"/.test(html), "普通视图行不应有恢复钮");
});

test("归档视图: 空态文案", async () => {
  const w = await bootWith([sess("a")], []);
  w.setArchiveView(true);
  assert.ok(listHtml(w).includes("暂无归档会话"));
});

test("点行归档钮: POST archive archived=true, 行原地移出主列表", async () => {
  const calls = [];
  const w = await bootWith([sess("a"), sess("keep")], calls);
  const row = w.document.getElementById("session-a") || [...w.document.querySelectorAll(".session-item")].find(el => el.dataset.id === "a");
  row.querySelector(".s-arc").click();
  await new Promise(r => setTimeout(r, 0));
  const hit = calls.find(c => c.url.includes("/archive"));
  assert.ok(hit, "应发归档请求");
  assert.equal(JSON.parse(hit.opt.body).archived, true);
  assert.ok(hit.url.includes("/a/"), "归档的是 a 不是别的会话");
  assert.ok(!listHtml(w).includes(">a<"), "归档后主列表应移除该行");
});

test("归档视图点恢复钮: POST archive archived=false, 行回主列表", async () => {
  const calls = [];
  const w = await bootWith([sess("b", { archived: true })], calls);
  w.setArchiveView(true);
  w.document.querySelector(".session-item .s-unarc").click();
  await new Promise(r => setTimeout(r, 0));
  const hit = calls.find(c => c.url.includes("/archive"));
  assert.equal(JSON.parse(hit.opt.body).archived, false);
  w.setArchiveView(false);
  assert.ok(listHtml(w).includes(">b<"), "恢复后应回到主列表");
});

test("setArchiveView: tab-archive 高亮与 archive-mode 类随开关切换", async () => {
  const w = await bootWith([sess("a")], []);
  w.setArchiveView(true);
  assert.ok(w.document.getElementById("tab-archive").classList.contains("on"));
  assert.ok(w.document.getElementById("side-tabs-row").classList.contains("archive-mode"));
  w.setArchiveView(false);
  assert.ok(!w.document.getElementById("tab-archive").classList.contains("on"));
  assert.ok(!w.document.getElementById("side-tabs-row").classList.contains("archive-mode"));
});

test("Esc 退出归档视图", async () => {
  const w = await bootWith([sess("a")], []);
  w.setArchiveView(true);
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" }));
  assert.ok(!w.document.getElementById("side-tabs-row").classList.contains("archive-mode"),
    "Esc 后应退出归档视图");
});

test("批量归档入口: 归档视图工具行有批量钮, 选 7 天走 batch-archive", async () => {
  const calls = [];
  const w = await bootWith([sess("a"), sess("old", { archived: true })], calls);
  w.setArchiveView(true);
  const btn = w.document.querySelector(".list-label-row .icon-btn");
  assert.ok(btn, "归档视图应有批量归档钮");
  w.eval("pickBatchDays = () => Promise.resolve(7)");   // 覆盖全局函数绑定
  btn.click();
  await new Promise(r => setTimeout(r, 0));
  const hit = calls.find(c => c.url.includes("batch-archive"));
  assert.ok(hit, "应发批量归档请求");
  assert.equal(JSON.parse(hit.opt.body).days, 7);
});

test("session_unarchived 事件: 触发 /api/sessions 拉取刷新", async () => {
  const calls = [];
  const w = await bootWith([], calls);
  calls.length = 0;
  w.onSessionUnarchived({});
  await new Promise(r => setTimeout(r, 0));
  assert.ok(calls.some(c => c.url.includes("/api/sessions") && !c.url.includes("archive")),
    "session_unarchived 应触发会话列表重新拉取");
});
