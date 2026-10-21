// tests/web/user-fold.test.js — 主聊天用户输入过长自动折叠
//
// 契约:
//   1. addUserBubble 渲染的用户气泡, 文本超过阈值（行数>8 或 字符>300）
//      默认折叠: .sa-task-folded + .u-text 内联 maxHeight=176px +
//      .sa-task-fade 渐隐 + .sa-task-expand 胶囊;
//   2. 短输入不折叠（无类、无按钮、无内联限高）;
//   3. 点「展开」→ .sa-task-open + maxHeight 释放 + 文案变「收起」;
//      再点 → 还原;
//   4. 长文本 + 图片/文件附件共存: 折叠生效, 附件节点保留。
//
// 与 tests/web/sa-task-fold.test.js 的关系: 子代理任务气泡折叠是同一
// 套视觉语言（先例）; 本次把它提取为 applyTextFold 共用函数后接入
// addUserBubble, 主聊天所有渲染路径（本地发送/历史回放/排队插队）
// 自动生效。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

function setup() {
  const { window } = loadApp("window.__state = () => state; window.__addUserBubble = addUserBubble;");
  window.__state().sessionId = "s-user-fold";
  return window;
}

test("长输入: 默认折叠（类 + 限高 + 渐隐 + 胶囊）", () => {
  const w = setup();
  const longText = Array.from({ length: 12 }, (_, i) => "第" + i + "行").join("\n");
  const b = w.__addUserBubble(longText, [], null);
  const msg = b.closest(".msg");
  assert.ok(msg.classList.contains("sa-task-folded"), "长输入加折叠类");
  assert.equal(b.querySelector(".u-text").style.maxHeight, "176px", "限高 176px 内联生效");
  assert.ok(b.querySelector(".sa-task-fade"), "底部渐隐层存在");
  const btn = b.querySelector(".sa-task-expand");
  assert.ok(btn, "「展开」胶囊存在");
  assert.match(btn.textContent, /展开/);
});

test("超长无换行文本: 字符数超阈值同样折叠", () => {
  const w = setup();
  const blob = "x".repeat(400);   // 无换行, 400 字符 > 300
  const b = w.__addUserBubble(blob, [], null);
  assert.ok(b.closest(".msg").classList.contains("sa-task-folded"), ">300 字符折叠");
});

test("短输入: 不折叠", () => {
  const w = setup();
  const b = w.__addUserBubble("帮我看看这个函数", [], null);
  const msg = b.closest(".msg");
  assert.ok(!msg.classList.contains("sa-task-folded"), "短输入无折叠类");
  assert.equal(b.querySelector(".u-text").style.maxHeight, "", "无限高");
  assert.ok(!b.querySelector(".sa-task-expand"), "无展开按钮");
  assert.ok(!b.querySelector(".sa-task-fade"), "无渐隐层");
});

test("点「展开」释放限高, 文案变「收起」; 再点还原", () => {
  const w = setup();
  const longText = Array.from({ length: 12 }, (_, i) => "第" + i + "行").join("\n");
  const b = w.__addUserBubble(longText, [], null);
  const msg = b.closest(".msg");
  const btn = b.querySelector(".sa-task-expand");
  btn.click();
  assert.ok(msg.classList.contains("sa-task-open"), "展开态类挂上");
  assert.equal(b.querySelector(".u-text").style.maxHeight, "none", "限高释放");
  assert.match(btn.textContent, /收起/);
  btn.click();
  assert.ok(!msg.classList.contains("sa-task-open"), "收起后类摘掉");
  assert.equal(b.querySelector(".u-text").style.maxHeight, "176px", "限高恢复");
  assert.match(btn.textContent, /展开/);
});

test("长文本 + 附件共存: 折叠生效, 图片与文件 chip 保留", () => {
  const w = setup();
  const longText = Array.from({ length: 12 }, (_, i) => "第" + i + "行").join("\n");
  const atts = [
    { kind: "image", name: "a.png", media_type: "image/png", data: "iVBORw0KGgo=" },
    { kind: "file", name: "notes.txt" },
  ];
  const b = w.__addUserBubble(longText, atts, null);
  const msg = b.closest(".msg");
  assert.ok(msg.classList.contains("sa-task-folded"), "长文本仍折叠");
  assert.equal(b.querySelectorAll(".u-img").length, 1, "图片缩略图保留");
  assert.ok(b.querySelector(".file-chip"), "文件 chip 保留");
});
