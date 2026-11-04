// tests/web/loading-mica.test.js — 开机动画页云母模式透明回归守卫
//
// 背景(2026-11-03 现场): 外观设「云母效果」后冷启动, 开机动画窗口完全透明。
// 根因链: ①loading 页预置脚本仅凭 localStorage(xc-style==="fluent-mica")
// 就无条件挂 html.fluent-mica → CSS 把 body 背景置 transparent; ②而 DWM 云母
// backdrop 全仓唯一开启点是主界面的 set_mica 确认制(syncMica), 冷启动 loading
// 阶段窗口下无垫底; ③Tauri 壳 Windows 主窗恒透明 + WebView2 底 alpha=0 →
// 三层全透明直接透视桌面。
// 本文件把它钉死: 与主界面 syncMica 相同语义的「确认制」——loading 页自己
// 向壳 invoke set_mica, 确认成功才挂让位类; 失败/无壳一律实底。
//
// 注意: 预置脚本(loading.html <head> 内联 IIFE)在测试里是真实源码逐字执行,
// 不是模拟实现; CSS 断言的是同一份真实样式文本。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "..", "static", "loading.html"), "utf-8");

// 预置脚本: loading.html 第一个 <script>...</script>, 逐字截取进 jsdom
const HEAD_SCRIPT = (() => {
  const open = HTML.indexOf("<script>");
  const close = HTML.indexOf("</script>", open);
  return HTML.slice(open + "<script>".length, close);
})();
assert.ok(HEAD_SCRIPT.includes("fluent-mica"), "预置脚本应含云母处理(脚本结构变化需同步本文件)");

// 样式块: loading.html 内 <style>...</style> 原文
const CSS_RULE = (() => {
  const start = HTML.indexOf("<style>");
  const end = HTML.indexOf("</style>", start);
  return HTML.slice(start + "<style>".length, end);
})();

function makeDom() {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://tauri.localhost/loading.html?boot=full",   // 壳内资产页同源语义
    runScripts: "outside-only",
  });
  const window = dom.window;
  window.matchMedia = window.matchMedia || (q => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  }));
  window.__TAURI_INTERNALS__ = undefined;   // 无壳默认(浏览器/老系统)
  return dom;
}

// 执行 pre-script: 返回其暴露的确认 Promise(脚本内 window.__micaConfirmed)
function runHeadScript(dom) {
  dom.window.eval(HEAD_SCRIPT);
  return dom.window.__micaConfirmed || Promise.resolve();
}

test("无云母偏好: 页面保持实底, 不透(默认路径)", () => {
  const dom = makeDom();
  runHeadScript(dom);
  const de = dom.window.document.documentElement;
  assert.ok(!de.classList.contains("fluent-mica"), "不得挂云母让位类");
  assert.ok(!de.classList.contains("data-mica"), "不得挂 data-mica");
  assert.match(CSS_RULE, /background:\s*#f7f6f3/, "浅色实底规则存在");
});

test("持云母偏好但无壳: 不得透明(本 bug 主断言)", async () => {
  const dom = makeDom();
  dom.window.localStorage.setItem("xc-style", "fluent-mica");
  await runHeadScript(dom);
  const de = dom.window.document.documentElement;
  assert.ok(!de.classList.contains("fluent-mica"), "确认失败不得挂类");
  assert.ok(!de.classList.contains("data-mica"), "确认失败不得挂 data-mica");
});

test("持云母偏好且壳确认成功: 才挂让位类(云母路径回归)", async () => {
  const dom = makeDom();
  dom.window.localStorage.setItem("xc-style", "fluent-mica");
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, payload) => {
      if (cmd === "set_mica") return true;
      throw new Error("unexpected cmd " + cmd);
    },
  };
  await runHeadScript(dom);
  const de = dom.window.document.documentElement;
  assert.ok(de.classList.contains("fluent-mica"), "确认成功应挂 fluent-mica");
  assert.ok(de.classList.contains("data-mica"), "确认成功应挂 data-mica");
});

test("壳确认失败(非 Win11 22H2): 不得透明", async () => {
  const dom = makeDom();
  dom.window.localStorage.setItem("xc-style", "fluent-mica");
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async () => false,
  };
  await runHeadScript(dom);
  const de = dom.window.document.documentElement;
  assert.ok(!de.classList.contains("fluent-mica"), "确认失败不得挂类");
});

test("让位规则存在: html.fluent-mica body → transparent(确认制生效后的唯一透明点)", () => {
  const m = /html\.fluent-mica body\s*\{([^}]*)\}/.exec(CSS_RULE);
  assert.ok(m, "html.fluent-mica body 规则存在");
});

/* ---------- 开机页自绘标题栏与主界面(app.css)同款语义回归守卫 ---------- */

// 提取选择器规则体(与 css-guard.test.js 同法; 行首锚避免误命中
// "html.custom-anim body #titlebar" 等含子串的选择器, 匹配多行规则)
function ruleBody(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:^|\\n)\\s*" + esc + "\\s*\\{");
  const m = re.exec(CSS_RULE);
  assert.ok(m, `规则必须存在: ${sel}`);
  const close = CSS_RULE.indexOf("}", m.index + m[0].length);
  return CSS_RULE.slice(m.index + m[0].length, close);
}

test("标题栏实底背景: 与主界面 --bg-side/--border 同值(浅/深)", () => {
  // 默认深色实底 = --bg-side 深 / --border 深
  assert.match(ruleBody("#titlebar"), /background:\s*#151519/, "深色默认实底");
  assert.match(ruleBody("#titlebar"), /border-bottom:\s*1px solid #2b2b31/, "深色默认分隔线");
  // 浅色覆盖 = --bg-side 浅 / --border 浅
  assert.match(ruleBody("html:not(.dark) #titlebar"), /background:\s*#f5f6f8/, "浅色实底");
  assert.match(ruleBody("html:not(.dark) #titlebar"), /border-bottom-color:\s*#e8e8ec/, "浅色分隔线");
});

test("标题栏文字/悬停/关闭色: 与主界面令牌同值", () => {
  assert.match(ruleBody(".tb-name"), /color:\s*#5f6068/, ".tb-name 浅色 = --text-2");
  assert.match(ruleBody("html.dark .tb-name"), /color:\s*#a0a1ab/, ".tb-name 深色 = --text-2");
  assert.match(ruleBody(".tb-btn"), /color:\s*#5f6068/, ".tb-btn 浅色 = --text-2");
  assert.match(ruleBody(".tb-btn:hover"), /background:\s*#efeff2/, "hover 浅 = --hover");
  assert.match(ruleBody("html.dark .tb-btn:hover"), /background:\s*#24242a/, "hover 深 = --hover");
  assert.match(ruleBody(".tb-btn.tb-close:hover"), /background:\s*#cf3a2c/, "close hover 浅 = --err");
  assert.match(ruleBody("html.dark .tb-btn.tb-close:hover"), /background:\s*#f87171/, "close hover 深 = --err");
});

test("云母模式: 标题栏坐裸云母(与主界面 :root[data-mica] 同款)", () => {
  const m = /html\.fluent-mica body #titlebar\s*\{([^}]*)\}/.exec(CSS_RULE);
  assert.ok(m, "云母覆盖规则存在");
  assert.match(m[1], /background:\s*transparent/, "坐裸云母: 背景透明(DWM 采样垫底)");
  assert.match(m[1], /backdrop-filter:\s*none/, "云母下撤掉模糊(与主界面同)");
});