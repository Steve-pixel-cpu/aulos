/* zh 字典 — 与 en.js 的 key 集合必须完全一致（tests/web/i18n.test.js 看护）。
 * 经典脚本: 显式挂 window, 供 i18n.js 与测试读取。
 * 注意: "use strict" 必须在 IIFE 内 —— tests/web/helpers.js 把全部
 * static 脚本拼成一段 eval, 文件级指令会让整段变严格模式, 破坏
 * app.js 顶层声明泄漏为全局的既有契约。 */
(function () {
"use strict";
window.I18N_STRINGS_ZH = {
  "settings.language.name": "语言",
  "settings.language.desc": "界面与 AI 回复使用的语言",
  "settings.language.invalid": "未知语言: {value}（可选: zh | en）",
};
})();
