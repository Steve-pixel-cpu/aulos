#!/usr/bin/env node
/* i18n_apply_b2.js — zh→en 批量替换 en.js 中 ws_handlers.* 的 value。
 * 用法: node tools/i18n_apply_b2.js
 * 只改 static/i18n/en.js 中命中 key 的行；不动 zh.js 与其他前缀。 */
"use strict";
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "static", "i18n", "en.js");

// key → 英文译文（完整覆盖 ws_handlers.001–117）
const T = {
  "ws_handlers.001": "Expired · will re-plan once the conversation resumes",
  "ws_handlers.002": "Terminal",
  "ws_handlers.003": "Terminal",
  "ws_handlers.004": "Read file",
  "ws_handlers.005": "Write file",
  "ws_handlers.006": "Implementation plan",
  "ws_handlers.007": "Task list",
  "ws_handlers.008": "Search content",
  "ws_handlers.009": "Find files",
  "ws_handlers.010": "Subagent",
  "ws_handlers.011": "Subagent status",
  "ws_handlers.012": "Waiting for subagents",
  "ws_handlers.013": "Harvesting subagents",
  "ws_handlers.014": "Subagent list",
  "ws_handlers.015": "under 1 second",
  "ws_handlers.016": " s",
  "ws_handlers.017": "{p0}m {p1}s",
  "ws_handlers.018": "{p0}m",
  "ws_handlers.019": "<span class=\"shine\">Thinking\u2026</span>",
  "ws_handlers.020": " (incl. rate-limit retry ",
  "ws_handlers.021": ")",
  "ws_handlers.022": "<span>Thinking \u00b7 lasted ",
  "ws_handlers.023": "<span class=\"shine\">Thinking\u2026</span>",
  "ws_handlers.024": "Running\u2026",
  "ws_handlers.025": "Running ",
  "ws_handlers.026": "<span class=\"tg-caret\">\u25be</span><span class=\"tg-title\">Tool call</span>",
  "ws_handlers.027": " items (done ",
  "ws_handlers.028": "Read current list",
  "ws_handlers.029": "New file",
  "ws_handlers.030": "Changes",
  "ws_handlers.031": "Running",
  "ws_handlers.032": "Completed",
  "ws_handlers.033": "Error",
  "ws_handlers.034": "Rejected",
  "ws_handlers.035": "Interrupted",
  "ws_handlers.036": "(no output)",
  "ws_handlers.037": "(no output)",
  "ws_handlers.038": "    [... truncated, ",
  "ws_handlers.039": " characters; see context for full output]",
  "ws_handlers.040": "Truncated",
  "ws_handlers.041": " lines",
  "ws_handlers.042": "Running\u2026",
  "ws_handlers.043": "Receiving arguments\u2026",
  "ws_handlers.044": "The radio didn't catch that request \u2014 click \u266b in the sidebar to play it manually",
  "ws_handlers.045": "Explore",
  "ws_handlers.046": "Plan",
  "ws_handlers.047": "General",
  "ws_handlers.048": "Verify",
  "ws_handlers.049": "<span>Expand</span>",
  "ws_handlers.050": "Collapse",
  "ws_handlers.051": "Expand",
  "ws_handlers.052": "Completed",
  "ws_handlers.053": "Failed",
  "ws_handlers.054": " s",
  "ws_handlers.055": "under 1 second",
  "ws_handlers.056": "Always allow \"{p0} \u2026\"",
  "ws_handlers.057": "Always allow",
  "ws_handlers.058": "Whitelisted and allowed: {p0}",
  "ws_handlers.059": "Failed to whitelist: ",
  "ws_handlers.060": "Allow for this session \"{p0} \u2026\"",
  "ws_handlers.061": "Allow for this session",
  "ws_handlers.062": "Won't ask again in this session: {p0}",
  "ws_handlers.063": "Failed to save session rule: ",
  "ws_handlers.064": "Allow and remember {p0}",
  "ws_handlers.065": "Allow and remember this directory",
  "ws_handlers.066": "Directory remembered; writes to it won't ask again: {p0}",
  "ws_handlers.067": "Failed to remember directory: ",
  "ws_handlers.068": "<i class=\"pr-dot\"></i>Awaiting approval",
  "ws_handlers.069": "(no arguments)",
  "ws_handlers.070": "Allow",
  "ws_handlers.071": "Deny",
  "ws_handlers.072": "Approve & implement",
  "ws_handlers.073": "Deny",
  "ws_handlers.074": "Implementation plan",
  "ws_handlers.075": "<span class=\"plan-title\">Implementation plan</span>",
  "ws_handlers.076": "<span class=\"pr-hint\"><i class=\"pr-dot\"></i>Awaiting approval",
  "ws_handlers.077": "(already open in the right panel)",
  "ws_handlers.078": "Approve & implement",
  "ws_handlers.079": "Deny",
  "ws_handlers.080": "<span>Copied</span>",
  "ws_handlers.081": "<span>Copy</span>",
  "ws_handlers.082": "Approved \u00b7 implementing",
  "ws_handlers.083": "Allowed",
  "ws_handlers.084": "Denied",
  "ws_handlers.085": "Approved \u00b7 implementing",
  "ws_handlers.086": "Denied",
  "ws_handlers.087": "Denied",
  "ws_handlers.088": "Interrupted",
  "ws_handlers.089": "Concurrency limit reached (max {p0} turns); will start automatically once earlier turns finish",
  "ws_handlers.090": "Input ",
  "ws_handlers.091": "Output ",
  "ws_handlers.092": "Cache write ",
  "ws_handlers.093": "Cache read ",
  "ws_handlers.094": "Tokens this turn \u00b7 ",
  "ws_handlers.095": "Stopped",
  "ws_handlers.096": "Stopped",
  "ws_handlers.097": "Per-turn iteration limit reached ({p0} calls); this turn wrapped up early",
  "ws_handlers.098": "\u26a0 Output token budget for this turn is exhausted",
  "ws_handlers.099": " (total output {p0}; consider raising turnTokenBudget)",
  "ws_handlers.100": ", this turn wrapped up early",
  "ws_handlers.101": "Continue",
  "ws_handlers.102": "Continue",
  "ws_handlers.103": "Connection not ready \u2014 please send \"Continue\" manually",
  "ws_handlers.104": "Unknown error",
  "ws_handlers.105": "Context was auto-compacted this turn",
  "ws_handlers.106": "Context above this point has been compacted",
  "ws_handlers.107": " (summary is for the model only; the full conversation history is unaffected)",
  "ws_handlers.108": "\u26a0 Rate limited \u2014 retrying (attempt {p1}/{p2}) in {p0}s\u2026",
  "ws_handlers.109": "Interrupting the current turn \u2014 stopping once model output/commands finish\u2026",
  "ws_handlers.110": "Interrupt",
  "ws_handlers.111": "Send",
  "ws_handlers.112": "Describe your task \u2014 you can attach files\u2026",
  "ws_handlers.113": "Keep typing to queue further changes",
  "ws_handlers.114": "Request further changes",
  "ws_handlers.115": "<span class=\"spin\"></span><span class=\"t\">Working\u2026</span>",
  "ws_handlers.116": "Failed to create session: ",
  "ws_handlers.117": "Expired · will re-plan once the conversation resumes",
};

