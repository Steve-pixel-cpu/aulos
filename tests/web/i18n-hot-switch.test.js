// tests/web/i18n-hot-switch.test.js — 语言热切换回归: 切语言不得整页 reload
// (reload 会断开 WebSocket → 后端 request_stop → 运行中轮次被掐断/排队清空)。
// 契约:
//   1. applyLanguageHot("en") 后 t() 即刻输出英文, <html lang>/data-lang 同步
//   2. localStorage["xc-lang"] 镜像已写(卫星页/首帧脚本的读取源)
//   3. 侧栏分组标签等"固化快照"在热切换后输出英文(工厂化/后期绑定)
//   4. 语言下拉 onChange 全程不触碰 location.reload
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

test("applyLanguageHot 热切换: t()/lang 镜像/固化标签全部跟随, 不触发 reload", () => {
  const { window: w } = loadApp();
  const de = w.document.documentElement;
  assert.equal(typeof w.applyLanguageHot, "function", "applyLanguageHot 未暴露");

  // spy location.reload —— jsdom 导航桩: 直接替换并计数
  let reloadCalls = 0;
  w.location.reload = () => { reloadCalls++; };

  // 模拟 loadSettings 完成后的 zh 态, 再热切 en
  w.setI18nLang("zh");
  assert.equal(w.t("sidebar.006"), "今天");
  w.applyLanguageHot("en");

  assert.equal(w.i18nLang(), "en");
  assert.equal(w.t("sidebar.006"), "Today");
  assert.equal(w.t("ws_handlers.002"), "Terminal");
  assert.equal(w.t("sidebar.010"), "Untitled task");
  // 固化点工厂化: BUCKET_LABELS/UNTITLED_TITLE 已是工厂, 热切换后现取即英文;
  // (侧栏 DOM 级断言见 archive-view.test.js —— 拼接 eval 的顶层 state
  //  不暴露到 window, 本文件不再旁路灌数据)
  assert.equal(de.getAttribute("lang"), "en");
  assert.equal(de.dataset.lang, "en");
  assert.equal(w.localStorage.getItem("xc-lang"), "en");
  assert.equal(reloadCalls, 0, "热切换不得 location.reload");
});

test("语言下拉 onChange: saveSettings 成功后热切换, 全程不 reload", async () => {
  const { window: w } = loadApp();
  const de = w.document.documentElement;
  let reloadCalls = 0;
  w.location.reload = () => { reloadCalls++; };
  // saveSettings → fetch POST; 桩返回成功响应(app.js 走 2xx 分支)。
  // init() 里 loadSessions 也会 fetch: 空列表让启动链完整走完
  w.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ language: "en" }),
  });
  w.fetch = (u) => String(u).includes("/api/sessions")
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ sessions: [] }) })
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ language: "en" }) });
  // 走真实用户路径: 点击下拉触发按钮 → 点击 "English" 菜单项 → choose() → onChange
  assert.ok(w.__langDd, "window.__langDd 未暴露");
  // 触发按钮: #sel-lang (settings-page.js 用 $("sel-lang") 构造)
  const trigger = w.document.getElementById("sel-lang");
  assert.ok(trigger, "#sel-lang 不存在");
  trigger.dispatchEvent(new w.Event("click", { bubbles: true }));
  // 菜单项: .dd-pop .dd-opt, 文案 "English"
  const opts = [...w.document.querySelectorAll(".dd-pop .dd-opt")];
  const en = opts.find(o => o.textContent === "English");
  assert.ok(en, "English 菜单项未渲染");
  en.dispatchEvent(new w.Event("click", { bubbles: true }));
  // onChange 是 async: 让微队列 + fetch 跑完
  await new Promise(r => setTimeout(r, 10));
  // 应用语言态: onChange 内部应完成热切换 —— t()/lang 必须已是英文
  assert.equal(w.i18nLang(), "en", "onChange 后语言态应已热切换");
  assert.equal(de && w.document.documentElement.dataset.lang, "en", "html data-lang 应同步");
  assert.equal(reloadCalls, 0, "语言切换路径不得 location.reload");
});
