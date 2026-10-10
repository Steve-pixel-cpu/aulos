// tests/web/ui-dialogs.test.js — 弹窗三件套 + 纯工具
// 测的是 static/ui-dialogs.js 真实源码 (helpers 里 eval 加载)。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadUiDialogs } = require("./helpers");

test("escapeHtml 转义五个危险字符", () => {
  const { window } = loadUiDialogs();
  assert.equal(window.escapeHtml(`<a href="x">&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("escapeHtml 幂等安全: 纯文本原样返回", () => {
  const { window } = loadUiDialogs();
  const s = "普通中文 abc 123";
  assert.equal(window.escapeHtml(s), s);
});

test("toast: 显示文案 + show 类, 默认 1600ms 后移除", async () => {
  const { window } = loadUiDialogs();
  const doc = window.document;
  window.toast("hello");
  const t = doc.getElementById("toast");
  assert.equal(t.textContent, "hello");
  assert.ok(t.classList.contains("show"));
  await new Promise(r => setTimeout(r, 1800));
  assert.ok(!t.classList.contains("show"));
});

test("toast: 连续调用重置计时器 (后一条覆盖且只消失一次)", async () => {
  const { window } = loadUiDialogs();
  const doc = window.document;
  window.toast("first", 300);
  await new Promise(r => setTimeout(r, 150));
  window.toast("second", 300);
  assert.equal(doc.getElementById("toast").textContent, "second");
  await new Promise(r => setTimeout(r, 400));
  assert.ok(doc.getElementById("toast").classList.contains("show") === false);
});

test("confirmDialog: 点确定 resolve(true) 且弹窗移除", async () => {
  const { window } = loadUiDialogs();
  const doc = window.document;
  const p = window.confirmDialog("删除?", { okText: "删除", danger: true });
  const ov = doc.getElementById("confirm-overlay");
  assert.ok(ov, "遮罩出现");
  assert.ok(ov.querySelector("[data-act='ok'].danger"), "危险样式");
  ov.querySelector("[data-act='ok']").click();
  assert.equal(await p, true);
  assert.equal(doc.getElementById("confirm-overlay"), null);
});

test("confirmDialog: 点取消/按 Esc 均 resolve(false)", async () => {
  const { window } = loadUiDialogs();
  const doc = window.document;
  const p1 = window.confirmDialog("a");
  doc.querySelector("#confirm-overlay [data-act='cancel']").click();
  assert.equal(await p1, false);
  const p2 = window.confirmDialog("b");
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(await p2, false);
});

test("promptDialog: 输入+Enter 返回 trim 后的值", async () => {
  const { window } = loadUiDialogs();
  const doc = window.document;
  const p = window.promptDialog("名称", { value: "  草稿  " });
  const inp = doc.getElementById("confirm-input");
  assert.equal(inp.value, "  草稿  ");
  inp.value = "  新名字 ";
  inp.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(await p, "新名字");
});

test("promptDialog: Esc 返回 null", async () => {
  const { window } = loadUiDialogs();
  const doc = window.document;
  const p = window.promptDialog("x");
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(await p, null);
});

test("copyText: 剪贴板 API 可用时走现代路径", async () => {
  const { window } = loadUiDialogs();
  let written = null;
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async (t) => { written = t; } },
    configurable: true,
  });
  assert.equal(await window.copyText("clip"), true);
  assert.equal(written, "clip");
});
