// tests/web/send-current-race.test.js — sendCurrent 草稿转正竞态回归
//
// 2026-10-10 事故: 草稿发送途中（POST /api/sessions 与列表刷新的 await
// 窗口里）切到旧会话, 全局 state.sessionId 被改写, 消息从旧会话的 WS
// 发出去——整轮对话写进旧会话文件, 新会话假死转圈。契约:
//   1. 消息归属在进入 await 前定死到局部 sid, await 之后不重读全局;
//   2. POST 期间草稿态同步收编, 重复发送不会双开会话;
//   3. 列表刷新不再阻塞消息上线（旧实现 await loadSessions 在 connectWs 前）。
// 手段: fetch 手闸桩 + FakeWS（微任务后 open, pendingSends 走真实
// onopen 冲刷路径）, 全部真实源码在 jsdom 里跑。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
  "desktop.js", "bubbles.js", "msg-extras.js", "ws-handlers.js",
  "sidebar.js", "settings-page.js"];   // = index.html 完整 defer 序

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;          // CONNECTING
    this.sent = [];
    FakeWS.all.push(this);
    // 模拟真实建连的异步性: open 发生在微任务之后, 发送期间建连中的
    // 消息进 run.pendingSends, 由 onopen 统一冲刷（与浏览器一致）
    queueMicrotask(() => {
      if (this.readyState === 0) {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      }
    });
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}
FakeWS.all = [];

