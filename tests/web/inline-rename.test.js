// tests/web/inline-rename.test.js — 会话操作最终形态: 侧栏直操作钮(置顶+归档) + 顶栏…菜单
//
// 契约:
//   1. 侧栏行 hover 出两钮: 置顶(.s-pin, 前) + 归档(.s-arc, 后); 无"…"菜单钮、无删除钮
//   2. 点置顶 → POST /api/sessions/{id}/pin {pinned:!pinned}, 行加 .pinned 排最前(时间分组/项目组/任务区口径一致), toast 反馈
//   3. 已置顶: 行内常亮图钉(.s-pinned-ico, 非 hover 时显示); 再点置顶钮 = 取消
//   4. 点归档 → POST /archive {archived:true}(原行为)
//   5. 顶栏标题点击 → …菜单: 重命名/置顶(取消置顶)/归档, 无删除; 重命名走 promptDialog 弹窗(预填/maxLength 60)
//
// 历史: 行内编辑框 → 浮层 → …菜单+直操作钮混用 → 最终: 侧栏直操作钮 + 顶栏…菜单
// (用户 2026-10-20 两轮定稿; 404 是旧版 exe 未含 /pin 路由, 重启应用即愈)。
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
  // rAF(pretendToBeVisual 走 setTimeout)会吊住 node:test 事件循环。
  // app 里 rAF 只用于 focus/select, 同步执行语义无损
  window.requestAnimationFrame = fn => { fn(); return 0; };
  window.setInterval = () => 0;
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__state = () => state;");
  return window;
}

const __windows = [];
test.afterEach(() => {
  /* 不 close 旧窗口: jsdom close 会 teardown document, 上个用例
   * 残留的异步回调(loadSessions 链)穿过 teardown 后会把下一用例
   * eval 期间的共享状态搞坏(doc-more null)。进程退出由 test.after
   * 的 process.exit 兜底, 泄漏几个 jsdom 无碍。 */
  __windows.length = 0;
});
test.after(() => { setTimeout(() => process.exit(0), 50); });   // jsdom 定时器吊进程, 断言已完成

function stubFetch(w, calls) {
  const orig = w.fetch;
  w.fetch = async (url, opt = {}) => {
    calls.push({ url: String(url), opt });
    if (String(url).startsWith("/api/sessions")) {
      // GET 列表回 {sessions:[...]}: loadSessions 解构需要
      const isGet = !opt.method || opt.method === "GET";
      return { ok: true, json: async () => (isGet ? { sessions: w.__state().sessions || [] } : {}) };
    }
    return orig(url, opt);
  };
}

function setup(sessions) {
  const w = loadApp();
  const calls = [];
  stubFetch(w, calls);
  w.__state().sessions = sessions;
  w.renderSessionList();
  __windows.push(w);
  return { w, calls };
}
const sess = (id, extra = {}) => ({ id, title: "会话" + id, ts: Date.now(), archived: false, workdir: null, ...extra });

test("侧栏行 hover 钮: 置顶在前 + 归档在后; 无…菜单钮/删除钮/改名钮", () => {
  const { w } = setup([sess("a")]);
  const item = w.document.querySelector('.session-item[data-id="a"]');
  assert.ok(item.querySelector(".s-pin"), "置顶钮存在");
  assert.ok(item.querySelector(".s-arc"), "归档钮存在");
  const ops = [...item.querySelectorAll("button")].map(b => b.className);
  assert.ok(ops.indexOf("s-pin") < ops.indexOf("s-arc"), "置顶钮在归档钮之前");
  assert.ok(!item.querySelector(".s-del"), "普通视图行无删除钮");
  assert.ok(!item.querySelector(".s-more"), "侧栏行无…菜单钮(菜单只在顶栏)");
  assert.ok(!item.querySelector(".s-ren"), "行内无改名钮(改名在顶栏菜单)");
});

test("点置顶 → POST pin {pinned:true}, 行加 .pinned 排最前(时间分组视图)", async () => {
  const { w, calls } = setup([sess("a"), sess("b")]);
  w.document.querySelector('.session-item[data-id="a"] .s-pin').click();
  await new Promise(r => setTimeout(r, 50));
  const pin = calls.find(c => c.url.includes("/pin"));
  assert.ok(pin, "发了 pin 请求");
  assert.equal(JSON.parse(pin.opt.body).pinned, true);
  assert.equal(w.__state().sessions[0].pinned, true, "state 更新");
  const first = w.document.querySelector("#session-list .session-item");
  assert.equal(first.dataset.id, "a", "置顶排到列表最前");
  assert.ok(first.classList.contains("pinned"), "行带 .pinned");
});

