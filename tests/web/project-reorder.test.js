// tests/web/project-reorder.test.js — 项目组拖动排序: projectOrder 渲染口径 /
// reorderProjects 换位与持久化 / 合成拖拽事件链 / 搜索态禁拖 / 陈旧 order 容错。
// fetch 全部桩掉; WebSocket 必须桩（否则 reconnect 退避 timer 吊住进程,
// 详见 archive-view.test.js 顶部注释）。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

function sess(id, { workdir = null } = {}) {
  return { id, title: id, message_count: 1,
           workdir: workdir === "none" ? null
             : (workdir === null ? "D:\\w\\proj" + id : workdir),
           archived: false, permission_mode: "default", plan_active: false };
}

/* loadApp 后: fetch 桩记调用; GET /api/sessions 返回给定会话, 经真实
 * loadSessions() 灌入 state。order 传入时在源码同一 eval 里播种——
 * 顶层 const state 不跨 eval 可见, 但 loadApp 的 extra 追加段共享词法环境,
 * 在其中既写 localStorage 又回填 state.projectOrder（等价启动装载路径）。 */
async function bootWith(sessions, order = null) {
  const seed = order
    ? 'localStorage.setItem("xc-project-order", ' + JSON.stringify(JSON.stringify(order)) + ');'
      + 'state.projectOrder = JSON.parse(localStorage.getItem("xc-project-order"));'
    : "";
  const { window } = loadApp(seed);
  window.WebSocket = class {
    constructor() {}
    close() {}
    send() {}
  };
  window.fetch = async (url, opt = {}) => {
    const isList = String(url).includes("/api/sessions")
      && !(opt.method && opt.method !== "GET")
      && !String(url).includes("search");
    return { ok: true, json: async () => isList ? { sessions } : { ok: true } };
  };
  await window.eval("loadSessions()");
  window.renderSessionList();
  return window;
}

const groupNames = w => [...w.document.querySelectorAll(".project-item .p-name")]
  .map(e => e.textContent);
/* reorderProjects 是拼接 eval 里的顶层函数声明, window 上可直接取到;
 * 走 eval 包装一层, 参数 JSON 序列化对反斜杠路径也安全 */
const reorder = (w, ...args) =>
  w.eval("reorderProjects(" + args.map(a => JSON.stringify(a)).join(",") + ")");
const storedOrder = w => JSON.parse(w.localStorage.getItem("xc-project-order"));
/* jsdom Event 无 dataTransfer/clientY, 处理器已容错; clientY 手动挂 */
const dragEv = (w, type, clientY) => {
  const ev = new w.Event(type, { bubbles: true, cancelable: true });
  if (clientY !== undefined) ev.clientY = clientY;
  return ev;
};
const headerOf = (w, sid) =>
  w.document.querySelector('.project-item[data-wd="D:\\\\w\\\\proj' + sid + '"]');

test("未手动排序: 组间保持最新会话倒序（无回归）", async () => {
  const w = await bootWith([sess("a1"), sess("z9")]);   // projz9 会话更新
  assert.deepEqual(groupNames(w), ["projz9", "proja1"]);
});

test("预置 xc-project-order: 按自定义序渲染, 旧会话组也能排前", async () => {
  const w = await bootWith([sess("a1"), sess("z9")],
    ["D:\\w\\proja1", "D:\\w\\projz9"]);
  assert.deepEqual(groupNames(w), ["proja1", "projz9"],
    "手动排过序的组按 order 数组序, 不再按最新会话");
});

test("reorderProjects: 更新 localStorage 与 DOM, 重渲染后保持", async () => {
  const w = await bootWith([sess("a1"), sess("z9")]);   // 当前序 [projz9, proja1]
  reorder(w, "D:\\w\\proja1", "D:\\w\\projz9", true);   // proja1 移到 projz9 之前
  assert.deepEqual(storedOrder(w), ["D:\\w\\proja1", "D:\\w\\projz9"]);
  assert.deepEqual(groupNames(w), ["proja1", "projz9"]);
  w.renderSessionList();   // 模拟后续任意重绘: 顺序须稳定
  assert.deepEqual(groupNames(w), ["proja1", "projz9"]);
});

test("合成事件链 dragstart→dragover→drop: 换位生效", async () => {
  const w = await bootWith([sess("a1"), sess("z9")]);   // 当前序 [projz9, proja1]
  const from = headerOf(w, "a1");
  const to = headerOf(w, "z9");
  assert.equal(from.draggable, true, "项目组头应可拖拽");
  from.dispatchEvent(dragEv(w, "dragstart"));
  const above = dragEv(w, "dragover", -10);   // clientY<0 → 上半 → 放前面
  to.dispatchEvent(above);
  to.dispatchEvent(dragEv(w, "drop", -10));   // drop 同样按指针位置判定前/后
  assert.deepEqual(storedOrder(w), ["D:\\w\\proja1", "D:\\w\\projz9"]);
  assert.deepEqual(groupNames(w), ["proja1", "projz9"]);
});