function boot() {
  FakeWS.all = [];
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  const calls = [];   // fetch 调用记录, 每条带 resolve/reject 手闸
  window.WebSocket = FakeWS;
  window.fetch = (url, opts) => {
    opts = opts || {};
    const rec = {
      url: String(url), method: opts.method || "GET",
      body: opts.body ? JSON.parse(opts.body) : null,
    };
    calls.push(rec);
    return new Promise((resolve, reject) => {
      rec.resolve = (json) => resolve({ ok: true, json: async () => json });
      rec.reject = (err) => reject(err);
    });
  };
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  /* loadApp 同款闭包 shim: state 是顶层 const 不上 window, 借 eval 内
   * getter 暴露活引用; 发送路径要驱动的主要函数一并带出 */
  window.eval(src + "\n;\nwindow.__api = { get state() { return state; }, runOf, startDraft, sendCurrent, selectSession, colOf };");
  return { window, calls };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const inputEl = w => w.document.getElementById("input");
const sentMessages = ws => ws.sent.map(s => JSON.parse(s));

// ---- 事故回放: POST 期间切到旧会话, 消息必须留在新会话 ----

test("POST 期间切到旧会话: 消息仍归属新会话, 旧会话 WS 零流量", async () => {
  const { window, calls } = boot();
  const api = window.__api;

  // 旧会话已存在、历史已加载（多会话并行: 切走不断 WS）
  api.state.sessions.push({ id: "old-1", title: "旧会话" });
  api.runOf("old-1").loaded = true;

  api.startDraft();
  api.state.draftDir = "D:/proj";
  inputEl(window).value = "给升级功能加 GitHub 加速兜底";

  const sending = api.sendCurrent();          // POST /api/sessions 挂起中
  await api.selectSession("old-1");           // 用户此刻点了旧会话
  assert.equal(api.state.sessionId, "old-1");
  assert.equal(api.state.draft, false, "草稿态已被发送流程同步收编");

  const post = calls.find(c => c.method === "POST" && c.url === "/api/sessions");
  assert.ok(post, "建会话请求已发出");
  assert.deepEqual(post.body, { workdir: "D:/proj" });
  post.resolve({ id: "new-9" });
  await sending;
  await tick();                               // FakeWS open + pendingSends 冲刷

  // 视图仍属于用户选的旧会话, 新会话在后台静默运行
  assert.equal(api.state.sessionId, "old-1");
  assert.equal(api.runOf("new-9").busy, true);

  const newWs = api.runOf("new-9").ws;
  assert.ok(newWs, "新会话已建立自己的 WS");
  const userMsg = sentMessages(newWs).find(m => m.type === "user");
  assert.ok(userMsg, "用户消息已发往新会话");
  assert.equal(userMsg.text, "给升级功能加 GitHub 加速兜底");
  assert.equal(userMsg.workdir, "D:/proj");

  const oldWs = api.runOf("old-1").ws;
  assert.ok(oldWs, "旧会话 WS 已连接");
  assert.equal(sentMessages(oldWs).length, 0, "旧会话 WS 不允许收到任何消息");

  // 气泡落在新会话的消息列, 而不是旧会话的列里
  assert.ok(api.colOf("new-9").querySelector(".msg.user"), "气泡在新会话列");
  assert.equal(api.colOf("old-1").querySelector(".msg.user"), null);
});

// ---- 防双开: POST 期间的第二次发送不得再建会话 ----

test("POST 期间再点发送: 草稿已收编, 只建一个会话", async () => {
  const { window, calls } = boot();
  const api = window.__api;

  api.startDraft();
  inputEl(window).value = "第一条";
  const sending = api.sendCurrent();          // POST 挂起, 草稿态此刻已收编
  inputEl(window).value = "第二条";
  api.sendCurrent();                          // 非草稿且无连接: 静默忽略

  const posts = calls.filter(c => c.method === "POST" && c.url === "/api/sessions");
  assert.equal(posts.length, 1, "重复发送不得二次建会话");

  posts[0].resolve({ id: "new-a" });
  await sending;
  await tick();

  const sent = sentMessages(api.runOf("new-a").ws);
  const userMsg = sent.find(m => m.type === "user");
  assert.ok(userMsg && userMsg.text === "第一条");
});

// ---- 忙碌排队: 显式带 sid, 不经 curRun ----

test("忙碌会话发送: 消息进该会话队列并从该会话 WS 发出", async () => {
  const { window } = boot();
  const api = window.__api;

  api.state.sessions.push({ id: "s1", title: "忙碌会话" });
  api.state.sessionId = "s1";
  const run = api.runOf("s1");
  run.ws = new FakeWS("ws://x/s1");
  run.ws.readyState = 1;
  run.busy = true;

  inputEl(window).value = "排队消息";
  await api.sendCurrent();

  assert.equal(run.queue.length, 1);
  assert.equal(run.queue[0].text, "排队消息");
  const userMsg = sentMessages(run.ws).find(m => m.type === "user");
  assert.ok(userMsg && userMsg.text === "排队消息");
  assert.equal(inputEl(window).value, "", "输入已清空");
});

// ---- 列转正次序: 欢迎/empty 状态移除 + 列 id 唯一 ----

test("草稿转正: 欢迎空态移除, 列 id 唯一, 气泡在同一列", async () => {
  const { window, calls } = boot();
  const api = window.__api;

  api.startDraft();   // startDraft → showEmptyState: 草稿列里挂着欢迎空态
  assert.ok(window.document.querySelector("#msg-col-__draft__ .empty-state"),
            "前置: 草稿列确有欢迎空态");
  inputEl(window).value = "测列转正";
  const sending = api.sendCurrent();
  calls.find(c => c.method === "POST" && c.url === "/api/sessions")
       .resolve({ id: "new-c" });
  await sending;
  await tick();

  // 曾实测的翻车形态: colOf(sid) 先造新空列, 旧草稿列随后改名成同一
  // id → DOM 两份 msg-col-new-c, 流式内容解析回旧列插在欢迎页下
  assert.equal(window.document.querySelectorAll("#msg-col-new-c").length, 1,
               "转正后 DOM 只允许一份 msg-col-new-c");
  const col = api.colOf("new-c");
  assert.equal(col.querySelector(".empty-state"), null, "欢迎空态已移除");
  assert.ok(col.querySelector(".msg.user"), "用户气泡就在转正后的列里");
});

// ---- 第二扇窗口: 列表刷新不阻塞消息上线 ----
test("GET /api/sessions 永不返回, 消息也照常进入发送队列", async () => {
  const { window, calls } = boot();
  const api = window.__api;

  api.startDraft();
  inputEl(window).value = "不等人";
  const sending = api.sendCurrent();
  const post = calls.find(c => c.method === "POST" && c.url === "/api/sessions");
  post.resolve({ id: "new-b" });
  await sending;

  // 旧实现在 connectWs 前 await loadSessions: GET 挂起则消息永远发不出。
  // 新契约: POST 返回后同步入 pendingSends, 列表刷新退到后台
  assert.equal(api.runOf("new-b").busy, true);
  await tick();
  const userMsg = sentMessages(api.runOf("new-b").ws).find(m => m.type === "user");
  assert.ok(userMsg && userMsg.text === "不等人");
  assert.ok(calls.some(c => c.method === "GET" && c.url === "/api/sessions"),
            "列表刷新在后台照常发起");
});
