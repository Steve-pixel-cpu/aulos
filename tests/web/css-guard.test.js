// tests/web/css-guard.test.js — 面板关键样式的存在性守卫
//
// 背景(2026-10-21 现场): 8cba453 重构 app.css 时误删 sa-panel 样式块
// (含 #sa-body 的 flex:1/overflow-y:auto/min-height:0 滚动三件套),
// 子代理面板滚动条消失; bcc8ed4 手工恢复, 但"再删一次"没有任何
// 测试会红。本文件用结构性断言把关键规则钉住: CSS 块可移动、可
// 改写, 但语义(滚动容器/网格布局/mica 透明)不可静默丢失。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs.readFileSync(path.join(__dirname, "..", "..", "static", "app.css"), "utf-8");

function rule(sel) {
  // 锚定"选择器紧跟{"的声明位置, 跳过注释/正文中对选择器的提及
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{");
  const m = re.exec(CSS);
  assert.ok(m, `选择器必须存在: ${sel}`);
  const close = CSS.indexOf("}", m.index);
  return CSS.slice(m.index + m[0].length, close);
}

test("sa-body 是唯一的面板滚动容器(8cba453 误删回归守卫)", () => {
  const body = rule("#sa-body");
  assert.match(body, /flex:\s*1/, "flex:1 占满面板剩余高度");
  assert.match(body, /overflow-y:\s*auto/, "overflow-y:auto 溢出即滚");
  assert.match(body, /min-height:\s*0/, "min-height:0 允许 flex 子项收缩");
});

test("sa-panel 参与 #pane 网格并排(与计划面板同构)", () => {
  const p = rule("#pane.sa-open > #sa-panel");
  assert.match(p, /grid-column:\s*2/, "第 2 列");
  assert.match(p, /grid-row:\s*1\s*\/\s*-1/, "跨全部行");
  assert.match(p, /flex-direction:\s*column/, "纵向 flex 容器");
});

test("mica 模式: sa-panel 与 plan-panel 同坐裸云母(不透明底遮死右栏)", () => {
  assert.match(rule(':root[data-mica="1"] #pane.plan-open > #plan-panel'), /transparent/);
  assert.match(rule(':root[data-mica="1"] #pane.sa-open > #sa-panel'), /transparent/);
});
