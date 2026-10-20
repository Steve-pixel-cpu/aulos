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
           /* "none" = 显式无项目（default 兜底）; 未传 = 默认带项目目录 */
           workdir: workdir === "none" ? null
             : (workdir === null ? "D:\\w\\proj" + id : workdir),
           archived, permission_mode: "default", plan_active: false };
}

/* loadApp 后: fetch 桩记调用; GET /api/sessions 返回给定会话,
   经真实 loadSessions 灌入 state（顶层数据通道, 零旁路） */
async function bootWith(sessions, fetchCalls) {
  const { window } = loadApp();
  /* 桩掉 WebSocket: loadSessions 成功 → init 自动 selectSession → connectWs。
   * 不桩的话 jsdom 会真实 TCP 连 127.0.0.1:8000, 失败后 scheduleReconnect
   * 指数退避 40 次(单次最长 10s), 事件循环被 timer 链吊住——13 个用例
   * 几百毫秒跑完, 进程却要再挂几分钟才退出（npm run test:web 超时的真因）。 */
  window.WebSocket = class {
    constructor() {}
    close() {}
    send() {}
  };
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

test("归档视图: 只显示已归档, 子行带恢复+删除钮与项目名(default 兜底)", async () => {
  const w = await bootWith([sess("a"), sess("b", { archived: true, workdir: "D:\\myproj" }), sess("c", { archived: true, workdir: "none" })], []);
  w.setArchiveView(true);
  const html = listHtml(w);
  assert.ok(html.includes(">b<"), "归档视图应显示已归档会话");
  assert.ok(html.includes(">c<"), "无项目归档会话也显示");
  assert.ok(!html.includes(">a<"), "未归档会话不出现在归档视图");
  assert.ok(!/data-tip="归档"/.test(html), "归档视图行不应再有归档钮");
  assert.ok(!/data-tip="重命名"/.test(html), "归档视图行不应有改名钮");
  assert.ok(/data-tip="恢复"/.test(html), "归档视图子行应有恢复钮");
  assert.ok(/data-tip="删除会话"/.test(html), "归档视图子行应有删除钮");
  assert.ok(html.includes("myproj"), "子行应带项目名");
  const items = [...w.document.querySelectorAll(".session-item")];
  const cItem = items.find(el => el.dataset.id === "c");
  assert.ok(cItem.querySelector(".s-workdir span").textContent === "default",
    "无项目的归档会话子行显示 default");
});

test("普通视图: 行带置顶+归档直操作钮, 无恢复钮", async () => {
  const w = await bootWith([sess("a")], []);
  const html = listHtml(w);
  assert.ok(/data-tip="置顶"/.test(html), "普通视图行应有置顶钮");
  assert.ok(/data-tip="归档"/.test(html), "普通视图行应有归档钮");
  assert.ok(!/data-tip="删除会话"/.test(html), "普通视图行不应有独立删除钮");
  assert.ok(!/data-tip="恢复"/.test(html), "普通视图行不应有恢复钮");
});

test("归档视图: 空态也渲染工具行（批量归档是空列表的入口）", async () => {
  const w = await bootWith([sess("a")], []);
  w.setArchiveView(true);
  const html = listHtml(w);
  assert.ok(html.includes("暂无归档会话"));
  const tips = [...w.document.querySelectorAll(".list-label-row .icon-btn")].map(b => b.dataset.tip);
  assert.ok(tips.some(t => t.startsWith("排序:")), "空态仍有排序钮");
  assert.ok(tips.some(t => t.includes("批量归档")), "空态仍有批量归档钮");
  assert.ok(tips.includes("更多操作"), "空态仍有…菜单");
  /* 回归: 空态按钮必须可点——innerHTML += 曾销毁重建工具行,
   * onclick 随旧元素丢失, 点了没反应 */
  w.document.querySelector('.list-label-row .icon-btn[data-tip^="排序:"]').click();
  await new Promise(r => setTimeout(r, 0));
  assert.ok(w.document.querySelector(".dd-pop"), "空态点排序钮应弹出菜单");
  assert.ok(w.document.body.textContent.includes("更新时间"), "菜单应含排序选项");
});

test("点行归档钮: POST archive archived=true, 行原地移出主列表", async () => {
  const calls = [];
  const w = await bootWith([sess("a"), sess("keep")], calls);
  const row = w.document.getElementById("session-a") || [...w.document.querySelectorAll(".session-item")].find(el => el.dataset.id === "a");
  row.querySelector(".s-arc").click();                       // 直操作钮
  await new Promise(r => setTimeout(r, 0));
  const hit = calls.find(c => c.url.includes("/archive") && c.opt.method === "POST");
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
  const hit = calls.find(c => c.url.includes("/archive") && c.opt.method === "POST");
  assert.ok(hit, "应发恢复(archive archived=false)请求");
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

test("批量归档入口: 预设档点击走 batch-archive", async () => {
  const calls = [];
  const w = await bootWith([sess("a"), sess("old", { archived: true })], calls);
  w.setArchiveView(true);
  const batchBtn = [...w.document.querySelectorAll(".list-label-row .icon-btn")]
    .find(b => b.dataset.tip.includes("批量归档"));
  assert.ok(batchBtn, "归档视图工具行应有批量归档钮");
  batchBtn.click();
  await new Promise(r => setTimeout(r, 0));
  const preset = [...w.document.querySelectorAll(".batch-pop .dd-opt")]
    .find(b => b.textContent.includes("30"));
  assert.ok(preset, "弹层应有 30 天预设档");
  preset.click();
  await new Promise(r => setTimeout(r, 0));
  const hit = calls.find(c => c.url.includes("batch-archive"));
  assert.ok(hit, "应发批量归档请求");
  assert.equal(JSON.parse(hit.opt.body).days, 30);
});

test("批量归档弹层: 自定义天数档点击展开输入, Enter 提交", async () => {
  const calls = [];
  const w = await bootWith([sess("old", { archived: true })], calls);
  w.setArchiveView(true);
  const batchBtn = [...w.document.querySelectorAll(".list-label-row .icon-btn")]
    .find(b => b.dataset.tip.includes("批量归档"));
  batchBtn.click();
  await new Promise(r => setTimeout(r, 0));
  // 初始只有选项, 没有输入框
  assert.ok(!w.document.querySelector(".batch-days-input"), "默认不显示输入框");
  const custom = [...w.document.querySelectorAll(".batch-pop .dd-opt")]
    .find(b => b.textContent.includes("自定义天数"));
  assert.ok(custom, "弹层应有自定义天数档");
  custom.click();
  await new Promise(r => setTimeout(r, 0));
  const inp = w.document.querySelector(".batch-days-input");
  assert.ok(inp, "点击后应展开输入框");
  inp.value = "14";
  inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise(r => setTimeout(r, 0));
  const hit = calls.find(c => c.url.includes("batch-archive"));
  assert.equal(JSON.parse(hit.opt.body).days, 14);
});

test("排序方式: 弹层两档, 选更新时间按 mtime 排序并持久化", async () => {
  const w = await bootWith([
    { id: "20260901-000000", title: "旧", message_count: 1, workdir: "D:/p1", archived: true,
      permission_mode: "default", plan_active: false, mtime: 100 },
    { id: "20260902-000000", title: "中", message_count: 1, workdir: "D:/p2", archived: true,
      permission_mode: "default", plan_active: false, mtime: 300 },
    { id: "20260903-000000", title: "新", message_count: 1, workdir: "D:/p3", archived: true,
      permission_mode: "default", plan_active: false, mtime: 200 },
  ], []);
  w.setArchiveView(true);
  const sortBtn = [...w.document.querySelectorAll(".list-label-row .icon-btn")]
    .find(b => b.dataset.tip.startsWith("排序:"));
  assert.ok(sortBtn, "工具行应有排序钮");
  // 默认 created: id 倒序 → 新、中、旧
  assert.deepEqual([...w.document.querySelectorAll(".session-item .title")].map(e => e.textContent),
    ["新", "中", "旧"]);
  sortBtn.click();
  await new Promise(r => setTimeout(r, 0));
  const opt = [...w.document.querySelectorAll(".dd-pop .dd-opt")]
    .find(b => b.textContent.includes("更新时间"));
  assert.ok(opt, "排序弹层应有更新时间档");
  opt.click();
  await new Promise(r => setTimeout(r, 0));
  // updated: mtime 倒序 → 中(300)、新(200)、旧(100)
  assert.deepEqual([...w.document.querySelectorAll(".session-item .title")].map(e => e.textContent),
    ["中", "新", "旧"]);
  assert.equal(w.localStorage.getItem("xc-archive-sort"), "updated");
});

test("…菜单: 显示归档计数, 全部删除走确认框 + batch-delete-archived", async () => {
  const calls = [];
  const w = await bootWith([sess("keep"), sess("old", { archived: true })], calls);
  w.setArchiveView(true);
  const moreBtn = [...w.document.querySelectorAll(".list-label-row .icon-btn")]
    .find(b => b.dataset.tip === "更多操作");
  assert.ok(moreBtn, "工具行应有更多操作钮");
  moreBtn.click();
  await new Promise(r => setTimeout(r, 0));
  const head = w.document.querySelector(".dd-pop .dd-head");
  assert.ok(head && head.textContent.includes("1 个归档任务"), "菜单头应显示归档计数");
  // 桩掉 confirmDialog: 拒绝时不发请求
  w.eval("window.confirmDialog = () => Promise.resolve(false)");
  const delOpt = [...w.document.querySelectorAll(".dd-pop .dd-opt.danger")]
    .find(b => b.textContent.includes("删除所有归档任务"));
  assert.ok(delOpt, "菜单应有删除所有归档任务");
  delOpt.click();
  await new Promise(r => setTimeout(r, 0));
  assert.ok(!calls.some(c => c.url.includes("batch-delete")), "拒绝后不应发删除请求");
  // 接受时发请求
  w.eval("window.confirmDialog = () => Promise.resolve(true)");
  moreBtn.click();
  await new Promise(r => setTimeout(r, 0));
  [...w.document.querySelectorAll(".dd-pop .dd-opt.danger")].find(b => b.textContent.includes("删除所有归档任务")).click();
  await new Promise(r => setTimeout(r, 0));
  const hit = calls.find(c => c.url.includes("batch-delete-archived"));
  assert.ok(hit, "确认后应发批量删除请求");
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
