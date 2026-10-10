// tests/web/helpers.js — 前端测试基建: jsdom + 真实源码 + 真实页面骨架
//
// 设计原则 (沿用项目既有哲学): 测的必须是真实产物——
//   1. JS 源码: 读 static/*.js 原文在 jsdom 里 eval (经典脚本语义,
//      与浏览器 defer 加载一致, 全局作用域共享)
//   2. DOM 骨架: 直接解析 static/index.html, 不手搓 —— 手搓骨架
//      追不上 7000 行脚本引用的节点 (两次"挤牙膏"教训)。
//      index.html 里的 music/pet 面板等不影响纯函数测试。
//
// 用法:
//   const { loadApp } = require("./helpers");
//   const { window } = loadApp();        // index.html 骨架 + ui-dialogs + app.js
//   const { loadUiDialogs } = ...        // 仅 ui-dialogs (轻, 无页面骨架)

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const STATIC = path.join(__dirname, "..", "..", "static");

// 页面骨架: 真实 index.html, 剔除 <script> (源码由我们按序 eval, 不让
// jsdom 的 runScripts 执行, 那样拿不到全局符号) 与样式表外链
function pageHtml() {
  return fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
}

function makeDom(html) {
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:8000/?desktop=1",   // 入口守卫: 桌面态才初始化
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  // jsdom 缺的浏览器 API, 最小桩 (集中此处, 不要散落到测试)
  window.matchMedia = window.matchMedia || (q => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }));
  window.scrollTo = window.scrollTo || (() => {});
  window.ResizeObserver = window.ResizeObserver || class {
    observe() {} unobserve() {} disconnect() {}
  };
  window.__consoleWarns = [];
  window.console.warn = (...a) => { window.__consoleWarns.push(a.join(" ")); };
  // 网络桩: init() 启动时 loadSettings/loadSessions 会 fetch, 无后端时
  // 让它们安静失败 (代码自带 catch, 只需 fetch 存在)
  window.fetch = window.fetch || (async () => {
    throw new TypeError("fetch stub: no backend in tests");
  });
  return window;
}

function runScript(window, file) {
  const src = fs.readFileSync(path.join(STATIC, file), "utf-8");
  window.eval(src);
}

// 按序拼接后一次 eval —— 浏览器里同页多个 <script> 共享「全局词法环境」,
// A 文件的顶层 const 对 B 文件可见; jsdom 的 window.eval 每次调用是
// 独立环境, const 不跨调用。拼接是唯一能还原浏览器语义的加载方式。
function runScripts(window, ...files) {
  const src = files
    .map(f => fs.readFileSync(path.join(STATIC, f), "utf-8"))
    .join("\n;\n");                     // 分号防 ASI 合并
  window.eval(src);
}

// 轻量: 仅 ui-dialogs (需 $, 页面只需 toast)
function loadUiDialogs() {
  const window = makeDom(`<div id="toast"></div>`);
  window.$ = id => window.document.getElementById(id);
  runScript(window, "ui-dialogs.js");
  return { window };
}

// 全量: 真实 index.html 骨架 + ui-dialogs + notify + app (拼接 eval, 共享词法环境)
// 桌面态: URL 已带 ?desktop=1; music.js/pet.js 按需在测试里自行 runScripts
function loadApp() {
  const window = makeDom(pageHtml());
  runScripts(window, "ui-dialogs.js", "notify.js", "app.js",
           "settings-extras.js", "desktop.js", "bubbles.js",
           "msg-extras.js", "ws-handlers.js", "sidebar.js",
           "settings-page.js");   // = index.html 完整 defer 序
  return { window };
}

module.exports = { loadApp, loadUiDialogs, runScript, runScripts, makeDom };
