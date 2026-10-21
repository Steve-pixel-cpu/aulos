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
      'nav.learn': '为什么做',
      'nav.get': '获取 Aulos',
      'hero.badge': '开源学习项目 · MIT · 本地运行',
      'hero.h1a': '把任务交给',
      'hero.h1b': 'Aulos',
      'hero.sub': 'Aulos 是一个在本地运行的编程 Agent。你说一句要做什么，它自己读代码、改代码、跑测试，一直到测试全部通过。整个过程不联网上传，代码都在你机器上。项目基于 MiniCC 二次开发，目前已有 38000 多行 Python——想弄明白 Agent 到底是怎么回事，直接看源码。',
      'hero.cta.download': '下载桌面版',
      'hero.cta.github': 'GitHub',
      'demo.pill': '本地会话',
      'demo.think': '思考中 · 拆解任务…',
      'demo.tgTitle': '子 Agent × 2',
      'demo.tgRun': 'running…',
      'demo.tgDone': '✓ 12 次工具调用',
      'demo.copied': '已复制',
      'demo.done': '完成',
      'demo.input': '输入任务，Enter 发送…',
      'demo.userText': '修一下 billing 模块：失败的测试修掉，缺的边界用例补上',
      'demo.asstText': '找到原因了：税率计算用了截断而不是四舍五入。已经修好，另外补了 6 个边界用例，测试全部通过：',
      'learn.kicker': 'WHY & HOW',
      'learn.title': '为什么做这个项目',
      'learn.sub': '做 Aulos 是为了彻底搞清楚 AI Agent 的内部构造。项目基于 MiniCC——一个极简的 Claude Code 复刻——在其架构上扩展出三层上下文压缩、多 Agent、MCP 接入等能力。读懂 MiniCC，就读懂了 Aulos 的一半。',
      'learn.c1t': '基于 MiniCC 构建',
      'learn.c1d': 'Aulos 以 MiniCC 为起点。MiniCC 用最少的代码复刻了 Claude Code 的核心设计，Aulos 在这条骨架上继续生长，每一处改动都有出处可查。',
      'learn.c2t': '代码可读性优先',
      'learn.c2d': '模块划分清晰，注释写的是设计取舍而不是套话。想读的话，从 aulos/runtime.py 的主循环开始。',
      'learn.c3t': '欢迎提 issue 和 PR',
      'learn.c3d': '发现 bug 可以直接开 issue，最好带上复现步骤。提交 PR 之前请先跑通全部测试。',
      'feat.kicker': 'FEATURES',
      'feat.title': '一个能把任务做完的 Agent',
      'feat.sub': '不是聊天窗口加了个壳。从内核到界面，每个设计都围绕一件事：把任务做完。',
      'f1.t': '工具循环',
      'f1.d': '模型自己决定调用哪个工具——读文件、改代码、跑命令，执行结果返回后继续推理，直到任务结束。全程流式输出，思考过程实时可见。',
      'f2.t': '三层上下文压缩',
      'f2.d': 'MicroCompact → Session Memory → Full Compact 三级逐层压缩，长对话不会撑爆上下文窗口。摘要锚定原文防止信息漂移，链路带熔断保护。',
      'f3.t': '多 Agent 并行',
      'f3.d': '主 Agent 负责拆解任务，子 Agent 并行执行。规划诊断交给能力强的模型，具体执行交给便宜的模型，把 token 花在关键的地方。',
      'f4.t': 'MCP 接入',
      'f4.d': '支持 stdio / http / sse 三种传输方式，兼容 Claude Code 的 SKILL.md 和配置格式。外部工具和内置工具走同一套审批。',
      'f5.t': '三级权限',
      'f5.d': 'plan 只读 → 工作区可写 → 完全放开，越权操作会弹窗审批。.git、~/.ssh 这类敏感路径无论如何都需要人工确认。',
      'f6.t': '桌面端 + 电台',
      'f6.d': '基于 Tauri 2 的桌面应用：设置页、多模型供应商、任务卡片。另外还有桌宠和电台，算是顺手做的小玩意，不影响主功能。',
      'arch.title': '38000 行 Python，一个包',
      'arch.sub': 'CLI 和桌面端共用同一个内核。模块怎么划分的，直接看：',
      'arch.code': 'CLI (main.py)                          # 终端交互 / 免交互模式\nDesktop shell (src-tauri)              # 桌面壳, 走 WebSocket / REST\n  |\n  +-> aulos/server.py                  # FastAPI 后端门面\n  |     +-> aulos/web/                 #   各功能域的 REST 接口\n  |     +-> aulos/radio/               #   电台曲库(网易云 / B站)\n  |\n  +-> aulos/runtime.py                 # Agent 主循环(核心)\n        +-> api_client / tools         #   模型调用客户端 / 内置工具\n        +-> permissions / compact      #   权限审批 / 三层压缩\n        +-> multi_agent / skills       #   子 Agent / 技能包\n        +-> memory / mcp_client        #   跨会话记忆 / MCP 接入\n        +-> config / storage           #   配置合并 / 会话存储\n                                       # 数据目录: ~/.aulos/',
      'l1.t': '不绑定供应商',
      'l1.d': '任何兼容 Anthropic / OpenAI 接口的服务都能接，base URL、key、模型随便换。',
      'l2.t': '有评测兜底',
      'l2.d': '6 类真实任务自动打分，外加基线回归。改坏了什么，合并之前就能发现。',
      'l3.t': '对 prompt cache 友好',
      'l3.d': '系统提示和工具定义固定在请求开头，缓存命中率上去了，账单就下来了。',
      'l4.t': '会话保存到本地',
      'l4.d': 'JSONL 原子写入，崩溃不会丢数据。-c 接着上次聊，--resume 恢复任意会话。',
      'shots.title': '界面长这样',
      'shots.sub': '桌面端实际长这样：深浅两套主题，石墨锌配色。这个宣传页的样式就是直接用的它的设计。',
      'shots.cap1': '浅色',
      'shots.cap2': '深色',
      'dl.title': '两种安装方式',
      'dl.sub': '图省事就下安装包；喜欢终端的话，uv 一条命令跑起来。',
      'dl.d1': '内置 Python 运行时，装完即用，支持自动更新',
      'dl.d2': 'Apple Silicon 原生构建，拖进 Applications 就行',
      'dl.d3': '单个文件，chmod +x 之后直接运行',
      'dl.d4': '然后 uv sync，源码随便看',
      'dl.note': '打 tag 自动构建三平台安装包 · Windows 需要安装 Git for Windows（执行层依赖 Git Bash）',
      'foot.tag': '本地运行的编程 Agent',
      'foot.releases': 'Releases',
      'foot.credit': '基于 MiniCC，感谢',
      'foot.built': '✻ 这个页面是 Aulos 自己写的',
    },
    en: {
      'nav.features': 'Features',
      'nav.arch': 'Architecture',
      'nav.shots': 'Interface',
      'nav.download': 'Download',
      'nav.learn': 'Why & How',
      'nav.get': 'Get Aulos',
      'hero.badge': 'Open-source learning project · MIT · Local-first',
      'hero.h1a': 'Hand the task to',
      'hero.h1b': 'Aulos',
      'hero.sub': 'Aulos is a coding agent that runs on your machine. You describe what you need; it reads the code, makes changes, runs the tests, and keeps going until everything passes. Nothing gets uploaded - your code stays local. The project is built on top of MiniCC and has grown to about 38,000 lines of Python. If you have ever wondered what an agent actually looks like inside, just read the source.',
      'hero.cta.download': 'Download for desktop',
      'hero.cta.github': 'GitHub',
      'demo.pill': 'local session',
      'demo.think': 'thinking · breaking down the task…',
      'demo.tgTitle': 'subagents × 2',
      'demo.tgRun': 'running…',
      'demo.tgDone': '✓ 12 tool calls',
      'demo.copied': 'copied',
      'demo.done': 'done',
      'demo.input': 'describe a task, press Enter…',
      'demo.userText': 'fix the billing module: repair the failing tests and add the missing edge cases',
      'demo.asstText': 'Found it - the tax calculation truncates instead of rounding. Fixed, plus 6 new edge-case tests. The whole suite is green now:',
      'learn.kicker': 'WHY & HOW',
      'learn.title': 'Why this project exists',
      'learn.sub': 'Aulos exists to understand how an AI agent actually works. It is built on MiniCC - a minimal Claude Code reimplementation - and extends that architecture with three-layer compaction, multi-agent orchestration, and MCP support. Read MiniCC and you understand half of Aulos.',
      'learn.c1t': 'Built on MiniCC',
      'learn.c1d': 'MiniCC is the starting point: it recreates the core design of Claude Code in the smallest possible codebase, and Aulos grows from that skeleton. Every change traces back to a source.',
      'learn.c2t': 'Readability first',
      'learn.c2d': 'Clean module boundaries; comments explain trade-offs, not filler. Start with the main loop in aulos/runtime.py.',
      'learn.c3t': 'Issues and PRs welcome',
      'learn.c3d': 'Found a bug? Open an issue - repro steps are appreciated. Please run the full test suite before sending a PR.',
      'feat.kicker': 'FEATURES',
      'feat.title': 'An agent that gets the job done',
      'feat.sub': 'Not a chat window with a shell taped on. From kernel to UI, everything serves one goal: finishing the task.',
      'f1.t': 'Tool loop',
      'f1.d': 'The model decides which tool to call - read a file, edit code, run a command - and the result feeds back into its reasoning until the task is done. Fully streamed; the thinking is visible as it happens.',
      'f2.t': 'Three-layer compaction',
      'f2.d': 'MicroCompact, Session Memory, then Full Compact - three levels so long conversations never blow the context window. Summaries stay anchored to the source, and the pipeline has a circuit breaker.',
      'f3.t': 'Parallel subagents',
      'f3.d': 'The main agent breaks the work down; subagents run in parallel. Planning goes to the stronger model, execution to the cheaper one - tokens are spent where they matter.',
      'f4.t': 'MCP support',
      'f4.d': 'stdio, http, and sse transports. Compatible with Claude Code SKILL.md and settings formats. External tools go through the same approval flow as built-in ones.',
      'f5.t': 'Three-tier permissions',
      'f5.d': 'plan (read-only), workspace-write, or full access - out-of-scope actions trigger an approval dialog. Sensitive paths like .git and ~/.ssh always require a human sign-off.',
      'f6.t': 'Desktop app and radio',
      'f6.d': 'A Tauri 2 desktop app with settings, multiple providers, and task cards. There is also a desktop pet and a radio - side quests, not core features.',
      'arch.title': '38,000 lines of Python, one package',
      'arch.sub': 'CLI and desktop share the same kernel. Here is how the modules are laid out:',
      'arch.code': 'CLI (main.py)                          # terminal UI / headless mode\nDesktop shell (src-tauri)              # desktop shell, WebSocket / REST\n  |\n  +-> aulos/server.py                  # FastAPI backend facade\n  |     +-> aulos/web/                 #   REST endpoints per domain\n  |     +-> aulos/radio/               #   radio sources (NetEase / Bilibili)\n  |\n  +-> aulos/runtime.py                 # agent main loop (the core)\n        +-> api_client / tools         #   model client / built-in tools\n        +-> permissions / compact      #   approvals / three-layer compaction\n        +-> multi_agent / skills       #   subagents / skill packs\n        +-> memory / mcp_client        #   cross-session memory / MCP\n        +-> config / storage           #   config merge / session store\n                                       # data dir: ~/.aulos/',
      'l1.t': 'No vendor lock-in',
      'l1.d': 'Works with any Anthropic / OpenAI-compatible endpoint. Base URL, key, and model are all configurable.',
      'l2.t': 'Backed by evals',
      'l2.d': 'Six families of real tasks are scored automatically, with baseline regression on top. If something breaks, you find out before it merges.',
      'l3.t': 'Prompt-cache friendly',
      'l3.d': 'System prompt and tool definitions stay at the front of the request. A better cache hit rate means a smaller bill.',
      'l4.t': 'Sessions saved locally',
      'l4.d': 'JSONL with atomic writes - a crash will not lose your data. Use -c to continue the last chat, or --resume to restore any session.',
      'shots.title': 'What it looks like',
      'shots.sub': 'The desktop app, as it actually looks: dark and light themes in a graphite-zinc palette. This page is styled directly after it.',
      'shots.cap1': 'Light',
      'shots.cap2': 'Dark',
      'dl.title': 'Two ways to install',
      'dl.sub': 'Grab an installer if you want it easy, or run it from source with a single uv command.',
      'dl.d1': 'Ships with a bundled Python runtime; auto-update included',
      'dl.d2': 'Native Apple Silicon build - just drag it into Applications',
      'dl.d3': 'A single file; chmod +x and run',
      'dl.d4': 'then uv sync. The source is all there to read',
      'dl.note': 'Tagging a release triggers builds for all three platforms. Windows requires Git for Windows (the exec layer depends on Git Bash)',
      'foot.tag': 'A coding agent that runs locally',
      'foot.releases': 'Releases',
      'foot.credit': 'Built on MiniCC - credits',
      'foot.built': '✻ This page was written by Aulos itself',
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
