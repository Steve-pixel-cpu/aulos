// tests/web/model-switch-mode-echo.test.js — 切模型不得把权限下拉刷回全局默认
//
// 2026-10-21 事故: 草稿态切模型走 saveSettings(REST 全局设置), 成功回包后
// 无条件 modeDd.setValue(全局默认) → 草稿预选的权限档显示被刷成「每次询问」;
// 会话运行中任何触发 loadSettings 的操作(供应商保存等)同理把会话级权限
// 显示刷成全局默认。后端权限档位实际未被重置——纯前端回显串值, 但用户
// 照显示再点一次就变成真的。契约:
//   1. 草稿态回显: 预选(draftMode/draftPlan)优先, 无预选才显示全局默认;
//   2. 会话运行态: loadSettings 不碰模式下拉(显示归 selectSession/onModeChanged)。
// 全部真实源码在 jsdom 里跑, fetch 即时桩(与 send-current-race 同 boot 思路)。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDom } = require("./helpers");

const STATIC = path.join(__dirname, "..", "..", "static");
const FILES = ["i18n/zh.js", "i18n/en.js", "i18n/i18n.js", "ui-dialogs.js", "notify.js", "app.js", "settings-extras.js",
  "desktop.js", "bubbles.js", "msg-extras.js", "ws-handlers.js",
  "sidebar.js", "settings-page.js"];   // = index.html 完整 defer 序

const ok = json => ({ ok: true, json: async () => json });

// 全局默认设置: 权限 prompt(每次询问) —— 与事故现场一致
function settingsPayload(over) {
  return Object.assign({
    permission_mode: "prompt", permission_plan: false,
    thinking_level: "medium", provider_id: "p1", model_id: "m1",
    max_iterations: 30, max_concurrent_turns: 2,
    browser_headless: true, browser_slow_mo: null,
    language: "zh", configured: true,
  }, over);
}

function boot() {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "");
  const window = makeDom(html);
  // 可变全局设置态: POST /api/settings 按 patch 语义合并并回显(与真实后端一致)
  const settings = settingsPayload();
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u === "/api/settings") {
      if ((opts || {}).method === "POST") {
        const patch = JSON.parse(opts.body);
        for (const k of Object.keys(patch)) if (k in settings) settings[k] = patch[k];
        return ok(settings);
      }
      return ok(settings);
    }
    if (u === "/api/providers") return ok({
      providers: [{ id: "p1", name: "P1", enabled: true,
        models: [{ id: "m1", name: "M1" }, { id: "m2", name: "M2" }] }],
      active: { provider: "p1", model: "m1" },
    });
    if (u === "/api/sessions") return ok({ sessions: [] });
    if (u.startsWith("/api/skills")) return ok({ skills: [] });
    return ok({});   // utility/worker-provider 等旁路请求
  };
  const src = FILES.map(f => fs.readFileSync(path.join(STATIC, f), "utf-8")).join("\n;\n");
  window.eval(src + "\n;\nwindow.__api = { get state() { return state; }, runOf, startDraft, loadSettings, saveSettings, modeDd, modelDd };");
  return window;
}

const tick = () => new Promise(r => setTimeout(r, 0));

// boot 后 init() IIFE 异步自启(loadSettings→loadSessions→selectSession/
// startDraft): 每条用例开头先等它落定, 避免测试结束后仍有在途异步活动
async function bootSettled() {
  const w = boot();
  await tick(); await tick();
  return w;
}

test("草稿态切模型: 权限下拉保持草稿预选, 不刷回全局默认", async () => {
  const w = await bootSettled();
  const api = w.__api;
  api.startDraft();                       // 草稿态: 显示全局默认 prompt|0
  // 用户把草稿权限预选为 workspace-write(经 onChange 的落点等价)
  api.state.draftMode = "workspace-write";
  api.state.draftPlan = false;
  api.modeDd.setValue("workspace-write|0");
  assert.equal(api.modeDd.getValue(), "workspace-write|0");

  // 切模型(草稿态无 run → 走 saveSettings 全局设置路径), 服务端回包
  // 里全局权限默认仍是 prompt——显示不得被它刷掉
  await api.saveSettings({ provider_id: "p1", model_id: "m2" });
  assert.equal(api.modeDd.getValue(), "workspace-write|0",
    "切模型后权限显示仍是草稿预选档");
  // 模型下拉照旧跟随新全局 active(该路径行为不变)
  assert.equal(api.modelDd.getValue(), "p1|m2");
});

test("草稿态无预选时切模型: 权限下拉显示全局默认(行为不变)", async () => {
  const w = await bootSettled();
  const api = w.__api;
  api.startDraft();
  assert.equal(api.modeDd.getValue(), "prompt|0");

  await api.saveSettings({ provider_id: "p1", model_id: "m2" });
  assert.equal(api.modeDd.getValue(), "prompt|0",
    "无预选 → 回显全局默认, 与旧行为一致");
});

// ---- 契约 2: 会话运行态, loadSettings 不得覆盖会话级权限显示 ----

test("会话运行中触发 loadSettings: 权限显示保持会话值", async () => {
  const w = await bootSettled();
  const api = w.__api;
  // 会话 s1 已把权限切到 danger-full-access(运行态与列表缓存一致)
  api.state.sessions.push({
    id: "s1", title: "会话", permission_mode: "danger-full-access",
    plan_active: false, thinking_level: "high",
    model_provider: "p1", model_id: "m1",
    workdir: null, archived: false, pinned: false,
  });
  api.state.draft = false;
  api.state.sessionId = "s1";
  api.runOf("s1").permissionMode = "danger-full-access|0";
  api.modeDd.setValue("danger-full-access|0");

  // 任何触发 loadSettings 的操作(供应商保存/改名兜底等): 全局默认仍是
  // prompt, 但会话级显示不能被它覆盖
  await api.loadSettings();
  assert.equal(api.modeDd.getValue(), "danger-full-access|0",
    "loadSettings 后会话权限显示不变");
});

test("初始化(无会话)时 loadSettings: 权限下拉回显全局默认(行为不变)", async () => {
  const w = await bootSettled();
  const api = w.__api;
  await api.loadSettings();
  assert.equal(api.modeDd.getValue(), "prompt|0",
    "启动加载: 无会话无预选 → 全局默认");
  assert.equal(api.state.globalDefaults.permissionMode, "prompt",
    "全局默认快照仍被无条件更新");
});
