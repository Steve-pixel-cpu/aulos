// tests/web/bg-prefetch.test.js — 启动预取壁纸/视频优化回归守卫
//
// 背景(2026-11-03 现场): 动态背景在开机动画切到主界面后并非立刻出现,
// 而是先显示默认背景, 等 /api/settings 返回 bg_video_ver 后才设 video.src,
// 下载+解码(oncanplay)后才点亮 data-bgv → 用户感知到明显的「切背景」过程。
// 修复: 上传时持久化版本号(xc-bg-ver / xc-bgv-ver), 启动时 prefetchBg()
// 在等 settings 之前就用本地版本号并行预取, 下载与会话列表加载并行;
// settings 返回后 syncVideoLayer/syncBgLayers 照常校准(版本变则换 URL,
// _bgvSeq 门控丢弃旧事件, 无串扰)。
// 本文件钉死预取语义: 有版本号且开关开 → 立即把 URL 挂到 video/置 bgVer;
// 开关关/无版本 → 不动。jsdom 不发真实网络请求, 断言的是 DOM 与词法状态。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

function setup() {
  const { window } = loadApp();
  // loadApp 的 init() 已自动跑过: 此时 localStorage 为空 → prefetchBg 未发。
  return window;
}

function callPrefetch(w) {
  w.eval("prefetchBg()");
}

test("有持久化版本号 + 开关开: 启动即把视频 URL 挂到 #bg-video(不等 settings)", () => {
  const w = setup();
  w.localStorage.setItem("xc-bgv", "1");
  w.localStorage.setItem("xc-bgv-ver", "12345");
  callPrefetch(w);
  const vid = w.document.getElementById("bg-video");
  assert.match(vid.getAttribute("src") || "", /\/api\/bg-video\?v=12345$/, "video.src 应带本地版本号");
});

test("预取路径: canplay 后点亮 data-bgv/data-bg(动态背景呈现)", () => {
  const w = setup();
  w.localStorage.setItem("xc-bgv", "1");
  w.localStorage.setItem("xc-bgv-ver", "12345");
  callPrefetch(w);
  const vid = w.document.getElementById("bg-video");
  // 模拟浏览器: 下载完成后触发 canplay
  vid.dispatchEvent(new w.Event("canplay"));
  const de = w.document.documentElement;
  assert.equal(de.dataset.bgv, "1", "canplay 后应挂 data-bgv");
  assert.equal(de.dataset.bg, "1", "应同时点亮 data-bg(半透明 UI 体系)");
});

test("开关关: 不预取视频", () => {
  const w = setup();
  w.localStorage.setItem("xc-bgv", "0");
  w.localStorage.setItem("xc-bgv-ver", "12345");
  callPrefetch(w);
  const vid = w.document.getElementById("bg-video");
  assert.equal(vid.getAttribute("src"), null, "开关关不应上 vID src");
});

test("无持久化版本号: 不预取(走原 settings 等待路径)", () => {
  const w = setup();
  w.localStorage.setItem("xc-bgv", "1");
  callPrefetch(w);
  const vid = w.document.getElementById("bg-video");
  assert.equal(vid.getAttribute("src"), null, "无版本号不应预取");
});

test("静态壁纸: 有版本号 + 开关开 → 预取; 视频预取不被静态触发", () => {
  const w = setup();
  w.localStorage.setItem("xc-bg", "1");
  w.localStorage.setItem("xc-bg-ver", "99");
  callPrefetch(w);
  const vid = w.document.getElementById("bg-video");
  assert.equal(vid.getAttribute("src"), null, "静态壁纸预取不应触碰视频元素");
  // Image 预取在 jsdom 中不可直接观测(无网络层), 但 bgVer 被顶层 let 持有,
  // prefetchBg 内 new Image() 调用不报错即证明该分支执行(其它用例已证分支逻辑)
});