const src = fs.readFileSync(FILE, "utf8");
const lines = src.split("\n");
const lineRe = /^(\s*)"ws_handlers\.(\d{3})":\s*(".*"),?$/;

let replaced = 0;
const missedInFile = [];   // 表里有、文件里没有
const fileKeys = new Set();

const out = lines.map((line) => {
  const m = line.match(lineRe);
  if (!m) return line;
  const key = "ws_handlers." + m[2];
  fileKeys.add(key);
  const en = T[key];
  if (en === undefined) {
    missedInFile.push(key + " (no translation in table)");
    return line;
  }
  replaced += 1;
  return m[1] + JSON.stringify(key) + ": " + JSON.stringify(en) + ",";
});

const tableKeys = Object.keys(T);
const notFound = tableKeys.filter((k) => !fileKeys.has(k));

fs.writeFileSync(FILE, out.join("\n"), "utf8");

console.log("[i18n_apply_b2] file:", FILE);
console.log("[i18n_apply_b2] replaced lines:", replaced);
console.log("[i18n_apply_b2] table entries:", tableKeys.length);
console.log("[i18n_apply_b2] file ws_handlers keys:", fileKeys.size);
if (missedInFile.length) console.log("[i18n_apply_b2] in table but not in file:", notFound);
if (notFound.length) console.log("[i18n_apply_b2] NOT FOUND in file:", notFound.join(", "));
if (missedInFile.length) console.log("[i18n_apply_b2] no translation for:", missedInFile.join(", "));
if (notFound.length === 0 && missedInFile.length === 0 && replaced === tableKeys.length) {
  console.log("[i18n_apply_b2] OK: all table entries applied, no leftovers");
}
