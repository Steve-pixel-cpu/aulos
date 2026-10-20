// tests/web/i18n-mode-dropdown.test.js — 顶栏权限/思考下拉的语言时序回归。
// 终审 Important#1: MODE_ITEMS/BASE_MODE_LABELS/THINK_ITEMS 曾在脚本加载期固化 zh,
// en 用户顶栏常驻中文。契约: en 注入后触发按钮 label 必须是英文。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");

function boot() {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  window.matchMedia = window.matchMedia || (() => ({
    matches: false, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {} }));
  window.ResizeObserver = window.ResizeObserver || class {
    observe() {} unobserve() {} disconnect() {} };
  window.fetch = async () => { throw new TypeError("no backend"); };
  const FILES = ["i18n/zh.js", "i18n/en.js", "i18n/i18n.js", "ui-dialogs.js",
    "notify.js", "app.js", "settings-extras.js", "desktop.js", "bubbles.js",
    "msg-extras.js", "ws-handlers.js", "sidebar.js", "settings-page.js"];
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src);
  return window;
}

test("en 注入后顶栏权限/思考下拉 label 为英文", () => {
  const w = boot();
  // 模拟 loadSettings 完成后的语言态
  w.setI18nLang("en");
  // modeLabel 是顶栏触发按钮的文案来源(闭包内)——经 modeDd.setValue 触发 syncLabel。
  // app.js 未暴露 modeDd; 通过全局函数 modeLabel 直接验证(它在词法环境, eval 后可见)
  assert.equal(typeof w.modeLabel, "function");
  assert.equal(w.modeLabel("prompt", false), "Ask every time");
  assert.equal(w.modeLabel("workspace-write", true), "Plan · Auto-edit");
  // think 下拉: THINK_ITEMS 若已工厂化, 经 window.__thinkDd? 未暴露则查值函数
  if (typeof w.thinkLabel === "function") {
    assert.equal(w.thinkLabel("low"), "Low");
  }
});
