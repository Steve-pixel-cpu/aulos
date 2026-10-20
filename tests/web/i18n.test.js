const test = require("node:test");
const assert = require("node:assert/strict");
const { makeDom, runScripts } = require("./helpers");

function loadI18n(extraHtml) {
  const window = makeDom(
    "<!DOCTYPE html><html><body>" +
    '<div id="b" data-i18n="settings.language.name">语言</div>' +
    '<input id="a" data-i18n-placeholder="settings.language.name" />' +
    (extraHtml || "") + "</body></html>");
  runScripts(window, "i18n/zh.js", "i18n/en.js", "i18n/i18n.js");
  return { window };
}

test("zh/en 字典 key 集合完全一致", () => {
  const { window } = loadI18n();
  assert.deepEqual(
    Object.keys(window.I18N_STRINGS_ZH).sort(),
    Object.keys(window.I18N_STRINGS_EN).sort());
});

test("默认 zh; setI18nLang('en') 后 t() 取英文字典", () => {
  const { window } = loadI18n();
  assert.equal(window.i18nLang(), "zh");
  assert.equal(window.t("settings.language.name"), "语言");
  window.setI18nLang("en");
  assert.equal(window.t("settings.language.name"), "Language");
});

test("en 缺 key 回退 zh 文案并 warn", () => {
  const { window } = loadI18n();
  window.setI18nLang("en");
  const warns = [];
  const orig = window.console.warn;   // i18n.js 调的是 window.console
  window.console.warn = (...a) => warns.push(a.join(" "));
  try {
    delete window.I18N_STRINGS_EN["settings.language.name"];
    assert.equal(window.t("settings.language.name"), "语言");
    assert.ok(warns.some(w => w.includes("missing key")));
  } finally {
    window.console.warn = orig;
    window.I18N_STRINGS_EN["settings.language.name"] = "Language";
  }
});

test("插值 {value} 被替换; 缺参数原样保留", () => {
  const { window } = loadI18n();
  assert.equal(
    window.t("settings.language.invalid", { value: "fr" }),
    "未知语言: fr（可选: zh | en）");
  assert.ok(window.t("settings.language.invalid", {})
    .includes("{value}"));
});

test("setI18nLang 非法值忽略, 保持当前语言", () => {
  const { window } = loadI18n();
  window.setI18nLang("en");
  assert.equal(window.setI18nLang(undefined), "en");
  assert.equal(window.setI18nLang("fr"), "en");
  assert.equal(window.i18nLang(), "en");
});

test("applyI18n 改写 data-i18n 与 data-i18n-placeholder", () => {
  const { window } = loadI18n();
  window.setI18nLang("en");
  window.applyI18n();
  assert.equal(window.document.getElementById("b").textContent, "Language");
  assert.equal(
    window.document.getElementById("a").getAttribute("placeholder"),
    "Language");
});
