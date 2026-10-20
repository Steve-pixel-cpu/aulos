// tests/web/sa-summary-lifecycle.test.js — 子代理摘要气泡的生命周期与渲染
//
// 契约（回归背景: 历史会话里打开子代理 A 的面板后, 摘要被从宿主卡摘走
// 搬进 #sa-body 且没人搬回; 切到子代理 B 时面板里叠着 A 的旧内容 —— 串台）:
//   1. reconcile 后无实时流的卡片补摘要气泡, 正文走 renderMd（渲染后 HTML）;
//   2. openSaPanel(A) → openSaPanel(B) 后 #sa-body 里只有 B 的摘要
//      （旧摘要已被归还给各自宿主卡, 不再残留）;
//   3. closeSaPanel 后摘要回到宿主卡尾、无 hosted 类, 面板清空;
//      重新打开同一代理, 内容仍是它自己的（关-开不串台）。
//
// 测的是真实产物: jsdom + 真实 index.html 骨架 + 完整 defer 序脚本,
// 额外 eval vendor/marked.umd.js（浏览器里它在 app.js 之前加载,
// helpers.pageHtml 会剥掉所有 <script>, 这里手动补上以走真实渲染路径）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
// = index.html 完整 defer 序, marked 插在 i18n 之后 app.js 之前（与页面一致）
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

// 回放场景搭建: 建一个会话消息列, 手工登记两张"无实时流"的子代理卡
// （= 历史回放重建出的空白卡, 与 reconcileSaCardsFromManifests 的输入一致）
async function setupWithCards(sid, stub) {
  const w = loadApp();
  // fetch 按 URL 分流: /api/agents 给 manifest 假数据, 其余给启动链
  // 的安全空值（照 i18n-hot-switch/browser-visibility 的既有模式）
  w.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes("/api/agents")
      ? stub
      : String(url).includes("/api/sessions")
        ? { sessions: [] }        // loadSessions 期望 {sessions:[...]}
        : {}),                    // 其余（settings 等）给空对象即可
  });
  // 等 init() 的异步尾巴安静落地, 避免 "activity after test ended" 噪音;
  // init 以空会话列表收尾会把 sessionId 置回 null, 故会话 id 在此之后设
  await new Promise(r => setTimeout(r, 30));
  w.__state().sessionId = sid;
  const col = w.colOf(sid);
  const mk = (aid, desc) => {
    const card = w.document.createElement("div");
    card.className = "tool-row";
    card.dataset.tool = "agent_tool";
    const d = w.document.createElement("div");
    d.className = "tdesc";
    d.textContent = desc;
    card.appendChild(d);
    col.appendChild(card);
    w.registerSubagentCard(w.runOf(sid), aid, card);
    return card;
  };
  return { w, col, mk };
}

const MANIFESTS = {
  agents: [
    { agent_id: "a1", subagent_type: "explore", description: "调查A",
      status: "completed", result_preview: "**b** 加粗", error: "",
      result_truncated: false },
    { agent_id: "a2", subagent_type: "general", description: "干活B",
      status: "completed", result_preview: "普通文本", error: "",
      result_truncated: false },
  ],
};

function summarize(w, sid) {
  return w.reconcileSaCardsFromManifests(sid);
}

test("reconcile 后摘要生成且正文是渲染后 HTML（marked 真实参与）", async () => {
  const { w, mk } = await setupWithCards("s-sum1", MANIFESTS);
  const cardA = mk("a1", "调查A");
  await summarize(w, "s-sum1");

  const sum = cardA.querySelector(".sa-summary");
  assert.ok(sum, "无实时流的卡片补上摘要气泡");
  const body = cardA.querySelector(".sa-summary-body");
  assert.ok(body, "摘要有正文");
  assert.equal(body.tagName, "DIV", "正文用 div（markdown 块级容器）");
  assert.ok(body.innerHTML.includes("<strong>b</strong>"),
    "正文已渲染: **b** → <strong>b</strong>");
});

test("openSaPanel(A) → openSaPanel(B) 后 #sa-body 只剩 B 的摘要", async () => {
  const { w, mk } = await setupWithCards("s-sum2", MANIFESTS);
  const cardA = mk("a1", "调查A");
  const cardB = mk("a2", "干活B");
  await summarize(w, "s-sum2");
  assert.ok(cardA.querySelector(".sa-summary") && cardB.querySelector(".sa-summary"));

  const sumB = cardB.querySelector(".sa-summary");
  w.openSaPanel("a1");
  const body1 = w.document.getElementById("sa-body");
  assert.equal(body1.querySelectorAll(".sa-summary").length, 1, "开 A: 面板里 1 份摘要");

  w.openSaPanel("a2");
  const sums = body1.querySelectorAll(".sa-summary");
  assert.equal(sums.length, 1, "切到 B: 面板里仍只有 1 份摘要（A 的已归还）");
  assert.ok(sums[0] === sumB, "留下的这份是 B 的那个节点");
  assert.ok(cardA.contains(cardA.querySelector(".sa-summary")),
    "A 的摘要回到 A 卡上");
});

test("closeSaPanel 后摘要回宿主卡且无 hosted 类; 重开不串台", async () => {
  const { w, mk } = await setupWithCards("s-sum3", MANIFESTS);
  const cardA = mk("a1", "调查A");
  const cardB = mk("a2", "干活B");
  await summarize(w, "s-sum3");

  w.openSaPanel("a1");
  w.closeSaPanel();
  const panelBody = w.document.getElementById("sa-body");
  const back = cardA.querySelector(".sa-summary");
  assert.ok(back, "摘要回到 A 卡");
  assert.ok(!back.classList.contains("hosted") &&
            !back.classList.contains("bubble-host"),
    "宿主卡内不再带面板样式类");
  assert.equal(panelBody.querySelectorAll(".sa-summary").length, 0,
    "面板清空");

  // 关-开循环: 重开 A 仍是 A 的内容, 不叠 B 的
  const sumA = cardA.querySelector(".sa-summary");
  w.openSaPanel("a1");
  const sums = panelBody.querySelectorAll(".sa-summary");
  assert.equal(sums.length, 1, "重开: 面板仍只有 1 份摘要");
  assert.ok(sums[0] === sumA, "且是 A 自己的那个节点");
  assert.ok(!cardB.querySelector(".sa-summary").classList.contains("hosted"),
    "B 的摘要始终留在自己卡上");
});
