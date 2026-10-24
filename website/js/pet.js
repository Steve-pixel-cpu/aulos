/* pet.js - Feibi desktop pet for the aulos promo site.
   Sprite rows follow the Codex contract used by aulos static/pet.js. */
(function () {
  'use strict';

  var pet = document.getElementById('feibi');
  if (!pet) { return; }

  var sprEl = pet.querySelector('.fb-sprite');
  var bubble = pet.querySelector('.fb-bubble');

  /* cell 192x208 at 50% => 96x104; sheet 1536 wide => 768 css px, 8 cols */
  var CELL_W = 144;
  var CELL_H = 156;
  var COLS = 8;
  var REDUCED = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ROWS_SPEC (subset): row index + per-frame ms */
  var ROWS = {
    idle: { row: 0, ms: [280, 110, 110, 140, 140, 320] },
    run: { row: 1, ms: [120, 120, 120, 120, 120, 120, 120, 220] },
    wave: { row: 3, ms: [140, 140, 140, 280], once: true },
    jump: { row: 4, ms: [140, 140, 140, 140, 280], once: true }
  };

  var QUIPS = {
    zh: [
      '摸鱼的时辰，也是圣洁的时辰哦',
      '嘘…菲比在偷读英雄传说的下一章',
      '这波如圣咏般流畅',
      '同一仪式反复吟唱，亦是修行哦',
      '才、才没有偷懒，这是冥想！'
    ],
    en: [
      'Idle hours are holy hours, okay?',
      'Shh... Feibi is reading the next chapter',
      'Smooth as a hymn',
      'Repeating the ritual is also training',
      'Not slacking! This is meditation!'
    ]
  };

  function lang() {
    return document.documentElement.getAttribute('lang') === 'en' ? 'en' : 'zh';
  }

  var st = null;
  var rafId = 0;
  var lastFrameKey = '';

  function showFrame(row, col) {
    var key = row + ':' + col;
    if (key === lastFrameKey) { return; }
    lastFrameKey = key;
    sprEl.style.backgroundPosition =
      '-' + (col * CELL_W) + 'px -' + (row * CELL_H) + 'px';
  }

  function stop() {
    st = null;
    cancelAnimationFrame(rafId);
  }

  function play(name) {
    if (REDUCED) {
      showFrame(ROWS.idle.row, 0);
      return;
    }
    var spec = ROWS[name] || ROWS.idle;
    stop();
    st = { name: name };
    var startTime = 0;
    var idx = 0;
    var total = 0;
    for (var k = 0; k < spec.ms.length; k++) { total += spec.ms[k]; }
    (function tick(ts) {
      if (!st || st.name !== name) { return; }
      if (!startTime) { startTime = ts; }
      var t = (ts - startTime) % total;
      var acc = 0;
      var frame = 0;
      for (var k2 = 0; k2 < spec.ms.length; k2++) {
        acc += spec.ms[k2];
        if (t < acc) { frame = k2; break; }
        frame = spec.ms.length - 1;
      }
      showFrame(spec.row, frame);
      if (spec.once && ts - startTime >= total) {
        st = null;
        rafId = requestAnimationFrame(function (ts2) { play('idle'); });
        return;
      }
      rafId = requestAnimationFrame(tick);
    }(0));
  }

  /* -------- bubble -------- */
  var bubbleTimer = 0;
  function quip(text) {
    bubble.textContent = text;
    bubble.classList.add('on');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () {
      bubble.classList.remove('on');
    }, 3200);
  }
  function randomQuip() {
    var list = QUIPS[lang()];
    quip(list[Math.floor(Math.random() * list.length)]);
  }

  /* -------- drag -------- */
  var dragging = false;
  var offX = 0;
  var offY = 0;
  var lastFlip = 0;

  pet.addEventListener('pointerdown', function (e) {
    dragging = true;
    offX = e.clientX - pet.offsetLeft;
    offY = e.clientY - pet.offsetTop;
    pet.setPointerCapture(e.pointerId);
    play('run');
    e.preventDefault();
  });
  pet.addEventListener('pointermove', function (e) {
    if (!dragging) { return; }
    pet.style.left = (e.clientX - offX) + 'px';
    pet.style.top = (e.clientY - offY) + 'px';
    pet.style.right = 'auto';
    pet.style.bottom = 'auto';
    var now = Date.now();
    if (now - lastFlip > 500) {
      lastFlip = now;
      play('run');
    }
  });
  pet.addEventListener('pointerup', function () {
    if (!dragging) { return; }
    dragging = false;
    play('jump');
    if (Math.random() < 0.6) { randomQuip(); }
  });

  /* double-click: launch Aulos Dig (the only entry into the game).
     Double-click fires two pointerdown/up pairs — the second drag
     never starts (no move between), so only the extra jump plays. */
  pet.addEventListener('dblclick', function () {
    if (window.AulosDig) { window.AulosDig.toggle(); }
  });

  /* -------- idle chatter -------- */
  function scheduleChatter() {
    var wait = 14000 + Math.random() * 18000;
    setTimeout(function () {
      if (!dragging) {
        randomQuip();
        play('wave');
      }
      scheduleChatter();
    }, wait);
  }

  /* -------- init -------- */
  sprEl.style.backgroundImage = 'url("assets/feibi/spritesheet.webp")';

  var sprImg = new Image();
  sprImg.onload = function () {
    play('idle');
    setTimeout(function () {
      quip(lang() === 'en'
        ? 'Feibi, reporting for duty!'
        : '菲比，应约而来');
      play('wave');
    }, 900);
    scheduleChatter();
  };
  sprImg.onerror = function () {
    pet.style.display = 'none';
  };
  sprImg.src = 'assets/feibi/spritesheet.webp';
})();
