#!/usr/bin/env node
/* i18n 字典去重规整（第 2 期 throwaway）。
 * 背景: merge 脚本对同一批 .i18n.json 重复追加, 字典里出现重复 key 块;
 * 此前内联正则又被 shell 转义坑(value 含 \" 的行漏匹配 → 丢 30 key)。
 * 这里用 JSON.parse 语义解析, 不依赖正则吃转义。 */
"use strict";
const fs = require("fs");

const RE_LINE = /^\s*"([a-z_.0-9]+)":\s*(.*?),?\s*$/;

function parseValue(raw) {
  // raw 是 JS 字面量（双引号串或单引号串）— 借 eval 得到真实字符串
  return eval(raw);
}

function rewrite(f, varName) {
  const lines = fs.readFileSync(f, "utf-8").split("\n");
  const uniq = new Map();          // key -> { raw, order }
  let inBody = false;
  const outHead = [];
  for (const line of lines) {
    if (!inBody) {
      outHead.push(line);
      if (/window\.\w+ = \{/.test(line)) { inBody = true; outHead.pop(); }
      continue;
    }
    if (/^\};/.test(line)) break;
    const m = line.match(RE_LINE);
    if (!m) continue;              // 空行等
    // 保留最后一次出现的 raw 值（重复块 = 后写覆盖）
    uniq.set(m[1], m[2].replace(/,\s*$/, ""));
  }
  const body = [...uniq.entries()]
    .map(([k, raw]) => `  "${k}": ${raw},`).join("\n");
  const head = outHead.join("\n").replace(/\n$/, "");
  const out = head + `\nwindow.${varName} = {\n${body}\n};\n})();\n`;
  fs.writeFileSync(f, out);
  return uniq.size;
}

const zh = rewrite("static/i18n/zh.js", "I18N_STRINGS_ZH");
const en = rewrite("static/i18n/en.js", "I18N_STRINGS_EN");
console.log(`zh 唯一 key: ${zh}, en 唯一 key: ${en}`);

// 校验: 双侧解析成功 + key 集合一致
const zsrc = fs.readFileSync("static/i18n/zh.js", "utf-8");
const esrc = fs.readFileSync("static/i18n/en.js", "utf-8");
const zobj = eval("(" + zsrc.match(/window\.I18N_STRINGS_ZH = \{[\s\S]*\};\n\}\)\(\);/)[0].replace("window.I18N_STRINGS_ZH = ", "").replace(/;\n\}\)\(\);/, "") + ")");
const eobj = eval("(" + esrc.match(/window\.I18N_STRINGS_EN = \{[\s\S]*\};\n\}\)\(\);/)[0].replace("window.I18N_STRINGS_EN = ", "").replace(/;\n\}\)\(\);/, "") + ")");
const zk = Object.keys(zobj), ek = Object.keys(eobj);
console.log("解析成功: zh", zk.length, "en", ek.length);
const onlyZh = zk.filter(k => !(k in eobj));
const onlyEn = ek.filter(k => !(k in zobj));
console.log("仅 zh:", onlyZh.length, onlyZh.slice(0, 5));
console.log("仅 en:", onlyEn.length, onlyEn.slice(0, 5));
if (!onlyZh.length && !onlyEn.length) console.log("KEY 集合一致 ✓");
