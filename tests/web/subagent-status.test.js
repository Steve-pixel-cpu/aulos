// tests/web/subagent-status.test.js — 子智能体卡片执行状态标识
//
// 契约:
//   1. subagent_started → 卡片进入"运行中"(dataset.state="run",
//      .tstate 文本"运行中"), 工具组头部计数含它;
//   2. 执行期间到达的 agent_tool tool_result(被吸收路径)不改状态;
//   3. subagent_done(completed) → "已完成"(dataset.state="ok" + 文本),
//      耗时写入 .t-dur, 工具组头部重算;
//   4. subagent_done(failed) → "失败"(dataset.state="err");
//   5. 侧栏 tab 状态点: started 后 running, done 后 done-ok。
//
// 回归背景: started 即 setToolState(card,"ok") —— 子代理刚开始就被标
// "已完成"(截图: 两个子代理还在跑、agent_wait 还在等, 卡片却全绿)。
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
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__state = () => state;");
  return window;
}

function setup(sid) {
  const w = loadApp();
  w.__state().sessionId = sid;
  return w;
}

function stateText(card) {
  return card.querySelector(".tstate").textContent;
}

test("started → 运行中; done(completed) → 已完成; 计数随之收口", () => {
  const w = setup("s-sa");
  w.onSubagentStarted({ agent_id: "ag1", subagent_type: "explore",
                        description: "调查" }, "s-sa");
  const card = w.runOf("s-sa").subagents.ag1;
  assert.ok(card, "started 建卡并登记路由");
  assert.equal(card.dataset.state, "run", "started 后卡片为运行中");
  assert.equal(stateText(card), "运行中");

  // 工具组头部: 该行计入"运行中"
  const grp = card.closest(".tool-group");
  const sum = grp.querySelector(".tg-sum");
  assert.match(sum.textContent, /运行中/, "组头计数把运行中的子代理算进去");

  // done: 状态翻转为已完成 + 耗时 + 组头重算
  w.onSubagentDone({ agent_id: "ag1", status: "completed",
                     duration_s: 5 }, "s-sa");
  assert.equal(card.dataset.state, "ok", "done 后 dataset.state=ok");
  assert.equal(stateText(card), "已完成");
  assert.match(card.querySelector(".t-dur").textContent, /5 ?秒/, "耗时写入");
  assert.ok(!/运行中/.test(sum.textContent), "组头不再显示运行中");
});

test("吸收路径: spawn 的 tool_result 不改子代理卡状态", () => {
  const w = setup("s-sa2");
  // 占位卡(agent_tool 参数未到)被 started 吸收
  w.onToolUseStarted({ id: "tu1", name: "agent_tool", input: "" }, "s-sa2");
  w.onSubagentStarted({ agent_id: "ag2", subagent_type: "explore",
                        description: "调查" }, "s-sa2");
  const card = w.runOf("s-sa2").subagents.ag2;
  assert.equal(card.dataset.state, "run", "started 后运行中");

  // agent_tool 的 tool_result(含 agent_id 回执) 到达: 被吞掉, 不 complete
  w.onToolResult({ id: "tu1", name: "agent_tool",
                   output: "spawned agent_id: ag2" }, "s-sa2");
  assert.equal(card.dataset.state, "run", "spawn 回执不改状态");
  assert.equal(stateText(card), "运行中");

  w.onSubagentDone({ agent_id: "ag2", status: "completed", duration_s: 2 }, "s-sa2");
  assert.equal(card.dataset.state, "ok");
});

test("done(failed) → 失败", () => {
  const w = setup("s-sa3");
  w.onSubagentStarted({ agent_id: "ag3", subagent_type: "general",
                        description: "干活" }, "s-sa3");
  const card = w.runOf("s-sa3").subagents.ag3;
  w.onSubagentDone({ agent_id: "ag3", status: "failed", duration_s: 3,
                     error: "boom" }, "s-sa3");
  assert.equal(card.dataset.state, "err");
  assert.equal(stateText(card), "失败");
});

