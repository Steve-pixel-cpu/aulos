// tests/web/session-renamed.test.js — session_renamed 事件即时更新侧栏标题
//
// 契约:
//   1. onSessionRenamed 就地更新 state.sessions 里对应会话的 title 并重绘,
//      不依赖 loadSessions 的网络往返（事件自带权威标题）;
//   2. loadSessions 竞态防护: 晚到的旧响应不覆盖新数据（发送序号判定）。
//
// 回归背景: 旧实现丢弃 msg.title 只重新 fetch 列表——turn_done 时刻发出的
// 列表请求（无标题）常晚于 AI 命名落盘, 两请求竞态后旧响应胜出, 侧栏停留
// "未命名"直到用户下次操作（2026-10-21 现场: 标题 02:08 已落盘, UI 02:12
// 二次发消息才显形）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["i18n/zh.js", "i18n/en.js", "i18n/i18n.js", "ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
  "desktop.js", "bubbles.js", "msg-extras.js", "ws-handlers.js",
  "sidebar.js", "settings-page.js"];   // = index.html 完整 defer 序

function setup() {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__exports = () => ({ state, onSessionRenamed, loadSessions });");
  // init() 的异步尾巴安静落地, 避免 "activity after test ended" 噪音
  return new Promise(res => setTimeout(() => res(window), 30));
}

test("session_renamed: 就地更新对应会话标题并重绘", async () => {
  const w = await setup();
  const { state, onSessionRenamed } = w.__exports();
  state.sessions = [
    { id: "s1", title: "", archived: false, pinned: false, mtime: 1 },
    { id: "s2", title: "", archived: false, pinned: false, mtime: 2 },
  ];
  onSessionRenamed({ type: "session_renamed", session_id: "s2", title: "用户输入过长折叠显示" });
  assert.equal(state.sessions[1].title, "用户输入过长折叠显示");
  assert.equal(state.sessions[0].title, "");   // 其他会话不受影响
  w.close();
});

test("session_renamed: 无标题字段不破坏现有 state", async () => {
  const w = await setup();
  const { state, onSessionRenamed } = w.__exports();
  state.sessions = [{ id: "s1", title: "旧标题", archived: false, pinned: false, mtime: 1 }];
  onSessionRenamed({ type: "session_renamed", session_id: "s1" });
  assert.equal(state.sessions[0].title, "旧标题");
  w.close();
});

test("session_renamed: 会话尚不在列表（新会话）也不抛错", async () => {
  const w = await setup();
  const { state, onSessionRenamed } = w.__exports();
  state.sessions = [];
  assert.doesNotThrow(() => {
    onSessionRenamed({ type: "session_renamed", session_id: "ghost", title: "新标题" });
  });
  w.close();
});

test("loadSessions 竞态防护: 晚到的旧响应被丢弃", async () => {
  const w = await setup();
  const { state, loadSessions } = w.__exports();
  // 受控 fetch: 第一次请求挂住, 第二次立即返回新数据
  let release = null;
  let first = true;
  w.fetch = () => {
    if (first) {
      first = false;
      return new Promise(res => {
        release = () => res({ json: async () => ({ sessions: [{ id: "old", title: "旧", archived: false, pinned: false, mtime: 1 }] }) });
      });
    }
    return Promise.resolve({ json: async () => ({ sessions: [{ id: "new", title: "新", archived: false, pinned: false, mtime: 2 }] }) });
  };
  // 先发旧请求（挂住）, 再发新请求（立即回）
  const load1 = loadSessions();
  await loadSessions();
  release();            // 旧响应此刻才落地
  await load1;
  assert.equal(state.sessions[0].id, "new");   // 旧响应未覆盖
  w.close();
});
