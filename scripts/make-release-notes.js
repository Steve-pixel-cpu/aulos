#!/usr/bin/env node
/*
 * Release notes 生成器：把 <prev-tag>..<tag> 之间的 commit 整理成
 * 面向用户的结构化 Markdown（GitHub Release body 用）。
 *
 *   node scripts/make-release-notes.js --tag v5.3.2 [--out dist/release-notes.md] [--repo a/b]
 *
 * 整洁规则（commit message ≠ release notes，过滤开发过程噪音）：
 *   - 跳过版本号提交（feat: v5.5.0）与 Merge 提交
 *   - 跳过 test/chore/ci/build 类型（对用户不可见）
 *   - 全角冒号同权（feat：xxx 不再漏进「其他」）
 *   - scope 归一化（去 -phaseN 后缀）并映射通俗中文标签（i18n → 多语言）
 *   - 平铺嵌套前缀（"A + fix(plan): B" → "A + B"）
 *
 * 精简规则（v5.5.0 51 条平铺太长的教训）：
 *   - 可见行只取「——」前的短摘要，全文进折叠块
 *   - 同节同 scope ≥ MERGE_AT 条 → 合并为一行摘要 + <details> 明细
 *   - 每节可见块超过 SECTION_CAP → 余量折进「其余 N 项」
 *   - 无 prev tag（首个版本）时只取最近 NO_PREV_CAP 条
 *
 * 分类：feat → ✨ 新特性；fix → 🐛 修复；perf → ⚡ 性能；其余 → 🔧 体验优化。
 * 与 make-latest-multi.js 同口径：下载表文件名前缀取自
 * src-tauri/tauri.conf.json 的 productName。
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const root = path.resolve(__dirname, "..");
const tag = argOf("--tag");
const repo = argOf("--repo", "Steve-pixel-cpu/aulos");
const out = argOf("--out");
const NO_PREV_CAP = 15; // 首个 tag 无 diff 基线, 只列最近 N 条
const MERGE_AT = 4; // 同节同 scope ≥ N 条 → 1 行摘要 + 折叠明细
const SECTION_CAP = 8; // 每节最多显示 N 个块, 其余折进「其余 N 项」

if (!tag) {
  console.error("[make-release-notes] 缺少 --tag (如 v5.3.2)");
  process.exit(1);
}

function git(gitArgs) {
  // 按参数逐个传（不走 shell），commit subject 含引号/中文也安全
  return execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" }).trim();
}

// 上一个 tag：tag 前一个提交能 describe 到的最近 tag。首个版本（无 prev）
// 降级为最近 N 条。
let prev = null;
try {
  // stdio 忽略 stderr: 首个 tag 时 git describe 会打印 "fatal: No tags can
  // describe", 属预期降级, 不该在 CI 日志里装失败
  prev = execFileSync("git", ["describe", "--tags", "--abbrev=0", `${tag}~1`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // 首个 tag 或历史不可达：prev 留空
}

const range = prev ? `${prev}..${tag}` : tag;
let commits;
try {
  commits = git(["log", range, "--pretty=%h%x09%s", "--no-merges"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split("\t");
      return { hash, subject: rest.join("\t") };
    });
} catch (e) {
  console.error(`[make-release-notes] git log ${range} 失败: ${e.message}`);
  console.error("[make-release-notes] CI 浅克隆时需 checkout fetch-depth: 0");
  process.exit(1);
}

// ---- 文本清洗 ----------------------------------------------------------

// conventional 前缀解析: "feat(ui): xxx" / 全角冒号 "feat：xxx"
function parseSubject(subject) {
  const m = subject.match(/^(\w+)(?:\(([^)]*)\))?[：:]\s*(.+)$/);
  if (!m) return { type: "other", scope: null, desc: subject };
  return { type: m[1].toLowerCase(), scope: m[2] || null, desc: m[3].trim() };
}

// 版本号提交（feat: v5.5.0）对用户无信息量
const isVersionBump = (desc) => /^v?\d+(\.\d+)+$/.test(desc);

// 对用户不可见的类型：纯开发过程
const DROP_TYPES = new Set(["test", "chore", "ci", "build"]);

// 嵌套前缀平铺："项目组拖动排序 + fix(plan): 计划卡沉底" → "项目组拖动排序 + 计划卡沉底"
function cleanDesc(desc) {
  return desc
    .replace(
      /\s*\+\s*(?:fix|feat|perf|style|refactor|test|chore)(?:\([^)]*\))?[：:]\s*/g,
      " + "
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

