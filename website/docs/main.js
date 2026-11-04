/* Buildless documentation. Content and navigation are useful without JS;
   progressive enhancement adds chapter routing, search, copy and mobile navigation. */
(function () {
  'use strict';

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.from((root || document).querySelectorAll(selector)); };
  var articles = $$('.docs__article');
  var links = $$('.docs__nav [data-page]');
  var toc = $('#toc-links');
  var pager = $('#docs-pager');
  var menuButton = $('#menu-toggle');
  var sidebar = $('#docs-sidebar');
  var scrim = $('#menu-scrim');
  var mobile = window.matchMedia('(max-width: 760px)');
  var currentArticle = null;
  var currentHeadings = [];
  var scrollScheduled = false;
  var dialog = $('#docs-search');
  var searchInput = $('#search-input');
  var searchResults = $('#search-results');
  var selectedResult = -1;
  var searchOpener = null;

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('#theme-toggle').setAttribute('aria-label', theme === 'dark' ? '切换为浅色主题' : '切换为深色主题');
    try { localStorage.setItem('aulos-theme', theme); } catch (error) { /* Storage can be disabled. */ }
  }
  var savedTheme;
  try { savedTheme = localStorage.getItem('aulos-theme'); } catch (error) { /* Use the site's default. */ }
  setTheme(savedTheme === 'light' ? 'light' : 'dark');
  $('#theme-toggle').hidden = false;
  $('#theme-toggle').addEventListener('click', function () {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  window.addEventListener('storage', function (event) {
    if (event.key === 'aulos-theme') { setTheme(event.newValue === 'light' ? 'light' : 'dark'); }
  });

  function toggleMenu(open, returnFocus) {
    document.body.classList.toggle('docs--menu-open', open);
    menuButton.setAttribute('aria-expanded', String(open));
    scrim.hidden = !open;
    if (open) {
      (sidebar.querySelector('[aria-current="page"]') || links[0]).focus();
    } else if (returnFocus && mobile.matches) {
      menuButton.focus();
    }
  }
  menuButton.addEventListener('click', function () {
    toggleMenu(menuButton.getAttribute('aria-expanded') !== 'true', true);
  });
  scrim.addEventListener('click', function () { toggleMenu(false, true); });
  mobile.addEventListener('change', function () { toggleMenu(false, false); });

  function makePagerLink(article, direction) {
    var link = document.createElement('a');
    link.href = '#' + article.id;
    link.dataset.direction = direction;
    var label = document.createElement('span');
    label.textContent = direction === 'previous' ? '← 上一篇' : '下一篇 →';
    link.append(label, document.createTextNode(article.dataset.title));
    return link;
  }

  function updateScrollState() {
    scrollScheduled = false;
    if (!currentHeadings.length) { return; }
    var threshold = mobile.matches ? 150 : 110;
    var active = currentHeadings[0];
    currentHeadings.forEach(function (heading) {
      if (heading.getBoundingClientRect().top <= threshold) { active = heading; }
    });
    $$('a', toc).forEach(function (link) {
      if (link.hash === '#' + active.id) { link.setAttribute('aria-current', 'location'); }
      else { link.removeAttribute('aria-current'); }
    });
  }

  function route(focusContent) {
    var id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch (error) { id = ''; }
    var target = document.getElementById(id);
    var article = target && target.closest('.docs__article');
    // The skip link has its own focus behavior and must not switch chapters.
    if (id === 'docs-content' && currentArticle) { return; }
    article = article || articles[0];
    if (dialog.open) { dialog.close(); }
    currentArticle = article;
    articles.forEach(function (item) { item.hidden = item !== article; });
    links.forEach(function (link) {
      if (link.dataset.page === article.id) { link.setAttribute('aria-current', 'page'); }
      else { link.removeAttribute('aria-current'); }
    });
    document.title = article.dataset.title + ' · Aulos 文档';
    $('#breadcrumb-title').textContent = article.dataset.title;
    $('#mobile-title').textContent = article.dataset.title;
    $('#back-top').href = '#' + article.id;
    currentHeadings = $$('h2, h3', article);
    toc.replaceChildren();
    currentHeadings.forEach(function (heading) {
      var link = document.createElement('a');
      link.href = '#' + heading.id;
      link.textContent = heading.textContent;
      link.dataset.level = heading.tagName.slice(1);
      toc.appendChild(link);
    });
    pager.replaceChildren();
    var index = articles.indexOf(article);
    if (index > 0) { pager.appendChild(makePagerLink(articles[index - 1], 'previous')); }
    if (index < articles.length - 1) { pager.appendChild(makePagerLink(articles[index + 1], 'next')); }
    toggleMenu(false, false);
    requestAnimationFrame(function () {
      var headingTarget = target && article.contains(target) && target !== article ? target : null;
      if (headingTarget) { headingTarget.scrollIntoView({ block: 'start', behavior: 'instant' }); }
      else { window.scrollTo({ top: 0, behavior: 'instant' }); }
      if (focusContent) {
        var focusTarget = headingTarget || $('h1', article);
        focusTarget.setAttribute('tabindex', '-1');
        focusTarget.focus({ preventScroll: true });
      }
      updateScrollState();
    });
  }
  window.addEventListener('hashchange', function () { route(true); });
  // Re-clicking the active chapter or heading does not emit hashchange.
  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[href^="#"]');
    if (link && link.hash === location.hash && link.hash !== '#docs-content') {
      event.preventDefault();
      route(true);
    }
  });
  window.addEventListener('scroll', function () {
    if (!scrollScheduled) { requestAnimationFrame(updateScrollState); scrollScheduled = true; }
  }, { passive: true });

  // Build search from the authored HTML so the searchable text cannot drift
  // from the visible documentation. Never interpolate search input as markup.
  var searchIndex = [];
  articles.forEach(function (article) {
    var entry = { id: article.id, page: article.dataset.title, title: article.dataset.title, text: '' };
    Array.from(article.children).forEach(function (element) {
      if (/^H[23]$/.test(element.tagName)) {
        searchIndex.push(entry);
        entry = { id: element.id, page: article.dataset.title, title: element.textContent, text: '' };
      } else {
        entry.text += ' ' + element.textContent.replace(/\s+/g, ' ').trim();
      }
    });
    searchIndex.push(entry);
  });

  function renderSearch() {
    searchResults.replaceChildren();
    selectedResult = -1;
    var query = searchInput.value.trim().toLocaleLowerCase();
    if (!query) {
      $('#search-status').textContent = '输入关键词，查找使用方法与配置说明。';
      return;
    }
    var terms = query.split(/\s+/);
    var matches = searchIndex.map(function (entry) {
      var title = (entry.page + ' ' + entry.title).toLocaleLowerCase();
      var text = entry.text.toLocaleLowerCase();
      var score = terms.reduce(function (total, term) { return total + (title.includes(term) ? 5 : 1); }, 0);
      return { entry: entry, score: terms.every(function (term) { return (title + text).includes(term); }) ? score : 0 };
    }).filter(function (item) { return item.score > 0; }).sort(function (a, b) { return b.score - a.score; });
    $('#search-status').textContent = matches.length ? '找到 ' + matches.length + ' 条结果' + (matches.length > 20 ? '，显示前 20 条' : '') : '没有找到相关内容，试试“模型”“权限”或“MCP”。';
    matches.slice(0, 20).forEach(function (match) {
      var entry = match.entry;
      var link = document.createElement('a');
      link.href = '#' + entry.id;
      var title = document.createElement('strong');
      title.textContent = entry.page === entry.title ? entry.title : entry.page + ' / ' + entry.title;
      var snippet = document.createElement('span');
      var position = entry.text.toLocaleLowerCase().indexOf(terms[0]);
      var start = Math.max(0, position - 24);
      snippet.textContent = (start ? '…' : '') + entry.text.slice(start, start + 115).trim() + (entry.text.length > start + 115 ? '…' : '');
      link.append(title, snippet);
      link.addEventListener('click', function () { dialog.close(); });
      searchResults.appendChild(link);
    });
  }
  function openSearch() {
    toggleMenu(false, false);
    searchOpener = document.activeElement;
    dialog.showModal();
    renderSearch();
    searchInput.focus();
  }
  if (typeof dialog.showModal === 'function') {
    $('#search-open').hidden = false;
    $('#search-open').addEventListener('click', openSearch);
  }
  $('#search-close').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('close', function () {
    if (searchOpener && searchOpener.isConnected) { searchOpener.focus({ preventScroll: true }); }
  });
  dialog.addEventListener('click', function (event) {
    var rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) { dialog.close(); }
  });
  searchInput.addEventListener('input', renderSearch);
  dialog.addEventListener('keydown', function (event) {
    var results = $$('a', searchResults);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) { return; }
      event.preventDefault();
      var focused = results.indexOf(document.activeElement);
      if (focused >= 0) { selectedResult = focused; }
      selectedResult = (selectedResult + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      results.forEach(function (result, index) { result.classList.toggle('is-selected', index === selectedResult); });
      results[selectedResult].focus();
    } else if (event.key === 'Enter' && document.activeElement === searchInput && results.length) {
      event.preventDefault();
      results[Math.max(0, selectedResult)].click();
    }
  });
  $('#search-shortcut').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && typeof dialog.showModal === 'function') {
      event.preventDefault();
      if (dialog.open) { dialog.close(); } else { openSearch(); }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (dialog.open) { dialog.close(); }
      else { toggleMenu(false, true); }
    }
    if (event.key === 'Tab' && mobile.matches && document.body.classList.contains('docs--menu-open')) {
      var focusable = $$('a[href]', sidebar);
      if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault(); focusable[focusable.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
        event.preventDefault(); focusable[0].focus();
      }
    }
  });

  $$('pre[data-language]').forEach(function (pre) {
    var header = document.createElement('div');
    header.className = 'docs__code-head';
    var label = document.createElement('span');
    label.textContent = pre.dataset.language;
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'docs__copy';
    copy.textContent = '复制';
    copy.setAttribute('aria-label', '复制 ' + pre.dataset.language + ' 代码');
    var resetTimer;
    copy.addEventListener('click', async function () {
      clearTimeout(resetTimer);
      try {
        await navigator.clipboard.writeText($('code', pre).textContent);
        copy.textContent = '已复制';
        $('#copy-status').textContent = '代码已复制到剪贴板';
      } catch (error) {
        var range = document.createRange();
        range.selectNodeContents($('code', pre));
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        copy.textContent = '请手动复制';
        $('#copy-status').textContent = '自动复制不可用，已选中代码，请使用系统复制快捷键';
      }
      resetTimer = setTimeout(function () { copy.textContent = '复制'; }, 2200);
    });
    header.append(label, copy);
    pre.prepend(header);
  });

  document.body.classList.add('docs--enhanced');
  $('#mobile-bar').hidden = false;
  $('#docs-toc').hidden = false;
  pager.hidden = false;
  route(false);
})();