test("已置顶: 再点置顶钮 = 取消; 项目组内同样置顶排序", async () => {
  const { w, calls } = setup([sess("a", { pinned: true }), sess("b")]);
  const itemA = w.document.querySelector('.session-item[data-id="a"]');
  assert.ok(itemA.classList.contains("pinned"), "初始 .pinned");
  itemA.querySelector(".s-pin").click();
  await new Promise(r => setTimeout(r, 50));
  const pin = calls.find(c => c.url.includes("/pin"));
  assert.equal(JSON.parse(pin.opt.body).pinned, false, "发取消置顶");
  assert.equal(w.__state().sessions[0].pinned, false, "state 更新");
});

test("项目组内置顶: 组内 pinned 会话排前面", () => {
  const wd = "D:/proj";
  const { w } = setup([
    sess("n1", { workdir: wd }), sess("p1", { workdir: wd, pinned: true }), sess("n2", { workdir: wd }),
  ]);
  const ids = [...w.document.querySelectorAll("#session-list .session-item")].map(e => e.dataset.id);
  assert.equal(ids.indexOf("p1"), 0, "组内置顶会话排最前");
});

test("点归档 → POST archive {archived:true}", async () => {
  const { w, calls } = setup([sess("a")]);
  w.document.querySelector('.session-item[data-id="a"] .s-arc').click();
  await new Promise(r => setTimeout(r, 50));
  const arc = calls.find(c => c.url.includes("/archive"));
  assert.ok(arc, "发了 archive 请求");
  assert.equal(JSON.parse(arc.opt.body).archived, true);
});

test("顶栏标题点击 → …菜单: 重命名/置顶/归档, 无删除", async () => {
  const { w } = setup([sess("a")]);
  w.__state().draft = false;
  w.__state().sessionId = "a";
  w.document.getElementById("doc-more").hidden = false; w.document.getElementById("doc-more").click();
  const pop = w.document.querySelector(".dd-pop");
  assert.ok(pop, "顶栏菜单出现");
  const labels = [...pop.querySelectorAll(".dd-opt .dd-txt")].map(e => e.textContent);
  assert.deepEqual(labels, ["重命名", "置顶", "归档"]);
  assert.ok(!labels.includes("删除"), "顶栏菜单无删除项");
});

test("顶栏菜单点重命名 → promptDialog 预填原标题, maxLength 60, Enter 提交", async () => {
  const { w, calls } = setup([sess("a")]);
  w.__state().draft = false;
  w.__state().sessionId = "a";
  w.document.getElementById("doc-more").hidden = false; w.document.getElementById("doc-more").click();
  [...w.document.querySelectorAll(".dd-pop .dd-opt")][0].click();   // 重命名
  const input = w.document.querySelector("#confirm-overlay input");
  assert.ok(input, "弹窗输入框存在");
  assert.equal(input.value, "会话a", "预填原标题");
  assert.equal(input.maxLength, 60);
  input.value = "改名后的标题";
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise(r => setTimeout(r, 50));
  const ren = calls.find(c => c.url.includes("/rename"));
  assert.ok(ren, "发了 rename 请求");
  assert.equal(JSON.parse(ren.opt.body).title, "改名后的标题");
});

test("顶栏菜单点置顶 → togglePin 发 pin 请求", async () => {
  const { w, calls } = setup([sess("a")]);
  w.__state().draft = false;
  w.__state().sessionId = "a";
  w.document.getElementById("doc-more").hidden = false; w.document.getElementById("doc-more").click();
  [...w.document.querySelectorAll(".dd-pop .dd-opt")]
    .find(b => b.textContent === "置顶").click();
  await new Promise(r => setTimeout(r, 50));
  const pin = calls.find(c => c.url.includes("/pin"));
  assert.ok(pin, "顶栏置顶发 pin 请求");
  assert.equal(JSON.parse(pin.opt.body).pinned, true);
});

test("运行中会话归档: 本地拦截, 不发请求, 友好提示", async () => {
  const { w, calls } = setup([sess("a")]);
  // 最小 run 桩: selectSession→渲染链会迭代 queue/pendingPerms 等字段
  w.__state().runs.a = { busy: true, queue: [], pendingPerms: {} };
  w.document.querySelector('.session-item[data-id="a"] .s-arc').click();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!calls.some(c => c.url.includes("/archive")), "busy 会话不发归档请求");
  assert.ok(w.document.body.textContent.includes("运行中"), "友好提示已展示");
});

test("后端 409(状态滞后) → 转友好提示, 不裸抛错误码", async () => {
  const { w, calls } = setup([sess("a")]);
  const orig = w.fetch;
  w.fetch = async (url, opt) => {
    if (String(url).includes("/archive")) return { ok: false, status: 409, json: async () => ({ detail: "会话正在对话中，暂不能归档" }) };
    return orig(url, opt);
  };
  w.document.querySelector('.session-item[data-id="a"] .s-arc').click();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(w.document.body.textContent.includes("运行中"), "409 转友好文案");
  assert.ok(!w.document.body.textContent.includes("409"), "不裸抛状态码");
});
