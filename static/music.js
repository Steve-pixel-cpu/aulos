"use strict";
/* ============================================================
 * 摸鱼电台: 网易云迷你播放器（独立文件, 不碰 app.js 的会话逻辑）
 * 播放条停靠在侧栏底部空白区（#side-chat 内, 会话列表下方）,
 * 不与主区输入框重叠; 面板从其上方弹出。
 * 找歌只有搜索; 收藏与自定义歌单存服务端 ~/.aulos/music-library.json,
 * 当前播放列表（队列）存 localStorage —— 重启后接着听。
 * 在线流式播放免费曲库; VIP/无版权歌（后端 url=null）自动跳下一首。
 * 聊天点播: 模型调 music_play 工具后, app.js 把 result_meta.music 转给
 * window.aulosMusicPlay —— 整队换队列 + 亮播放条 + 开播（见文件底部）。
 * ============================================================ */
(function () {
  if (window.__aulosMusic) return;      // 防重复初始化
  window.__aulosMusic = true;

  const DESKTOP_PAGE = !!document.getElementById("messages");   // 主界面才挂播放器
  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);
  const toastFn = window.aulosToast || (msg => console.log("[music]", msg));

  const mstate = {
    queue: [],            // 当前播放队列 [{id,name,artist,album,duration,fee,pic,source}]
    qname: "",            // 队列来源名（「收藏」/「我的歌单: xx」/「搜索: xx」）
    index: -1,            // 当前歌在队列里的下标
    mode: "order",        // order | one | shuffle
    playing: false,
    failedStreak: 0,      // 连续跳过计数: 防"全队列不可播"死循环
    src: "netease",       // 搜索来源: netease | bili
    library: { favorites: [], playlists: [] },   // 本地曲库, 写操作后整体刷新
    mineView: null,       // 我的歌单 Tab: null=歌单列表; 数字=正在看的歌单 id
  };
  let audio = null;

  /* 曲库/队列项 id 是混合形态（网易云 int / B站 BV 号字符串）,
     所有「同一首」判断都用复合键 source:id, 防止 BV 号撞数字 id */
  const srcKey = s => (s.source || "netease") + ":" + String(s.id);

  const MKEY = "xc-music";
  const pref = (() => {
    try { return JSON.parse(localStorage.getItem(MKEY)) || {}; }
    catch { return {}; }
  })();
  function savePref() {
    try {
      localStorage.setItem(MKEY, JSON.stringify({
        mode: mstate.mode,
        src: mstate.src,   // 持久化音源: 重启不再重置, 桌宠点歌也按它读
        vol: audio ? Math.round(audio.volume * 100) : (pref.vol ?? 70),
        dock: !$("music-dock").hidden,
        queue: mstate.queue, qname: mstate.qname, index: mstate.index,
        webkitAudioOk: !!pref.webkitAudioOk,
        webkitAudioForce: !!pref.webkitAudioForce,
      }));
    } catch { /* 存不了就算了 */ }
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  }

  function escapeText(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function getAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = "auto";
    audio.volume = (pref.vol ?? 70) / 100;
    audio.addEventListener("ended", () => musicNext(true));
    audio.addEventListener("loadedmetadata", () => {
      /* 冷启动点条预选的落点: 元数据一到位就落位（15s 内有效） */
      if (pendingSeek.ratio == null) return;
      if (Date.now() - pendingSeek.at > 15000 || !isFinite(audio.duration)) {
        pendingSeek.ratio = null;
        return;
      }
      audio.currentTime = pendingSeek.ratio * audio.duration;
      pendingSeek.ratio = null;
      seekPaint(audio.currentTime);
    });
    audio.addEventListener("timeupdate", () => {
      if (seekState.active) return;   // 拖拽中: fill/thumb 由拖拽逻辑驱动, 别被 timeupdate 打回去
      seekPaint(audio.currentTime);
      const d = audioDur();
      $("music-time").textContent = fmtTime(audio.currentTime)
        + (d > 0 ? " / " + fmtTime(d) : "");
    });
    audio.addEventListener("play", () => { setPlayingUi(true); markPlayingRow(); });
    audio.addEventListener("pause", () => { setPlayingUi(false); markPlayingRow(); });
    return audio;
  }

  /* ---- 播放条 UI ---- */
  function setPlayingUi(on) {
    mstate.playing = on;
    document.querySelector("#music-toggle .ic-play").style.display = on ? "none" : "";
    document.querySelector("#music-toggle .ic-pause").style.display = on ? "" : "none";
    $("music-cover").classList.toggle("spin", on);
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = on ? "playing" : "paused";
    }
  }

  function curSong() { return mstate.queue[mstate.index] || null; }

  function refreshBar() {
    const s = curSong();
    const title = $("music-title");
    const wrap = $("music-title-wrap");
    const inner = $("music-title-inner");
    const clone = $("music-title-clone");
    title.textContent = s ? s.name : t("music.001");
    $("music-artist").textContent = s ? s.artist : "";
    clone.textContent = title.textContent;
    /* 标题自身超宽才滚动（marquee）: 不能用 wrap.scrollWidth —— 那会把
       克隆副本的宽度算进去, 等效阈值变成"标题超过一半就滚", 放得下的
       也转起来。停一帧等字体就绪再量宽。 */
    requestAnimationFrame(() => {
      const overflows = title.scrollWidth > wrap.clientWidth + 2;
      if (s) {
        const dist = title.scrollWidth + 40;   // 位移 = 一份标题 + 40px 间距
        inner.dataset.dur = Math.max(6, Math.round(dist / 60));
        inner.style.setProperty("--md-scroll-dur", (inner.dataset.dur || 10) + "s");
      }
      inner.classList.toggle("scroll", !!s && overflows);
    });
    if (s) {
      document.title = s.name + " - " + s.artist;   // 摸鱼: 标题栏只显示歌名
      if (s.pic) {
        if ("mediaSession" in navigator) {
          try {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: s.name, artist: s.artist, album: s.album,
              artwork: [{ src: s.pic, sizes: "300x300" }],
            });
          } catch { /* 无关紧要 */ }
        }
      }
    } else {
      document.title = "aulos";
    }
  }

  /* ---- 核心: 播放队列里的某一首 ---- */
  // Linux AppImage 的 WebKitGTK 会继承被污染的 GStreamer 环境 (APPDIR 旧版
  // libgstreamer 遮蔽系统库 + 插件扫描指向空目录), 媒体管线一创建就
  // WebProcess 假死拖垮整页 (Ubuntu 24.04 实测)。壳侧 (main.rs) 与服务侧
  // (server.py) 的环境清洗已剥掉污染, 但用户系统真缺插件时管线同样不可用
  // —— 两种情况都用「静音探测」兜底区分, 不再一刀切禁用:
  //   探测通过 → pref.webkitAudioOk 记住, 之后直接播;
  //   超时/失败 → 提示安装 gstreamer1.0-plugins-base/good/libav, 本次会话
  //   停用; Shift+点歌 = 强制播放 (已知环境正常时绕过探测的逃生口)。
  // 检测: 本应用在 Linux 的 WebView 必是 WebKitGTK (UA 无 WebKitGTK 字串,
  // 用 平台=Linux 且 UA 无 Chrome/Firefox/Edg 识别; 正常 Linux 浏览器与
  // Windows/mac 全部排除)。
  const IS_WEBKIT_GTK = navigator.platform.startsWith("Linux")
    && !/Chrome|Chromium|Firefox|Edg\//.test(navigator.userAgent);

  function silentWavUrl() {
    // 10ms 8bit 静音 WAV: 探测"能否创建并启动播放管线"
    const sr = 8000, n = 80;
    const buf = new Uint8Array(44 + n);
    const dv = new DataView(buf.buffer);
    const tag = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    tag(0, "RIFF"); dv.setUint32(4, 36 + n, true); tag(8, "WAVE");
    tag(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 8, true);
    dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    tag(36, "data"); dv.setUint32(40, n, true);
    buf.fill(128, 44);                       // 8bit 静音中点
    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  }

  let webkitAudioProbe = null;   // { at, ok, promise } — 失败进冷却, 到期允许重探
  const PROBE_RETRY_MS = 45000;  // 失败冷却 45s: 冷启动/瞬时故障的误判不该钉死整晚
  const PROBE_TIMEOUT_MS = 6000; // 首次管线创建含 GStreamer 冷初始化, 看门狗放宽到 6s

  function probeWebkitAudio() {
    if (webkitAudioProbe) {
      if (webkitAudioProbe.ok) return webkitAudioProbe.promise;   // 已确认可用
      if (Date.now() - webkitAudioProbe.at < PROBE_RETRY_MS) {    // 冷却期内沿用上次结论
        return webkitAudioProbe.promise;
      }
    }
    const record = { at: Date.now(), ok: false };
    const attempt = (async () => {
      const url = silentWavUrl();
      const a = new Audio(url);
      a.volume = 0;
      try {
        await Promise.race([
          a.play(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), PROBE_TIMEOUT_MS)),
        ]);
        pref.webkitAudioOk = true; savePref();
        return true;
      } catch (e) {
        // NotAllowedError = 自动播放策略拒绝 —— 管线建到策略检查这步, 说明是通的
        if (e && e.name === "NotAllowedError") {
          pref.webkitAudioOk = true; savePref();
          return true;
        }
        pref.webkitAudioOk = false; savePref();
        toastFn(t("music.002")
          + t("music.003"));
        return false;
      } finally {
        try { a.pause(); a.removeAttribute("src"); } catch { /* 已清理 */ }
        URL.revokeObjectURL(url);
      }
    })();
    webkitAudioProbe = record;
    attempt.then(ok => { record.ok = ok; });
    return attempt;
  }

  // 页面加载即后台预热探测: 别让用户第一次点歌去撞 GStreamer 冷初始化
  // (延迟 1.5s 避开页面初始化期的 toast/依赖未就绪)
  if (IS_WEBKIT_GTK) setTimeout(() => probeWebkitAudio(), 1500);

  async function playIndex(idx) {
    if (!mstate.queue.length) return;
    // WebKitGTK 且未确认管线可用 → 先探测 (Shift 强制 = 已知环境正常, 跳过探测直连)
    if (IS_WEBKIT_GTK && !pref.webkitAudioOk && !pref.webkitAudioForce) {
      setPlayingUi(false);
      if (await probeWebkitAudio() === false) return;
    }
    mstate.index = ((idx % mstate.queue.length) + mstate.queue.length) % mstate.queue.length;
    savePref();   // 记住听到哪首, 重启恢复
    const s = mstate.queue[mstate.index];
    refreshBar();
    markPlayingRow();
    const a = getAudio();
    try {
      if ((s.source || "netease") === "bili") return await playBili(a, s);
      const r = await fetch(`/api/music/url?id=${s.id}&br=128000`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data.url) {
        toastFn(t("music.004", { p0: s.name }));
        return skipFailed();
      }
      a.src = data.url;
      await a.play();
      mstate.failedStreak = 0;
    } catch (e) {
      if (e && e.name === "AbortError") return;   // 用户快速切歌: 旧请求作废
      toastFn(t("music.005") + (e && e.message || e));
      return skipFailed();
    }
  }

  /* B 站视频纯音频: 先拿本地代理 token, 再挂到 <audio> 出声。
     带 Range 请求支持断点续传（快进 seek 会发第二次 Range 请求,
     后端转发直链天然支持）。 */
  async function playBili(a, s) {
    const r = await fetch(`/api/bili/url?bvid=${encodeURIComponent(s.id)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data.url) {
      toastFn(t("music.006", { p0: s.name }));
      return skipFailed();
    }
    a.src = `/api/bili/stream?token=${encodeURIComponent(data.token)}`;
    await a.play();
    mstate.failedStreak = 0;
  }

  /* 当前歌拿不到直链/播放出错: 自动下一首, 连续失败超限就停 */
  function skipFailed() {
    mstate.failedStreak++;
    if (mstate.failedStreak > Math.min(mstate.queue.length, 10)) {
      mstate.failedStreak = 0;
      getAudio().pause();
      toastFn(t("music.007"));
      return;
    }
    musicNext(true);
  }

  function musicNext(auto) {
    if (!mstate.queue.length) return;
    if (mstate.mode === "one" && auto) {        // 单曲循环: 重头再放
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    let idx;
    if (mstate.mode === "shuffle") {
      idx = mstate.queue.length > 1 ? (Math.random() * mstate.queue.length | 0) : 0;
      if (idx === mstate.index && mstate.queue.length > 1) idx = (idx + 1) % mstate.queue.length;
    } else {
      idx = mstate.index + 1;
    }
    playIndex(idx);
  }
  function musicPrev() { playIndex(mstate.index - 1); }

  /* 播放键共用入口。刷新恢复队列后 audio 还没挂音源（src 为空）, 裸 play()
     是无声空拍（异常被吞, UI 也不动）——先走 playIndex 取 URL 挂源, 顺带
     刷新已过期的直链; 已挂源才原地续播/暂停。 */
  function togglePlay() {
    if (!curSong()) { openMusicPanel(); return; }   // 还没选歌: 引导去面板
    const a = getAudio();
    if (!a.paused) { a.pause(); return; }
    if (!a.src) { playIndex(mstate.index); return; }
    a.play().catch(() => {});
  }

  /* ---- 本地曲库 API（收藏 / 我的歌单）---- */
  async function libFetch(url, opts) {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
    return data;
  }

  async function refreshLibrary() {
    mstate.library = await libFetch("/api/music/library");
  }

  function isFav(s) {
    if (!s || typeof s === "number") return false;
    return mstate.library.favorites.some(x => srcKey(x) === srcKey(s));
  }

  async function toggleFav(s) {
    const key = srcKey(s);
    try {
      if (isFav(s)) {
        await libFetch(`/api/music/favorites/${encodeURIComponent(s.id)}?source=${s.source || "netease"}`,
                       { method: "DELETE" });
        toastFn(t("music.008", { p0: s.name }));
      } else {
        await libFetch("/api/music/favorites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ songs: [s] }),
        });
        toastFn(t("music.009", { p0: s.name }));
      }
      await refreshLibrary();
      refreshFavHearts();
      if (!$("music-panel").hidden) {
        const onTab = document.querySelector("#music-panel .mp-tabs > button.on");
        if (onTab && onTab.dataset.tab === "fav") renderFavTab();
      }
    } catch (e) {
      toastFn(t("music.010") + (e.message || e));
    }
  }

  /* 曲库变化后, 页面上所有行的心形跟着刷新（不动列表结构） */
  function refreshFavHearts() {
    $$("#music-panel .mp-song").forEach(row => {
      const btn = row.querySelector(".mp-s-fav");
      if (!btn) return;
      const key = (row.dataset.src || "netease") + ":" + row.dataset.songId;
      btn.classList.toggle("on", mstate.library.favorites.some(s => srcKey(s) === key));
    });
  }

  /* 把歌追加进当前播放列表（不打断正在放的歌, 也不动当前下标） */
  function appendQueue(songs, label) {
    const known = new Set(mstate.queue.map(srcKey));
    let n = 0;
    songs.forEach(s => {
      const k = srcKey(s);
      if (!known.has(k)) { mstate.queue.push(s); known.add(k); n++; }
    });
    savePref();
    if (!n) {
      toastFn(t("music.011", { p0: label }));
      return;
    }
    toastFn(songs.length === 1
      ? t("music.012", { p0: label })
      : t("music.013", { p0: label, p1: n }));
    if (!$("music-panel").hidden) {
      const onTab = document.querySelector("#music-panel .mp-tabs > button.on");
      if (onTab && onTab.dataset.tab === "queue") renderQueue();
    }
  }

  /* 浏览面（搜索结果）点歌: 已在队列就跳过去播, 否则插播到当前歌后面。
     队列是唯一的播放真相源 —— 搜索只浏览, 绝不整表替换队列
     （老行为把搜索结果整个灌进播放列表, 就是「点＋却加了一页」的根源）。 */
  function playFromBrowse(s) {
    const at = mstate.queue.findIndex(q => srcKey(q) === srcKey(s));
    if (at >= 0) { playIndex(at); return; }
    const insertAt = mstate.index >= 0 ? mstate.index + 1 : mstate.queue.length;
    mstate.queue.splice(insertAt, 0, s);
    savePref();
    playIndex(insertAt);
  }

  /* ---- 「添加到…」菜单: 行上的 ＋ 弹出, 可加入 播放列表 / 任意歌单 / 新歌单 ---- */
  function closeAddMenu() {
    const m = $("music-add-menu");
    if (m) m.remove();
    document.removeEventListener("mousedown", onAddMenuAway, true);
    document.removeEventListener("keydown", onAddMenuEsc, true);
  }
  function onAddMenuAway(e) {
    if (!e.target.closest || !e.target.closest("#music-add-menu")) closeAddMenu();
  }
  function onAddMenuEsc(e) { if (e.key === "Escape") closeAddMenu(); }

  async function addToPlaylist(pl, songs, label) {
    try {
      const r = await libFetch(`/api/music/playlists/${pl.id}/songs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songs }),
      });
      await refreshLibrary();
      toastFn(r.added
        ? t("music.014", { p0: label, p1: r.name, p2: r.added })
        : t("music.015", { p0: r.name }));
    } catch (e) {
      toastFn(t("music.016") + (e.message || e));
    }
  }

  function openAddMenu(anchor, songs, label) {
    if (!anchor || !anchor.isConnected) return;   // 按钮已不在 DOM（重渲染过）就不弹
    closeAddMenu();
    const items = [];
    if (!songs.every(s => mstate.queue.some(q => q.id === s.id))) {
      items.push({ text: t("music.017"), hint: t("music.018"),
        act: () => appendQueue(songs, label) });
    }
    (mstate.library.playlists || []).forEach(pl => {
      items.push({ text: pl.name, hint: pl.songs.length + t("music.019"),
        act: () => addToPlaylist(pl, songs, label) });
    });
    items.push({ text: t("music.020"), hint: "", act: async () => {
      const name = await promptDialog(t("music.021", { p0: label }), {
        title: t("music.022"), placeholder: t("music.023"), okText: t("music.024"),
      });
      if (!name) return;
      try {
        const pl = await libFetch("/api/music/playlists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, songs }),
        });
        await refreshLibrary();
        toastFn(t("music.025", { p0: pl.name, p1: pl.songs.length }));
      } catch (e) {
        toastFn(t("music.026") + (e.message || e));
      }
    }});

    const m = document.createElement("div");
    m.id = "music-add-menu";
    items.forEach(it => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = '<span class="mpam-name"></span><span class="mpam-hint"></span>';
      b.querySelector(".mpam-name").textContent = it.text;
      b.querySelector(".mpam-hint").textContent = it.hint;
      b.onclick = () => { closeAddMenu(); it.act(); };
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    let left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    let bottom = window.innerHeight - r.top + 6;      // 默认: 按钮上方
    if (r.top - mh - 12 < 0) {                        // 上方放不下 → 按钮下方
      bottom = Math.max(8, window.innerHeight - r.bottom - 6);
    }
    m.style.left = left + "px";
    m.style.bottom = bottom + "px";
    document.addEventListener("mousedown", onAddMenuAway, true);
    document.addEventListener("keydown", onAddMenuEsc, true);
  }

  /* ---- 歌曲行: ❤ 收藏 + ＋ 加入播放列表 ---- */
  function songRow(s, i, opts = {}) {
    const row = document.createElement("div");
    row.className = "mp-song";
    row.dataset.songId = s.id;
    row.dataset.src = s.source || "netease";
    const fav = mstate.library.favorites.some(x => srcKey(x) === srcKey(s));
    const delBtn = opts.deletable
      ? t("music.027")
      : "";
    row.innerHTML =
      '<span class="mp-s-eq"><i></i><i></i><i></i></span>' +
      `<span class="mp-s-idx">${i + 1}</span>` +
      '<span class="mp-s-main"><span class="mp-s-name"></span>' +
      '<span class="mp-s-artist"></span></span>' +
      (s.source === "bili" ? t("music.028")
         : (s.fee === 1 ? '<span class="mp-s-tag">VIP</span>' : "")) +
      `<span class="mp-s-dur">${fmtTime(s.duration)}</span>` +
      t("music.029") +
      t("music.030", { p0: fav ? " on" : "", p1: fav ? "currentColor" : "none" }) +
      delBtn;
    row.querySelector(".mp-s-name").textContent = s.name;
    row.querySelector(".mp-s-artist").textContent = s.artist;
    row.querySelector(".mp-s-fav").onclick = (ev) => {
      ev.stopPropagation();
      toggleFav(s);
    };
    row.querySelector(".mp-s-add").onclick = (ev) => {
      ev.stopPropagation();
      const btn = ev.currentTarget;   // currentTarget 只在派发期间有效, 异步前先抓下来
      refreshLibrary().catch(() => {}).then(() =>
        openAddMenu(btn, [s], t("music.031") + s.name + t("music.032")));
    };
    if (opts.deletable) {
      row.querySelector(".mp-s-del").onclick = (ev) => {
        ev.stopPropagation();
        opts.onDelete(s, i);
      };
    }
    return row;
  }

  /* 纯渲染列表。行点击/删除行为由 onPlay/onDelete 决定, 这里不碰队列
     （老版本在这里 replaceQueue 整表灌队列, 是「加一首变加一页」的根源）。 */
  function renderSongList(body, songs, { onPlay = null, deletable = false, onDelete = null } = {}) {
    if (!songs.length) {
      body.innerHTML = t("music.033");
      return;
    }
    body.innerHTML = "";
    songs.forEach((s, i) => {
      const row = songRow(s, i, {
        deletable,
        onDelete: onDelete || ((song) => {
          /* 默认删除行为: 从当前队列移除 */
          const idx = mstate.queue.findIndex(q => q.id === song.id);
          if (idx >= 0) removeQueueAt(idx);
        }),
      });
      row.onclick = () => (onPlay ? onPlay(s, i) : playFromBrowse(s));
      body.appendChild(row);
    });
    markPlayingRow();
  }

  async function doSearch() {
    const kw = $("music-search-input").value.trim();
    if (!kw) return;
    const body = $("music-search-results");
    body.innerHTML = t("music.034");
    try {
      const endpoint = mstate.src === "bili"
        ? `/api/bili/search?kw=${encodeURIComponent(kw)}&limit=30`
        : `/api/music/search?kw=${encodeURIComponent(kw)}`;
      const r = await fetch(endpoint);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const songs = mstate.src === "bili" ? (data.videos || []) : (data.songs || []);
      if (!songs.length) {
        body.innerHTML = t("music.035", { p0: escapeText(kw), p1: 
          mstate.src === "bili" ? "视频" : "歌曲" });
        return;
      }
      renderSongList(body, songs);   // 纯浏览: 点行插播, 不动队列
    } catch (e) {
      body.innerHTML = t("music.036", { p0: escapeText(e.message) });
    }
  }

  /* ---- 播放列表 Tab ---- */
  function renderQueue() {
    const body = document.querySelector('#music-panel [data-tab-body="queue"]');
    if (!mstate.queue.length) {
      body.innerHTML = t("music.037");
      return;
    }
    body.innerHTML =
      '<div class="mp-queue-head"><span></span><span class="mp-queue-ops">' +
      t("music.038") +
      t("music.039");
    body.querySelector("span").textContent
      = t("music.040", { p0: mstate.qname || "播放列表", p1: mstate.queue.length });
    body.querySelector("#music-queue-clear").onclick = () => {
      getAudio().pause();
      mstate.queue = [];
      mstate.index = -1;
      refreshBar();
      savePref();
      renderQueue();
    };
    body.querySelector("#music-queue-save").onclick = async () => {
      const name = await promptDialog(t("music.041"), {
        title: t("music.042"), value: mstate.qname || t("music.043"), okText: t("music.044"),
      });
      if (!name) return;   // 取消或空名
      try {
        const pl = await libFetch("/api/music/playlists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, songs: mstate.queue }),
        });
        await refreshLibrary();
        toastFn(t("music.045", { p0: pl.name, p1: pl.songs.length }));
      } catch (e) {
        toastFn(t("music.046") + (e.message || e));
      }
    };
    const list = document.createElement("div");
    mstate.queue.forEach((s, i) => {
      const row = songRow(s, i, {
        deletable: true,
        onDelete: () => removeQueueAt(i),
      });
      if (i === mstate.index) row.classList.add("playing");
      // Shift+点击 = 无视 WebKitGTK 守卫强制播放 (装好 gstreamer 后的逃生门),
      // 选择会记住, 之后普通点击也直连
      row.onclick = (ev) => {
        if (ev.shiftKey) { pref.webkitAudioForce = true; savePref(); }
        playIndex(i);
      };
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  function removeQueueAt(i) {
    mstate.queue.splice(i, 1);
    if (i < mstate.index) {
      mstate.index--;
    } else if (i === mstate.index) {
      mstate.index = Math.min(mstate.index, mstate.queue.length - 1);
      if (mstate.playing && mstate.index >= 0) {
        playIndex(mstate.index);
      } else {
        getAudio().pause();
        refreshBar();
      }
    }
    savePref();
    renderQueue();
  }

  /* ---- 收藏 Tab ---- */
  function renderFavTab() {
    const body = document.querySelector('#music-panel [data-tab-body="fav"]');
    const favs = mstate.library.favorites || [];
    if (!favs.length) {
      body.innerHTML = t("music.047");
      return;
    }
    body.innerHTML =
      '<div class="mp-queue-head"><span></span><span class="mp-queue-ops">' +
      t("music.048");
    body.querySelector("span").textContent = t("music.049", { p0: favs.length });
    body.querySelector("#music-fav-playall").onclick = () => {
      mstate.queue = favs.slice();
      mstate.qname = t("music.050");
      mstate.index = -1;
      savePref();
      playIndex(0);
    };
    const list = document.createElement("div");
    favs.forEach((s, i) => {
      const row = songRow(s, i, {
        deletable: true,
        onDelete: async (song) => {
          try {
            await libFetch(`/api/music/favorites/${encodeURIComponent(song.id)}?source=${song.source || "netease"}`,
                       { method: "DELETE" });
            await refreshLibrary();
            renderFavTab();
          } catch (e) {
            toastFn(t("music.051") + (e.message || e));
          }
        },
      });
      row.onclick = () => {
        mstate.queue = favs.slice();   // 整个收藏作为队列, 可上下切换
        mstate.qname = t("music.052");
        savePref();
        playIndex(i);
      };
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  /* ---- 我的歌单 Tab: null=列表视图, 数字=歌单详情视图 ---- */
  function renderMineTab() {
    const body = document.querySelector('#music-panel [data-tab-body="mine"]');
    if (mstate.mineView === null) { renderMineList(body); return; }

    const pl = (mstate.library.playlists || []).find(p => p.id === mstate.mineView);
    if (!pl) { mstate.mineView = null; renderMineList(body); return; }

    body.innerHTML =
      '<div class="mp-queue-head mp-pl-detail-head">' +
      t("music.053") +
      '<span class="mp-queue-ops">' +
      t("music.054") +
      t("music.055");
    body.querySelector("span").textContent = t("music.056", { p0: pl.name, p1: pl.songs.length });
    body.querySelector("#music-pl-back").onclick = () => {
      mstate.mineView = null;
      renderMineTab();
    };
    body.querySelector("#music-pl-append").onclick = () => {
      if (!pl.songs.length) { toastFn(t("music.057")); return; }
      appendQueue(pl.songs, t("music.058", { p0: pl.name }));
    };
    body.querySelector("#music-pl-del").onclick = async () => {
      if (!(await confirmDialog(t("music.059", { p0: pl.name }), { title: t("music.060"), okText: t("music.061"), danger: true }))) return;
      try {
        await libFetch(`/api/music/playlists/${pl.id}`, { method: "DELETE" });
        mstate.mineView = null;
        await refreshLibrary();
        toastFn(t("music.062", { p0: pl.name }));
        renderMineTab();
      } catch (e) {
        toastFn(t("music.063") + (e.message || e));
      }
    };
    if (!pl.songs.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = t("music.064");
      body.appendChild(empty);
      return;
    }
    const list = document.createElement("div");
    pl.songs.forEach((s, i) => {
      const row = songRow(s, i, {
        deletable: true,
        onDelete: async (song) => {
          try {
            await libFetch(`/api/music/playlists/${pl.id}/songs/${encodeURIComponent(song.id)}?source=${song.source || "netease"}`,
                       { method: "DELETE" });
            await refreshLibrary();
            renderMineTab();
          } catch (e) {
            toastFn(t("music.065") + (e.message || e));
          }
        },
      });
      row.onclick = () => {
        mstate.queue = pl.songs.slice();   // 整个歌单作为队列
        mstate.qname = t("music.066") + pl.name;
        savePref();
        playIndex(i);
      };
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  function renderMineList(body) {
    const pls = mstate.library.playlists || [];
    body.innerHTML =
      '<div class="mp-pl-new"><input id="music-pl-name" type="text" ' +
      t("music.067");
    const input = body.querySelector("#music-pl-name");
    input.addEventListener("keydown", async (ev) => {
      ev.stopPropagation();
      if (ev.key !== "Enter") return;
      const name = input.value.trim();
      if (!name) return;
      try {
        const pl = await libFetch("/api/music/playlists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        await refreshLibrary();
        toastFn(t("music.068", { p0: pl.name }));
        renderMineList(body);
      } catch (e) {
        toastFn(t("music.069") + (e.message || e));
      }
    });

    if (!pls.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = t("music.070");
      body.appendChild(empty);
      return;
    }
    const list = document.createElement("div");
    pls.forEach((pl) => {
      const row = document.createElement("div");
      row.className = "mp-pl";
      row.innerHTML =
        '<span class="mp-pl-name"></span>' +
        '<span class="mp-pl-meta"></span>' +
        '<span class="mp-queue-ops">' +
        t("music.071") +
        t("music.072") +
        t("music.073") +
        '</span>';
      row.querySelector(".mp-pl-name").textContent = pl.name;
      row.querySelector(".mp-pl-meta").textContent = pl.songs.length + t("music.074");
      row.onclick = () => {           // 点名称进详情
        mstate.mineView = pl.id;
        renderMineTab();
      };
      row.querySelector(".mp-pl-play").onclick = (ev) => {
        ev.stopPropagation();
        if (!pl.songs.length) { toastFn(t("music.075")); return; }
        mstate.queue = pl.songs.slice();
        mstate.qname = t("music.076") + pl.name;
        mstate.index = -1;
        savePref();
        playIndex(0);
      };
      row.querySelector(".mp-pl-rename").onclick = async (ev) => {
        ev.stopPropagation();
        const name = await promptDialog(t("music.077"), {
          title: t("music.078"), value: pl.name, okText: t("music.079"),
        });
        if (!name) return;
        try {
          await libFetch(`/api/music/playlists/${pl.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          await refreshLibrary();
          renderMineList(body);
        } catch (e) {
          toastFn(t("music.080") + (e.message || e));
        }
      };
      row.querySelector(".mp-pl-del").onclick = async (ev) => {
        ev.stopPropagation();
        if (!(await confirmDialog(t("music.081", { p0: pl.name }), { title: t("music.082"), okText: t("music.083"), danger: true }))) return;
        try {
          await libFetch(`/api/music/playlists/${pl.id}`, { method: "DELETE" });
          await refreshLibrary();
          toastFn(t("music.084", { p0: pl.name }));
          renderMineList(body);
        } catch (e) {
          toastFn(t("music.085") + (e.message || e));
        }
      };
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  function markPlayingRow() {
    const curId = curSong() ? String(curSong().id) : null;
    $$("#music-panel .mp-song").forEach(row => {
      const isCur = row.dataset.songId === curId;
      row.classList.toggle("playing", isCur);
      const idx = row.querySelector(".mp-s-idx");
      const eq = row.querySelector(".mp-s-eq");
      if (idx) idx.style.display = isCur ? "none" : "";
      if (eq) eq.style.display = isCur && mstate.playing ? "inline-flex" : "none";
    });
  }

  /* ---- 面板 / Tab ---- */
  function switchTab(key) {
    $$("#music-panel .mp-tabs > button[data-tab]").forEach(b => {
      b.classList.toggle("on", b.dataset.tab === key);
    });
    $$("#music-panel .mp-tab-body").forEach(b => {
      b.style.display = b.dataset.tabBody === key ? "" : "none";
    });
    if (key === "queue") renderQueue();
    if (key === "fav") renderFavTab();
    if (key === "mine") renderMineTab();
  }

  /* 面板锚在 dock 正上方（dock 收起时锚在侧栏底栏上方） */
  function anchorPanel() {
    const panel = $("music-panel");
    const dock = $("music-dock");
    const anchorEl = !dock.hidden ? dock : document.querySelector(".side-bottom");
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    panel.style.left = Math.round(r.left) + "px";
    panel.style.bottom = Math.round(window.innerHeight - r.top + 8) + "px";
  }

  async function openMusicPanel() {
    anchorPanel();
    $("music-panel").hidden = false;
    try { await refreshLibrary(); } catch { /* 离线也不挡着用搜索 */ }
    const onTab = document.querySelector("#music-panel .mp-tabs > button.on");
    if (onTab) switchTab(onTab.dataset.tab);   // 重渲染当前 Tab（收藏实心态等）
  }
  function closeMusicPanel() { $("music-panel").hidden = true; }

  function showDock(show) {
    $("music-dock").hidden = !show;
    if (!show) closeMusicPanel();
    savePref();
  }

  /* ---- 事件绑定（元素都在主界面 index.html 里）---- */
  if (!DESKTOP_PAGE) return;   // loading 页等无播放器结构: 不绑定

  /* 上次亮着播放条 → 这次直接恢复 */
  if (pref.dock) $("music-dock").hidden = false;
  /* 上次的搜索音源也回来（桌宠点歌桥按它选搜索端点） */
  if (pref.src === "bili" || pref.src === "netease") mstate.src = pref.src;
  /* 上次的队列/当前歌恢复回来（收藏和歌单在服务端, 不走这里） */
  if (Array.isArray(pref.queue) && pref.queue.length) {
    mstate.queue = pref.queue;
    mstate.qname = String(pref.qname || "");
    mstate.index = Number.isInteger(pref.index) ? pref.index : -1;
    if (mstate.index >= mstate.queue.length) mstate.index = -1;
    refreshBar();
  }
  /* 预拉曲库: ❤ 实心态和收藏 Tab 不等第一次开面板 */
  refreshLibrary().catch(() => {});

  $("btn-music").onclick = () => {
    // 二元开关: 有任何弹窗/播放条开着 → 一键全关; 全关 → 亮出播放条。
    // 旧的三态循环(面板只关自己、播放条永远留着)回不到干净状态。
    // showDock(false) 顺带关面板 + savePref, 重启后不再自动恢复。
    const allClosed = $("music-dock").hidden && $("music-panel").hidden;
    showDock(allClosed);
  };
  $("music-hide").onclick = () => showDock(false);
  $("music-toggle").onclick = togglePlay;
  $("music-next").onclick = () => musicNext(false);
  $("music-prev").onclick = musicPrev;
  $("music-list-btn").onclick = () => {
    if ($("music-panel").hidden) openMusicPanel();
    switchTab("queue");
  };
  $("music-close").onclick = closeMusicPanel;
  $("music-mode-btn").onclick = () => {
    mstate.mode = mstate.mode === "order" ? "one"
      : mstate.mode === "one" ? "shuffle" : "order";
    applyModeIcon();
    savePref();
    toastFn({ order: t("music.086"), one: t("music.087"), shuffle: t("music.088") }[mstate.mode]);
  };
  $("music-vol").value = pref.vol ?? 70;
  $("music-vol").oninput = (ev) => {
    getAudio().volume = ev.target.value / 100;
    savePref();
  };
  $$("#music-panel .mp-tabs > button[data-tab]").forEach(b => {
    b.onclick = () => switchTab(b.dataset.tab);
  });
  $("music-search-input").addEventListener("keydown", ev => {
    ev.stopPropagation();
    if (ev.key === "Enter") doSearch();
  });
  /* 叉号可见性跟着内容走; 清空 = 输入框归零 + 结果区回占位提示 */
  const syncMusicClear = () => {
    $("music-search-input").closest(".mp-input-wrap")
      .classList.toggle("has-value", !!$("music-search-input").value);
  };
  $("music-search-input").addEventListener("input", syncMusicClear);
  $("music-search-clear").onclick = () => {
    const input = $("music-search-input");
    if (!input.value) return;
    input.value = "";
    syncMusicClear();
    $("music-search-results").innerHTML =
      t("music.089", { p0: mstate.src === "bili" ? "B站视频只取音轨, 画面不进电台" : "搜歌名 / 歌手" });
    input.focus();
  };
  /* 搜索来源切换: 网易云 / B站。切来源时清空结果, 换 placeholder */
  $$("#music-src-btns > button").forEach(b => {
    b.onclick = () => {
      $$("#music-src-btns > button").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      mstate.src = b.dataset.src;
      $("music-src-btns").dataset.src = mstate.src;   // 驱动滑块位
      savePref();                                     // 音源持久化(桌宠点歌也读)
      const input = $("music-search-input");
      input.placeholder = mstate.src === "bili"
        ? t("music.090")
        : t("music.091");
      $("music-search-results").innerHTML =
        t("music.092", { p0: mstate.src === "bili" ? "B站视频只取音轨, 画面不进电台" : "搜歌名 / 歌手" });
    };
  });
  /* ---- 进度条: 拖拽 + 点击 + 键盘 ----
     旧实现只有一个 onclick, 轨道又只有 3px 高 —— 点一下 = 跳一下, 没法拖,
     手感极差。现在换成 Pointer 事件完整拖拽: 按下即进入 scrub 状态, fill/
     thumb/时间跟随指针, 松手才真正 seek（拖拽期间 timeupdate 不回写 UI）。 */
  const seekState = { active: false, wasPlaying: false, wasPausedByDrag: false, ratio: null };
  /* 冷启动点进度条: audio 还没挂源时没有时长, 先把落点比例记下,
     挂源起播（loadedmetadata）后落到该位置。15s 内有效, 防止残留串歌。 */
  const pendingSeek = { ratio: null, at: 0 };
  const NOMINAL_DUR = 240;   // 无时长时的名义时长(秒): 只用于画拖拽预览/气泡的近似
  const seekEl = $("music-seek");
  const seekFill = $("music-progress-fill");
  const seekThumb = $("music-progress-thumb");
  const seekTip = $("music-progress-tip");

  /* 时长兜底: 有的代理流 duration=Infinity（缺 Content-Length 时 Chromium 的
     行为）, 但 seekable 仍有界 —— seekable.end 即总时长。不兜底的话进度条
     整个锁死（拖不动/画不了）。两个都拿不到才返回 0（真不可 seek）。 */
  function audioDur() {
    if (!audio) return 0;
    if (isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    try {
      const s = audio.seekable;
      if (s && s.length && isFinite(s.end(s.length - 1))) return s.end(s.length - 1);
    } catch { /* 元数据未就绪 */ }
    return 0;
  }

  function seekPaint(t) {
    const d = audioDur();
    const pct = d > 0 ? Math.min(100, Math.max(0, t / d * 100)) : 0;
    seekFill.style.width = pct + "%";
    seekThumb.style.left = pct + "%";
    seekEl.setAttribute("aria-valuenow", Math.round(pct));
    if (!seekState.active) {
      seekEl.setAttribute("aria-valuetext", fmtTime(t) + " / " + fmtTime(d));
    }
  }

  /* 拖拽期间暂停播放（不然 audio 一边走、指针一边拖, 松手前后打架）,
     记住之前是播是停, 松手 seek 后恢复。所有 audio 操作都套 .catch 防闹。 */
  function seekPauseForDrag() {
    const a = getAudio();
    seekState.wasPlaying = a && !a.paused;
    if (seekState.wasPlaying) {
      seekState.wasPausedByDrag = true;
      a.pause();
    }
  }
  function seekResumeAfterDrop() {
    if (!seekState.wasPausedByDrag) return;
    seekState.wasPausedByDrag = false;
    const a = getAudio();
    if (a.src) a.play().catch(() => {});
  }

  function seekClientX(t) {
    const d = audioDur();
    if (!audio || d <= 0) return;
    const rect = seekEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (t - rect.left) / rect.width));
    seekState.scrub = ratio * d;
    seekPaint(seekState.scrub);
    seekTip.textContent = fmtTime(seekState.scrub);
    seekEl.setAttribute("aria-valuetext", fmtTime(seekState.scrub) + " / " + fmtTime(d));
    $("music-time").textContent = fmtTime(seekState.scrub) + " / " + fmtTime(d);
  }

  function seekStart(e) {
    if (!audio || audioDur() <= 0) {
      /* 冷启动（还没播过歌）: 没时长不 seek, 但点击不能没反应 ——
         队列有歌就记下落点比例, 起播后落位; 空队列引导去选歌面板。 */
      e.preventDefault();
      if (!mstate.queue.length) { openMusicPanel(); return; }
      const rect = seekEl.getBoundingClientRect();
      pendingSeek.ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      pendingSeek.at = Date.now();
      const s = curSong();
      if (s) seekPaintPreview(pendingSeek.ratio, s);
      playIndex(mstate.index);
      return;
    }
    e.preventDefault();   // 别让拖拽变成文本选择/焦点迁移
    seekState.active = true;
    seekEl.classList.add("dragging");
    try { seekEl.setPointerCapture(e.pointerId); } catch { /* 合成事件/无效指针: 忽略 */ }
    seekPauseForDrag();
    seekClientX(e.clientX);
  }
  function seekMove(e) {
    if (seekState.active) { seekClientX(e.clientX); return; }
    // 纯悬停: 气泡预览落点时间
    const d = audioDur();
    const rect = seekEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (!rect.width) return;
    // 冷启动悬停也有反馈: 按名义时长估一个时间（真挂源后会纠正）
    if (!audio || d <= 0) {
      seekTip.style.left = (ratio * 100) + "%";
      seekTip.textContent = "~" + fmtTime(ratio * NOMINAL_DUR);
      seekTip.classList.add("show");
      return;
    }
    seekTip.style.left = (ratio * 100) + "%";
    seekTip.textContent = fmtTime(ratio * d);
    seekTip.classList.add("show");
  }
  function seekDrop(e) {
    if (!seekState.active) return;
    seekState.active = false;
    seekEl.classList.remove("dragging");
    const d = audioDur();
    const rect = seekEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const t = ratio * d;
    try { audio.currentTime = t; } catch { /* 元数据未就绪等, 忽略 */ }
    seekPaint(t);
    seekResumeAfterDrop();
  }
  /* 无时长时的预览绘制: 冷启动点进度条立刻给视觉反馈, 别让条子纹丝不动 */
  function seekPaintPreview(ratio) {
    seekFill.style.width = (ratio * 100) + "%";
    seekThumb.style.left = (ratio * 100) + "%";
    seekEl.setAttribute("aria-valuenow", Math.round(ratio * 100));
    $("music-time").textContent = "~" + fmtTime(ratio * NOMINAL_DUR);
  }

  seekEl.addEventListener("pointerdown", seekStart);
  seekEl.addEventListener("pointermove", seekMove);
  seekEl.addEventListener("pointerup", seekDrop);
  seekEl.addEventListener("pointercancel", (e) => {
    if (!seekState.active) return;
    seekState.active = false;
    seekEl.classList.remove("dragging");
    seekResumeAfterDrop();          // 没动过=没暂停过; 动过就恢复播
  });
  seekEl.addEventListener("pointerleave", () => seekTip.classList.remove("show"));
  // 拖到窗口外松手: 指针捕获保证 pointerup 仍派发给 seekEl, 兜底清状态
  window.addEventListener("blur", () => {
    if (!seekState.active) return;
    seekState.active = false;
    seekEl.classList.remove("dragging");
    seekResumeAfterDrop();
  });
  // 键盘可调（role=slider）: 左右 ±5s, Home/End 跳首尾
  seekEl.addEventListener("keydown", (e) => {
    const d = audioDur();
    if (!audio || d <= 0) return;
    const step = 5;
    let t = audio.currentTime;
    if (e.key === "ArrowLeft") t -= step;
    else if (e.key === "ArrowRight") t += step;
    else if (e.key === "Home") t = 0;
    else if (e.key === "End") t = d - 0.25;
    else return;
    e.preventDefault();
    audio.currentTime = Math.min(d - 0.25, Math.max(0, t));
    seekPaint(audio.currentTime);
  });
  /* 窗口缩放时面板跟着 dock 重新锚定; 标题是否超宽也随宽度重判 */
  window.addEventListener("resize", () => {
    if (!$("music-panel").hidden) anchorPanel();
    refreshBar();
  });
  /* 点面板外收起（播放条按钮除外）;
     添加菜单(#music-add-menu)挂在 body 上、不在 panel 内, 点它不算"面板外",
     否则一点菜单按钮/菜单项面板就整个收起 —— 搜索页跟着消失。 */
  document.addEventListener("mousedown", (ev) => {
    if ($("music-panel").hidden) return;
    const panel = $("music-panel");
    const trigger = $("btn-music");
    const dock = $("music-dock");
    const menu = $("music-add-menu");
    if (!panel.contains(ev.target)
        && !(trigger && trigger.contains(ev.target))
        && !(dock && dock.contains(ev.target))
        && !(menu && menu.contains(ev.target))) {
      closeMusicPanel();
    }
  });

  /* mediaSession 硬件键（耳机切歌等） */
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.setActionHandler("play", () => {
        if (!curSong()) return;
        const a = getAudio();
        if (!a.src) { playIndex(mstate.index); return; }   // 刷新后首播: 先挂源
        a.play().catch(() => {});
      });
      navigator.mediaSession.setActionHandler("pause", () => getAudio().pause());
      navigator.mediaSession.setActionHandler("previoustrack", musicPrev);
      navigator.mediaSession.setActionHandler("nexttrack", () => musicNext(false));
    } catch { /* 部分平台不支持 */ }
  }

  applyModeIcon();

  function applyModeIcon() {
    const btn = $("music-mode-btn");
    btn.querySelector(".ic-order").style.display = mstate.mode === "order" ? "" : "none";
    btn.querySelector(".ic-one").style.display = mstate.mode === "one" ? "" : "none";
    btn.querySelector(".ic-shuffle").style.display = mstate.mode === "shuffle" ? "" : "none";
  }

  /* ---- 聊天点播入口 ----
   * app.js 收到 music_play 工具结果时转交 {song, queue, qname}:
   * 整队替换当前队列（点播是新意图, 不与旧队列混排）, 直接开播。
   * 摸鱼原则: 不自动弹播放条/面板 —— 播放条收着就继续收着, 照样出声;
   * 想看队列再点侧栏 ♫。面板若已开着, 顺手刷新播放列表 Tab。 */
  window.aulosMusicPlay = function (cmd) {
    if (!DESKTOP_PAGE) return false;
    const songs = (cmd && Array.isArray(cmd.queue) ? cmd.queue : [])
      .filter(s => s && s.name && String(s.id));
    if (!songs.length) return false;
    const wantKey = srcKey(cmd.song);              // 「source:id」复合键
    let at = songs.findIndex(s => srcKey(s) === wantKey);
    if (at < 0) at = 0;
    mstate.queue = songs;
    mstate.qname = typeof cmd.qname === "string" && cmd.qname ? cmd.qname : t("music.093");
    mstate.failedStreak = 0;
    if (!$("music-panel").hidden) {
      const onTab = document.querySelector("#music-panel .mp-tabs > button.on");
      if (onTab && onTab.dataset.tab === "queue") renderQueue();
    }
    playIndex(at);           // 内部 savePref + 刷条 + 拉直链播放
    return true;
  };

  /* ---- 桌宠点击开关播放 ----
   * 暂停/续播当前歌(续播含刷新后首播的挂源路径)。返回切换后的
   * {title, artist, playing} 供桌宠气泡回显; 队列是空的返回 null——
   * 此时 togglePlay 已顺带打开选歌面板引导。 */
  window.aulosMusicToggle = function () {
    if (!DESKTOP_PAGE) return null;
    togglePlay();
    const s = curSong();
    if (!s) return null;
    return { title: s.name, artist: s.artist, playing: !getAudio().paused };
  };
})();
