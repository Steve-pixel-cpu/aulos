/* Aulos promo site - interactions
   theme toggle / i18n / nav state / demo replay /
   count-up stats / reveal on scroll / copy / lightbox */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) {
    return Array.prototype.slice.call((r || document).querySelectorAll(s));
  };
  var REDUCED = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- i18n ---------------- */
        var I18N = {
    zh: {
      'nav.features': '特性',
      'nav.arch': '架构',
      'nav.shots': '界面',
      'nav.download': '下载',
      'nav.learn': '简介',
      'nav.get': '获取 Aulos',
      'hero.badge': '开源 · MIT · 本地运行',
      'hero.h1a': '把任务说清楚，',
      'hero.h1b': '剩下的交给 Aulos',
      'hero.sub': 'Aulos 是一个运行在本地的编程 Agent：读代码、改代码、跑测试，直到全部通过。数据不出机器。基于 MiniCC 构建，全部源码开放审查。',
      'hero.cta.download': '下载',
      'hero.cta.github': '源码',
      'demo.pill': '本地会话',
      'demo.think': '拆解任务…',
      'demo.tgTitle': '子 Agent × 2',
      'demo.tgRun': 'running…',
      'demo.tgDone': '✓ 12 次工具调用',
      'demo.copied': '已复制',
      'demo.done': '完成',
      'demo.input': '描述任务，Enter 发送',
      'demo.userText': '修 billing 模块：修掉失败的测试，补齐缺失的边界用例',
      'demo.asstText': '原因：税率计算用了截断而非四舍五入。已修复，新增 6 个边界用例，全量测试通过：',
      'learn.kicker': 'ABOUT',
      'learn.title': '项目简介',
      'learn.sub': 'Aulos 基于 MiniCC 构建。MiniCC 用尽量少的代码复刻了 Claude Code 的核心设计，Aulos 在它的骨架上补齐了上下文压缩、多 Agent 和 MCP。全部源码开放，想知道它怎么工作，读代码就行。',
      'learn.c1t': '基于 MiniCC',
      'learn.c1d': 'MiniCC 把 Claude Code 的核心设计整理成一个小而清晰的骨架，Aulos 不另起炉灶，直接在上面做扩展——每个功能加了什么、为什么这么加，都有据可查。',
      'learn.c2t': '代码是写给人看的',
      'learn.c2d': '模块划分清楚，注释解释的是「为什么这么做」，而不是复述代码。想了解工作原理，从 aulos/runtime.py 的主循环读起就行——整个 Agent 都围着它转。',
      'learn.c3t': '欢迎参与贡献',
      'learn.c3d': '发现 Bug 欢迎报告 issue，最好带上复现步骤。想提 PR 的话：跑通全量测试，说清楚改动动机，风格跟着现有代码走。',
      'feat.kicker': 'FEATURES',
      'feat.title': '干活的工具，不是玩具',
      'feat.sub': '衡量标准只有一个：任务是否完成。以下机制都为此存在。',
      'f1.t': '工具循环',
      'f1.d': '模型自主选择工具——读文件、改代码、执行命令——结果回填继续推理，直至任务结束。全程流式，决策过程可审计。',
      'f2.t': '三层上下文压缩',
      'f2.d': 'MicroCompact、Session Memory、Full Compact 三级降级，长会话不超窗口。摘要锚定原文抑制漂移，链路带熔断。',
      'f3.t': '多 Agent 并行',
      'f3.d': '主 Agent 拆解任务，子 Agent 并行执行。规划用强模型，执行用便宜模型。token 开销与决策质量分开考虑。',
      'f4.t': 'MCP',
      'f4.d': 'stdio / http / sse 三种传输，兼容 Claude Code 的 SKILL.md 与配置格式。外部工具与内置工具走同一套审批，没有特权路径。',
      'f5.t': '三级权限',
      'f5.d': 'plan 只读、工作区可写、完全放开，三档明确，越权即审批。.git 与 ~/.ssh 等路径无条件要求人工确认——没有例外，没有开关。',
      'f6.t': '桌面端',
      'f6.d': 'Tauri 2 外壳：设置、多供应商、任务卡片。附带桌宠与电台，不影响核心功能，不喜欢可以无视。',
      'arch.title': '模块划分',
      'arch.sub': 'CLI 与桌面端共用同一内核。划分如下：',
      'arch.code': 'CLI (main.py)                          # 终端入口 / 免交互模式\nDesktop shell (src-tauri)              # 桌面壳, WebSocket / REST\n  |\n  +-> aulos/server.py                  # FastAPI 后端\n  |     +-> aulos/web/                 #   REST 接口, 按域拆分\n  |     +-> aulos/radio/               #   电台数据源\n  |\n  +-> aulos/runtime.py                 # Agent 主循环, 核心在这里\n        +-> api_client / tools         #   模型客户端 / 内置工具\n        +-> permissions / compact      #   权限审批 / 三层压缩\n        +-> multi_agent / skills       #   子 Agent / 技能包\n        +-> memory / mcp_client        #   跨会话记忆 / MCP\n        +-> config / storage           #   配置合并 / 会话存储\n                                       # 数据目录: ~/.aulos/',
      'l1.t': '不绑定供应商',
      'l1.d': '兼容 Anthropic / OpenAI 接口的服务均可接入。base URL、key、模型皆可配置。',
      'l2.t': '评测把关',
      'l2.d': '6 类真实任务自动打分，附带基线回归。回归在合并前暴露，而不是在用户那里。',
      'l3.t': '对 prompt cache 友好',
      'l3.d': '系统提示与工具定义固定在请求前缀。缓存命中率高，账单就低。这是设计约束，不是巧合。',
      'l4.t': '会话持久化',
      'l4.d': 'JSONL 原子追加，崩溃不丢数据。-c 续接上一会话，--resume 恢复任意会话。',
      'shots.title': '界面',
      'shots.sub': '深浅双主题，石墨锌配色。本页样式直接取自桌面端。',
      'shots.cap1': '浅色',
      'shots.cap2': '深色',
      'dl.title': '安装',
      'dl.sub': '桌面安装包，或从源码运行。',
      'dl.d1': '内置 Python 运行时，支持自动更新',
      'dl.d2': 'Apple Silicon（M 系列），支持自动更新',
      'dl.d3': 'Debian / Ubuntu 系，dpkg -i 安装',
      'dl.d4': 'uv sync 后直接运行，源码可审',
      'dl.note': '打 tag 触发三平台构建 · Windows 依赖 Git for Windows（执行层使用 Git Bash）',
      'foot.tag': '本地运行的编程 Agent',
      'foot.releases': 'Releases',
      'foot.credit': '基于 MiniCC',
      'foot.built': '✻ 本页由 Aulos 生成',
    },
    en: {
      'nav.features': 'Features',
      'nav.arch': 'Architecture',
      'nav.shots': 'Interface',
      'nav.download': 'Download',
      'nav.learn': 'About',
      'nav.get': 'Get Aulos',
      'hero.badge': 'Open source · MIT · Local-first',
      'hero.h1a': 'State the task.',
      'hero.h1b': 'Aulos does the rest.',
      'hero.sub': 'Aulos is a coding agent that runs on your machine: it reads code, edits code, runs tests, and stops when they pass. Nothing leaves your machine. Built on MiniCC; the full source is open for review.',
      'hero.cta.download': 'Download',
      'hero.cta.github': 'Source',
      'demo.pill': 'local session',
      'demo.think': 'breaking down the task…',
      'demo.tgTitle': 'subagents × 2',
      'demo.tgRun': 'running…',
      'demo.tgDone': '✓ 12 tool calls',
      'demo.copied': 'copied',
      'demo.done': 'done',
      'demo.input': 'describe a task, press Enter',
      'demo.userText': 'fix billing: repair the failing tests, add the missing edge cases',
      'demo.asstText': 'Cause: the tax calculation truncates instead of rounding. Fixed, 6 edge-case tests added. Full suite green:',
      'learn.kicker': 'ABOUT',
      'learn.title': 'About the project',
      'learn.sub': 'Aulos is built on MiniCC, a small and readable re-creation of the core ideas behind Claude Code. On top of that skeleton Aulos adds context compaction, multi-agent, and MCP. The full source is open - if you want to know how it works, just read the code.',
      'learn.c1t': 'Built on MiniCC',
      'learn.c1d': 'MiniCC distills the core design of Claude Code into a small, clean skeleton. Aulos extends it rather than starting over - every feature can point to what it added and why.',
      'learn.c2t': 'Code is written for people',
      'learn.c2d': 'Modules are cleanly separated, and comments explain why the code is written this way instead of restating it. To learn how the agent works, start with the main loop in aulos/runtime.py - everything revolves around it.',
      'learn.c3t': 'Contributions welcome',
      'learn.c3d': 'Found a bug? Open an issue, ideally with steps to reproduce. For PRs: make sure the full test suite passes, explain the motivation, and follow the existing code style.',
      'feat.kicker': 'FEATURES',
      'feat.title': 'A tool that finishes work, not a toy',
      'feat.sub': 'One metric matters: whether the task gets done. Everything below exists for that.',
      'f1.t': 'Tool loop',
      'f1.d': 'The model picks its own tools - read, edit, execute - and results feed back into reasoning until the task ends. Fully streamed; decisions are auditable.',
      'f2.t': 'Three-layer compaction',
      'f2.d': 'MicroCompact, Session Memory, then Full Compact. Long sessions stay inside the window; summaries are anchored to source, and the pipeline has a circuit breaker.',
      'f3.t': 'Parallel subagents',
      'f3.d': 'The leader splits work; subagents run in parallel. Planning goes to the strong model, execution to the cheap one. Token cost and decision quality are budgeted separately.',
      'f4.t': 'MCP',
      'f4.d': 'stdio, http, and sse transports. Compatible with Claude Code SKILL.md and settings formats. External tools pass the same approval gate as built-ins - no privileged paths.',
      'f5.t': 'Three-tier permissions',
      'f5.d': 'plan, workspace-write, full access. Out-of-scope actions get an approval dialog. Paths like .git and ~/.ssh always require a human - no exceptions, no override.',
      'f6.t': 'Desktop app',
      'f6.d': 'A Tauri 2 shell: settings, providers, task cards. A desktop pet and a radio come with it; they stay out of the way, and ignoring them costs nothing.',
      'arch.title': 'Module layout',
      'arch.sub': 'CLI and desktop share the same kernel. Module layout:',
      'arch.code': 'CLI (main.py)                          # terminal entry / headless mode\nDesktop shell (src-tauri)              # desktop shell, WebSocket / REST\n  |\n  +-> aulos/server.py                  # FastAPI backend\n  |     +-> aulos/web/                 #   REST endpoints, one per domain\n  |     +-> aulos/radio/               #   radio data sources\n  |\n  +-> aulos/runtime.py                 # the agent main loop. Start here.\n        +-> api_client / tools         #   model client / built-in tools\n        +-> permissions / compact      #   approvals / three-layer compaction\n        +-> multi_agent / skills       #   subagents / skill packs\n        +-> memory / mcp_client        #   cross-session memory / MCP\n        +-> config / storage           #   config merge / session store\n                                       # data dir: ~/.aulos/',
      'l1.t': 'No vendor lock-in',
      'l1.d': 'Any Anthropic / OpenAI-compatible endpoint works. Base URL, key, and model are configuration, not code.',
      'l2.t': 'Gated by evals',
      'l2.d': 'Six families of real tasks scored automatically, plus baseline regression. Regressions surface before merge, not in front of users.',
      'l3.t': 'Prompt-cache friendly',
      'l3.d': 'System prompt and tool definitions sit at the fixed prefix of every request. A higher cache hit rate means a smaller bill - a design constraint, not a coincidence.',
      'l4.t': 'Sessions persist',
      'l4.d': 'JSONL with atomic appends; a crash loses nothing. -c continues the last session, --resume restores any session.',
      'shots.title': 'Interface',
      'shots.sub': 'Dark and light, graphite zinc. This page is styled directly after the desktop app.',
      'shots.cap1': 'Light',
      'shots.cap2': 'Dark',
      'dl.title': 'Install',
      'dl.sub': 'Desktop installers, or run from source.',
      'dl.d1': 'Bundled Python runtime; auto-update included',
      'dl.d2': 'For Apple Silicon (M-series); auto-update included',
      'dl.d3': 'Debian / Ubuntu: dpkg -i and done',
      'dl.d4': 'uv sync, then run. The source is open for review',
      'dl.note': 'Tag push triggers all three platform builds · Windows requires Git for Windows (the exec layer shells out to Git Bash)',
      'foot.tag': 'A coding agent that runs locally',
      'foot.releases': 'Releases',
      'foot.credit': 'Built on MiniCC',
      'foot.built': '✻ This page was generated by Aulos',
    },
  };

  var lang = 'zh';

  function applyLang(l) {
    lang = l;
    document.documentElement.setAttribute('lang', l === 'zh' ? 'zh-CN' : 'en');
    $$('[data-i18n]').forEach(function (el) {
      var v = I18N[l][el.getAttribute('data-i18n')];
      if (typeof v === 'string') { el.textContent = v; }
    });
    var shell = document.querySelector('[data-i18n-shell]');
    if (shell) {
      var code = shell.querySelector('code');
      if (code && typeof I18N[l]['arch.code'] === 'string') {
        code.textContent = I18N[l]['arch.code'];
      }
    }
    var btn = $('#langBtn');
    if (btn) { btn.textContent = l === 'zh' ? 'EN' : '中'; }
    try { localStorage.setItem('aulos-lang', l); } catch (e) { /* noop */ }
  }

  /* ---------------- theme ---------------- */
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('aulos-theme', t); } catch (e) { /* noop */ }
  }

  /* ---------------- nav scrolled state ---------------- */
  function bindNav() {
    var nav = $('#nav');
    if (!nav) { return; }
    var onScroll = function () {
      nav.classList.toggle('scrolled', window.scrollY > 8);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------------- reveal on scroll ---------------- */
  function bindReveal() {
    if (REDUCED || !('IntersectionObserver' in window)) {
      $$('.reveal').forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) { return; }
        en.target.classList.add('in');
        io.unobserve(en.target);
      });
    }, { threshold: 0.12 });
    $$('.reveal').forEach(function (el) { io.observe(el); });
  }

  /* ---------------- demo window replay ---------------- */
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function typeInto(el, text) {
    return new Promise(function (resolve) {
      var caret = document.createElement('span');
      caret.className = 'type-caret';
      var i = 0;
      var step = text.length > 60 ? 2 : 1;
      (function tick() {
        if (window.__aulosDemoPaused) { caret.remove(); resolve(); return; }
        if (i >= text.length) {
          el.textContent = text;
          caret.remove();
          resolve();
          return;
        }
        i = Math.min(text.length, i + step);
        el.textContent = text.slice(0, i);
        el.appendChild(caret);
        setTimeout(tick, 34);
      })();
    });
  }

  function demoReset() {
    ['dUser', 'dThink', 'dTools', 'dTool1', 'dTool2', 'dTool3', 'dAsst']
      .forEach(function (id) {
        var el = $('#' + id);
        if (el) { el.classList.remove('on'); }
      });
    $('#dUserText').textContent = '';
    $('#dAsstText').textContent = '';
    var sum = $('#dToolsSum');
    sum.classList.add('run');
    sum.textContent = I18N[lang]['demo.tgRun'];
    var cw = $('#demoChat .code-wrap');
    if (cw) { cw.classList.remove('show'); }
    $('#dDone').classList.remove('show');
  }

  function demoFinal() {
    ['dUser', 'dTools', 'dTool1', 'dTool2', 'dTool3', 'dAsst']
      .forEach(function (id) { $('#' + id).classList.add('on'); });
    $('#dUserText').textContent = I18N[lang]['demo.userText'];
    $('#dAsstText').textContent = I18N[lang]['demo.asstText'];
    var sum = $('#dToolsSum');
    sum.classList.remove('run');
    sum.textContent = I18N[lang]['demo.tgDone'];
    var cw = $('#demoChat .code-wrap');
    if (cw) { cw.classList.add('show'); }
    $('#dDone').classList.add('show');
  }

  async function runDemo() {
    if (REDUCED) { demoFinal(); return; }
    for (;;) {
      /* the sandbox game shares #demoChat; freeze the demo while it runs */
      if (window.__aulosDemoPaused) { await sleep(500); continue; }
      demoReset();
      await sleep(700);
      $('#dUser').classList.add('on');
      await typeInto($('#dUserText'), I18N[lang]['demo.userText']);
      await sleep(350);
      $('#dThink').classList.add('on');
      await sleep(1500);
      $('#dThink').classList.remove('on');
      $('#dTools').classList.add('on');
      await sleep(500);
      $('#dTool1').classList.add('on');
      await sleep(750);
      $('#dTool2').classList.add('on');
      await sleep(850);
      $('#dTool3').classList.add('on');
      await sleep(800);
      var sum = $('#dToolsSum');
      sum.classList.remove('run');
      sum.textContent = I18N[lang]['demo.tgDone'];
      await sleep(450);
      $('#dAsst').classList.add('on');
      await typeInto($('#dAsstText'), I18N[lang]['demo.asstText']);
      var cw = $('#demoChat .code-wrap');
      if (cw) { cw.classList.add('show'); }
      await sleep(700);
      $('#dDone').classList.add('show');
      await sleep(9500);
    }
  }

  /* ---------------- copy install cmd ---------------- */
  function bindCopy() {
    var btn = $('#copyInstall');
    if (!btn) { return; }
    btn.addEventListener('click', function () {
      var txt = $('#installCmd').textContent;
      var done = function () {
        btn.classList.add('copied');
        setTimeout(function () { btn.classList.remove('copied'); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, done);
      } else { done(); }
    });
  }

  /* ---------------- lightbox ---------------- */
  function bindLightbox() {
    var lb = $('#lightbox');
    var img = $('#lightboxImg');
    if (!lb || !img) { return; }
    $$('.shot img').forEach(function (shot) {
      shot.addEventListener('click', function () {
        img.src = shot.src;
        lb.classList.add('on');
      });
    });
    lb.addEventListener('click', function () { lb.classList.remove('on'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { lb.classList.remove('on'); }
    });
  }

  /* ---------------- init ---------------- */
  var savedTheme = null;
  var savedLang = null;
  try {
    savedTheme = localStorage.getItem('aulos-theme');
    savedLang = localStorage.getItem('aulos-lang');
  } catch (e) { /* noop */ }

  setTheme(savedTheme === 'light' ? 'light' : 'dark');
  applyLang(savedLang === 'en' ? 'en' : 'zh');

  var themeBtn = $('#themeBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      setTheme(cur === 'light' ? 'dark' : 'light');
    });
  }
  var langBtn = $('#langBtn');
  if (langBtn) {
    langBtn.addEventListener('click', function () {
      applyLang(lang === 'zh' ? 'en' : 'zh');
    });
  }

  bindNav();
  bindReveal();
  bindCopy();
  bindLightbox();
  runDemo();
})();