// 短摘要：本仓库 commit 惯用 "摘要——解释"，可见行只留摘要段
function shortDesc(desc) {
  const i = desc.indexOf("——");
  return (i > 0 ? desc.slice(0, i) : desc).trim();
}

// 可见行硬截断（无「——」分隔的长描述兜底, 如 "会话列表添加置顶功能以及设置增加并发上限配置，…"）
function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max) + "…";
}

// scope 归一化 + 通俗中文标签（覆盖仓库常用 scope, 未收录原样保留）
function normScope(scope) {
  if (!scope) return null;
  return scope.replace(/-phase\d+$/i, "").toLowerCase();
}
const SCOPE_LABELS = {
  ui: "界面",
  css: "样式",
  theme: "主题",
  chat: "对话",
  sidebar: "侧栏",
  session: "会话",
  subagent: "子智能体",
  agent: "智能体",
  i18n: "多语言",
  tauri: "桌面端",
  electron: "Electron 端",
  web: "Web 端",
  mica: "云母效果",
  music: "音乐播放",
  browser: "浏览器工具",
  server: "服务端",
  mode: "模式切换",
  plan: "计划模式",
  permissions: "权限",
  guard: "委派护栏",
  runtime: "运行时",
  "llm-status": "模型状态",
  conn: "连接指示",
  probe: "连通探测",
  stop: "停止控制",
  release: "发版流程",
  tests: "测试",
};
const scopeLabel = (scope) => SCOPE_LABELS[scope] || scope;

// ---- 分类聚合 ----------------------------------------------------------

const BUCKETS = [
  { type: "feat", title: "✨ 新特性", noun: "特性" },
  { type: "fix", title: "🐛 修复", noun: "修复" },
  { type: "perf", title: "⚡ 性能", noun: "优化" },
];
const OTHER = { type: "other", title: "🔧 体验优化", noun: "改进" };
const ALL_BUCKETS = [...BUCKETS, OTHER];

const dropped = { n: 0 };
const grouped = new Map(ALL_BUCKETS.map((b) => [b.type, []]));
for (const c of commits) {
  const { type, scope, desc: rawDesc } = parseSubject(c.subject);
  if (isVersionBump(rawDesc)) { dropped.n++; continue; }
  if (DROP_TYPES.has(type)) { dropped.n++; continue; }
  grouped.get(grouped.has(type) ? type : "other").push({
    scope: normScope(scope),
    desc: cleanDesc(rawDesc),
    hash: c.hash,
  });
}

// 首个 tag（无 diff 基线）只保留最近 N 条, 避免把全部历史搬上 Release
if (!prev && commits.length > NO_PREV_CAP) {
  const kept = new Set(commits.slice(0, NO_PREV_CAP).map((c) => c.hash));
  for (const [t, list] of grouped)
    grouped.set(t, list.filter((i) => kept.has(i.hash)));
}

// 重点方向: feat+fix+perf 里出现最多的前 3 个 scope（≥2 次才值得提）
const scopeCount = new Map();
for (const b of BUCKETS)
  for (const { scope } of grouped.get(b.type))
    if (scope) scopeCount.set(scope, (scopeCount.get(scope) || 0) + 1);
const topScopes = [...scopeCount.entries()]
  .filter(([, n]) => n >= 2)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .map(([scope, n]) => `**${scopeLabel(scope)}**（${n} 项）`);

// ---- 渲染 --------------------------------------------------------------

// 每个 item 两种行: 可见行(短摘要 + hash) / 明细行(全文 + hash)
const plainLine = (it) =>
  `- ${it.scope ? `**${scopeLabel(it.scope)}**: ` : ""}${truncate(
    shortDesc(it.desc),
    40
  )} (\`${it.hash}\`)`;
const fullLine = (it) =>
  `- ${it.scope ? `**${scopeLabel(it.scope)}**: ` : ""}${it.desc} (\`${it.hash}\`)`;

