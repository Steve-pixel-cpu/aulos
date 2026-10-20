// tests/web/sa-task-fold.test.js — 子智能体任务输入气泡折叠
//
// 契约:
//   1. user_message 镜像事件渲染的气泡, 超过阈值（行数>8 或 字符>300）
//      默认折叠: .sa-task-folded + .u-text 内联 maxHeight=176px +
//      .sa-task-fade 渐隐 + .sa-task-expand 胶囊;
//   2. 短提示不折叠（无类、无按钮、无内联限高）;
//   3. 点「展开」→ .sa-task-open + maxHeight 释放 + 文案变「收起」;
//      再点 → 还原。
//
// 回归背景: 旧实现 rAF 里量 uText.scrollHeight 定折叠——但事件到达时
// 气泡写在游离列（card._saStream, 面板没开就不挂 DOM）, 无布局盒的
// 元素 scrollHeight 恒为 0, 恒判"短任务", 折叠从未生效（2026-10-20
// 现场: 整段 prompt 满屏展开）。改为内容长度判定后与挂载状态解耦。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["i18n/zh.js", "i18n/en.js", "i18n/i18n.js", "ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
  "desktop.js", "bubbles.js", "msg-extras.js", "ws-handlers.js",
  "sidebar.js", "settings-page.js"];   // = index.html 完整 defer 序

function setup(sid) {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__state = () => state;");
  window.__state().sessionId = sid;
  return window;
}

/* 派发 started + user_message, 返回气泡所在 .msg 节点。
 * 关键: 不开侧栏面板——气泡落在游离列上（恰是回归场景: 旧实现
 * 在此路径 scrollHeight=0 恒判短, 折叠失效）。 */
function dispatchTask(w, sid, text) {
  w.onSubagentStarted({ agent_id: "ag1", subagent_type: "explore",
                        description: "调查" }, sid);
  w.onSubagentEvent({ agent_id: "ag1",
                      event: { type: "user_message", text } }, sid);
  const card = w.runOf(sid).subagents.ag1;
  const col = card._saStream;
  return { card, msg: col.querySelector(".msg.user") };
}

test("长任务提示: 默认折叠（游离列路径也生效）", () => {
  const w = setup("s-fold1");
  const longPrompt = "You are a Senior Code Reviewer.\n\n".padEnd(400, "x");
  const { msg } = dispatchTask(w, "s-fold1", longPrompt);
  assert.ok(msg, "任务气泡已渲染进嵌套流");
  assert.ok(msg.classList.contains("sa-task-folded"), "长提示加折叠类");
  const uText = msg.querySelector(".u-text");
  assert.equal(uText.style.maxHeight, "176px", "限高 176px 内联生效");
  assert.ok(msg.querySelector(".sa-task-fade"), "底部渐隐层存在");
  const btn = msg.querySelector(".sa-task-expand");
  assert.ok(btn, "「展开」胶囊存在");
  assert.match(btn.textContent, /展开/);
});

test("多行但字符不多: 行数超阈值同样折叠", () => {
  const w = setup("s-fold2");
  const tenLines = Array.from({ length: 10 }, (_, i) => "行" + i).join("\n");
  assert.ok(tenLines.length <= 300, "前提: 字符未超, 走行数阈值");
  const { msg } = dispatchTask(w, "s-fold2", tenLines);
  assert.ok(msg.classList.contains("sa-task-folded"), ">8 行折叠");
});

test("短任务提示: 不折叠", () => {
  const w = setup("s-fold3");
  const { msg } = dispatchTask(w, "s-fold3", "查一下这个函数的调用方");
  assert.ok(msg, "气泡已渲染");
  assert.ok(!msg.classList.contains("sa-task-folded"), "短提示无折叠类");
  assert.equal(msg.querySelector(".u-text").style.maxHeight, "", "无限高");
  assert.ok(!msg.querySelector(".sa-task-expand"), "无展开按钮");
  assert.ok(!msg.querySelector(".sa-task-fade"), "无渐隐层");
});

test("展开/收起: 点击翻转限高与文案", () => {
  const w = setup("s-fold4");
  const longPrompt = Array.from({ length: 12 }, (_, i) => "line " + i).join("\n");
  const { msg } = dispatchTask(w, "s-fold4", longPrompt);
  const btn = msg.querySelector(".sa-task-expand");
  const uText = msg.querySelector(".u-text");

  btn.dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.ok(msg.classList.contains("sa-task-open"), "展开态类挂上");
  assert.equal(uText.style.maxHeight, "none", "限高释放");
  assert.match(btn.textContent, /收起/, "文案变「收起」");

  btn.dispatchEvent(new w.Event("click", { bubbles: true }));
  assert.ok(!msg.classList.contains("sa-task-open"), "收起后类摘掉");
  assert.equal(uText.style.maxHeight, "176px", "限高恢复");
  assert.match(btn.textContent, /展开/, "文案还原「展开」");
});
