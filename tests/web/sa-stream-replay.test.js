// tests/web/sa-stream-replay.test.js — 子代理流持久化回放
//
// 契约（subagent_stream 持久化后, 历史回放按真实流重建面板）:
//   1. replaySubagentStreams: 逐事件喂现有渲染管线——卡片获得 _saStream
//      游离列, 内含 prompt 气泡(user_message)/思考/正文/工具卡;
//   2. 终态: ok=true → onSubagentDone 路径置"已完成"+耗时, 侧栏 tab
//      done-ok;
//   3. openSaPanel 后面板内容 = 流列本身（不再是摘要气泡）;
//   4. /api/agents 端点已删: loadSessionHistory 不再 fetch 它。
//
// 测真实产物: jsdom + index.html 骨架 + 完整 defer 序脚本 + marked。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["i18n/zh.js", "i18n/en.js", "i18n/i18n.js", "vendor/marked.umd.js",
  "ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
  "desktop.js", "bubbles.js", "msg-extras.js", "ws-handlers.js",
  "sidebar.js", "settings-page.js"];

function loadApp() {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__state = () => state;");
  return window;
}

async function setup(sid) {
  const w = loadApp();
  const fetched = [];
  // /api/sessions/{id}/messages 回带持久化流; 其余启动链给空值
  w.fetch = async (url) => {
    fetched.push(String(url));
    return { ok: true, status: 200, json: async () => (
      String(url).includes("/messages") ? {
        session_id: sid,
        // 消息链: 主 agent 派工的 tool_use + tool_result 回执
        // （回执文本带 agent_id, 渲染时工具卡升级成子代理卡）。
        // 格式对齐 renderHistoryMessage: {role, blocks:[...]}
        messages: [{
          role: "assistant", blocks: [
            { type: "tool_use", id: "tu1", name: "agent_tool",
              input: { subagent_type: "explore",
                       description: "调查侧边栏渲染逻辑" } },
          ],
        }, {
          role: "tool", blocks: [
            { type: "tool_result", id: "tu1", name: "agent_tool",
              output: "spawned agent_id: ag1 ok" },
          ],
        }],
        workdir: null,
        subagent_streams: {
          ag1: { events: [
            { type: "user_message", text: "调查侧边栏渲染逻辑" },
            { type: "thinking_start" },
            { type: "thinking_delta", text: "先看 app.js" },
            { type: "thinking_end" },
            { type: "text_delta", text: "调研完毕: " },
            { type: "text_delta", text: "渲染链在 bubbles.js" },
          ], ok: true, duration_s: 35 },
        },
      }
      : String(url).includes("/api/sessions") ? { sessions: [] }
      : {}) };
  };
  await new Promise(r => setTimeout(r, 30));
  w.__state().sessionId = sid;
  return { w, fetched };
}

test("replaySubagentStreams: 流事件重建面板内容(prompt/思考/正文)+终态", async () => {
  const { w } = await setup("s-rp1");
  // 建卡（回放时 spawn 回执升级路径等价: 直接走 started）
  w.onSubagentStarted({ agent_id: "ag1", subagent_type: "explore",
                        description: "调查侧边栏渲染逻辑" }, "s-rp1");
  const card = w.runOf("s-rp1").subagents.ag1;

  w.replaySubagentStreams("s-rp1", {
    ag1: { events: [
      { type: "user_message", text: "调查侧边栏渲染逻辑" },
      { type: "thinking_start" },
      { type: "thinking_delta", text: "先看 app.js" },
      { type: "thinking_end" },
      { type: "text_delta", text: "调研完毕: " },
      { type: "text_delta", text: "渲染链在 bubbles.js" },
    ], ok: true, duration_s: 35 },
  });

  // 流列已建: 卡片持有游离 _saStream
  const stream = card._saStream;
  assert.ok(stream && stream.isConnected !== undefined, "卡片获得流列");
  assert.match(stream.textContent, /调查侧边栏渲染逻辑/, "prompt 气泡在流里");
  assert.match(stream.textContent, /调研完毕: 渲染链在 bubbles.js/,
               "text_delta 顺序拼接");

  // 终态: completed + 耗时
  assert.equal(card.dataset.state, "ok", "ok=true 置已完成");
  assert.match(card.textContent, /已完成/, "状态文本");
  assert.match(card.textContent, /35/, "耗时写入");
});

test("loadSessionHistory 不再请求 /api/agents, 流随 messages 到达", async () => {
  const { w, fetched } = await setup("s-rp2");
  await w.loadSessionHistory("s-rp2");
  assert.ok(!fetched.some(u => u.includes("/api/agents")),
            "不再 fetch /api/agents");
  assert.ok(fetched.some(u => u.includes("/messages")), "拉了 messages");
  const card = w.runOf("s-rp2").subagents && w.runOf("s-rp2").subagents.ag1;
  assert.ok(card, "卡片已建（流回放前需有卡）");
  assert.ok(card._saStream, "流已回放进卡片");
  assert.equal(card.dataset.state, "ok", "终态已置");
});

test("openSaPanel: 面板内容是流列, 摘要机制不复存在", async () => {
  const { w } = await setup("s-rp3");
  w.onSubagentStarted({ agent_id: "ag1", subagent_type: "explore",
                        description: "调查" }, "s-rp3");
  w.replaySubagentStreams("s-rp3", {
    ag1: { events: [{ type: "user_message", text: "查一下" }], ok: true,
           duration_s: 2 },
  });
  const card = w.runOf("s-rp3").subagents.ag1;
  w.openSaPanel("ag1");
  const body = w.document.getElementById("sa-body");
  assert.ok(body.contains(card._saStream), "面板装的是流列本身");
  assert.ok(!body.querySelector(".sa-summary"), "无摘要气泡残留");
  assert.match(body.textContent, /查一下/, "prompt 可见");
});