// 节渲染: scope 归组(≥MERGE_AT 折叠) + 节级截断(余量折叠)
// 返回 null 表示该节无内容
function buildSection(bucket, items) {
  if (items.length === 0) return null;

  // 按 scope 首次出现顺序归组（无 scope 的保持流水）
  const groups = [];
  const byScope = new Map();
  for (const it of items) {
    const key = it.scope || "";
    if (!byScope.has(key)) {
      const g = { scope: it.scope, items: [] };
      byScope.set(key, g);
      groups.push(g);
    }
    byScope.get(key).items.push(it);
  }

  // 组 → 块: 大组折叠成一行 summary, 小组逐条平铺
  const blocks = []; // {item} 平铺行 | {summary, items} 折叠块
  for (const g of groups) {
    if (g.scope && g.items.length >= MERGE_AT) {
      blocks.push({
        summary: `${scopeLabel(g.scope)}：${g.items.length} 项${bucket.noun}`,
        items: g.items,
      });
    } else {
      for (const it of g.items) blocks.push({ item: it });
    }
  }

  const out = [`### ${bucket.title}`, ""];
  let anyCollapsed = false;
  const visible = blocks.slice(0, SECTION_CAP);
  const rest = blocks.slice(SECTION_CAP);
  for (const b of visible) {
    if (b.item) {
      out.push(plainLine(b.item));
    } else {
      anyCollapsed = true;
      out.push(
        "<details>",
        `<summary>${b.summary}</summary>`,
        "",
        ...b.items.map(fullLine),
        "</details>",
        ""
      );
    }
  }
  if (rest.length > 0) {
    anyCollapsed = true;
    const lines = rest.flatMap((b) => (b.item ? [fullLine(b.item)] : b.items.map(fullLine)));
    out.push(
      "<details>",
      `<summary>其余 ${rest.reduce((n, b) => n + (b.item ? 1 : b.items.length), 0)} 项${bucket.noun}</summary>`,
      "",
      ...lines,
      "</details>"
    );
  }
  // 节尾空行: 下个标题紧跟列表行时部分渲染器不识别为标题
  out.push("");
  return { text: out, anyCollapsed };
}

const listed = ALL_BUCKETS.reduce((n, b) => n + grouped.get(b.type).length, 0);

const md = [];
let anyCollapsed = false;
if (listed <= 0) {
  md.push(`## ${tag}`, "", "本版本无独立代码变更（跳版发布）。", "");
} else {
  const truncated = !prev && commits.length > NO_PREV_CAP;
  const intro = prev
    ? `自 ${prev} 以来的 ${listed} 项变更`
    : `首批发布，共 ${listed} 项变更`;
  md.push(
    `## 更新内容\n\n${intro}${
      topScopes.length ? `，重点集中在 ${topScopes.join("、")}` : ""
    }${truncated || true ? "，以下为主要条目" : ""}\n`
  );
  if (truncated) {
    md.push(`> 历史变更较多，仅列出最近 ${listed} 条，更早从略。\n`);
  }
  for (const b of ALL_BUCKETS) {
    const s = buildSection(b, grouped.get(b.type));
    if (s) {
      md.push(...s.text);
      anyCollapsed = anyCollapsed || s.anyCollapsed;
    }
  }
}

// 下载表: 与 make-latest-multi.js 同一 productName 单点
const productName = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")
).productName;
const ver = tag.replace(/^v/, "");

md.push(
  "## 下载",
  "",
  "| 平台 | 文件 |",
  "| --- | --- |",
  `| Windows x64 | \`${productName}_${ver}_x64-setup.exe\` |`,
  `| macOS (Apple Silicon) | \`${productName}_${ver}_aarch64.dmg\` |`,
  `| Linux (deb) | \`${productName}_${ver}_amd64.deb\` |`,
  "",
  `**完整变更**: https://github.com/${repo}/compare/${prev ? `${prev}...${tag}` : `4b825dc642cb6eb9a060e54bf8d69288fbee4904...${tag}`}`,
  "",
  "> 已安装用户将在下次启动时自动收到更新提示。"
);

const text = md.join("\n");

if (out) {
  fs.writeFileSync(out, text, "utf8");
  console.log(
    `[make-release-notes] wrote ${out}: ${listed}/${commits.length} commits ` +
      `${prev ? `(${prev}..${tag})` : `(首个 tag, cap=${NO_PREV_CAP})`}`
  );
} else {
  console.log(text);
}
