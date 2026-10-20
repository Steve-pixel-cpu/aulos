/* i18n.js — 轻量字典运行时（零依赖, 经典脚本, IIFE 挂 window）。
 * 依赖: 先于本文件加载的 zh.js / en.js（字典挂 window）。
 * 语言来源: 后端 GET /api/settings 的 language 字段, 由 app.js 的
 * loadSettings() 调 setI18nLang() 注入（spec §5.3: 服务端持久化,
 * 不走 localStorage）。切换语言 = saveSettings + 整页 reload。
 * 规则: 默认/回退 zh; 缺 key 回退 zh 并 console.warn（spec §3）。
 * 注意: "use strict" 在 IIFE 内 —— helpers.js 拼接 eval 契约（见 zh.js 注释）。 */
(function () {
"use strict";
  const FALLBACK = "zh";
  let current = "zh";

  function dictOf(lang) {
    if (lang === "en") return window.I18N_STRINGS_EN || {};
    return window.I18N_STRINGS_ZH || {};
  }

  function i18nLang() { return current; }

  function setI18nLang(v) {
    // 非法/缺失值静默忽略（旧后端无 language 字段、fetch 失败等场景）
    if (v === "zh" || v === "en") current = v;
    return current;
  }

  function fmt(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(params, k)
        ? String(params[k]) : m);
  }

  function t(key, params) {
    const table = dictOf(current);
    if (Object.prototype.hasOwnProperty.call(table, key))
      return fmt(table[key], params);
    const zh = dictOf(FALLBACK);
    if (Object.prototype.hasOwnProperty.call(zh, key)) {
      console.warn("[i18n] missing key '" + key + "' in '" +
        current + "', fallback to zh");
      return fmt(zh[key], params);
    }
    console.warn("[i18n] missing key '" + key + "' in all dictionaries");
    return key;
  }

  function applyI18n(root) {
    const doc = root || document;
    doc.querySelectorAll("[data-i18n]").forEach(el => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    doc.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    doc.querySelectorAll("[data-i18n-title]").forEach(el => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
  }

  window.i18nLang = i18nLang;
  window.setI18nLang = setI18nLang;
  window.t = t;
  window.applyI18n = applyI18n;
})();
