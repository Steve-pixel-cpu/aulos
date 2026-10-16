// tests/web/browser-visibility.test.js — 设置页「显示浏览器窗口」开关回显。
// 回归: 回显逻辑曾把 browser_headless !== false 当作「开启」, 语义完全颠倒——
// 文件里存 browserHeadless: true（隐身=关）时开关显示开、且点掉又弹回开。
// 正确语义: 开关「开」= 可见 = browser_headless === false。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

function bootWithSettings(payload) {
  const { window } = loadApp();
  window.__settingsPayload = payload;
  window.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes("/api/settings")
      ? window.__settingsPayload
      : String(url).includes("/api/sessions")
        ? { sessions: [] }          // loadSessions 期望 {sessions:[...]}
        : []),                      // 其余列表接口给数组
  });
  return window;
}

async function loadSettingsOn(window) {
  // loadSettings 定义于 app.js 的 IIFE 词法环境; 拼接 eval 后在全局可见
  await window.loadSettings();
  window.syncBrowserVisibilityControls();
  // 等 init() 的异步尾巴 (loadSessions 等对桩外 URL 的 fetch) 安静落地,
  // 避免 "activity after test ended" 噪音
  await new Promise(r => setTimeout(r, 30));
}

test("回显: browser_headless:true(隐身,默认) → 开关显示 关", async () => {
  const w = bootWithSettings({ browser_headless: true, browser_slow_mo: 300 });
  await loadSettingsOn(w);
  assert.equal(w.document.getElementById("set-browser-headed").checked, false);
});

test("回显: browser_headless:false(可见) → 开关显示 开", async () => {
  const w = bootWithSettings({ browser_headless: false, browser_slow_mo: 300 });
  await loadSettingsOn(w);
  assert.equal(w.document.getElementById("set-browser-headed").checked, true);
});
