/* zh 字典 — 与 en.js 的 key 集合必须完全一致（tests/web/i18n.test.js 看护）。
 * 经典脚本: 显式挂 window, 供 i18n.js 与测试读取。 */
"use strict";
window.I18N_STRINGS_ZH = {
  "settings.language.name": "语言",
  "settings.language.desc": "界面与 AI 回复使用的语言",
  "settings.language.invalid": "未知语言: {value}（可选: zh | en）",
};