test("侧栏 tab 状态点随生命周期翻转", () => {
  const w = setup("s-sa4");
  w.onSubagentStarted({ agent_id: "ag4", subagent_type: "explore",
                        description: "调查" }, "s-sa4");
  w.openSaPanel("ag4");
  let tab = w.document.querySelector("#sa-tabs .sa-tab");
  assert.ok(tab.classList.contains("running"), "运行中: 点转圈");

  w.onSubagentDone({ agent_id: "ag4", status: "completed", duration_s: 1 }, "s-sa4");
  tab = w.document.querySelector("#sa-tabs .sa-tab");
  assert.ok(tab.classList.contains("done-ok"), "完成: 点变绿");
});

test("长会话历史分组: 已完成子代理收进「历史 N」胶囊, 不再占满 tab 行", () => {
  const w = setup("s-sa5");
  // 8 个已完成 + 1 个运行中
  for (let i = 1; i <= 8; i++) {
    w.onSubagentStarted({ agent_id: "done" + i, subagent_type: "explore",
                          description: "调查" + i }, "s-sa5");
    w.onSubagentDone({ agent_id: "done" + i, status: "completed",
                       duration_s: 3 }, "s-sa5");
  }
  w.onSubagentStarted({ agent_id: "live1", subagent_type: "general",
                        description: "实时代理" }, "s-sa5");

  // 渲染状态: tab 行只放 1 个运行中的 tab + 1 个历史胶囊
  // （openSaPanel(null) 会提前 return 不渲染 —— 直接调渲染函数）
  w.saRenderTabs(w.runOf("s-sa5"));
  const tabs = w.document.querySelectorAll("#sa-tabs .sa-tab");
  const histBtn = w.document.querySelector("#sa-tabs .sa-hist-btn");
  assert.ok(histBtn, "存在历史胶囊");
  assert.match(histBtn.textContent, /历史 ?8/, "胶囊计数 8");
  assert.equal(tabs.length, 2, "tab 行 = 运行中 + 胶囊 (历史不再平铺)");

  // 运行中 tab 是 live1, 不是 done 系列
  assert.ok(tabs[0].classList.contains("running"), "平铺的是运行中代理");
  assert.equal(tabs[0].dataset.agent, "live1");

  // 点开胶囊: 列出 8 个历史项
  histBtn.click();
  const items = w.document.querySelectorAll("#sa-history .sa-hist-item");
  assert.equal(items.length, 8, "历史列表面板有 8 项");
  assert.match(items[0].textContent, /探索/, "历史项带类型前缀");
  // 点开历史项 → openSaPanel(done1), tab 行变成"当前选中 done1"置顶
  items[0].click();
  const tabsAfter = w.document.querySelectorAll("#sa-tabs .sa-tab");
  const onTab = w.document.querySelector("#sa-tabs .sa-tab.on");
  assert.ok(onTab, "有打开中的 tab 高亮");
  assert.equal(onTab.dataset.agent, "done1", "点历史项打开对应代理面板");
  assert.equal(tabsAfter[0].dataset.agent, "done1", "当前打开的历史代理置顶");
  assert.ok(w.runOf("s-sa5").subagents.done1, "历史代理卡仍在路由表");
});

test("回放后 reconcileSaCardsFromManifests: 给空白卡补摘要气泡", async () => {
  const w = setup("s-sa6");
  // 卡片已由回放登记 (无流, 无状态), 模拟 empty 卡
  w.onToolUseStarted({ id: "tu1", name: "agent_tool", input: "{}" }, "s-sa6");
  w.onSubagentStarted({ agent_id: "ag6", subagent_type: "verify",
                        description: "校验" }, "s-sa6");
  // 无 subagent_event, 卡片无 _saStream
  const card = w.runOf("s-sa6").subagents.ag6;

  // mock fetch: 只 mock /api/agents, 其余路径仍走 stub(抛错)——
  // 否则 init() 的 loadSettings/loadSessions 会被"成功 mock"打进
  // 意外成功路径, 反而触发真实 bug
  const realFetch = w.fetch;
  w.fetch = (url) => {
    if (String(url).includes("/api/agents")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ agents: [{
          agent_id: "ag6", subagent_type: "verify", description: "校验",
          status: "completed", result_preview: "12 项全过", error: "",
        }] }),
      });
    }
    return realFetch(url);
  };

  await w.reconcileSaCardsFromManifests("s-sa6");
  const sum = card.querySelector(".sa-summary");
  assert.ok(sum, "空白卡补上摘要气泡");
  assert.match(sum.textContent, /12 项全过/, "摘要含结果预览");
  assert.match(sum.textContent, /完成/, "摘要元信息含状态");
});
