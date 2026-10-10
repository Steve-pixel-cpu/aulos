// tests/web/app-core.test.js — app.js 纯渲染层: renderMd / decorateCode / genQid
// renderMd 是用户可见输出的最后一站, 回归价值最高。
// marked/katex 用受控桩: 只实现 parse/renderToString 契约, 断言占位符协议。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers");

function boot() {
  const { window } = loadApp();
  // 独立挂载点: 用例 DOM 全部塞这里, 不碰 app.js init() 的异步尾巴
  // (selectSession/startDraft 定时器) 还要读写的 #input/#messages 等节点
  const fx = window.document.createElement("div");
  fx.id = "test-fixture";
  window.document.body.appendChild(fx);
  window.__fx = fx;
  return window;
}

function fx_set(window, html) {
  window.__fx.innerHTML = html;
}

// ---- 降级路径 (无 marked) ----

test("renderMd 降级: 无 marked 时转义 + <p><br>", () => {
  const w = boot();
  delete w.marked; delete w.katex;
  const html = w.renderMd("a\n<b>&");
  assert.equal(html, "<p>a\n&lt;b&gt;&amp;</p>".replace("\n", "<br>"));
});

test("renderMd 降级: marked.parse 抛异常也安全落地", () => {
  const w = boot();
  w.marked = { parse: () => { throw new Error("boom"); } };
  assert.equal(w.renderMd("x<y"), "<p>x&lt;y</p>");
});

// ---- 正常路径: 占位符协议 (公式不遭 markdown 转义/代码段不遭公式解析) ----

function stubMarked(w, spy) {
  // 最小 marked: 把 \n 变 </p><p>, 其余原样——足够观察占位符流经的形态
  w.marked = { parse: (src) => {
    spy.src = src;
    return "<p>" + src.split("\n").join("</p><p>") + "</p>";
  }};
}

test("renderMd: 行内公式 $...$ 抽成占位符, marked 看不到 $, katex 还原", () => {
  const w = boot();
  const seen = {};
  stubMarked(w, seen);
  const rendered = [];
  w.katex = { renderToString: (tex, opt) => { rendered.push({ tex, display: opt.displayMode }); return `<katex>${tex}</katex>`; } };
  const html = w.renderMd("能量是 $E=mc^2$ 好东西");
  assert.ok(!seen.src.includes("E=mc^2"), "marked 不应看到公式原文");
  assert.ok(html.includes("<katex>E=mc^2</katex>"), html);
  assert.deepEqual(rendered[0], { tex: "E=mc^2", display: false });
});

test("renderMd: 块级公式 $$...$$ display=true", () => {
  const w = boot();
  stubMarked(w, {});
  const out = [];
  w.katex = { renderToString: (tex, o) => { out.push(o.displayMode); return "K"; } };
  w.renderMd("$$\n\\int_0^1 x dx\n$$");
  assert.deepEqual(out, [true]);
});

test("renderMd: 代码段里的 $ 不触发公式解析 (保护顺序: 先代码后公式)", () => {
  const w = boot();
  const seen = {};
  stubMarked(w, seen);
  let katexCalled = 0;
  w.katex = { renderToString: () => { katexCalled++; return "K"; } };
  const html = w.renderMd("看代码 `const x = $a + $b` 和\n```\n$$block$$\n```");
  assert.equal(katexCalled, 0, "代码内的 $ 不应被当公式");
  assert.ok(seen.src.includes("```"), "代码段原样进入 marked");
});

test("renderMd: katex 未加载时公式回退 $tex$ 原文", () => {
  const w = boot();
  stubMarked(w, {});
  delete w.katex;
  const html = w.renderMd("$a+b$");
  assert.ok(html.includes("$a+b$"), html);
});

test("renderMd: katex.renderToString 抛异常时回退原文 (throwOnError 桩不住的情况)", () => {
  const w = boot();
  stubMarked(w, {});
  w.katex = { renderToString: () => { throw new Error("katex boom"); } };
  const html = w.renderMd("$a+b$");
  assert.ok(html.includes("$a+b$"), html);
});

// ---- decorateCode: 代码块装饰 (语言徽标 + 复制按钮) ----

test("decorateCode: 加语言徽标与复制按钮, data-dec 防重复", () => {
  const w = boot();
  w.hljs = null;   // 不测高亮, 只测装饰
  const doc = w.document;
  fx_set(w, `<pre><code class="language-python">print(1)</code></pre>`);
  w.decorateCode(w.__fx);
  // pre 被包进 .code-wrap: 头部(语言徽标+复制钮) + pre 本体
  const wrap = doc.querySelector(".code-wrap");
  assert.ok(wrap, "包进 code-wrap");
  const head = wrap.querySelector(".code-head");
  assert.equal(head.querySelector(".code-lang").textContent, "python");
  assert.ok(head.querySelector("button.code-copy"), "有复制按钮");
  assert.ok(wrap.querySelector("pre code"), "代码本体还在");
  w.decorateCode(wrap);   // 二次调用: data-dec 幂等, 不再包一层
  assert.equal(doc.querySelectorAll(".code-wrap").length, 1);
  assert.equal(doc.querySelectorAll("button.code-copy").length, 1);
});

test("decorateCode: table 包 table-wrap (横向滚动)", () => {
  const w = boot();
  const doc = w.document;
  fx_set(w, `<table><tr><td>x</td></tr></table>`);
  w.decorateCode(w.__fx);   // decorateTables 由它一并驱动? 若是独立函数则直接调
  if (!doc.querySelector(".table-wrap")) {
    // decorateTables 是独立导出: 显式调用
    w.decorateTables(w.__fx);
  }
  assert.ok(doc.querySelector(".table-wrap table"), "表被包进 wrap");
  if (w.decorateTables) {
    w.decorateTables(w.__fx);   // 幂等
    assert.equal(doc.querySelectorAll(".table-wrap").length, 1);
  }
});

// ---- 小工具 ----

test("genQid: q- 前缀 + 基36时间戳, 全局唯一性抽样", () => {
  const w = boot();
  const a = w.genQid(), b = w.genQid();
  assert.match(a, /^q-[0-9a-z]+-[0-9a-z]+$/);
  assert.notEqual(a, b);
});
