// tests/web/bg-video-bright.test.js — 动态壁纸的亮度滑块联动
//
// 背景(2026-11-01 现场): 亮度滑块的禁用逻辑只看静态壁纸(bgvPref&&!bgVer),
// 只上传视频壁纸时滑块被禁用——但视频层与静态层共用同一套 --bg-dim
// 遮罩变量, 任一壁纸存在滑块都应有意义。本文件钉住两个语义:
// 1) syncBgLayers 的滑块禁用条件必须包含视频壁纸存在的情况
// 2) syncVideoLayer 开/关时也要重算滑块禁用(两个同步函数共享该职责)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP = fs.readFileSync(path.join(__dirname, "..", "..", "static", "app.js"), "utf-8");

test("滑块禁用条件包含视频壁纸(只传视频时滑块可用)", () => {
  // 禁用逻辑抽为 syncBgBrightAvail, 条件必须含视频壁纸状态
  const m = APP.match(/function syncBgBrightAvail\(\) \{[\s\S]{0,400}?\n\}/);
  assert.ok(m, "syncBgBrightAvail 存在(共享禁用逻辑)");
  assert.match(m[0], /bgvPref\(\)/, "禁用条件必须含视频偏好");
  assert.match(m[0], /bgvVer/, "禁用条件必须含视频版本");
  // 两个同步函数都要调用它
  assert.match(APP.match(/function syncBgLayers\(\) \{[\s\S]{0,700}?\n\}/)[0], /syncBgBrightAvail\(/,
    "syncBgLayers 必须调用 syncBgBrightAvail");
  assert.match(APP.match(/function syncVideoLayer\(\) \{[\s\S]{0,1300}?\n\}/)[0], /syncBgBrightAvail\(/,
    "syncVideoLayer 必须调用 syncBgBrightAvail");
});

test("视频壁纸激活时必须同时点亮 data-bg(亮度体系依赖它)", () => {
  // --bg-dim/--bg-surf 只被 :root[data-bg="1"] 消费; 纯视频壁纸若不挂
  // data-bg, 亮度滑块拖动无任何效果(2026-11-01 用户实测回归)
  const m = APP.match(/function syncVideoLayer\(\) \{[\s\S]{0,1200}?\n\}/);
  assert.ok(m, "syncVideoLayer 存在");
  assert.match(m[0], /dataset\.bg = "1"/, "视频激活分支必须挂 data-bg 标记(点亮亮度/半透明化体系)");
  // 关闭分支必须摘掉(回退静态壁纸时由 syncBgLayers 重算)
  assert.match(m[0], /delete document\.documentElement\.dataset\.bg/, "视频关闭分支必须摘 data-bg");
  // CSS 侧: data-bgv 也要点亮 scrim(纯视频时遮罩在视频之上压暗)
  const CSS = fs.readFileSync(path.join(__dirname, "..", "..", "static", "app.css"), "utf-8");
  assert.match(CSS, /:root\[data-bgv="1"\] #bg-scrim/, "纯视频壁纸时 scrim 也必须显示(亮度遮罩作用于视频)");
});

test("syncVideoLayer 联动滑块可用性(上传/清除视频后立即生效)", () => {
  const m = APP.match(/function syncVideoLayer\(\) \{[\s\S]{0,1300}?\n\}/);
  assert.ok(m, "syncVideoLayer 存在");
  assert.match(m[0], /syncBgBrightAvail\(/, "syncVideoLayer 必须同步亮度滑块禁用状态");
});

test("loading 页云母模式让位: body 透明 + 标记与主界面同源", () => {
  // 主界面选「Fluent·系统云母」后, 启动页却是实色板(风格断裂)。
  // DWM backdrop 是窗口属性跨导航持久, loading 页只需 CSS 让位。
  const LH = fs.readFileSync(path.join(__dirname, "..", "..", "static", "loading.html"), "utf-8");
  assert.match(LH, /xc-style/, "loading 页必须读 xc-style 偏好(与主界面同源)");
  assert.match(LH, /data-mica/, "云母模式必须挂 data-mica 标记");
  // CSS: 云母时 body 透明让出 DWM 底(照主界面 :root[data-mica="1"] body 规则)
  assert.match(LH, /html\.fluent-mica\s+body\s*\{[^}]*background:\s*transparent/,
    "云母模式下 body 必须 transparent(否则实色板挡住云母)");
});