test("搜索态: 组头不可拖（过滤后的列表换位语义不明确）", async () => {
  const w = await bootWith([sess("a1"), sess("z9")]);
  w.document.getElementById("search-input").value = "proja1";
  w.renderSessionList();
  const head = headerOf(w, "a1");
  assert.ok(head, "搜索命中时项目组仍渲染");
  assert.equal(head.draggable, false);
});

test("order 含已删除的 workdir: 渲染不受影响且剩余排序仍生效", async () => {
  const w = await bootWith([sess("a1"), sess("z9")],
    ["D:\\w\\ghost", "D:\\w\\proja1", "D:\\w\\projz9"]);
  assert.deepEqual(groupNames(w), ["proja1", "projz9"],
    "ghost 组不存在只是被跳过, 其后条目的 rank 仍生效");
});

test("dragleave/dragend: 清理指示线与拖拽源, 不改顺序", async () => {
  const w = await bootWith([sess("a1"), sess("z9")]);
  const from = headerOf(w, "a1");
  const to = headerOf(w, "z9");
  from.dispatchEvent(dragEv(w, "dragstart"));
  to.dispatchEvent(dragEv(w, "dragover", -10));
  assert.equal(to.className.includes("drop-above"), true, "悬停上半应显示上方指示线");
  to.dispatchEvent(dragEv(w, "dragleave"));
  assert.equal(to.className.includes("drop-above"), false, "dragleave 应摘掉指示线");
  from.dispatchEvent(dragEv(w, "dragend"));
  to.dispatchEvent(dragEv(w, "drop"));   // dragend 后源已清空: drop 不应换位
  assert.equal(storedOrder(w), null, "未发生有效 drop 时不应写 order");
  assert.deepEqual(groupNames(w), ["projz9", "proja1"]);
});

test.afterEach(async () => {
  await new Promise(r => setImmediate(r));
});

/* ---- 回归: 历史回放中 present_plan 计划卡的位置 ----
 * 曾用 colOf(真列) appendChild, 被换入逻辑当"实时节点"挪到整个历史之后,
 * 卡片沉底（2026-10-21 现场）。必须走 msgCol() → 回放缓冲列, 按数组序就位。 */
test("历史回放: 计划卡按消息序渲染, 不沉底", async () => {
  const { loadApp } = require("./helpers");
  const msgs = [
    { role: "user", blocks: [{ type: "text", text: "任务" }], ts: "2026-10-20T23:41:00Z" },
    { role: "assistant", ts: "2026-10-20T23:47:59Z", blocks: [
      { type: "text", text: "计划如下" },
      { type: "tool_use", id: "t1", name: "present_plan", input: { plan: "# 计划" } },
    ]},
    { role: "tool", ts: "2026-10-20T23:48:00Z", blocks: [
      { type: "tool_result", tool_use_id: "t1", output: "ok" },
    ]},
    { role: "assistant", ts: "2026-10-20T23:50:00Z", blocks: [
      { type: "text", text: "后续总结消息" },
    ]},
  ];
  const seed = 'localStorage.setItem("xc-projects", "[]");';
  const { window: w } = loadApp(seed);
  w.WebSocket = class { constructor() {} close() {} send() {} };
  w.fetch = async (url, opt = {}) => {
    const isList = String(url).includes("/api/sessions")
      && !(opt.method && opt.method !== "GET") && !String(url).includes("search");
    if (String(url).endsWith("/messages")) {
      return { ok: true, json: async () => ({ session_id: "s1", workdir: null, messages: msgs }) };
    }
    return { ok: true, json: async () => isList ? { sessions: [] } : { ok: true } };
  };
  await w.eval("loadSessions()");
  // 选会话触发历史回放
  await w.eval("selectSession('s1')");
  await new Promise(r => setTimeout(r, 20));
  await w.eval("loadSessionHistory('s1')");
  await new Promise(r => setTimeout(r, 20));
  const col = w.document.getElementById("msg-col-s1");
  assert.ok(col, "会话列应已创建");
  const kids = [...col.children];
  const planIdx = kids.findIndex(el => el.classList && el.classList.contains("plan-card"));
  const summaryIdx = kids.findIndex(el => el.textContent && el.textContent.includes("后续总结消息"));
  assert.ok(planIdx >= 0, "计划卡应渲染");
  assert.ok(summaryIdx > planIdx,
    `计划卡(第${planIdx}个节点)必须在后续消息(第${summaryIdx}个节点)之前, 不应沉底`);
});

test.afterEach(async () => {
  await new Promise(r => setImmediate(r));
});
