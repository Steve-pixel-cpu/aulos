/* game2.js — "Aulos Dig" on Phaser 3.
   Replaces the hand-rolled 2D canvas renderer whose lighting/camera/
   collision layers kept regressing. What survives from the old game:
     - js/worldgen.js            (terraria-style generator, untouched)
     - assets/mc tilesheet       (CC0, build_tilesheet.py)
     - the feibi spritesheet     (character)
     - dig/place/hotbar game rules (hardness table, inventory counts)
   Everything else (rendering, lighting, camera, physics, input) is now
   Phaser. See docs/.../terraria-like-sandbox-design.md. */
(function () {
  'use strict';
  window.addEventListener('error', function (e) {
    console.error('[dig] error at', e.filename, e.lineno, e.colno, e.message);
  });

  var win = document.getElementById('demoWindow');
  if (!win) { return; }

  var pill = win.querySelector('.demo-tb-pill');
  var fsBtn = document.getElementById('demoFs');
  var chat = win.querySelector('.demo-chat');
  var input = win.querySelector('.demo-input');
  var titleEl = win.querySelector('.demo-tb-title');

  var TILE = 32;                       /* on-screen tile size (16px source x2) */
  var WORLD_W = 512, WORLD_H = 256;
  /* average surface line (world px), set by create() from worldgen data */
  var PLAYER_SURFACE_Y = 96 * 32;
  var MAX_HP = 3;

  var game = null;                     /* Phaser.Game */
  var scene = null;

  var world = null;                    /* worldgen result */
  var FALL_FRAME_IDX = 11;   /* sprite sheet frame used as the airborne pose (run-row mid-stride) */
  var META = null, TILEMETA = {}, ATLAS_KEY = 'mc';
  var stats = { mined: 0, kills: 0, chests: 0, deaths: 0 };
  var inventory = [];
  var hotbarSel = 0;
  var over = false, flagHit = false;
  var crystalsGot = 0, CRYSTALS_NEED = 3;   /* goal-chain fuel */
  /* NG+ (二周目): each win raises the stakes for the NEXT world.
     Difficulty knobs live in one table so tuning stays single-point. */
  var loopLevel = 0;                         /* wins so far this session */
  var runStartT = 0;                         /* for the win-screen timer */
  var DIFF = [
    { need: 3, bugCap: 10, torchLife: 150000, label: '第一夜' },
    { need: 4, bugCap: 13, torchLife: 120000, label: '第二夜' },
    { need: 5, bugCap: 16, torchLife: 100000, label: '第三夜' },
    { need: 6, bugCap: 20, torchLife: 80000,  label: '深 渊' }
  ];
  function diff() { return DIFF[Math.min(loopLevel, DIFF.length - 1)]; }
  /* TORCH FUEL: placed torches burn TORCH_LIFE ms then gutter out.
     Worldgen torches (chest rooms) are eternal - no registry entry. */
  var torchLife = {};                 /* tileIndex -> expiry time (ms) */
  var TORCH_LIFE = 150000;            /* 2.5 minutes per player torch */
  var openedChests = {};

  /* load atlas metadata (inline global first — file:// safe) */
  function useMeta(j) {
    META = j;
    for (var i = 0; i < j.tiles.length; i++) { TILEMETA[j.tiles[i].id] = j.tiles[i]; }
  }
  if (window.__TILES_META__) { useMeta(window.__TILES_META__); }
  else {
    fetch('assets/mc/tiles.json').then(function (r) { return r.json(); })
      .then(useMeta)
      .catch(function (e) { console.error('tilesheet meta missing', e); });
  }

  function giveItem(id, n) {
    for (var i = 0; i < inventory.length; i++) {
      if (inventory[i].id === id) { inventory[i].n += n; return; }
    }
    if (inventory.length < 9) { inventory.push({ id: id, n: n }); }
  }
  function takeItem(id, n) {
    for (var i = 0; i < inventory.length; i++) {
      if (inventory[i].id === id) {
        inventory[i].n -= n;
        if (inventory[i].n <= 0) {
          inventory.splice(i, 1);
          hotbarSel = Math.max(0, Math.min(hotbarSel, inventory.length - 1));
        }
        return true;
      }
    }
    return false;
  }

  /* ---- Phaser scene ------------------------------------------------ */
  function MainScene() {
    Phaser.Scene.call(this, { key: 'main' });
  }
  MainScene.prototype = Object.create(Phaser.Scene.prototype);
  MainScene.prototype.constructor = MainScene;

  MainScene.prototype.preload = function () {
    /* build a tiny per-id texture strip so Phaser can draw arbitrary
       ids from our atlas without a runtime spritesheet parser */
    this.load.spritesheet('phoebe', 'assets/feibi/spritesheet.webp',
      { frameWidth: 192, frameHeight: 208 });
    this.load.image('flag', 'assets/scenery/flag0.png?v=s1');
    this.load.image('bug', 'assets/scenery/bug0.png?v=s1');
    this.load.image('bug1', 'assets/scenery/bug1.png?v=s1');
    this.load.image('bat', 'assets/scenery/bat0.png?v=s1');
    this.load.image('bat1', 'assets/scenery/bat1.png?v=s1');
    /* slime: bouncy cave crawler (Kenney CC0, was sitting unused) */
    this.load.image('slime', 'assets/scenery/slime0.png?v=s1');
    this.load.image('slime1', 'assets/scenery/slime1.png?v=s1');
    /* winged bug: flies in short hops, ground-bound unlike the bat */
    this.load.image('bugW', 'assets/scenery/bugW0.png?v=s1');
    this.load.image('bugW1', 'assets/scenery/bugW1.png?v=s1');
    /* fire bat: deep-lava-zone variant, tinted at spawn */
    this.load.image('batF', 'assets/scenery/batF0.png?v=s1');
    this.load.image('batF1', 'assets/scenery/batF1.png?v=s1');
    /* ---- Cthulhu bestiary (Tiny Creatures pack, Clint Bellanger CC0,
       opengameart.org/content/tiny-creatures). Deeper = more eldritch.
       Each has a 2-frame idle wobble, same texture-swap pattern.
       ASSET_REV: shared fingerprint in every sprite URL so replacing a
       texture file auto-invalidates the browser cache (same trick as
       the tiles.png size fingerprint). */
    var ASSET_REV = 't1';
    this.load.image('eyelet', 'assets/tiny/eyelet0.png?v=' + ASSET_REV);   /* small floating eye: shallow caves */
    this.load.image('eyelet1', 'assets/tiny/eyelet1.png?v=' + ASSET_REV);
    this.load.image('arachni', 'assets/tiny/arachni0.png?v=' + ASSET_REV); /* cave spider */
    this.load.image('arachni1', 'assets/tiny/arachni1.png?v=' + ASSET_REV);
    this.load.image('cube', 'assets/tiny/cube0.png?v=' + ASSET_REV);       /* gelatinous cube: mid depth */
    this.load.image('cube1', 'assets/tiny/cube1.png?v=' + ASSET_REV);
    this.load.image('krtentacle', 'assets/tiny/krtentacle0.png?v=' + ASSET_REV); /* severed kraken tentacle */
    this.load.image('krtentacle1', 'assets/tiny/krtentacle1.png?v=' + ASSET_REV);
    this.load.image('eye', 'assets/tiny/eye0.png?v=' + ASSET_REV);         /* disembodied eye: deep */
    this.load.image('eye1', 'assets/tiny/eye1.png?v=' + ASSET_REV);
    this.load.image('wraith', 'assets/tiny/wraith0.png?v=' + ASSET_REV);   /* wraith: deep, phases */
    this.load.image('wraith1', 'assets/tiny/wraith1.png?v=' + ASSET_REV);
    this.load.image('kraken', 'assets/tiny/kraken0.png?v=' + ASSET_REV);   /* kraken: lava-depth apex */
    this.load.image('kraken1', 'assets/tiny/kraken1.png?v=' + ASSET_REV);
    /* FLYING SHOOTERS: willowisp (cave tier) + flameskull (lava tier).
       Both keep distance and spit slow projectiles at the player —
       they make torch-lit caves feel hunted, not just dark. */
    this.load.image('spitter', 'assets/tiny/willowisp0.png?v=' + ASSET_REV);
    this.load.image('spitter1', 'assets/tiny/willowisp1.png?v=' + ASSET_REV);
    this.load.image('spitterF', 'assets/tiny/flameskull0.png?v=' + ASSET_REV);
    this.load.image('spitterF1', 'assets/tiny/flameskull1.png?v=' + ASSET_REV);
    /* THE BOSS: 64px kraken-lord composite (head 2.5x + central eye +
       6 radial tentacles), procedurally assembled from the same CC0
       parts. Guards the altar when the player arrives with crystals. */
    this.load.image('boss', 'assets/tiny/boss0.png?v=t2');
    this.load.image('boss1', 'assets/tiny/boss1.png?v=t2');
    /* NEW CREATURES — same CC0 pack, re-extracted from the transparent
       packed tilemap (single-tile exports had opaque black backgrounds
       baked in — that's why everything looked like squares). */
    this.load.image('willowisp', 'assets/tiny/willowisp0.png?v=t2');  /* flame w/ face */
    this.load.image('willowisp1', 'assets/tiny/willowisp1.png?v=t2');
    this.load.image('flameskull', 'assets/tiny/flameskull0.png?v=t2'); /* burning skull */
    this.load.image('flameskull1', 'assets/tiny/flameskull1.png?v=t2');
    this.load.image('maneater', 'assets/tiny/maneater0.png?v=t2');     /* ambush plant */
    this.load.image('maneater1', 'assets/tiny/maneater1.png?v=t2');
    this.load.image('purpleworm', 'assets/tiny/purpleworm0.png?v=t2'); /* burrower */
    this.load.image('purpleworm1', 'assets/tiny/purpleworm1.png?v=t2');
    this.load.image('naga', 'assets/tiny/naga0.png?v=t2');             /* serpent elite */
    this.load.image('naga1', 'assets/tiny/naga1.png?v=t2');
    this.load.image('dragonkin', 'assets/tiny/dragonkin0.png?v=t2');   /* lava bruiser */
    this.load.image('dragonkin1', 'assets/tiny/dragonkin1.png?v=t2');
    this.load.image('demon', 'assets/tiny/demon0.png?v=t2');           /* nightmare */
    this.load.image('demon1', 'assets/tiny/demon1.png?v=t2');
    this.load.image('banshee', 'assets/tiny/banshee0.png?v=t2');       /* wailing ghost */
    this.load.image('banshee1', 'assets/tiny/banshee1.png?v=t2');
    this.load.image('goul', 'assets/tiny/goul0.png?v=t2');             /* hunched ghoul */
    this.load.image('goul1', 'assets/tiny/goul1.png?v=t2');
    this.load.image('mummy', 'assets/tiny/mummy0.png?v=t2');           /* tomb shuffler */
    this.load.image('mummy1', 'assets/tiny/mummy1.png?v=t2');
    this.load.image('cockatrice', 'assets/tiny/cockatrice0.png?v=t2'); /* weird terror */
    this.load.image('cockatrice1', 'assets/tiny/cockatrice1.png?v=t2');
    this.load.image('manticore', 'assets/tiny/manticore0.png?v=t2');   /* winged lion */
    this.load.image('manticore1', 'assets/tiny/manticore1.png?v=t2');
    this.load.image('wight', 'assets/tiny/wight0.png?v=t2');           /* armored spectre */
    this.load.image('wight1', 'assets/tiny/wight1.png?v=t2');
    this.load.image('hydra', 'assets/tiny/hydra0.png?v=t2');           /* three heads */
    this.load.image('hydra1', 'assets/tiny/hydra1.png?v=t2');
    /* GIANT composites (64/48px, multi-part, procedurally assembled
       from transparent pack tiles) — the real heavyweight spawns */
    this.load.image('bigworm', 'assets/tiny/gworm0.png?v=t2');         /* 64x32 segmented worm */
    this.load.image('bigworm1', 'assets/tiny/gworm1.png?v=t2');
    this.load.image('bhydra', 'assets/tiny/bhydra0.png?v=t2');         /* 64x48 titan hydra */
    this.load.image('bhydra1', 'assets/tiny/bhydra1.png?v=t2');
    this.load.image('dlord', 'assets/tiny/dlord0.png?v=t2');           /* 48x64 demon lord */
    this.load.image('dlord1', 'assets/tiny/dlord1.png?v=t2');
    /* ---- REAL large monsters (found online, no self-composites) ----
       bevouliin "Land Monster" CC0: 120x96 green beast, 2-frame idle.
       Ars Notoria (Redshrike) CC-BY 3.0: dark eldritch bosses.
       Source zips kept in assets/big/src/ as license provenance. */
    this.load.image('bigmonster', 'assets/big/bigmonster0.png?v=b1');
    this.load.image('bigmonster1', 'assets/big/bigmonster1.png?v=b1');
    this.load.image('andromalius', 'assets/big/andromalius0.png?v=b1');
    this.load.image('andromalius1', 'assets/big/andromalius1.png?v=b1');
    this.load.image('gnu', 'assets/big/gnu0.png?v=b1');
    this.load.image('gnu1', 'assets/big/gnu1.png?v=b1');
    this.load.image('shadow', 'assets/big/shadow0.png?v=b1');
    this.load.image('shadow1', 'assets/big/shadow1.png?v=b1');
    this.load.image('tentaclebig', 'assets/big/tentacle0.png?v=b1');
    this.load.image('tentaclebig1', 'assets/big/tentacle1.png?v=b1');
    /* atlas URL carries a size fingerprint: if tiles.png ever changes
       shape, browsers must not serve the stale cached sheet while the
       meta JSON (tiles.meta.js?v=N) is fresh — a 48-cell sheet with a
       155-tile meta crashes PutTileAt (tiles[] has only 48 gids) */
    this.load.image('mc', 'assets/mc/tiles.png?v=' + (META && META.atlas
      ? META.atlas[0] + 'x' + META.atlas[1] : '1'));
    this.load.image('cloud', 'assets/scenery/cloud.png?v=s1');
  };

  MainScene.prototype.create = function () {
    scene = this;
    var S = this;

    /* regenerate world */
    world = worldgen.generate((Date.now() % 4294967296) | 0, WORLD_W, WORLD_H);
    /* backdrop band anchor: mean surface row -> world px */
    (function () {
      var sum = 0;
      for (var i = 0; i < world.surfaceY.length; i++) { sum += world.surfaceY[i]; }
      PLAYER_SURFACE_Y = (sum / world.surfaceY.length) * TILE;
    })();
    /* seal sky leaks: any air cell BELOW its column's surface that has no
       wall would show the sky gradient through the cave (pale rectangles).
       These are enclosed pockets — give them the stone back-wall. */
    for (var sx = 0; sx < WORLD_W; sx++) {
      for (var sy = world.surfaceY[sx] + 1; sy < WORLD_H; sy++) {
        var wi = sy * WORLD_W + sx;
        if (world.tile[wi] === 0 && world.wall[wi] === 0) { world.wall[wi] = 2; }
      }
    }
    stats = { mined: 0, kills: 0, chests: 0, deaths: 0 };
    inventory = [{ id: 12, n: 20 }];
    hotbarSel = 0;
    S.boss = null;
    over = false; flagHit = false; openedChests = {}; crystalsGot = 0; torchLife = {};
  CRYSTALS_NEED = diff().need;

    /* render the worldgen arrays into two static canvases (wall + tile):
       512*32=16384 px wide is too big for one texture; slice into
       horizontal strips of 256 tiles and blit as images. */
    /* ---- world tiles via the official tilemap API ----
       WebGL renders tiles per-frame with viewport culling (no offscreen
       bake), so a single full-size layer per plane is fine — the
       half-layer split existed only for the CANVAS renderer's bake. */
    var map = this.make.tilemap({ tileWidth: 16, tileHeight: 16,
      width: WORLD_W, height: WORLD_H });
    var tileset = map.addTilesetImage('mc', 'mc', 16, 16, 0, 0);
    /* guard: cached-atlas/meta mismatch (stale tiles.png) would crash
       later inside PutTileAt with an opaque stack — fail with a clear
       message instead */
    var srcImg = this.textures.get('mc').getSourceImage();
    if (META && META.atlas && (srcImg.width !== META.atlas[0] ||
        srcImg.height !== META.atlas[1])) {
      console.error('[dig] atlas/meta mismatch: png ' + srcImg.width +
        'x' + srcImg.height + ', meta ' + META.atlas[0] + 'x' +
        META.atlas[1] + ' — hard-refresh (Ctrl+F5) to drop the cached sheet');
      return;
    }

    this.tiles = map.createBlankLayer('tiles', tileset).setDepth(-1);
    /* Terraria underground backdrop: dark fill under the wall layer with
       its top edge EXACTLY tracking each column's surfaceY (drawn once
       into a texture — zero per-frame cost, world-attached, never jitters
       and never peeks above terrain on hills/cliffs). */
    (function () {
      /* bake at 1/4 world resolution (4096x2048 = 32MB) then scale x4:
         quantization step 8px is invisible under 32px tiles/walls */
      var Q = 4;                        /* texel = 8 world px */
      var tw = Math.ceil(WORLD_W * TILE / Q);
      var th = Math.ceil(WORLD_H * TILE / Q);
      var g = this.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0x241d16, 1);
      for (var fx = 0; fx < WORLD_W; fx++) {
        var syW = world.surfaceY[fx] * TILE;
        g.fillRect(fx * TILE / Q, syW / Q, TILE / Q,
          (WORLD_H * TILE - syW) / Q);
      }
      g.generateTexture('caveFill', tw, th);
      g.destroy();
      this.add.image(0, 0, 'caveFill').setOrigin(0, 0)
        .setScale(Q, Q).setDepth(-2.5);
    }).call(this);
    this.walls = map.createBlankLayer('walls', tileset).setDepth(-2).setAlpha(0.55);

    for (var y = 0; y < WORLD_H; y++) {
      for (var x = 0; x < WORLD_W; x++) {
        var i = y * WORLD_W + x;
        var tid = world.tile[i], wid = world.wall[i];
        if (tid) {
          var tm = TILEMETA[tid];
          if (tm) { this.tiles.putTileAt(tm.atlasIndex, x, y); }
        }
        if (wid) {
          var wtex = (META.wallTex || {})[wid];
          /* WALL_WOOD(3) has no wallTex entry (only dirt/stone do) -
            chest alcoves showed the raw SKY through the missing wall =
            the "chest floating on a white block" look. Map any unmapped
            wall to the plank texture so enclosed pockets never leak
            sky. */
          if (!wtex && wid === 3) { wtex = 7; }   /* plank as wood wall */
          var wm = TILEMETA[wtex];
          if (wm) { this.walls.putTileAt(wm.atlasIndex, x, y); }
        }
      }
    }
    /* the tilemap bakes 16px source tiles while the camera/physics/
       player all operate in 32px world units — setScale(2) is the
       bridge; without it the visual world is half size */
    this.tiles.setScale(2);
    this.walls.setScale(2);

    /* dig/place helpers */
    this.tileLayerFor = function () { return this.tiles; };
    this.wallLayerFor = function () { return this.walls; };
    this.localY = function (y) { return y; };

    /* ---- world-space lightmap (the ACTUAL light engine) ----
       A tiny canvas, 1 pixel per tile (512x256): each pixel's ALPHA =
       darkness of that tile (0 = fully lit, 255 = pitch black), RGB is
       white so MULTIPLY keeps hue. Rendered as a world image at depth
       40 with LINEAR filtering, so the camera scrolls it with the
       terrain: no seams, no lag, no DOM sync. Rebuilt by relight() on
       torch place / dig (BFS over 512x256, a few ms). */
    this.lightCv = document.createElement('canvas');
    this.lightCv.width = WORLD_W; this.lightCv.height = WORLD_H;
    this.lightTex = this.textures.addCanvas('worldLight', this.lightCv);
    /* pixelArt:true forces NEAREST on all textures — fine for tiles,
       but the lightmap must interpolate or caves get blocky edges */
    this.lightTex.setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.darkImg = this.add.image(0, 0, 'worldLight')
      .setOrigin(0, 0)
      .setDisplaySize(WORLD_W * TILE, WORLD_H * TILE)
      .setDepth(40)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    relight(this);

    /* ---- Light2D retired: the world-space lightmap above IS the light
       engine (occlusion + day/night + torches). Keeping Light2D ambient
       on top of it double-dims the scene. ---- */
    /* flicker triage: log renderer once; context-loss listeners stay —
       if real-GPU flicker ever returns, check console for contextlost */
    var S = this;
    console.log('[dig] renderer=', this.game.renderer.type === Phaser.WEBGL ? 'WebGL' : 'Canvas',
      'light2d=', !window.__digNoLight);
    this.game.canvas.addEventListener('webglcontextlost', function (e) {
      console.warn('[dig] webglcontextlost — flicker = context loss'); e.preventDefault();
    });
    this.game.canvas.addEventListener('webglcontextrestored', function () {
      console.warn('[dig] webglcontextrestored');
    });

    /* ---- player ---- */
    this.player = this.physics.add.sprite(
      world.spawn[0] * TILE, world.spawn[1] * TILE, 'phoebe', 0)
      .setDisplaySize(88, 96)           /* frame 192x208 → 88x96 on screen */
      .setOrigin(0.5, 1);
    this.player.setCollideWorldBounds(true);
    /* body units are FRAME pixels (192x208): a 30x52 world box with the
       on-screen scale 88/192=0.458 → 66x114 frame px, offset pins it to
       the feet (origin 0.5,1 means body bottom = sprite bottom) */
    this.player.body.setSize(66, 114);
    this.player.body.setOffset(63, 94);
    this.player.setDepth(10);   /* below the lightmap (40): the player
                                    is lit by the world like everything
                                    else — dark at night, bright by torch */
    /* NOTE: no Light2D player lamp — a point light centered on the
       sprite made the character glow like a halo. The soft lamp lives
       in the flood-field lampBuf instead. */

    /* sprite anims: the feibi sheet was loaded via load.spritesheet
       (192x208 cells), so frames are auto-numbered 0..87.
       row 0 = idle (0-5), row 1 = run (8-15). */
    if (this.anims.exists('run')) { this.anims.remove('run'); }
    this.anims.create({
      key: 'run',
      frames: this.anims.generateFrameNumbers('phoebe', { start: 8, end: 15 }),
      frameRate: 9, repeat: -1
    });
    if (this.anims.exists('idle')) { this.anims.remove('idle'); }
    this.anims.create({
      key: 'idle',
      frames: this.anims.generateFrameNumbers('phoebe', { start: 0, end: 5 }),
      frameRate: 4, repeat: -1
    });
    /* real animations from the pet sheet's own spec (see pet.js ROWS):
       row 3 = wave (one-shot, plays on chest open), row 4 = jump
       (one-shot, first jump — far better than freezing a run frame) */
    if (this.anims.exists('jump')) { this.anims.remove('jump'); }
    this.anims.create({
      key: 'jump',
      frames: this.anims.generateFrameNumbers('phoebe', { start: 32, end: 36 }),
      frameRate: 8, repeat: 0
    });
    if (this.anims.exists('wave')) { this.anims.remove('wave'); }
    this.anims.create({
      key: 'wave',
      frames: this.anims.generateFrameNumbers('phoebe', { start: 24, end: 27 }),
      frameRate: 7, repeat: 0
    });
    /* bug/bat flap: swap between the two loaded frames on a timer.
       (Canvas-composed textures have no numbered frames, so
       generateFrameNumbers built duration-less anims → play() threw.
       Texture swapping needs no anim system and cannot break.) */
    this.bugFrame = false;
    this.time.addEvent({
      delay: 150, loop: true, callback: function () {
        S.bugFrame = !S.bugFrame;
        S.bugs.children.each(function (b) {
          if (!b.active) { return; }
          /* per-kind frame pairs keep every species flapping/squishing
             on the shared 150ms timer (textures carry no anim frames) */
          var k = b.kind;
          b.setTexture(S.bugFrame ? k + '1' : k);
          if (b.tint) { b.setTint(b.tint); }   /* re-apply after texture swap */
        });
      }
    });

    /* ---- camera ---- */
    this.cameras.main.setBounds(0, 0, WORLD_W * TILE, WORLD_H * TILE);
    this.cameras.main.startFollow(this.player, true, 0.25, 0.25,
      0, H0(this) * 0.1);
    this.cameras.main.setDeadzone(160, 120);
    this.physics.world.setBounds(0, 0, WORLD_W * TILE, WORLD_H * TILE);

    /* ---- static collision: merge solid tiles into VERTICAL runs per
       column ---- plain images need real physics bodies. COLUMN runs,
       NOT horizontal: a dig changes exactly one column, and vertical
       runs never cross columns, so rebuildSolids() can destroy/rebuild
       one column exactly. (Horizontal runs spanned the whole row - the
       first rebuild nuked them and dirt outside the 3-column window
       lost collision = "missing dirt collision" bug.) */
    this.solids = this.physics.add.staticGroup();
    for (var sx2 = 0; sx2 < WORLD_W; sx2++) { buildColumnRuns(this, sx2); }
    this.physics.add.collider(this.player, this.solids);

    /* ---- enemies ---- */
    this.bugs = this.physics.add.group();
    this.bullets = this.physics.add.group();
    this.time.addEvent({
      delay: 700, loop: true, callback: function () { spawnBug(S); }
    });
    /* AI brain tick: ground bugs WALK toward the player (with small
       hop over walls); bats make swooping dives when in range. Turns
       the enemies from ambient decoration into an actual threat that
       escorts you through caves. */
    this.time.addEvent({
      delay: 400, loop: true, callback: function () { bugBrain(S); }
    });
    /* torch fuel sweep: gutter expired torches, puff smoke, relight.
       Runs at 3s as a BACKSTOP; the update() loop checks
       nextTorchExpiry each frame so the actual gutter-out happens
       within a frame of expiry (the 3s poll alone left dead torches
       lit for up to 3s and out of sync with the fuel HUD). */
    this.time.addEvent({
      delay: 3000, loop: true, callback: function () {
        gutterTorches(S);
      }
    });
    this.physics.add.overlap(this.player, this.bugs, function (pl, bug) {
      /* boss is NEVER one-shot by contact — it DEALS the damage and
         stays. (It spawns at the altar where the player stands; the
         old unconditional destroy() killed it on frame one.) */
      if (bug.isBoss) {
        if (pl.invT > 0) { return; }
        pl.invT = 1.2;
        hpChange(S, -2);                    /* the lord hits hard */
        SFX.hurt();
        var awayB = pl.x < bug.x ? -1 : 1;
        pl.setVelocity(awayB * 320, -300);
        S.cameras.main.shake(200, 0.012);
        S.tweens.add({ targets: pl, tint: 0xff5555, duration: 70,
          yoyo: true, repeat: 3, onComplete: function () { pl.clearTint(); } });
        return;
      }
      if (bug.glow && bug.glow.active) { bug.glow.destroy(); }
      if (pl.invT > 0) { bug.destroy(); return; }
      pl.invT = 1.2;
      hpChange(S, -1);
      SFX.hurt();
      /* hurt feedback: knockback away from the bug, red flash, short
         screenshake - damage now READS as damage */
      var away = pl.x < bug.x ? -1 : 1;
      pl.setVelocity(away * 240, -260);
      S.cameras.main.shake(140, 0.008);
      S.tweens.add({ targets: pl, tint: 0xff5555, duration: 70,
        yoyo: true, repeat: 3, onComplete: function () { pl.clearTint(); } });
      bug.destroy();
    });
    this.physics.add.collider(this.bugs, this.solids);

    /* ---- flag & chests ---- */
    this.flagSpr = this.add.image(
      world.flag[0] * TILE + 16, world.flag[1] * TILE + 32, 'flag')
      .setOrigin(0.5, 1).setScale(1.4).setDepth(9);
    /* flag is not a Light2D target — keep it unlit so the goal stays
       visible from a distance, like a landmark */

    /* clouds behind the terrain, light parallax like the old game */
    for (var cl = 0; cl < 7; cl++) {
      this.add.image(300 + cl * 1500, 110 + ((cl * 97) % 190), 'cloud')
        .setScrollFactor(0.25).setDepth(-3).setAlpha(0.9)
        .setScale(1 + (cl % 3) * 0.4);
    }

    /* Terraria-style backdrop lives in the DOM sky overlay (drawSky),
       NOT as Phaser objects: the world-space lightmap (depth 40 MULTIPLY)
       would multiply screen-fixed sprites by the CAVE light under the
       camera — painting mountains near-black and making them strobe as
       you move. drawSkyBackdrop() draws them into eggSkyOverlay, which
       sits UNDER the game canvas and is never light-multiplied. */

    /* ---- DOM overlays: sky (bottom) + HUD (top). No darkness mask —
       caves are dark simply because no light reaches them; ALL light
       (sun + torches) is the world-space colored lightmap. ---- */
    this.hp = MAX_HP;
    ensureOverlays(this);

    /* onboarding strip (loop 0 only): one line, auto-fades after 9s.
       Without it nobody discovers K=jump / E=chest / shard auto-pickup. */
    if (loopLevel === 0) {
      var tut = bannerEl('eggTut');
      tut.style.top = '56%';
      tut.style.fontSize = '14px';
      tut.style.color = '#ffe9b0';
      tut.style.textShadow = '0 2px 4px #000';
      tut.textContent = 'AD/←→ 移动 · K/空格 跳（二段跳）· 左键挖矿/射击 · 右键放置 · E 开箱 · 1-9 选物 · 深洞紫水晶×' + CRYSTALS_NEED + ' → 祭坛激活';
      tut.style.opacity = 1;
      this.time.delayedCall(9000, function () { tut.style.opacity = 0; });
    }
    this.hudCtx = document.getElementById('eggHudOverlay').getContext('2d');
    this.skyCtx = document.getElementById('eggSkyOverlay').getContext('2d');
    this.mcImg = this.textures.get('mc').getSourceImage();
    /* NO ambient lamp around the player — light comes only from a held
       torch (hotbar slot selected) or placed torches. Darkness is NOT
       painted; caves are dark because no light reaches them. */
    this.digG = this.add.graphics().setDepth(50);
    drawHotbar(this);
    this.scale.on('resize', function () {
      sizeOverlays(S);
      drawSky(S);
      drawHotbar(S);
    });
    /* entering fullscreen resizes the chat box without a window resize
       event → the game canvas kept the old size and uncovered sky showed
       as a big rectangle around the world. Force refresh on
       fullscreenchange (and slightly after, when CSS settles). */
    document.addEventListener('fullscreenchange', function () {
      var refit = function () {
        S.scale.refresh();
        sizeOverlays(S);
        drawSky(S);
        drawHotbar(S);
      };
      setTimeout(refit, 60);
      setTimeout(refit, 250);
    });
    /* catch ALL size sources (fullscreen, devtools, window drag-resize) */
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        sizeOverlays(S);
        drawSky(S);
        drawHotbar(S);
      }).observe(chat);
    }
    /* the chat box may still be settling when create() runs (egg CSS just
       flipped display modes) — re-size once the layout is final */
    this.time.delayedCall(350, function () {
      sizeOverlays(S);
      drawSky(S);
      drawHotbar(S);
    });

    /* ---- input ---- */
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keysA = this.input.keyboard.addKeys('W,A,S,D,K,X,E');
    var S = this;
    /* old-game keymap: K/W/Up/Space = jump (double jump), J/X/F = shoot */
    this.keysK = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.K);
    this.keysJ = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.J);
    this.keysF = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F);
    this.keysSpace = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.numKeys = [];
    var nkNames = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
    for (var nk = 0; nk < nkNames.length; nk++) {
      this.numKeys.push(this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes[nkNames[nk]]));
    }
    this.input.mouse.disableContextMenu();
    /* hover highlight: track the pointer live (update loop), not just on click */
    this.input.on('pointermove', function (p) { digAt(S, p); });
    this.input.on('pointerdown', function (p) {
      if (p.rightButtonDown()) { placeAt(S, p); return; }
      /* left button: dig if a minable tile is under the cursor, else
         shoot at the cursor. digAt() refreshes S.digTarget first. */
      digAt(S, p);
      if (S.digTarget) { S.digging = true; }
      else { shoot(S); S.mouseFire = true; }
    });
    this.input.on('pointerup', function () { S.digging = false; S.mouseFire = false; });
    this.input.on('wheel', function (p, go, dx, dy) {
      hotbarSel = (hotbarSel + (dy > 0 ? 1 : -1) + 9) % 9;
      drawHotbar(S);
    });

    /* dig tick */
    this.time.addEvent({ delay: 33, loop: true, callback: function () { digTick(S); } });
    /* E: open chest */
    this.keysE = this.input.keyboard.addKey('E');
  };

  function H0(S) { return S.scale.height; }

    function spawnBug(S) {
    if (S.bugs.getLength() >= diff().bugCap || over) { return; }
    var p = S.player;
    var side = Math.random() < 0.5 ? -1 : 1;
    /* spawn DISTANCE: underground the world is pitch black beyond the
       torch radius — a 600-900px offscreen spawn crawls 10+ seconds
       through invisible dark. Drop to 300-420px underground: enemies
       arrive within seconds AND are visible at the light's edge. */
    var depth0 = Math.floor(p.y / TILE) - world.surfaceY[
      Math.max(0, Math.min(WORLD_W - 1, Math.floor(p.x / TILE)))];
    var cave = depth0 > 10;                   /* cave tier now 10 tiles deep */
    var off = cave ? 300 + Math.random() * 120 : 380 + Math.random() * 180;
    var bx = p.x + side * off;
    bx = Math.max(64, Math.min(WORLD_W * TILE - 64, bx));
    /* species by depth: deeper = more eldritch; NIGHT lets wraiths
       and small eyes haunt the surface (dayT>0.5 = dusk..dawn) */
    var depth = Math.floor(p.y / TILE) - world.surfaceY[
      Math.max(0, Math.min(WORLD_W - 1, Math.floor(bx / TILE)))];
    var roll = Math.random();
    var kind, fly = false;
    /* ROSTER (user verdict: the big/composite experiment didn't land —
       giants + Ars Notoria crowd removed). Kept: the cohesive Kenney/
       Tiny pixel roster — bug, bat, slime, winged bug, fire bat, plus
       eyelet/arachni cave natives. The Kraken Lord boss remains. */
    if (depth > 150) {
      /* lava tier: fire bats, bugs + flameskull shooters */
      kind = roll < 0.40 ? 'batF' : roll < 0.60 ? 'spitterF' : 'bug';
    } else if (depth > 24) {
      /* cave tier: slimes, eyes, spiders + willowisp shooters */
      kind = roll < 0.18 ? 'slime' : roll < 0.33 ? 'eyelet'
        : roll < 0.48 ? 'arachni' : roll < 0.60 ? 'spitter'
        : roll < 0.82 ? 'bugW' : 'bug';
    } else if (dayT > 0.5) {
      /* NIGHT surface: bats join, eyelets scout, wisps haunt */
      kind = roll < 0.35 ? 'bug' : roll < 0.60 ? 'bat' : roll < 0.80 ? 'eyelet' : 'spitter';
      fly = kind === 'bat' || kind === 'eyelet' || kind === 'spitter';
    } else {
      kind = roll < 0.6 ? 'bug' : roll < 0.9 ? 'bat' : 'spitter';
      fly = kind !== 'bug';
    }
    var by = fly ? p.y - 120 - Math.random() * 80 : surfacePx(S, bx) - 20;
    /* underground: spawn at the player's depth so cave fights happen
       where the player actually digs, not on the far-away surface */
    if (!fly && depth > 24) {
      by = p.y + (Math.random() - 0.5) * 120;
      by = Math.max(TILE * 4, Math.min(WORLD_H * TILE - 64, by));
    }
    var b = S.bugs.create(bx, by, kind).setScale(1.3);
    b.kind = kind;
    b.fly = fly;
    /* SIZE: everything reads bigger now. 16px sprites at 1.3 were tiny;
       base 1.9 (30px), big species 2.4-2.8 (38-45px). ELITE variant:
       deep-tier monsters have a 15% chance to spawn as 1.5x-size
       elites (double HP implied via extra knockback resistance) with
       a brighter halo — miniboss silhouettes in the dark. */
    var baseScale = (kind === 'bigmonster') ? 1.6                     /* 120x96 -> 192px! */
      : (kind === 'andromalius') ? 2.2                                /* 54x87 -> 119px */
      : (kind === 'bigworm' || kind === 'bhydra') ? 2.2               /* 64px sheets */
      : (kind === 'dlord') ? 2.0                                      /* 48x64 sheet */
      : (kind === 'gnu') ? 2.0                                        /* 60x79 -> 120px */
      : (kind === 'shadow') ? 2.2                                     /* 69x43 -> 152px wide */
      : (kind === 'tentaclebig') ? 2.6                                /* 22x55 -> 143px tall */
      : (kind === 'kraken') ? 2.8
      : (kind === 'cube' || kind === 'eye' || kind === 'krtentacle') ? 2.4
      : (kind === 'wraith' || kind === 'batF') ? 2.1
      : 1.9;
    var elite = (depth > 60 && Math.random() < 0.15 && kind.indexOf('big') < 0 &&
                 kind !== 'bhydra' && kind !== 'dlord');
    if (elite) { baseScale *= 1.5; }
    b.elite = elite;
    b.setScale(baseScale);
    /* giants are their own elite: mark them for the slower pace + no
       double elite scaling above */
    if (kind === 'bigworm' || kind === 'bhydra' || kind === 'dlord') {
      b.elite = true;
      b.giant = true;
    }
    /* spawn-spot validation: an underground spawn can land INSIDE a
       solid tile — embedded enemies never move and are invisible in
       the dark. Nudge to the nearest air cell above. */
    /* PHYSICS BODY: arcade bodies don't auto-scale with setScale — a
       190px-wide giant kept a 120px (or unscaled) body, so it clipped
       through thin static runs and fell through floors. Give every
       giant an explicit body matching its DISPLAYED size. */
    var dispW = 16 * baseScale, dispH = 16 * baseScale;
    var frameW = b.width, frameH = b.height;      /* unscaled frame */
    dispW = frameW * baseScale; dispH = frameH * baseScale;
    if (kind === 'bigmonster' || kind === 'andromalius' || kind === 'gnu' ||
        kind === 'shadow' || kind === 'tentaclebig' || kind === 'bigworm' ||
        kind === 'bhydra' || kind === 'dlord') {
      b.body.setSize(frameW, frameH);             /* reset to frame first */
      b.body.setSize(Math.max(24, frameW * baseScale * 0.7),
                     Math.max(24, frameH * baseScale * 0.8));
      /* center the smaller hitbox on the sprite */
      b.body.setOffset(
        (frameW - b.body.width) / 2 / baseScale * 1,
        (frameH - b.body.height) / baseScale);
      b.setMaxVelocity(90, 420);                  /* no tunneling falls */
    }
    /* nudge loop v2: the OLD loop checked only the sprite CENTER tile —
       a 3-6 tile wide giant stayed embedded chest-deep. Require the
       WHOLE body box to be in air. */
    if (!fly || kind === 'bigworm') {
      var tries = 0;
      var bw = Math.ceil(b.body.width / TILE) + 1;
      var bh = Math.ceil(b.body.height / TILE) + 1;
      while (tries < 30) {
        var cxi0 = Math.floor((b.x - b.body.width / 2) / TILE);
        var cyi0 = Math.floor((b.y - b.body.height / 2) / TILE);
        var clear = true;
        for (var nx = cxi0; nx < cxi0 + bw && clear; nx++) {
          for (var ny = cyi0; ny < cyi0 + bh && clear; ny++) {
            if (nx < 1 || nx >= WORLD_W - 1 || ny < 1 || ny >= WORLD_H - 1) { continue; }
            if (world.tile[ny * WORLD_W + nx] !== 0) { clear = false; }
          }
        }
        if (clear) { break; }
        b.y -= TILE;                          /* box intersects rock: rise */
        tries++;
      }
      if (tries >= 30) { b.y = Math.max(TILE * 3, p.y - 300); } /* last resort: sky */
    }
    b.setDepth(8);            /* above tiles, below HUD; same plane as shards */
    b.setVelocityX((Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 40) * (elite ? 0.7 : 1));
    if (fly) { b.body.setAllowGravity(false); b.setVelocityY(-20); }
    /* ground giants spawn above the player (open air) but fall to the
       cave floor and fight from there — gravity must be ON for them */
    if (kind === 'bigworm' || kind === 'bigmonster' || kind === 'gnu' ||
        kind === 'shadow') {
      b.body.setAllowGravity(true); b.setVelocityY(0);
    }
    if (kind === 'batF') { b.tint = 0xff7746; }   /* fire bat tint */
    if (kind === 'slime') { b.tint = 0x8fe06a; }  /* cave-green tint */
    if (kind === 'cube') { b.tint = 0x9fd8ff; }   /* icy gel */
    if (kind === 'eye') { b.tint = 0xd9a6ff; }    /* purple gaze */
    if (kind === 'wraith' || kind === 'banshee') { b.tint = 0xb8c8ff; b.setAlpha(0.75); }
    if (kind === 'krtentacle') { b.tint = 0x6fa3d9; }
    if (kind === 'willowisp' || kind === 'flameskull') { b.tint = 0xffc86b; } /* ember glow */
    if (kind === 'maneater') { b.tint = 0x9fe06a; } /* hungry green */
    if (kind === 'purpleworm') { b.tint = 0xd98fd9; } /* worm purple */
    if (kind === 'dragonkin' || kind === 'cockatrice') { b.tint = 0xff9a6b; }
    if (kind === 'demon') { b.tint = 0xe86a6a; }
    if (kind === 'naga' || kind === 'hydra') { b.tint = 0x7ad9b0; }
    if (kind === 'mummy' || kind === 'goul' || kind === 'wight') { b.tint = 0xd9d0b8; }
    if (kind === 'manticore') { b.tint = 0xf2b86b; }
    if (elite) { b.tint = b.tint ? b.tint : 0xffffff; }
    /* NO glow halos (user request): monsters are lit only by the
       world lightmap — if you want to see them, carry a torch.
       Visibility in the dark comes from SIZE: see bigworm/bhydra/
       dlord composites (45-130px). */
    /* hover bob via a sine in updatePre, NOT a tween — tween vs physics
       both writing Y is what caused the ghosting/jitter */
  }

  /* collectible crystal shard: physics pickup that bounces, glows
     (ADD blend, above the lightmap so it's visible in the dark), and
     auto-collects on player contact. Lifetime 12s, blink before exp. */
  /* one-time generated shard texture (tiny faceted purple gem), same
     approach as the bullet: 'mc' is a single-frame TEXTURE loaded via
     load.image — passing an atlasIndex frame to it rendered the WHOLE
     tiles.png sheet as the sprite (the giant atlas panel bug). */
  function ensureShardTexture(S) {
    if (S.textures.exists('shard')) { return; }
    var cv = document.createElement('canvas');
    cv.width = 24; cv.height = 24;
    var ctx = cv.getContext('2d');
    /* faceted gem: light top-left facet, dark bottom-right */
    ctx.beginPath();
    ctx.moveTo(12, 2); ctx.lineTo(22, 10); ctx.lineTo(12, 22);
    ctx.lineTo(2, 10); ctx.closePath();
    var g = ctx.createLinearGradient(2, 2, 22, 22);
    g.addColorStop(0, '#e6c8ff');
    g.addColorStop(0.5, '#a86ff2');
    g.addColorStop(1, '#7a3fd9');
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = '#f2e2ff'; ctx.lineWidth = 1.5; ctx.stroke();
    /* inner facet line */
    ctx.beginPath();
    ctx.moveTo(12, 2); ctx.lineTo(12, 22);
    ctx.moveTo(2, 10); ctx.lineTo(22, 10);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.stroke();
    S.textures.addCanvas('shard', cv);
  }

  /* soft radial glow texture for the enemy halos — a HARD-EDGED gem
     sprite scaled 4x + ADD blend renders as a pale diamond BLOCK (the
     'floating purple square' bug). A radial gradient fading to full
     transparency reads as an actual light source. Tinted per-species.
     Pixels are manually PREMULTIPLIED: WebGL ADD blend adds RGB weighted
     by alpha — a straight-alpha canvas uploads with wrong corner colors
     and the whole quad brightens as a visible rectangle (the '奇怪的
     矩形' bug). Premultiplied RGB = correct additive falloff. */
  function ensureGlowTexture(S) {
    if (S.textures.exists('glow')) { return; }
    var cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    var ctx = cv.getContext('2d');
    var g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.32)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.10)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    /* premultiply: rgb *= alpha so the additive blend sees the real
       falloff instead of a constant RGB sheet across the whole quad */
    var id = ctx.getImageData(0, 0, 64, 64);
    var d = id.data;
    for (var i = 0; i < d.length; i += 4) {
      var a = d[i + 3] / 255;
      d[i] = d[i] * a; d[i + 1] = d[i + 1] * a; d[i + 2] = d[i + 2] * a;
    }
    ctx.putImageData(id, 0, 0);
    S.textures.addCanvas('glow', cv);
  }

  var BOSS_MAX = 40;                          /* bullet hits */
  function bossSpawn(S) {
    if (S.boss) { return; }
    ensureGlowTexture(S);                     /* the halo needs it */
    ensureShardTexture(S);                    /* eyelet minion halos */
    var fx = world.flag[0] * TILE + 16, fy = world.flag[1] * TILE - 90;
    var b = S.bugs.create(fx, fy, 'boss');
    b.kind = 'boss';
    b.fly = true;                             /* no gravity */
    b.isBoss = true;
    b.bossHP = BOSS_MAX;
    b.body.setAllowGravity(false);
    b.body.setCircle(30, 2, 2);               /* generous hit circle */
    b.setDepth(9);
    b.setScale(2.0);
    b.setTint(0x9a6cff);
    S.boss = b;
    /* boss music sting + camera shake announce */
    S.cameras.main.shake(500, 0.012);
    tone(90, 0.8, 'sawtooth', 0.16, 40);
    tone(60, 1.2, 'square', 0.12, 30);
    showBossBanner(S, true);
    return b;
  }
  function bossBrain(S) {
    var b = S.boss;
    if (!b || !b.active) { return; }
    var p = S.player;
    var dx = p.x - b.x, dy = p.y - b.y;
    var dist = Math.max(1, Math.hypot(dx, dy));
    var frac = b.bossHP / BOSS_MAX;
    /* phase from remaining HP: hover-float -> aggressive chase -> rage */
    var phase = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
    var spd = [0, 46, 82, 120][phase];
    b.setVelocity((dx / dist) * spd, (dy / dist) * spd * 0.6);
    /* tentacle pulse: scale breaths faster as it takes damage */
    var breath = 0.12 + 0.06 * (3 - phase);
    b.setScale(2.0 + breath * Math.sin(S.time.now / (260 - phase * 60)));
    /* wraith-flicker when hurt badly */
    b.setAlpha(frac < 0.33 ? 0.75 + 0.25 * Math.abs(Math.sin(S.time.now / 240)) : 1);
    /* HP bar: thin bar under the banner while the fight lasts */
    var bar = document.getElementById('bossBar');
    if (!bar) {
      bar = bannerEl('bossBar');
      bar.style.top = '20%';
      bar.style.fontSize = '13px';
      bar.style.color = '#e8d9ff';
      bar.style.textShadow = '0 1px 3px #000';
    }
    bar.innerHTML = '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬'.slice(0, Math.ceil(frac * 20)) +
      '▫'.repeat(20 - Math.ceil(frac * 20)) + ' ' + Math.ceil(frac * 100) + '%';
    bar.style.opacity = 1;
    /* phase 2+: spits homing eyelets (spawn small eye minions) */
    if (phase >= 2 && Math.random() < 0.012 * phase) {
      var mx = b.x + (Math.random() - 0.5) * 40;
      var my = b.y + 20;
      var m = S.bugs.create(mx, my, 'eyelet');
      m.kind = 'eyelet';
      m.fly = true;
      m.body.setAllowGravity(false);
      m.setDepth(8).setScale(1.1).setTint(0xd9a6ff);
    }
    /* phase 3 rage: ring burst of ink particles */
    if (phase === 3 && Math.random() < 0.05) {
      for (var i = 0; i < 10; i++) {
        (function (ang) {
          burst(S, b.x + Math.cos(ang) * 40, b.y + Math.sin(ang) * 40, 0x4a2a8a, 3);
        })(i / 10 * Math.PI * 2);
      }
    }
  }
  function PhaseBlend(S) { return Phaser.BlendModes.ADD; }
  function bossHurt(S, dmg) {
    var b = S.boss;
    if (!b || !b.active) { return; }
    b.bossHP -= (dmg || 1);
    S.cameras.main.shake(80, 0.004);
    burst(S, b.x, b.y, 0xb48cff, 5);
    if (b.bossHP <= 0) {
      /* DEATH: the true win */
      over = true;
      SFX.win();
      for (var i = 0; i < 5; i++) {
        (function (d) { S.time.delayedCall(d * 90, function () {
          burst(S, b.x + (Math.random() - 0.5) * 70, b.y + (Math.random() - 0.5) * 70, 0x9a6cff, 16);
          burst(S, b.x, b.y, 0xf2e07e, 10);
        }); })(i);
      }
      if (b.glow && b.glow.active) { b.glow.destroy(); }
      b.destroy();
      S.boss = null;
      showBossBanner(S, false);
      var bb = document.getElementById('bossBar');
      if (bb) { bb.style.opacity = 0; }
      /* victory path shares the altar win: flag + crystals were already
         delivered — boss kill is the final gate */
      flagHit = true;
      showWinBanner(S);
      stats.kills = (stats.kills || 0) + 1;
    }
  }
  /* ---- altar compass: edge arrow toward the altar once the gems are
     complete (you now WHERE to go, even from deep caves). The arrow
     clamps to the screen edge so it's always visible; hides itself
     when the altar is on-screen or the boss already rose. */
  function altarCompassUpdate(S) {
    var el = bannerEl('eggCompass');
    var ready = crystalsGot >= CRYSTALS_NEED && !flagHit && !S.boss;
    if (!ready) { el.style.opacity = 0; return; }
    var cam = S.cameras.main;
    var ax = world.flag[0] * TILE + 16, ay = world.flag[1] * TILE + 16;
    var sx = ax - cam.scrollX, sy = ay - cam.scrollY;
    var W = cam.width, H = cam.height;
    var onScreen = sx > 40 && sx < W - 40 && sy > 40 && sy < H - 40;
    if (onScreen) { el.style.opacity = 0; return; }
    var cx2 = W / 2, cy2 = H / 2;
    var ang = Math.atan2(sy - cy2, sx - cx2);
    /* clamp to an inset ellipse near the screen edge */
    var rx = W / 2 - 46, ry = H / 2 - 46;
    var t = 1 / Math.max(Math.abs(Math.cos(ang)) / rx,
                         Math.abs(Math.sin(ang)) / ry);
    var px2 = cx2 + Math.cos(ang) * t, py2 = cy2 + Math.sin(ang) * t;
    el.style.left = px2 + 'px';
    el.style.top = py2 + 'px';
    el.style.right = 'auto';
    el.style.fontSize = '26px';
    el.style.color = '#7ef2c0';
    el.style.textShadow = '0 0 8px #0af, 0 2px 3px #000';
    el.style.transform = 'translate(-50%,-50%) rotate(' + (ang * 180 / Math.PI) + 'deg)';
    el.textContent = '⮞';
    el.style.opacity = 0.9;
  }

  function showBossBanner(S, on) {
    var el = bannerEl('bossBanner');
    if (on) {
      el.style.top = '12%';
      el.style.fontSize = '22px';
      el.style.color = '#c9a6ff';
      el.style.textShadow = '0 2px 10px #000';
      el.innerHTML = '⟁ 克拉肯领主 苏醒 ⟁<br>' +
        '<span style="font-size:14px;color:#ccb3f5">祭坛的守卫者 —— 击败它以完成献祭</span>';
      el.style.opacity = 1;
    } else {
      el.style.opacity = 0;
    }
  }

  function spawnShard(S, x, y, ttl) {
    ensureShardTexture(S);
    if (!S.shards) {
      S.shards = S.physics.add.group();
      S.physics.add.overlap(S.player, S.shards, function (pl, sh) {
        if (!sh.active) { return; }
        sh.destroy();
        crystalsGot = Math.min(CRYSTALS_NEED + 3, crystalsGot + 1);
        SFX.crystal();
        burst(S, pl.x, pl.y - 40, 0xb48cff, 10);
        drawHotbar(S);
      });
    }
    var sh = S.shards.create(x, y, 'shard');
    if (ttl) { sh.ttl = ttl; }
    sh.setDepth(45).setScale(1.4);
    sh.setBlendMode(Phaser.BlendModes.ADD);
    sh.body.setBounce(0.55);
    sh.body.setVelocity((Math.random() - 0.5) * 140, -180 - Math.random() * 90);
    sh.setTint(0xd9b3ff);
    /* physics vs the static world */
    if (!S.shardsCollider) {
      S.shardsCollider = S.physics.add.collider(S.shards, S.solids);
    }
    /* despawn after 12s (blink the last 2.5s) */
    S.time.delayedCall(sh.ttl || 12000, function () {
      if (sh.active) {
        S.tweens.add({ targets: sh, alpha: 0.15, yoyo: true,
          duration: 180, repeat: 12, onComplete: function () { sh.destroy(); } });
      }
    });
  }

  function bugBrain(S) {
    if (over || !S.player) { return; }
    var px = S.player.x, py = S.player.y;
    S.bugs.children.each(function (b) {
      if (!b.active) {
        /* killed: destroy the glow halo with the body */
        if (b.glow && b.glow.active) { b.glow.destroy(); }
        return;
      }
      var dx = px - b.x, dy = py - b.y;
      var dist = Math.hypot(dx, dy);
      b.setFlipX(dx < 0);
      var k = b.kind;
      if (k === 'kraken') {
        /* kraken: apex — slow relentless FLOATING pursuit, gravity off,
           pulsing size read as breathing; ink puffs when hurt-player */
        b.body.setAllowGravity(false);
        if (dist < 520) {
          var spk = 65;
          b.setVelocity((dx / dist) * spk, (dy / dist) * spk);
        } else if (Math.random() < 0.3) {
          b.setVelocity((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 30);
        }
        b.setScale((b.elite ? 4.2 : 2.8) + 0.15 * Math.sin(S.time.now / 400));
      } else if (k === 'wraith') {
        /* wraith: spectral — drifts fast toward the player when LOOKED
           at (dist < 300), creeps slowly otherwise; flickers */
        b.body.setAllowGravity(false);
        if (dist < 300) {
          b.setVelocity((dx / dist) * 150, (dy / dist) * 150);
        } else {
          b.setVelocity((dx / dist) * 35, (dy / dist) * 20);
        }
        b.setAlpha(0.55 + 0.3 * Math.abs(Math.sin(S.time.now / 300)));
      } else if (k === 'eye' || k === 'eyelet') {
        /* disembodied eye: blinks out and RELOCATES when the player
           gets close — pure creepy, only contacts you when you dig */
        b.body.setAllowGravity(false);
        if (dist < 90 && Math.random() < 0.05) {
          b.x = p.x + (Math.random() < 0.5 ? -1 : 1) * (500 + Math.random() * 200);
          b.y = p.y + (Math.random() - 0.5) * 160;
          burst(S, b.x, b.y, 0xd9a6ff, 4);     /* blink-out puff */
        }
        if (dist < 260) {
          var spe = k === 'eye' ? 60 : 50;
          b.setVelocity((dx / dist) * spe, (dy / dist) * spe);
        } else if (Math.random() < 0.3) {
          b.setVelocity((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 24);
        }
      } else if (k === 'cube') {
        /* gelatinous cube: oozes along the ground, too slow to dodge-
           spam but hits hard because it never stops */
        if (dist < 400) {
          if (b.body.blocked.down) {
            b.setVelocityX((dx < 0 ? -1 : 1) * 38);
            /* ooze UP a single-tile step */
            if ((b.body.blocked.left || b.body.blocked.right)) { b.setVelocityY(-190); }
          }
        } else if (Math.random() < 0.2) {
          b.setVelocityX((Math.random() < 0.5 ? -1 : 1) * 22);
        }
      } else if (k === 'krtentacle') {
        /* severed tentacle: bursts from stillness — waits, then LUNGES
           in a short hop when the player is near */
        if (dist < 200) {
          if (b.body.blocked.down && Math.random() < 0.25) {
            b.setVelocity((dx < 0 ? -1 : 1) * 160, -260);
          }
        } else {
          b.setVelocityX(0);
        }
      } else if (k === 'arachni') {
        /* cave spider: fast skittering crawler, wall-stick hops */
        if (dist < 380) {
          var dirA = dx < 0 ? -1 : 1;
          if (b.body.blocked.down) {
            b.setVelocityX(dirA * (85 + Math.random() * 30));
            if ((b.body.blocked.left || b.body.blocked.right)) { b.setVelocityY(-230); }
            /* climb toward a player above */
            if (dy < -40 && Math.abs(dx) < 90) { b.setVelocityY(-320); }
          }
        } else if (Math.random() < 0.3) {
          b.setVelocityX((Math.random() < 0.5 ? -1 : 1) * 60);
        }
      } else if (k === 'batF') {
        /* fire bat: faster, longer aggro range, leaves embers behind */
        if (dist < 420) {
          b.body.setAllowGravity(false);
          var spf = 170;
          b.setVelocity((dx / dist) * spf, (dy / dist) * spf);
        } else if (Math.random() < 0.4) {
          b.setVelocity((Math.random() - 0.5) * 110, (Math.random() - 0.5) * 70);
        }
        if (Math.random() < 0.06) {
          burst(S, b.x, b.y, 0xff8844, 2);   /* ember trail */
        }
      } else if (k === 'spitter' || k === 'spitterF') {
        /* FLYING SHOOTER: hovers at a stand-off band (180-320px),
           strafing sideways; spits a slow aimed projectile every
           ~1.6s when the player is in sight range. Killable by one
           bolt like every small mob - the threat is the projectile,
           not the body. */
        b.body.setAllowGravity(false);
        var isF = k === 'spitterF';
        var band = dist < 180 ? -1 : (dist > 320 ? 1 : 0);   /* approach/hold/back off */
        var spSp = isF ? 95 : 75;
        var vx = (dx / (dist || 1)) * spSp * band;
        var vy = (dy / (dist || 1)) * spSp * band
                 + Math.sin(S.time.now / 500 + b.x) * 28;    /* gentle bob */
        /* strafe: circle the player while holding the band */
        if (band === 0) {
          var side2 = b.x < p.x ? 1 : -1;
          vx = side2 * spSp * 0.8;
          vy = Math.sin(S.time.now / 500 + b.x) * 34;
        }
        b.setVelocity(vx, vy);
        /* fire cycle: spaced salvos while the player is in range */
        if (!b.spitLast) { b.spitLast = S.time.now; }
        if (S.time.now - b.spitLast > (isF ? 1300 : 1700) && dist < 460) {
          b.spitLast = S.time.now;
          spitShot(S, b, isF);
        }
      } else if (b.fly) {
        /* bat: within 320px, dive at the player; otherwise hover-wander */
        if (dist < 320) {
          b.body.setAllowGravity(false);
          var sp = 130;
          b.setVelocity((dx / dist) * sp, (dy / dist) * sp);
        } else if (Math.random() < 0.35) {
          b.setVelocity((Math.random() - 0.5) * 90, (Math.random() - 0.5) * 60);
        }
      } else if (k === 'slime') {
        /* slime: hop toward the player — no crawling. Grounded = wind
           up; airborne = travel arc. Slower but tanks one extra hit
           via knockback instead of death (see bullet overlap). */
        if (dist < 460) {
          if (b.body.blocked.down) {
            var dirS = dx < 0 ? -1 : 1;
            b.setVelocity(dirS * (70 + Math.random() * 40), -300);
          }
        } else if (b.body.blocked.down && Math.random() < 0.2) {
          b.setVelocity((Math.random() < 0.5 ? -1 : 1) * 60, -220);
        }
      } else if (k === 'bugW') {
        /* winged bug: short powered hops — glides toward the player,
           gravity ON, so it lingers on walls/ceilings like a crawler */
        if (dist < 380) {
          var dirW = dx < 0 ? -1 : 1;
          if (b.body.blocked.down) {
            b.setVelocity(dirW * 120, -200);
          } else {
            b.setVelocityX(dirW * 90);
            b.setVelocityY(b.body.velocity.y - 1.2);  /* slow flutter */
          }
          if ((b.body.blocked.left || b.body.blocked.right)) {
            b.setVelocityY(-240);
          }
        } else if (Math.random() < 0.3) {
          b.setVelocityX((Math.random() < 0.5 ? -1 : 1) * 50);
        }
      } else {
        /* ground bug: crawl toward the player when within 420px; hop if
           blocked by a 1-tile step */
        if (dist < 420) {
          var dir = dx < 0 ? -1 : 1;
          var spd = 55 + Math.min(45, 4200 / Math.max(60, dist));
          b.setVelocityX(dir * spd);
          if ((b.body.blocked.left || b.body.blocked.right) && b.body.blocked.down) {
            b.setVelocityY(-260);           /* hop the obstacle */
          }
          if (b.body.blocked.down && Math.abs(dy) > 48 && dy < 0 &&
              Math.abs(dx) < 60) {
            b.setVelocityY(-340);           /* player is above: jump up */
          }
        } else if (Math.random() < 0.3) {
          b.setVelocityX((Math.random() < 0.5 ? -1 : 1) * 40);
        }
      }
    });
  }

  function surfacePx(S, wx) {
    var c = Math.max(0, Math.min(WORLD_W - 1, Math.floor(wx / TILE)));
    return world.surfaceY[c] * TILE;
  }

  /* particle burst (ported from old game.js burst()) */
    /* particle burst (ported from old game.js burst()) — capture per-particle
       refs via closure args; the old loop-variable bug let tweens hold
       stale sprites forever = ghost trails */
  function burst(S, x, y, col, n) {
    for (var i = 0; i < n; i++) {
      (function () {
        var a = Math.random() * Math.PI * 2;
        var sp = 60 + Math.random() * 160;
        var p = S.add.rectangle(x, y, 4, 4, col).setDepth(30);
        var dx = Math.cos(a) * sp * 0.4, dyy = Math.sin(a) * sp * 0.4 - 30;
        S.tweens.add({
          targets: p, x: x + dx, y: y + dyy, alpha: 0,
          duration: 420 + Math.random() * 200,
          onComplete: function () { p.destroy(); }
        });
      })();
    }
  }

  var DIG_RANGE = 6;   /* tiles from player center (old game.js parity) */
  function digAt(S, p) {
    var wp = S.cameras.main.getWorldPoint(p.x, p.y);
    var tx = Math.floor(wp.x / TILE), ty = Math.floor(wp.y / TILE);
    /* hover highlight follows the LIVE pointer; stale targets left the
       white box parked on whichever tile was last clicked */
    var dist = Math.abs(tx * TILE + 16 - S.player.x) + Math.abs(ty * TILE + 16 - S.player.y);
    S.digTarget = dist <= DIG_RANGE * TILE
      ? { x: tx, y: ty }
      : null;
  }
  function placeAt(S, p) {
    var wp = S.cameras.main.getWorldPoint(p.x, p.y);
    var tx = Math.floor(wp.x / TILE), ty = Math.floor(wp.y / TILE);
    if (tx < 0 || ty < 0 || tx >= WORLD_W || ty >= WORLD_H) { return; }
    var i = ty * WORLD_W + tx;
    var sel = inventory[hotbarSel];
    if (!sel || world.tile[i] !== 0) { return; }
    /* adjacency rule */
    var nb = (isSolid(tx - 1, ty) || isSolid(tx + 1, ty) || isSolid(tx, ty - 1) ||
              isSolid(tx, ty + 1) || world.wall[i] !== 0);
    if (!nb) { return; }
    var pr = S.player.getBounds();
    var tr = new Phaser.Geom.Rectangle(tx * TILE, ty * TILE, TILE, TILE);
    if (Phaser.Geom.Intersects.RectangleToRectangle(pr, tr)) { return; }
    world.tile[i] = sel.id;
    takeItem(sel.id, 1);
    if (sel.id === 42) {
      S.placedCrystals = S.placedCrystals || {};
      S.placedCrystals[i] = true;             /* re-dig gives item, NOT count */
    }
    refreshStrip(S, tx);
    rebuildSolids(S, tx);     /* placed block must be solid to stand on */
    if (sel.id === 12 || (TILEMETA[sel.id] && TILEMETA[sel.id].light > 0)) {
      /* torch/lava/crystal placed: refreshStrip already ran a windowed
         relight over the area - the placed tile's seed is inside that
         window, so no full relight needed (the old full relight here
         was redundant work per placement) */
      if (sel.id === 12) {
        torchLife[i] = S.time.now + diff().torchLife;
        if (torchLife[i] < nextTorchExpiry) { nextTorchExpiry = torchLife[i]; }
      }
    }
  }
  /* ---- shooting (ported from old game.js: K fires a bolt, bugs die) ---- */
  var BULLET_V = 780, SHOOT_CD = 170, lastShot = 0;
  /* one-time generated glowing-blue bullet texture (radial gradient) */
  function ensureBulletTexture(S) {
    if (S.textures.exists('bolt')) { return; }
    var cv = document.createElement('canvas');
    cv.width = 26; cv.height = 12;
    var ctx = cv.getContext('2d');
    var g = ctx.createRadialGradient(13, 6, 1, 13, 6, 12);
    g.addColorStop(0, 'rgba(220,245,255,1)');
    g.addColorStop(0.35, 'rgba(90,180,255,0.95)');
    g.addColorStop(1, 'rgba(0,0,0,0)');   /* RGB must go to 0 with alpha */
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 26, 12);
    ctx.fillStyle = '#eaf7ff';
    ctx.fillRect(8, 4, 12, 4);           /* hot core streak */
    S.textures.addCanvas('bolt', cv);
  }
  function shoot(S) {
    if (!running || over) { return; }
    if (S.time.now - lastShot < SHOOT_CD) { return; }
    lastShot = S.time.now;
    SFX.shoot();
    ensureBulletTexture(S);
    /* aim: at the pointer if it is inside the window, else facing */
    var aimX = 1, aimY = 0;
    var ap = S.input.activePointer;
    if (ap && (ap.x !== 0 || ap.y !== 0)) {
      var wp2 = S.cameras.main.getWorldPoint(ap.x, ap.y);
      var ddx = wp2.x - S.player.x, ddy = wp2.y - (S.player.y - 52);
      var len = Math.hypot(ddx, ddy);
      if (len > 24) { aimX = ddx / len; aimY = ddy / len; }
      else { aimX = S.player.flipX ? -1 : 1; }
    } else {
      aimX = S.player.flipX ? -1 : 1;
    }
    /* muzzle: clear of the body; if it's inside a solid tile, step the
       spawn out along the aim line so shots never die at birth */
    var mx = S.player.x + aimX * 30, my = S.player.y - 52;
    for (var guard = 0; guard < 3 && isSolid(Math.floor(mx / TILE), Math.floor(my / TILE)); guard++) {
      mx += aimX * 18;
    }
    /* group.create → body owned by the physics group from birth; setting
       velocity AFTER add() was being wiped when the group re-configured
       the fresh body (velocity reset to 0 = bullet hanging in the air) */
    var b = S.bullets.create(mx, my, 'bolt');
    b.setDepth(45);                              /* ABOVE the lightmap: a
                                                    glowing bolt is a light
                                                    SOURCE, it must not be
                                                    dimmed by the MULTIPLY
                                                    darkness */
    b.setBlendMode(Phaser.BlendModes.ADD);      /* glow over the scene */
    b.setRotation(Math.atan2(aimY, aimX));
    b.body.setAllowGravity(false);
    b.body.setSize(14, 6);
    b.setVelocity(aimX * BULLET_V, aimY * BULLET_V);
    /* muzzle flash */
    burst(S, mx, my, 0x5ab4ff, 3);
  }

  /* enemy projectile: slow glowing orb from a spitter. Reuses the
     bolt group (same collider vs world solids, same cleanup) but is
     tinted + flagged hostile so it can hurt the PLAYER and can NEVER
     hurt other enemies. Speed 240 px/s - dodgeable at walking pace. */
  function spitShot(S, b, isF) {
    ensureBulletTexture(S);
    var p = S.player;
    var dx = p.x - b.x, dy = (p.y - 30) - b.y;
    var len = Math.hypot(dx, dy) || 1;
    var sp = isF ? 280 : 240;
    var pr = S.bullets.create(b.x, b.y, 'bolt');
    pr.setDepth(45);
    pr.setBlendMode(Phaser.BlendModes.ADD);
    pr.hostile = true;                       /* hurts player, not bugs */
    pr.setTint(isF ? 0xff8a3d : 0x9ff5b3);   /* ember orange / wisp green */
    pr.setScale(0.85);
    pr.setRotation(Math.atan2(dy, dx));
    pr.body.setAllowGravity(false);
    pr.body.setSize(12, 12);
    pr.setVelocity((dx / len) * sp, (dy / len) * sp);
    SFX.spit ? SFX.spit() : 0;
    burst(S, b.x, b.y, isF ? 0xff8a3d : 0x9ff5b3, 3);
  }

  function isSolid(x, y) {
    if (x < 0 || x >= WORLD_W) { return true; }
    if (y < 0 || y >= WORLD_H) { return false; }
    var m = TILEMETA[world.tile[y * WORLD_W + x]];
    return !!(m && m.solid);
  }

  /* ---- day/night sky ----
     The sky is a gradient rect + sun/moon disc + stars, redrawn onto the
     HUD overlay every few frames. dayT loops 0..1 over DAY_LEN seconds:
     0=dawn, 0.25=noon, 0.5=dusk, 0.75=midnight. World light scales with
     sun height so caves stay dark while the surface dims at night. */
  var DAY_LEN = 120;              /* seconds per full day */
  var dayT = -1;                  /* set from hash in startGame(); 0.06 dawn */
  var SKY_STOPS = [               /* [t, top, bottom] colors */
    [0.00, 0x1a2440, 0x3a3a5c],   /* pre-dawn */
    [0.08, 0x7a9ec9, 0xd9b98a],   /* sunrise */
    [0.25, 0x7aa8e8, 0xb8d4f0],   /* noon */
    [0.45, 0x7a9ec9, 0xe8b88a],   /* golden hour */
    [0.55, 0x2a3455, 0x5a4a6c],   /* dusk */
    [0.75, 0x0a0f22, 0x1a2438],   /* midnight */
    [0.92, 0x1a2440, 0x3a3a5c],   /* back to pre-dawn */
    [1.00, 0x1a2440, 0x3a3a5c]    /* wraps to t=0 pre-dawn: the loop
                                     must cover t in [0,1] FULLY — the
                                     old table stopped at 0.92 and the
                                     fallback returned NOON blue, so
                                     every dawn the sky flashed white
                                     for the last 8% of the cycle */
  ];
  function skyColors(t) {
    for (var i = 0; i < SKY_STOPS.length - 1; i++) {
      var a = SKY_STOPS[i], b = SKY_STOPS[i + 1];
      if (t >= a[0] && t <= b[0]) {
        var f = (t - a[0]) / (b[0] - a[0]);
        return {
          top: lerpColor(a[1], b[1], f),
          bot: lerpColor(a[2], b[2], f),
          dayness: dayFactor(t)
        };
      }
    }
    return { top: SKY_STOPS[2][1], bot: SKY_STOPS[2][2], dayness: 1 };
  }
  function lerpColor(c1, c2, f) {
    var r = ((c1 >> 16) & 255) + (((c2 >> 16) & 255) - ((c1 >> 16) & 255)) * f;
    var g = ((c1 >> 8) & 255) + (((c2 >> 8) & 255) - ((c1 >> 8) & 255)) * f;
    var b = (c1 & 255) + ((c2 & 255) - (c1 & 255)) * f;
    return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  }
  /* sun elevation 0..1: rises 0→0.25 (noon), falls to 0 at 0.5 (dusk),
     stays 0 through the night half */
  function dayFactor(t) {
    return t >= 0.5 ? 0 : Math.sin(t / 0.5 * Math.PI);
  }
  function cssColor(c) {
    return 'rgb(' + ((c >> 16) & 255) + ',' + ((c >> 8) & 255) + ',' + (c & 255) + ')';
  }

  /* ---- DOM overlays: sky canvas (z0, BEHIND the transparent game
     canvas) + HUD canvas (z6, on top). The old darkness layer is gone. ---- */
  /* overlays are sized to the GAME CANVAS — not the chat box. In
     fullscreen the chat (100% of screen) is larger than the canvas
     (which keeps its pre-fullscreen size under Scale.RESIZE unless
     refreshed); sky painted at chat size showed as a bright rectangle
     extending past the world. Matching the canvas rect keeps the sky
     exactly behind the world. */
  function ensureOverlays(S) {
    if (getComputedStyle(chat).position === 'static') { chat.style.position = 'relative'; }
    var skyCv = document.getElementById('eggSkyOverlay');
    if (!skyCv) {
      skyCv = document.createElement('canvas');
      skyCv.id = 'eggSkyOverlay';
      skyCv.style.cssText =
        'position:absolute;left:0;top:0;pointer-events:none;z-index:0;';
      chat.insertBefore(skyCv, chat.firstChild);
    }
    var hudCv = document.getElementById('eggHudOverlay');
    if (!hudCv) {
      hudCv = document.createElement('canvas');
      hudCv.id = 'eggHudOverlay';
      hudCv.style.cssText =
        'position:absolute;left:0;top:0;pointer-events:none;z-index:6;';
      chat.appendChild(hudCv);
    }
    var gc = S.game.canvas;
    gc.style.position = 'relative';
    gc.style.zIndex = '1';
    sizeOverlays(S);
  }
  function sizeOverlays(S) {
    var skyCv = document.getElementById('eggSkyOverlay');
    var hudCv = document.getElementById('eggHudOverlay');
    var gc = S.game && S.game.canvas;
    if (!skyCv || !hudCv || !gc) { return; }
    /* pin overlays to the game canvas rect (offsets handle the canvas
       being offset inside chat; sizes match 1:1 so no bleed) */
    var cr = chat.getBoundingClientRect();
    var gr = gc.getBoundingClientRect();
    var left = Math.round(gr.left - cr.left), top = Math.round(gr.top - cr.top);
    var w = Math.round(gr.width), h = Math.round(gr.height);
    [[skyCv, 0], [hudCv, 6]].forEach(function (pair) {
      var cv = pair[0];
      cv.style.left = left + 'px';
      cv.style.top = top + 'px';
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
      if (cv.width !== w || cv.height !== h) {
        cv.width = w; cv.height = h;
      }
    });
  }

  /* ---- world-space lightmap: the ACTUAL light engine ---------------
     skyLight (Uint8/tile): 255 where open sky reaches a cell (air
     column down to the first solid tile), with a 4-row soft falloff
     under the surface line. Static until geometry changes.
     torchField (Uint8/tile): BFS flood from torch tiles; air decays
     18/tile (~14 tiles reach), solid 64/tile (~4 tiles) so light
     mostly stays in caves but warms nearby walls.
     paintLight composes: light = max(ambient + sky, torch); alpha =
     255 - light into the 512x256 canvas, refreshed as one texture. */

  var skyLight = null, torchField = null;

  /* ---- Terraria-style COLORED torch light ----
     Three channels (R/G/B) propagated independently, so a warm torch
     fades white -> gold -> orange -> dull red at the rim (hue shifts
     with brightness like real firelight; a scalar field with a fixed
     tint cannot do that). Decay is MULTIPLICATIVE (v *= f): smooth
     exponential pools instead of linear BFS rings, and solid tiles
     decay much harder than air = occlusion. */
  var TORCH_R = 255, TORCH_G = 214, TORCH_B = 130;  /* seed color */
  var AIR_F = 0.86, WALL_F = 0.60;                  /* decay air/solid */
  /* torch-only boost curve: v_out = 255*(v/255)^(1/1.25). Applied to
     the torch channels INSTEAD of the ambient gamma so the pool reads
     BRIGHT through its mid-range (a shared 1/1.7 curve left the whole
     pool muddy - "torches too dark"). Reach ~21 air tiles. */
  var TORCH_LUT = (function () {
    var t = new Uint8Array(256);
    for (var v = 0; v < 256; v++) {
      t[v] = Math.round(255 * Math.pow(v / 255, 1 / 1.25));
    }
    return t;
  })();
  var torchR = null, torchG = null, torchB = null;
  /* emissive buffers: light-SOURCE tiles render at full intensity
     (their own pixel in the lightmap = their lightColor). Without this,
     a lava pool at the bottom of a dark cave multiplied down to its
     0.4-strength seed and became invisible - the "light sources you
     can't see" problem. emisKind: 0 = not a source, 1 = torch,
     2 = strong glow (>=0.35), 3 = faint glow (<0.35); rebuilt by
     seedTorches alongside the torch seeds so emissive and propagation
     stay in lock-step. */
  var emisR = null, emisG = null, emisB = null;
  var emisKind = null;
  var torchField = null;   /* mono snapshot for held-torch window logic */

  function ensureTorchBufs() {
    var n = WORLD_W * WORLD_H;
    if (!torchR) {
      torchR = new Uint8ClampedArray(n);
      torchG = new Uint8ClampedArray(n);
      torchB = new Uint8ClampedArray(n);
      torchField = new Uint8Array(n);
      emisR = new Uint8Array(n);
      emisG = new Uint8Array(n);
      emisB = new Uint8Array(n);
      emisKind = new Uint8Array(n);
    }
  }

  function resetTorchField() {
    ensureTorchBufs();
    torchR.fill(0); torchG.fill(0); torchB.fill(0); torchField.fill(0);
    emisR.fill(0); emisG.fill(0); emisB.fill(0); emisKind.fill(0);
  }

  function seedTorches(now, x0, y0, x1, y1) {
    if (x0 === undefined) { x0 = 0; y0 = 0; x1 = WORLD_W - 1; y1 = WORLD_H - 1; }
    for (var y = y0; y <= y1; y++) {
      var row = y * WORLD_W;
      for (var x = x0; x <= x1; x++) {
        var i = row + x;
        var t = world.tile[i];
        var m = t ? TILEMETA[t] : null;
        var lum = m && m.light ? m.light : 0;
        if (t === 12) {              /* TORCH: warm full-strength */
        /* fuel check: worldgen torches (no registry entry) burn eternal;
           player-placed ones gutter out when their clock runs down */
        if (torchLife[i] && torchLife[i] < now) { continue; }
        torchR[i] = TORCH_R; torchG[i] = TORCH_G; torchB[i] = TORCH_B;
        torchField[i] = 255;
        emisR[i] = TORCH_R; emisG[i] = TORCH_G; emisB[i] = TORCH_B;
        emisKind[i] = 1;
        } else if (lum > 0) {
        /* data-driven glow: crystal/coral/lava/mushroom etc. Terraria-style
           COLORED light: meta may carry lightColor:[r,g,b]; without one,
           fall back to the warm torch tint (scaled), same as before. */
        var sr, sg, sb;
        if (m.lightColor && m.lightColor.length === 3) {
          sr = m.lightColor[0]; sg = m.lightColor[1]; sb = m.lightColor[2];
        } else {
          sr = TORCH_R; sg = TORCH_G; sb = TORCH_B * 1.3;
        }
        /* ORE beacons: gold(10) / diamond(11) / amethyst(42) light at
           FULL torch strength in their own color - the deep-cave
           amethyst objective must glow across a cave like a placed
           torch, not a faint 0.35 tint. Everything else keeps the
           meta strength (decorative glows x1.25 boost below). */
        var oreGlow = (t === 10 || t === 11 || t === 42);
        var lumSeed = oreGlow ? 1
          : (lum < 0.35 ? Math.min(1, lum * 1.25) : lum);
        torchR[i] = Math.round(sr * lumSeed);
        torchG[i] = Math.round(sg * lumSeed);
        torchB[i] = Math.round(sb * lumSeed);
        torchField[i] = Math.round(255 * lumSeed);
        /* emissive self-illumination only for REAL light emitters
           (lumSeed >= 0.35: torches, ores, lava, diamond, amethyst).
           Decorative glows (coral, ice, mushroom) keep their tinted
           pool but never light their own cell. */
        if (lumSeed >= 0.35) {
          emisR[i] = sr; emisG[i] = sg; emisB[i] = sb;
          emisKind[i] = 2;
        }
      }
      }
    }
  }

  /* per-cell relaxation: incoming = max of the 4 neighbors, each decayed
     by THIS tile's factor (occlusion); keep max(self, incoming). */
  function relCell(i, x, y, W, H, fr, fg, fb) {
    var L = x > 0 ? i - 1 : -1,
        R = x < W - 1 ? i + 1 : -1,
        U = y > 0 ? i - W : -1,
        D = y < H - 1 ? i + W : -1;
    var f = isSolid(x, y) ? WALL_F : AIR_F;
    var r = Math.max(L < 0 ? 0 : fr[L] * f, R < 0 ? 0 : fr[R] * f,
                     U < 0 ? 0 : fr[U] * f, D < 0 ? 0 : fr[D] * f);
    var g = Math.max(L < 0 ? 0 : fg[L] * f, R < 0 ? 0 : fg[R] * f,
                     U < 0 ? 0 : fg[U] * f, D < 0 ? 0 : fg[D] * f);
    var b = Math.max(L < 0 ? 0 : fb[L] * f, R < 0 ? 0 : fb[R] * f,
                     U < 0 ? 0 : fb[U] * f, D < 0 ? 0 : fb[D] * f);
    if (r > fr[i]) { fr[i] = r; }
    if (g > fg[i]) { fg[i] = g; }
    if (b > fb[i]) { fb[i] = b; }
  }

  /* four directional sweeps (LR, RL, TB, BT) x 2 rounds: two rounds let
     light wrap corners softly (diagonal leakage, like Terraria). Runs
     on 512x256 x 3 channels - a few ms, same league as the old BFS. */
  function sweepRGB(fr, fg, fb, x0, y0, x1, y1) {
    var W = WORLD_W, H = WORLD_H;
    var round, x, y;
    for (round = 0; round < 2; round++) {
      for (y = y0; y <= y1; y++) {
        var row = y * W;
        for (x = x0; x <= x1; x++) { relCell(row + x, x, y, W, H, fr, fg, fb); }
        for (x = x1; x >= x0; x--) { relCell(row + x, x, y, W, H, fr, fg, fb); }
      }
      for (y = y1; y >= y0; y--) {
        var row2 = y * W;
        for (x = x0; x <= x1; x++) { relCell(row2 + x, x, y, W, H, fr, fg, fb); }
        for (x = x1; x >= x0; x--) { relCell(row2 + x, x, y, W, H, fr, fg, fb); }
      }
    }
  }

  /* full-world torch pass: reset -> seed every torch tile -> sweep. */
  function computeTorchField(now) {
    resetTorchField();
    seedTorches(now || 0);
    sweepRGB(torchR, torchG, torchB, 0, 0, WORLD_W - 1, WORLD_H - 1);
  }

  /* gutter out expired torches: remove tile + smoke + windowed relight
     (per torch, not per sweep) + track nextTorchExpiry so update()
     can act on expiry within a frame (the 3s poll alone left dead
     torches lit for up to 3s and out of sync with the fuel HUD) */
  var nextTorchExpiry = Infinity;
  function gutterTorches(S) {
    if (!torchLife) { return; }
    var now = S.time.now;
    nextTorchExpiry = Infinity;
    var dirty = false;
    for (var k in torchLife) {
      if (torchLife[k] < now) {
        var ti = k | 0;
        if (world.tile[ti] === 12) {
          world.tile[ti] = 0;
          refreshStrip(S, ti % WORLD_W);
          burst(S, (ti % WORLD_W) * TILE + 16,
            Math.floor(ti / WORLD_W) * TILE + 16, 0x555555, 6);
          dirty = true;
        }
        delete torchLife[k];
      } else if (torchLife[k] < nextTorchExpiry) {
        nextTorchExpiry = torchLife[k];
      }
    }
    return dirty;
  }

  /* skyLight (Uint8/tile): 255 where open sky reaches a cell (air
     column down to the first solid tile), with a soft falloff into the
     first solid rows below the surface line. Static until geometry
     changes. */
  /* solidBits: 1 per solid tile, 0 per air - the solid-aware blur's
     occlusion mask. Rebuilt on every geometry change (relight /
     windowRelight), reads world.tile via isSolid(). */
  var solidBits = null;
  function rebuildSolidBits(x0, y0, x1, y1) {
    if (!solidBits) { solidBits = new Uint8Array(WORLD_W * WORLD_H); }
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        solidBits[y * WORLD_W + x] = isSolid(x, y) ? 1 : 0;
    }
    }
  }

  function computeSkyLight() {
    skyLight = skyLight || new Uint8Array(WORLD_W * WORLD_H);
    skyLight.fill(0);
    /* seed: cells with a clear column to the sky = full light */
    for (var x = 0; x < WORLD_W; x++) {
      for (var y = 0; y < WORLD_H; y++) {
        var i = y * WORLD_W + x;
        var m = TILEMETA[world.tile[i]];
        if (m && m.solid) { break; }
        skyLight[i] = 255;
      }
    }
    /* BLEED: relax the sky field sideways through air, exactly like
       the torch field. Replaces the old per-column 4-step staircase
       (190/73/46/32 -> 0), which painted a hard horizontal "fog line"
       ~4 tiles under every surface and inside every pit - the visible
       light/dark boundary. Now cave mouths and pit walls get a smooth
       exponential falloff instead.
       airF matches AIR_F (torch air decay) so sky and torch pools
       share ONE falloff feel at cave mouths - the old 0.74/0.40 pair
       made the two sources transition differently across the same
       opening ("split style" at the threshold). */
    sweepScalar(skyLight, 0, 0, WORLD_W - 1, WORLD_H - 1, AIR_F, 0.40);
  }

  /* scalar variant of the four-sweep relaxation (see sweepRGB): each
     cell takes the best of its 4 neighbors decayed by THIS cell's
     factor (air vs solid). 2 rounds = light wraps corners softly. */
  function sweepScalar(f, x0, y0, x1, y1, airF, wallF) {
    var W = WORLD_W, H = WORLD_H;
    for (var round = 0; round < 2; round++) {
      for (var y = y0; y <= y1; y++) {
        var row = y * W;
        for (var x = x0; x <= x1; x++) { relaxScalar(row + x, x, y, W, H, f, airF, wallF); }
        for (var x2 = x1; x2 >= x0; x2--) { relaxScalar(row + x2, x2, y, W, H, f, airF, wallF); }
      }
      for (var y2 = y1; y2 >= y0; y2--) {
        var row2 = y2 * W;
        for (var x3 = x0; x3 <= x1; x3++) { relaxScalar(row2 + x3, x3, y2, W, H, f, airF, wallF); }
        for (var x4 = x1; x4 >= x0; x4--) { relaxScalar(row2 + x4, x4, y2, W, H, f, airF, wallF); }
      }
    }
  }

  function relaxScalar(i, x, y, W, H, f, airF, wallF) {
    var L = x > 0 ? i - 1 : -1,
        R = x < W - 1 ? i + 1 : -1,
        U = y > 0 ? i - W : -1,
        D = y < H - 1 ? i + W : -1;
    var fa = isSolid(x, y) ? wallF : airF;
    var v = Math.max(L < 0 ? 0 : f[L] * fa, R < 0 ? 0 : f[R] * fa,
                     U < 0 ? 0 : f[U] * fa, D < 0 ? 0 : f[D] * fa);
    if (v > f[i]) { f[i] = v; }
  }

  /* compose sky + torch into the lightmap canvas. BRIGHTNESS lives in
     RGB (alpha stays 255): Phaser MULTIPLY multiplies RGB and IGNORES
     alpha (alpha-encoded maps were a no-op - the "torches didn't glow"
     bug). Composition per channel: out = max(surfaceTint, torchRGB,
     emissive), then a gamma LUT lifts dim values so light pools read
     bright and shadow edges stay soft instead of muddy.

     zone: null = full map (create / full relight); 'view' = camera
     viewport only (the 20 Hz ambient tick - visible tiles are ~8% of
     the map, so clipping cuts the CPU pixel pipeline ~12x); a tile
     rect {x0,y0,x1,y1} = local window relights (dig/place/torch).
     All buffers are persistent (no per-call 512KB allocations - the
     old version allocated a scratch canvas + typed array every 50ms,
     20 Hz GC pressure). lightComp always holds the LATEST composed
     value of every pixel, so a zone blur can read correct unblurred
     inputs just outside its border: no seams. */
  var BLUR_R = 2;   /* box-blur radius in tiles */

  function paintLight(S, zone) {
    var day = dayFactor(dayT);
    /* surface tint: neutral white at noon, warm gold at golden hour,
       cool moonlight blue at night. Lerp in RGB between keyed stops. */
    var noon   = [255, 250, 242];   /* high sun: near-neutral */
    var golden = [255, 216, 156];   /* sunrise / sunset */
    var night  = [104, 122, 158];   /* moonlight (cool, dim) */
    var surf;
    if (day > 0.35) {
      var f = (day - 0.35) / 0.65;             /* 0..1 toward noon */
      surf = lerp3(golden, noon, f);
    } else {
      var f2 = day / 0.35;                     /* 0..1 toward golden */
      surf = lerp3(night, golden, f2);
    }
    /* scale the tint so peak brightness never exceeds noon white:
       lerp3 the COLOR, then multiply by the day brightness curve */
    var bright = 0.42 + 0.58 * day;            /* 0.42 night .. 1 noon */
    var sR = Math.round(surf[0] * bright),
        sG = Math.round(surf[1] * bright),
        sB = Math.round(surf[2] * bright);
    /* cave floor: dim cool blue-gray (deep shadow, not pure black -
       pure black MULTIPLY crushes all tile detail) */
    var cR = 30, cG = 32, cB = 40;

    var W = WORLD_W, H = WORLD_H;
    if (zone === 'view') {
      var vw = S.cameras.main.worldView;
      zone = { x0: Math.floor(vw.x / TILE), y0: Math.floor(vw.y / TILE),
               x1: Math.ceil((vw.x + vw.width) / TILE),
               y1: Math.ceil((vw.y + vw.height) / TILE) };
    }
    /* zx/zy = the zone whose DISPLAY must be correct;
       px/py = blur+put region (zone + BLUR_R halo, so the ring just
       outside a window relight also gets re-blurred from fresh
       inputs);  cx/cy = compose region (needs 2*BLUR_R reach for the
       separable h+v kernels). */
    var zx0 = 0, zy0 = 0, zx1 = W - 1, zy1 = H - 1;
    if (zone) {
      zx0 = Math.max(0, zone.x0); zy0 = Math.max(0, zone.y0);
      zx1 = Math.min(W - 1, zone.x1); zy1 = Math.min(H - 1, zone.y1);
    }
    var px0 = Math.max(0, zx0 - BLUR_R), py0 = Math.max(0, zy0 - BLUR_R),
        px1 = Math.min(W - 1, zx1 + BLUR_R), py1 = Math.min(H - 1, zy1 + BLUR_R);
    var cx0 = Math.max(0, zx0 - 2 * BLUR_R), cy0 = Math.max(0, zy0 - 2 * BLUR_R),
        cx1 = Math.min(W - 1, zx1 + 2 * BLUR_R), cy1 = Math.min(H - 1, zy1 + 2 * BLUR_R);

    var ctx = S.lightCv.getContext('2d');
    if (!S.gammaLUT || S.gammaLUT.day !== day.toFixed(3)) {
      S.gammaLUT = makeGammaLUT(day);
    }
    var lut = S.gammaLUT.t;
    /* persistent buffers:
       lightComp - composed (pre-blur) RGBA for the WHOLE map
       hOut      - horizontal blur scratch
       lightImg  - final blur output ImageData (putImageData source)
       All full-map, allocated once. */
    if (!S.lightComp) { S.lightComp = new Uint8ClampedArray(W * H * 4); }
    if (!S.hOut)      { S.hOut = new Uint8ClampedArray(W * H * 4); }
    if (!S.lightImg)  { S.lightImg = ctx.createImageData(W, H); }
    var comp = S.lightComp, hOut = S.hOut, out = S.lightImg.data;

    /* 1. compose: ambient(sky-day tint) vs torch (own brighter LUT)
       vs emissive (source tiles at display intensity) - per channel. */
    for (var y = cy0; y <= cy1; y++) {
      var row = y * W;
      for (var x = cx0; x <= cx1; x++) {
        var i = row + x, p4 = i * 4;
        var s = skyLight[i] / 255;                /* 0..1 sky reach */
        var baseR = cR + (sR - cR) * s,
            baseG = cG + (sG - cG) * s,
            baseB = cB + (sB - cB) * s;
        var tR = TORCH_LUT[torchR[i]],
            tG = TORCH_LUT[torchG[i]],
            tB = TORCH_LUT[torchB[i]];
        var oR = lut[baseR | 0], oG = lut[baseG | 0], oB = lut[baseB | 0];
        if (tR > oR) { oR = tR; }
        if (tG > oG) { oG = tG; }
        if (tB > oB) { oB = tB; }
        var eR = emisR[i], eG = emisG[i], eB = emisB[i];
        if (eR > oR) { oR = eR; }
        if (eG > oG) { oG = eG; }
        if (eB > oB) { oB = eB; }
        comp[p4] = oR; comp[p4 + 1] = oG; comp[p4 + 2] = oB; comp[p4 + 3] = 255;
      }
    }

    /* 2. horizontal blur pass (solid-aware). A bright air cell no
       longer averages in samples from across a wall - the old
       isotropic blur smeared light THROUGH 1-2 tile walls (thin-wall
       leak). Rule: AIR centers skip SOLID samples; SOLID centers
       still sample air (a lit wall face may glow, but the far-side
       air never samples across the wall). */
    for (var y2 = cy0; y2 <= cy1; y2++) {
      var row2 = y2 * W;
      for (var x2 = px0; x2 <= px1; x2++) {
        var c2 = row2 + x2, cs = solidBits[c2];
        var sumR = 0, sumG = 0, sumB = 0, n = 0;
        for (var k = -BLUR_R; k <= BLUR_R; k++) {
          var xi = x2 + k;
          if (xi < cx0 || xi > cx1) { continue; }
          var si = row2 + xi;
          if (cs === 0 && solidBits[si] !== 0) { continue; }
          var q = si * 4;
          sumR += comp[q]; sumG += comp[q + 1]; sumB += comp[q + 2]; n++;
        }
        var o2 = c2 * 4;
        hOut[o2] = sumR / n; hOut[o2 + 1] = sumG / n; hOut[o2 + 2] = sumB / n;
        hOut[o2 + 3] = 255;
      }
    }

    /* 3. vertical blur pass (same solid rule), then emissive re-max:
       a source tile's own pixel must never average BELOW its glow. */
    for (var y3 = py0; y3 <= py1; y3++) {
      var row3 = y3 * W;
      for (var x3 = px0; x3 <= px1; x3++) {
        var c3 = row3 + x3, cs3 = solidBits[c3];
        var s2R = 0, s2G = 0, s2B = 0, n2 = 0;
        for (var k2 = -BLUR_R; k2 <= BLUR_R; k2++) {
          var yi = y3 + k2;
          if (yi < cy0 || yi > cy1) { continue; }
          var si2 = yi * W + x3;
          if (cs3 === 0 && solidBits[si2] !== 0) { continue; }
          var q2 = si2 * 4;
          s2R += hOut[q2]; s2G += hOut[q2 + 1]; s2B += hOut[q2 + 2]; n2++;
        }
        var o3 = c3 * 4;
        var vR = s2R / n2, vG = s2G / n2, vB = s2B / n2;
        if (emisKind[c3]) {
          if (emisR[c3] > vR) { vR = emisR[c3]; }
          if (emisG[c3] > vG) { vG = emisG[c3]; }
          if (emisB[c3] > vB) { vB = emisB[c3]; }
        }
        out[o3] = vR; out[o3 + 1] = vG; out[o3 + 2] = vB; out[o3 + 3] = 255;
      }
    }

    /* 4. upload only the dirty rect */
    ctx.putImageData(S.lightImg, 0, 0,
                     px0, py0, px1 - px0 + 1, py1 - py0 + 1);
    S.lightTex.refresh();
  }

  function lerp3(a, b, f) {
    return [a[0] + (b[0] - a[0]) * f,
            a[1] + (b[1] - a[1]) * f,
            a[2] + (b[2] - a[2]) * f];
  }

  /* output gamma: MULTIPly lightmaps look muddy because mid-dim values
     sit too low on the sRGB curve. v_out = 255*(v/255)^(1/2.2) would
     overexpose; a gentler 1/1.7 keeps the top end clean while lifting
     shadow detail. */
  function makeGammaLUT(day) {
    var t = new Uint8Array(256);
    for (var v = 0; v < 256; v++) {
      t[v] = Math.round(255 * Math.pow(v / 255, 1 / 1.7));
    }
    return { t: t, day: day.toFixed(3) };
  }

  /* held torch: the player carries a moving light. A full-world sweep
     per frame is too much; instead a local window relight - snapshot
     the RGB field in a HELD_R box, restore it when the torch moves,
     then seed the held-torch tile and sweep inside the box only. */
  var HELD_R = 22;   /* > torch reach (0.8^t < ~0.08 around t=12 air
                        tiles; 22 gives the pool room to fade without a
                        square clip at the window edge) */

  function heldRestore(S) {
    if (!S.heldTorchAt || !S.heldSnap) { return; }
    var ox = S.heldTorchAt[0], oy = S.heldTorchAt[1], R = HELD_R;
    var stride = 2 * R + 1;
    for (var yy = oy - R; yy <= oy + R; yy++) {
      for (var xx = ox - R; xx <= ox + R; xx++) {
        if (xx < 0 || xx >= WORLD_W || yy < 0 || yy >= WORLD_H) { continue; }
        var wi = yy * WORLD_W + xx;
        var sIdx = (yy - (oy - R)) * stride + (xx - (ox - R));
        torchR[wi] = S.heldSnap[sIdx * 3];
        torchG[wi] = S.heldSnap[sIdx * 3 + 1];
        torchB[wi] = S.heldSnap[sIdx * 3 + 2];
      }
    }
    S.heldTorchAt = null; S.heldSnap = null;
  }

  function heldTorchRelight(S) {
    ensureTorchBufs();
    var pt = S.player;
    var tx = Math.floor((pt.x + (pt.flipX ? -14 : 14)) / TILE);
    var ty = Math.floor((pt.y - 46) / TILE);
    if (S.heldTorchAt && S.heldTorchAt[0] === tx && S.heldTorchAt[1] === ty) {
      return;                                   /* not moved a tile */
    }
    heldRestore(S);                             /* undo the old window */
    var R2 = HELD_R;
    /* snapshot the new window (interleaved RGB) */
    S.heldSnap = new Uint8ClampedArray((2 * R2 + 1) * (2 * R2 + 1) * 3);
    var stride = 2 * R2 + 1;
    for (var yy2 = ty - R2; yy2 <= ty + R2; yy2++) {
      for (var xx2 = tx - R2; xx2 <= tx + R2; xx2++) {
        var sIdx = (yy2 - (ty - R2)) * stride + (xx2 - (tx - R2));
        if (xx2 < 0 || xx2 >= WORLD_W || yy2 < 0 || yy2 >= WORLD_H) {
          continue;                             /* restore skips OOB too */
        }
        var wi = yy2 * WORLD_W + xx2;
        S.heldSnap[sIdx * 3] = torchR[wi];
        S.heldSnap[sIdx * 3 + 1] = torchG[wi];
        S.heldSnap[sIdx * 3 + 2] = torchB[wi];
      }
    }
    /* seed the held torch, then sweep INSIDE the window only. Border
       cells keep their incoming values from outside the window (the
       sweep reads neighbors, never zeroes them), so the pool blends
       into the surrounding field with no visible seam. */
    if (tx >= 0 && tx < WORLD_W && ty >= 0 && ty < WORLD_H) {
      var seed = ty * WORLD_W + tx;
      torchR[seed] = TORCH_R; torchG[seed] = TORCH_G; torchB[seed] = TORCH_B;
    }
    var x0 = Math.max(0, tx - R2), x1 = Math.min(WORLD_W - 1, tx + R2);
    var y0 = Math.max(0, ty - R2), y1 = Math.min(WORLD_H - 1, ty + R2);
    sweepRGB(torchR, torchG, torchB, x0, y0, x1, y1);
    S.heldTorchAt = [tx, ty];
    /* compose only the held-torch window + blur halo (was full-map) */
    paintLight(S, { x0: x0, y0: y0, x1: x1, y1: y1 });
  }

  function relight(S) {
    rebuildSolidBits(0, 0, WORLD_W - 1, WORLD_H - 1);
    computeSkyLight();
    computeTorchField(S && S.time ? S.time.now : 0);
    /* geometry changed: any held-torch window is stale — drop it so
       the next frame rebuilds from the fresh field */
    S.heldTorchAt = null; S.heldSnap = null;
    paintLight(S);
  }

  /* ---- windowed local relight: dig/place/torch-expiry ---------------
     A dig/place changes light in a radius = light reach (~22 tiles)
     around the changed column. Full-world sweeps made rapid digging
     relight the ENTIRE 512x256 field per block (the top perf hit).
     Window approach (same trick as the held torch):
       1. snapshot skyLight + torch RGB + emissive in a W_R box
       2. re-seed the sky column seeds INSIDE the box only (open-sky
          columns re-lit to 255 down to first solid), re-seed torch
          tiles inside the box, then sweep INSIDE the box
       3. sweep uses max() so borders blend into the untouched field
       4. paintLight(zone) composites only the box + blur halo
     Sky needs special handling: a dig that opens a shaft to the sky
     lights the whole column; seeding per-column inside the box covers
     exactly that. */
  var W_R = 24;   /* window radius: > torch reach (21) + margin */

  function windowRelight(S, cx, cy) {
    ensureTorchBufs();
    heldRestore(S);            /* undo held-torch window first: field
                                  must be the persisted base */
    var x0 = Math.max(0, cx - W_R), x1 = Math.min(WORLD_W - 1, cx + W_R);
    var y0 = Math.max(0, cy - W_R), y1 = Math.min(WORLD_H - 1, cy + W_R);

    /* geometry changed inside the window: refresh the blur mask there
       BEFORE sky seeding reads it */
    rebuildSolidBits(x0, y0, x1, y1);

    /* 1. zero + re-seed INSIDE the window */
    for (var y = y0; y <= y1; y++) {
      var row = y * WORLD_W;
      for (var x = x0; x <= x1; x++) {
        var i = row + x;
        skyLight[i] = 0;
        torchR[i] = 0; torchG[i] = 0; torchB[i] = 0;
        emisR[i] = 0; emisG[i] = 0; emisB[i] = 0; emisKind[i] = 0;
      }
    }
    /* sky seeds: per column, scan from WORLD TOP to first solid (same
       rule as computeSkyLight), then light the non-solid cells of that
       column that fall INSIDE the window. A dig can only open a shaft
       where it dug (inside the window), so above-window cells keep
       their already-correct values. */
    for (var x2 = x0; x2 <= x1; x2++) {
      for (var y2 = 0; y2 <= y1; y2++) {
        var i2 = y2 * WORLD_W + x2;
        if (solidBits[i2]) { break; }        /* first solid ends the column */
        if (y2 >= y0) { skyLight[i2] = 255; }
      }
    }
    /* torch + emissive seeds inside the window (same rules as full) */
    seedTorches(S.time ? S.time.now : 0, x0, y0, x1, y1);

    /* 2. sweeps inside the window. Border cells keep their incoming
       values from outside (max-only), so pools blend seamlessly. */
    sweepScalar(skyLight, x0, y0, x1, y1, AIR_F, 0.40);
    sweepRGB(torchR, torchG, torchB, x0, y0, x1, y1);

    /* 3. compose just the window + halo */
    paintLight(S, { x0: x0, y0: y0, x1: x1, y1: y1 });
  }



  /* ---- sky (2d ctx on the BOTTOM overlay, behind the game canvas) ---- */
  function drawSky(S) {
    var ctx = S.skyCtx;
    if (!ctx) { return null; }
    var w = ctx.canvas.width, h = ctx.canvas.height;
    var sky = skyColors(dayT);
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, cssColor(sky.top));
    grad.addColorStop(1, cssColor(sky.bot));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    /* sun / moon arc across the top of the window */
    var ang, isDay = dayT < 0.5;
    if (isDay) { ang = (dayT / 0.5) * Math.PI; }
    else { ang = ((dayT - 0.5) / 0.5) * Math.PI; }
    var cx = w * (0.08 + 0.84 * (ang / Math.PI));
    var cy = h * 0.30 - Math.sin(ang) * h * 0.24;
    ctx.beginPath();
    if (isDay) {
      ctx.fillStyle = '#ffe9a8';
      ctx.shadowColor = 'rgba(255,220,120,.9)';
      ctx.shadowBlur = 26;
    } else {
      ctx.fillStyle = '#e8ecf5';
      ctx.shadowColor = 'rgba(210,225,255,.7)';
      ctx.shadowBlur = 18;
    }
    ctx.arc(cx, cy, isDay ? 17 : 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (!isDay) {   /* moon crater bite */
      ctx.fillStyle = cssColor(sky.top);
      ctx.beginPath();
      ctx.arc(cx + 7, cy - 4, 10, 0, Math.PI * 2);
      ctx.fill();
    }

    /* stars fade in as the sun sets */
    if (sky.dayness < 0.45) {
      var sa = Math.min(1, (0.45 - sky.dayness) / 0.3);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.85 * sa) + ')';
      for (var st = 0; st < 40; st++) {
        var sx = (st * 971) % w, sy = (st * 613) % (h * 0.55);
        var tw = 0.6 + 0.4 * Math.sin((S.time.now / 700) + st * 1.7);
        ctx.globalAlpha = sa * tw;
        ctx.fillRect(sx, sy, 2, 2);
      }
      ctx.globalAlpha = 1;
    }

    /* ---- Terraria backdrop: clouds / snow mountains / forest line /
       grass hills, drawn INTO this sky canvas (under the game canvas, so
       the world lightmap can never darken them). Parallax via camera x
       with tiny factors; brightness follows the day cycle. ---- */
    drawBackdrop(S, ctx, w, h, sky);
    return sky;
  }

  /* ---- Terraria-style backdrop: hand-painted CC0 layers by MatiasVME
     (opengameart.org/content/parallax-background-forest-pixel-art).
     8 seamless 1280x360 layers blitted with per-layer parallax into the
     DOM sky canvas (never touched by the world lightmap). ---- */
  var _bkTex = null;
  var _bkLoaded = false;
  var _bkGround = null;
  var _bkDbg = false;
  /* depth treatment baked per layer at LOAD time (blur + aerial haze with
     'source-atop', so the wash only tints THIS layer, never the canvas):
       far mountains = softest + most washed, near trees = crisp.
     The pack's own sky/sun layers are NOT used: drawSky already renders a
     day/night gradient + sun/moon + stars. */
  var BK_HAZE = '#cdd8dd';   /* aerial haze: bright desaturated gray-blue */
  /* Admurin snowy-mountains set (CC-BY 4.0, recolored to Terraria daylight
     slate) + brightened plains forests. Files live in assets/scenery/bg/. */
  var BK_DEFS = [
    { n: 'clouds',       blur: 0, haze: 0.12, fx: 0.01,  top: 0.05 },
    { n: 'ridge',        blur: 0, haze: 0.52, fx: 0.018 },
    { n: 'peaks',        blur: 0, haze: 0.34, fx: 0.03 },
    { n: 'rocks_gray',   blur: 0, haze: 0.18, fx: 0.05 },
    { n: 'forest_3',     blur: 0, haze: 0.06, fx: 0.08 },
    { n: 'forest_2',     blur: 0, haze: 0,    fx: 0.12 },
    { n: 'trees_near',   blur: 0, haze: 0,    fx: 0.18 }
  ];
  function loadBackdropLayers() {
    if (_bkLoaded || typeof Image === 'undefined') { return; }
    _bkLoaded = true;
    _bkTex = { img: {} };
    BK_DEFS.forEach(function (d) {
      var im = new Image();
      im.onload = function () {
        if (!d.blur && !d.haze) { _bkTex.img[d.n] = im; return; }
        /* bake: blur, then haze tinted ONLY onto this layer's pixels */
        var c = document.createElement('canvas');
        c.width = im.width; c.height = im.height;
        var x2 = c.getContext('2d');
        if (d.blur) { x2.filter = 'blur(' + d.blur + 'px)'; }
        x2.drawImage(im, 0, 0);
        x2.filter = 'none';
        if (d.haze) {
          x2.globalCompositeOperation = 'source-atop';
          x2.globalAlpha = d.haze;
          x2.fillStyle = BK_HAZE;
          x2.fillRect(0, 0, c.width, c.height);
          x2.globalCompositeOperation = 'source-over';
          x2.globalAlpha = 1;
        }
        _bkTex.img[d.n] = c;
        /* remember the NEAREST layer's bottom-edge color: used to extend
           the backdrop to the canvas bottom when jumps expose it */
        if (d.n === 'trees_near') {
          var p2 = c.getContext('2d').getImageData(6, c.height - 2, 1, 1).data;
          _bkGround = 'rgb(' + p2[0] + ',' + p2[1] + ',' + p2[2] + ')';
        }
      };
      im.src = 'assets/scenery/bg/' + d.n + '.png';
      _bkTex.img[d.n] = im;          /* shown until the bake lands */
    });
  }
  /* readiness: baked layers are CANVASES which have NO .complete —
     checking .complete alone made T permanently null after the bake
     (the "backdrop never appears" bug). Canvas => ready by definition. */
  function bkReady(im) {
    if (!im) { return false; }
    if (im.tagName === 'CANVAS') { return true; }
    /* broken (404) images: complete=true but naturalWidth=0 */
    return im.complete && im.naturalWidth > 0;
  }
  function drawBackdrop(S, ctx, w, h, sky) {
    loadBackdropLayers();
    var T = _bkTex && _bkTex.img && bkReady(_bkTex.img.clouds)
      ? _bkTex : null;
    var cam = S && S.cameras ? S.cameras.main : null;
    if (!cam) { return; }
    var scroll = cam.scrollX;
    if (!T) { return; }
    var sc = w / 1280;
    var dw = 1280 * sc, dh = 360 * sc;
    var NW = 768, NH = 432;          /* Admurin layers native 2x size */
    /* Terraria anchoring: the band lives at the WORLD SURFACE. Its screen
       y = (worldSurfacePx - camera.scrollY) * (1 - a small factor), so
       walking on the surface keeps it steady, descending into caves lets
       it slide up and away BEHIND the terrain (exactly how Terraria
       hides the surface backdrop underground). PLAYER_SURFACE_Y is the
       world px of the average terrain line; scrollFactorY-like 0.85 */
    var surfWorldY = (typeof PLAYER_SURFACE_Y === 'number'
      ? PLAYER_SURFACE_Y : 96 * 32);
    /* BK_LIFT in WORLD px (TILE=32): scale-independent. The band top sits
       ~10 tiles above the mean surface, whether window is 720p or 4K. */
    var BK_LIFT = 10 * 32;
    /* DEAD-ZONE lock: at the surface scrollY has a constant offset (the
       camera centers the player above the ground line), so multiply-free
       anchoring keeps the band perfectly still while walking/jumping.
       Only when the camera descends into caves (scrollY passes the
       surface-centered band + slack) does the backdrop start sliding up
       behind the terrain. smoothstep over 6 tiles of descent. */
    var slack = 6 * 32;
    var deep = cam.scrollY + h * 0.5 - (surfWorldY + slack * 2);
    var t = Math.max(0, Math.min(1, deep / (6 * 32)));
    var ease = t * t * (3 - 2 * t);
    /* Terraria-style scrollFactorY ≈ 0.15: tiny vertical parallax so the
       band is essentially stable (jump = ±12px drift of distant hills,
       reads as natural depth) yet never looks glued/frozen. ease slides
       the band fully off-screen once you descend into caves. */
    var restSy = surfWorldY - h * 0.54;
    /* y-factor 0: the band is fully locked while above ground (jumps
       cause ZERO band movement — the user-visible requirement). The
       ease slide still lowers it away when descending into caves. */
    var surfScreen = (surfWorldY - restSy);
    var yBase = surfScreen - dh * 0.78 - ease * (surfScreen + dh);
    /* day/night dim: dayness 1=noon -> 1.0, 0=midnight -> 0.34 floor */
    var lum = 0.34 + 0.66 * sky.dayness;
    for (var bi = 0; bi < BK_DEFS.length; bi++) {
      var d = BK_DEFS[bi];
      var im = T.img[d.n];
      if (!bkReady(im)) { continue; }
      ctx.globalAlpha = lum;
      var y = d.top != null ? h * d.top : yBase;
      var is768 = im.width === NW;
      var lw = is768 ? NW * sc : dw;
      var lh = is768 ? NH * sc : dh;
      /* Admurin ground line sits at ~96% of its frame: align layer bottoms
         to the same terrain horizon as the 1280-wide clouds */
      var yy = is768 ? yBase + (dh - lh) : y;
      var off = -((scroll * d.fx) % lw);
      for (var xx = off; xx < w; xx += lw) {
        ctx.drawImage(im, Math.round(xx), Math.round(yy),
          Math.ceil(lw) + 1, Math.ceil(lh));
        /* seal the bottom: repeat the layer's last rows down to the
           canvas floor so jumps (camera up) can never expose sky under
           the backdrop — the wall reads as continuous, static ground */
        var bot = yy + lh;
        if (bot < h) {
          var bandH = Math.min(8, im.height);
          ctx.drawImage(im, 0, im.height - bandH, im.width, bandH,
            Math.round(xx), Math.round(bot) - 1,
            Math.ceil(lw) + 1, Math.ceil(h - bot) + 2);
        }
      }
    }
    /* ground plane: from the lowest layer's bottom to the canvas floor,
       painted in the nearest layer's ground color. The sky canvas is then
       FULLY opaque below the band — no sky gradient can peek through dug
       shafts/55% walls regardless of camera position; underground it reads
       as a consistent earth tone behind the wall tiles. */
    var yBot = yBase + dh;
    if (yBot < h && _bkGround) {
      ctx.globalAlpha = lum;
      ctx.fillStyle = _bkGround;
      ctx.fillRect(0, Math.round(yBot) - 1, w, Math.ceil(h - yBot) + 2);
    }
    /* CROP at the horizon: erase the sky canvas below each column's world
       surface line. The band's own green "field" section can then never
       bleed through 55% walls underground — below the terrain the sky
       canvas is fully transparent, so walls blend against caveFill's dark
       (Terraria rule: surface backdrop ends AT the terrain). */
    if (world && world.surfaceY) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,1)';
      var step = 4;
      for (var sx = 0; sx < w; sx += step) {
        var wx = Math.floor((cam.scrollX + sx) / 32);
        if (wx < 0) { wx = 0; }
        if (wx >= WORLD_W) { wx = WORLD_W - 1; }
        var syW = world.surfaceY[wx] * 32 - cam.scrollY;
        if (syW >= h) { continue; }
        var top = Math.max(0, Math.round(syW));
        ctx.fillRect(sx, top, step, h - top);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }
  /* ---- SFX: WebAudio synth (zero audio files) --------------------------
     Tiny helper: every call creates osc/gain, schedules envelope, done.
     Lazy AudioContext on first user gesture (autoplay policy). */
  var AC = null;
  function ac() {
    if (!AC) {
      try { AC = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { AC = null; }
    }
    if (AC && AC.state === 'suspended') { AC.resume(); }
    return AC;
  }
  function tone(freq, dur, type, vol, slide) {
    var c = ac(); if (!c) { return; }
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, c.currentTime);
    if (slide) { o.frequency.exponentialRampToValueAtTime(slide, c.currentTime + dur); }
    g.gain.setValueAtTime(vol || 0.08, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + dur);
  }
  function noise(dur, vol, freq) {
    var c = ac(); if (!c) { return; }
    var n = Math.floor(c.sampleRate * dur);
    var buf = c.createBuffer(1, n, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) { d[i] = (Math.random() * 2 - 1) * (1 - i / n); }
    var s = c.createBufferSource(); s.buffer = buf;
    var f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq || 900;
    var g = c.createGain(); g.gain.value = vol || 0.1;
    s.connect(f); f.connect(g); g.connect(c.destination);
    s.start();
  }
  var SFX = {
    dig: function () { noise(0.05, 0.05, 1400); },
    break: function () { noise(0.12, 0.12, 420); tone(160, 0.1, 'triangle', 0.06, 90); },
    crystal: function () { tone(880, 0.1, 'sine', 0.1); setTimeout(function(){tone(1318,0.12,'sine',0.1);},90); setTimeout(function(){tone(1760,0.2,'sine',0.1);},180); },
    chest: function () { tone(523, 0.09, 'square', 0.06); setTimeout(function(){tone(659,0.09,'square',0.06);},80); setTimeout(function(){tone(784,0.15,'square',0.06);},160); },
    hurt: function () { tone(180, 0.22, 'sawtooth', 0.12, 60); },
    shoot: function () { tone(920, 0.07, 'square', 0.05, 320); },
    spit: function () { tone(340, 0.12, 'sawtooth', 0.06, 160); },
    jump: function () { tone(300, 0.12, 'sine', 0.06, 600); },
    win: function () {
      var seq = [523, 659, 784, 1047, 1319];
      for (var i = 0; i < seq.length; i++) {
        (function (f, d) { setTimeout(function () { tone(f, 0.35, 'triangle', 0.12); }, d); })(seq[i], i * 160);
      }
    }
  };

  function drawHotbar(S) {
    var ctx = S.hudCtx;
    if (!ctx) { return; }
    var w = ctx.canvas.width;
    ctx.clearRect(0, 0, w, ctx.canvas.height);
    var slot = 44, pad = 6, x0 = 12, y0 = 12;
    var img = S.mcImg;
    for (var i = 0; i < 9; i++) {
      var x = x0 + i * (slot + pad), sel = i === hotbarSel;
      ctx.fillStyle = sel ? 'rgba(240,193,75,.95)' : 'rgba(0,0,0,.55)';
      ctx.fillRect(x, y0, slot, slot);
      ctx.lineWidth = 2;
      ctx.strokeStyle = sel ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,.35)';
      ctx.strokeRect(x, y0, slot, slot);
      var it = inventory[i];
      if (it && img) {
        var m = TILEMETA[it.id];
        var aI = m ? m.atlasIndex : 0;
        ctx.drawImage(img, (aI % 16) * 16, ((aI / 16) | 0) * 16, 16, 16,
          x + 6, y0 + 6, slot - 12, slot - 12);
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'right';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#fff';
        ctx.strokeText(String(it.n), x + slot - 4, y0 + slot - 5);
        ctx.fillText(String(it.n), x + slot - 4, y0 + slot - 5);
      }
    }
    /* hearts, top-right */
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'right';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#ff5a5a';
    var hp = S.hp || 0, hx = w - 14;
    for (var hh = 0; hh < MAX_HP; hh++) {
      ctx.globalAlpha = hh < hp ? 1 : 0.22;
      ctx.strokeText('♥', hx, 34);
      ctx.fillText('♥', hx, 34);
      hx -= 24;
    }
    ctx.globalAlpha = 1;

    /* crystal counter, top-center: ◆ xN / NEED — the goal chain at a
       glance. Pulsing color when full (altar ready). */
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    var done = crystalsGot >= CRYSTALS_NEED;
    ctx.fillStyle = done ? '#7ef2c0' : '#b48cff';
    ctx.lineWidth = 3; ctx.strokeStyle = '#000';
    var label = '◆ ' + crystalsGot + ' / ' + CRYSTALS_NEED +
      (done ? ' — 祭坛就绪!' : '');
    ctx.strokeText(label, w / 2, 34);
    ctx.fillText(label, w / 2, 34);
    ctx.textAlign = 'left';
  }
  function updateHearts(S) { drawHotbar(S); }

  function drawDigHighlight(S) {
    var g = S.digG;
    g.clear();
    if (!S.digTarget || over) { return; }
    var t = S.digTarget;
    if (t.x < 0 || t.x >= WORLD_W || t.y < 0 || t.y >= WORLD_H) { return; }
    var dist = Math.abs(t.x * TILE + 16 - S.player.x) + Math.abs(t.y * TILE + 16 - S.player.y);
    g.lineStyle(2, 0xffffff, 0.8);
    g.strokeRect(t.x * TILE, t.y * TILE, TILE, TILE);
    var m = TILEMETA[world.tile[t.y * WORLD_W + t.x]];
    if (m && m.hardness >= 0 && S.dmg && S.dmg[t.y * WORLD_W + t.x] > 0) {
      g.fillStyle(0xffffff, 0.25 * Math.min(1, S.dmg[t.y * WORLD_W + t.x]));
      g.fillRect(t.x * TILE, t.y * TILE, TILE, TILE);
    }
  }

  function digTick(S) {
    if (!S.digging || !S.digTarget || over) { return; }
    var t = S.digTarget;
    var i = t.y * WORLD_W + t.x;
    if (i < 0 || i >= WORLD_W * WORLD_H) { return; }
    var tid = world.tile[i];
    var m = TILEMETA[tid];
    if (!m || m.hardness < 0) { return; }
    S.dmg = S.dmg || {};
    S.dmg[i] = (S.dmg[i] || 0) + 0.033 / m.hardness;
    SFX.dig();
    if (S.dmg[i] >= 1) {
      giveItem(tid, 1);
      if (tid === 12) { delete torchLife[i]; }
      if (tid === 42 && !(S.placedCrystals && S.placedCrystals[i])) {
        /* goal-fuel count ONLY on first harvest. placedCrystals marks
           tiles the player placed a crystal on: re-digging one returns
           the item but must NOT inflate crystalsGot (the place->dig
           loop counted the same gem forever). */
        crystalsGot += 1;
        SFX.crystal();
        burst(S, t.x * TILE + 16, t.y * TILE + 16, 0xb48cff, 14);
        burst(S, t.x * TILE + 16, t.y * TILE + 16, 0x7ef2c0, 8);
        drawHotbar(S);
      } else {
        SFX.break();
      }
      if (S.placedCrystals && S.placedCrystals[i]) { delete S.placedCrystals[i]; }
      world.tile[i] = 0;
      delete S.dmg[i];
      stats.mined += 1;
      /* break FX: chip particles in the tile's color + a shrinking
         ghost tile. The chip rectangles fly ABOVE the lightmap (depth
         45) so the burst stays visible in dark caves. */
      digBurst(S, t.x, t.y, tid);
      refreshStrip(S, t.x);
      rebuildSolids(S, t.x);
    }
  }

  /* dig break FX: a handful of tile-colored chips + a crack flash.
     Uses the atlas tile as the chip color source so granite chips look
     granite, dirt looks dirt. */
  function digBurst(S, tx, ty, tid) {
    var m = TILEMETA[tid];
    var cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
    /* tile-colored chips: sample the sheet pixel via a tiny canvas */
    var col = 0x9aa0aa;
    if (m && S.mcImg) {
      try {
        var cv = document.createElement('canvas');
        cv.width = 16; cv.height = 16;
        var cctx = cv.getContext('2d');
        var ax = (m.atlasIndex % 16) * 16, ay = ((m.atlasIndex / 16) | 0) * 16;
        cctx.drawImage(S.mcImg, ax, ay, 16, 16, 0, 0, 1, 1);
        var d = cctx.getImageData(0, 0, 1, 1).data;
        col = (d[0] << 16) | (d[1] << 8) | d[2];
      } catch (e) { /* keep fallback */ }
    }
    for (var i = 0; i < 8; i++) {
      (function () {
        var a = Math.random() * Math.PI * 2;
        var sp = 50 + Math.random() * 130;
        var p = S.add.rectangle(cx, cy, 5, 5, col).setDepth(45);
        var dx = Math.cos(a) * sp * 0.35, dy2 = Math.sin(a) * sp * 0.35 - 40;
        S.tweens.add({
          targets: p, x: cx + dx, y: cy + dy2, alpha: 0,
          duration: 380 + Math.random() * 180,
          onComplete: function () { p.destroy(); }
        });
      })();
    }
    /* quick crack flash overlay on the removed tile */
    var fl = S.add.rectangle(cx, cy, TILE, TILE, 0xffffff, 0.35)
      .setDepth(45);
    S.tweens.add({
      targets: fl, alpha: 0, scaleX: 1.3, scaleY: 1.3,
      duration: 140, onComplete: function () { fl.destroy(); }
    });
  }

  /* ---- collision maintenance -------------------------------------------
     Static solids are VERTICAL run-merged rects, one set per column.
     A dig/place changes exactly ONE column, so the rebuild is exact:
     destroy that column's rects, re-merge its solid runs. No other
     column is touched - with the old horizontal runs the destroy step
     spanned the whole row and dirt outside the window lost collision. */
  function buildColumnRuns(S, cx) {
    var runStart = -1;
    for (var sy = 0; sy <= WORLD_H; sy++) {
      var solid = sy < WORLD_H && isSolid(cx, sy);
      if (solid && runStart < 0) { runStart = sy; }
      else if (!solid && runStart >= 0) {
        var len = sy - runStart;
        var rect = S.add.rectangle(
          cx * TILE + TILE / 2, runStart * TILE + len * TILE / 2,
          TILE, len * TILE);
        rect.col = cx;                        /* column tag for exact
                                                 destroy on rebuild */
        S.physics.add.existing(rect, true);   /* static */
        S.solids.add(rect);
        runStart = -1;
      }
    }
  }

  function rebuildSolids(S, x) {
    if (!S.solids) { return; }
    /* destroy only THIS column's rects (tagged with col at build) */
    var toKill = [];
    S.solids.children.each(function (r) {
      if (r.active && r.col === x) { toKill.push(r); }
    });
    for (var k = 0; k < toKill.length; k++) { toKill[k].destroy(); }
    buildColumnRuns(S, x);
  }
  function refreshStrip(S, x) {
    /* re-put the changed column into the tile layer */
    for (var y = 0; y < WORLD_H; y++) {
      var i = y * WORLD_W + x;
      var tid = world.tile[i], wid = world.wall[i];
      var tL = S.tileLayerFor(y), wL = S.wallLayerFor(y);
      var ly = S.localY(y);
      var tm = tid ? TILEMETA[tid] : null;
      var wtex = wid ? (META.wallTex || {})[wid] : null;
      if (!wtex && wid === 3) { wtex = 7; }   /* wood wall -> plank */
      var wm = wtex ? TILEMETA[wtex] : null;
      if (tm) { tL.putTileAt(tm.atlasIndex, x, ly); }
      else { tL.removeTileAt(x, ly); }
      if (wm) { wL.putTileAt(wm.atlasIndex, x, ly); }
      else { wL.removeTileAt(x, ly); }
    }
    /* world geometry changed -> light paths changed. Windowed relight:
       only the ~50x50 box around the changed column re-sweeps (the
       full-world BFS per dig was the top perf hit during rapid
       digging). Full relight stays for world create / torch sweep. */
    windowRelight(S, x, Math.floor(S.player.y / TILE));
  }

  function hpChange(S, d) {
    S.hp = Math.max(0, (S.hp || MAX_HP) + d);
    if (S.hp === 0) {
      stats.deaths += 1;
      S.hp = MAX_HP;
      /* DEATH COST: half the crystals (rounded down) pop out as
         collectible shards at the death spot - a corpse run. Dying
         right after a deep-cave haul now actually hurts. */
      var drop = Math.floor(crystalsGot / 2);
      if (drop > 0) {
        crystalsGot -= drop;
        drawHotbar(S);
        for (var di = 0; di < drop; di++) { spawnShard(S, S.player.x, S.player.y - 30, 25000); }
      }
      S.player.setPosition(world.spawn[0] * TILE, world.spawn[1] * TILE);
      /* death while fighting the boss: the lord retreats (respawn on
         return) — otherwise a corpse-run back to an active boss is
         instant re-death, and leaving it alive = softlock-free anyway */
      if (S.boss && S.boss.active) {
        if (S.boss.glow && S.boss.glow.active) { S.boss.glow.destroy(); }
        S.boss.destroy();
        S.boss = null;
        showBossBanner(S, false);
      }
      S.bugs.clear(true, true);
      tone(140, 0.4, 'sawtooth', 0.12, 60);
      showDeathBanner(S, drop);
    }
  }

  /* every DOM banner bannerEl() can create — leave() removes them all
     so nothing outlives the game session */
  var BANNER_IDS = ['eggTut', 'eggDeath', 'eggAltarPrompt', 'eggAltarHint',
    'eggWin', 'eggCompass', 'bossBanner', 'bossBar'];

  /* ---- altar / win banners (DOM, above the canvas) ---- */
  function bannerEl(id) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'position:absolute;left:0;right:0;text-align:center;' +
        'pointer-events:none;z-index:9;font-family:monospace;transition:opacity .4s;opacity:0;';
      var host = document.getElementById('demoWindow');
      if (host) { host.appendChild(el); }
    }
    return el;
  }
  function showDeathBanner(S, dropped) {
    var el = bannerEl('eggDeath');
    el.style.top = '42%';
    el.style.fontSize = '20px';
    el.style.color = '#ff8a8a';
    el.style.textShadow = '0 2px 4px #000';
    el.textContent = dropped > 0
      ? '阵亡！丢失 ' + dropped + ' 颗水晶（在原地可拾回，快去）'
      : '阵亡！在祭坛复活';
    el.style.opacity = 1;
    setTimeout(function () { el.style.opacity = 0; }, 3200);
  }

  function showAltarPrompt(S, ready) {
    var el = bannerEl('eggAltarPrompt');
    el.style.top = '52%';
    el.style.fontSize = '17px';
    el.style.textShadow = '0 2px 4px #000';
    if (ready) {
      el.style.color = '#ff9d5c';
      el.innerHTML = '⚔ 水晶已集齐 — 触碰祭坛召唤守护者，准备战斗！';
    } else {
      el.style.color = '#ffd479';
      el.innerHTML = '祭坛沉睡中… 需覆 ' +
        (CRYSTALS_NEED - crystalsGot) + ' 颗水晶（深洞紫晶）';
    }
    el.style.opacity = 1;
  }
  function hideAltarPrompt(S) {
    var el = document.getElementById('eggAltarPrompt');
    if (el) { el.style.opacity = 0; }
  }

  function showAltarHint(S, need) {
    var el = bannerEl('eggAltarHint');
    el.style.top = '38%';
    el.style.fontSize = '16px';
    el.style.color = '#ffd479';
    el.style.textShadow = '0 2px 4px #000';
    el.textContent = '祭坛沉睡中… 需要再采 ' + need + ' 颗能量水晶（深洞紫晶）';
    el.style.opacity = 1;
    setTimeout(function () { el.style.opacity = 0; }, 2600);
  }
  function showWinBanner(S) {
    var el = bannerEl('eggWin');
    el.style.top = '30%';
    el.style.fontSize = '26px';
    el.style.color = '#7ef2c0';
    el.style.textShadow = '0 2px 6px #000';
    var mins = Math.floor((Date.now() - runStartT) / 60000),
        secs = Math.floor(((Date.now() - runStartT) / 1000) % 60);
    var nextL = DIFF[Math.min(loopLevel + 1, DIFF.length - 1)].label;
    el.innerHTML = '★ 祭坛激活 ★<br>' +
      '<span style="font-size:15px;color:#eee">用时 ' + mins + ':' +
      (secs < 10 ? '0' : '') + secs +
      ' · 挖矿 ' + stats.mined +
      ' · 开箱 ' + stats.chests + ' · 击杀 ' + (stats.kills || 0) +
      ' · 阵亡 ' + stats.deaths + '</span><br>' +
      '<button id="eggNextLoop" style="margin-top:14px;padding:10px 26px;' +
      'font:16px monospace;background:#2e8b57;color:#eafff3;border:2px solid #7ef2c0;' +
      'border-radius:6px;cursor:pointer;pointer-events:auto">进入 ' + nextL +
      ' →</button>';
    el.style.opacity = 1;
    var btn = document.getElementById('eggNextLoop');
    if (btn) {
      btn.onclick = function () {
        loopLevel += 1;
        el.style.opacity = 0;
        /* full restart: new world, fresh state, harder knobs */
        leave(); enter();
      };
    }
  }

  MainScene.prototype.update = function (time, delta) {
    if (!this.player) { return; }
    var dt = delta / 1000;
    dayT = (dayT + dt / DAY_LEN) % 1;
    var spd = 190;
    var mv = (this.keysA.D.isDown || this.cursors.right.isDown ? 1 : 0) -
             (this.keysA.A.isDown || this.cursors.left.isDown ? 1 : 0);
    this.player.setVelocityX(mv * spd);
    if (mv) { this.player.setFlipX(mv < 0); }
    /* ---- jump: coyote time + jump buffer + double jump (old game.js) ----
       K/W/Up/Space; grounded→JUMP_V, air→JUMP_V2 once, then buffer */
    var jumpKeysDown = this.keysK.isDown || this.keysA.W.isDown ||
      this.cursors.up.isDown || this.keysSpace.isDown;
    if (this.player.body.blocked.down) {
      this.coyoteT = 0;
      this.jumps = 0;
    } else {
      this.coyoteT = (this.coyoteT || 9999) + dt;
    }
    var jumpJustDown = Phaser.Input.Keyboard.JustDown(this.keysK) ||
      Phaser.Input.Keyboard.JustDown(this.keysA.W) ||
      Phaser.Input.Keyboard.JustDown(this.cursors.up) ||
      Phaser.Input.Keyboard.JustDown(this.keysSpace);
    if (jumpJustDown) {
      var canGround = this.player.body.blocked.down || this.coyoteT < 0.09;
      if (canGround) {
        /* gravity here is 1500 (old engine differed); -620 ≈ 4.3-tile hop */
        this.player.setVelocityY(-620);
        this.jumps = 1;
        this.jumpPose = true;      /* pose is JUMP-KEYED, not airborne-
                                      keyed: stepping off a ledge or
                                      riding a falling platform keeps
                                      the run cycle */
        this.player.anims.play('jump', true);   /* pet sheet row 4 */
        SFX.jump();
        this.coyoteT = 9999;
      } else if (this.jumps < 2) {
        this.player.setVelocityY(-520);   /* second jump ≈ +3 tiles */
        this.jumps = 2;
        this.jumpPose = true;
        burst(this, this.player.x, this.player.y + 56, 0xececf1, 9);
        /* double-jump FLIP: full spin around the visual center so the
           second jump reads as a distinct, animated move instead of the
           frozen fall pose held through the whole arc. Origin is
           feet-anchored (0.5,1); shift the pivot to the center for the
           spin (y -48 keeps the center put), restore on completion.
           The physics body rides along for ~0.34s of open air. */
        if (!this.flipTween || !this.flipTween.isActive()) {
          var pj = this.player;
          pj.setOrigin(0.5, 0.5);
          pj.y -= 48;
          var deg = (pj.flipX ? -360 : 360) * Math.PI / 180;
          this.flipTween = this.tweens.add({
            targets: pj, rotation: deg,
            duration: 340, ease: 'Cubic.easeOut',
            onComplete: function () {
              pj.rotation = 0;
              pj.setOrigin(0.5, 1);
              pj.y += 48;
            }
          });
        }
      } else {
        this.jumpBufT = 0.12;
      }
    } else if (this.jumpBufT > 0) {
      this.jumpBufT -= dt;
      if (this.player.body.blocked.down) {
        this.player.setVelocityY(-620);
        this.jumps = 1;
        this.jumpPose = true;
        this.jumpBufT = 0;
      }
    }

    /* held torch: the lightmap is the ONLY light — a glow sprite on top
       would double-light the player (that was the "player too bright"
       bug). Just seed the moving light into the torch field. */
    var heldItem = inventory[hotbarSel];
  var heldTorch = heldItem && (heldItem.id === 12 ||
    (TILEMETA[heldItem.id] && TILEMETA[heldItem.id].light > 0));
    if (heldTorch) {
      /* moving light: windowed BFS into the torch field (only runs
         when the player crosses a tile boundary) */
      heldTorchRelight(this);
    } else if (this.heldTorchAt) {
      /* torch just unequipped: restore the field window and recompose
         just that window (was full-map repaint) */
      var ha = this.heldTorchAt, hr = HELD_R + 1;
      heldRestore(this);
      paintLight(this, { x0: ha[0] - hr, y0: ha[1] - hr,
                         x1: ha[0] + hr, y1: ha[1] + hr });
    }
    /* torch fuel: frame-level expiry check so gutter-out lands within
       one frame of the clock (3s backstop sweep stays for safety) */
    if (nextTorchExpiry !== Infinity && this.time.now >= nextTorchExpiry) {
      gutterTorches(this);
    }
    /* day/night clock advances continuously; ambient + sky follow it */
    this.lightT = (this.lightT || 0) + dt;
    /* sky + HUD redraw at ~20 Hz */
    this.hudT = (this.hudT || 0) + dt;
    if (this.hudT > 0.05 || this.hudDirty) {
      this.hudT = 0; this.hudDirty = false;
      drawSky(this);
      drawHotbar(this);
      /* ambient re-tint only (no BFS) — composed for the camera
         viewport only (~8% of the map; full-map putImageData was the
         steady-state CPU cost every 50ms) */
      paintLight(this, 'view');
    }

    /* dig highlight + damage fill */
    var pActive = this.input.activePointer;
    if (pActive) { digAt(this, pActive); }
    drawDigHighlight(this);

    /* hotbar 1-9 */
    for (var hk = 0; hk < this.numKeys.length; hk++) {
      if (Phaser.Input.Keyboard.JustDown(this.numKeys[hk])) {
        hotbarSel = hk; drawHotbar(this);
      }
    }
    /* invulnerability window after a hit: counts down in update.
       (This line was MISSING from the original code - invT was set to
       1.2 on the first hit and never decremented, so the player became
       permanently invincible after losing one heart: the "one hit then
       no more damage" bug.) 70% alpha blink while immune so the state
       reads clearly. */
    if (this.player.invT > 0) {
      this.player.invT -= dt;
      this.player.setAlpha(this.player.invT > 0 && (Math.floor(this.player.invT * 10) % 2 === 0) ? 0.45 : 1);
      if (this.player.invT <= 0) { this.player.setAlpha(1); }
    }

    if (this.keysJ.isDown || this.keysA.X.isDown || this.keysF.isDown) { shoot(this); }
    /* auto-fire at the pointer while the left button is held (mouseFire
       is only set when the press did NOT start a dig). */
    if (this.mouseFire) { shoot(this); }
    /* bullets: fly; solid tile → burst+die; bug overlap → kill+burst;
       HOSTILE projectiles (spitter spit) instead hurt the PLAYER */
    var S = this;
    this.bullets.children.each(function (bl) {
      if (!bl.active) { return; }
      var bx = bl.x, by = bl.y;
      /* hostile spit: check the player, never the bugs */
      if (bl.hostile) {
        var pl = S.player;
        if (pl && pl.active && Math.abs(pl.x - bx) < 20 && Math.abs(pl.y - 30 - by) < 34) {
          if (!pl.invT || pl.invT <= 0) {
            pl.invT = 1.0;
            hpChange(S, -1);
            SFX.hurt();
            var awayS = pl.x < bx ? -1 : 1;
            pl.setVelocity(awayS * 220, -240);
            S.cameras.main.shake(140, 0.008);
            S.tweens.add({ targets: pl, tint: 0xff5555, duration: 70,
              yoyo: true, repeat: 3, onComplete: function () { pl.clearTint(); } });
          }
          burst(S, bx, by, 0xff8a3d, 6);
          bl.destroy();
          return;
        }
        /* spit also dies on walls/outside view */
        var camS = S.cameras.main;
        var hitWallS = isSolid(Math.floor(bx / TILE), Math.floor(by / TILE));
        if (hitWallS || bx < camS.scrollX - 200 || bx > camS.scrollX + S.scale.width + 200 ||
            by < camS.scrollY - 200 || by > camS.scrollY + S.scale.height + 200) {
          burst(S, bx, by, 0x9ff5b3, 4);
          bl.destroy();
        }
        return;
      }
      var hitWall = isSolid(Math.floor(bx / TILE), Math.floor(by / TILE));
      var hitBug = false;
      S.bugs.children.each(function (bg) {
        if (hitBug || !bg.active) { return; }
        /* boss: wide body, dedicated damage path — NOT one-shot */
        if (bg.isBoss) {
          if (Math.abs(bg.x - bx) < 58 && Math.abs(bg.y - by) < 58) {
            hitBug = true;
            bossHurt(S, 1);
            burst(S, bx, by, 0xc9a6ff, 6);
          }
          return;
        }
        if (Math.abs(bg.x - bx) < 24 && Math.abs(bg.y - by) < 30) {
          hitBug = true;
          burst(S, bg.x, bg.y, 0xf87171, 12);
          burst(S, bg.x, bg.y, 0xfbbf24, 6);
          /* 30% drop: a crystal SHARD worth 1/3 pickaxe-progress-free
             crystal? No — shards count toward the goal at 1 each but cap
             at the requirement; keeps combat rewarding without removing
             the mining goal. Simple v1: 30% chance the kill drops a
             collectible shard entity (bouncy purple gem). */
          if (Math.random() < 0.3) { spawnShard(S, bg.x, bg.y); }
          if (bg.glow && bg.glow.active) { bg.glow.destroy(); }
          bg.destroy();
          stats.kills = (stats.kills || 0) + 1;
          noise(0.08, 0.1, 700); tone(500, 0.08, 'square', 0.05, 220);
        }
      });
      var cam = S.cameras.main;
      if (hitWall || hitBug ||
          bx < cam.scrollX - 24 || bx > cam.scrollX + S.scale.width + 24) {
        if (hitWall) { burst(S, bx, by, 0x99aabb, 5); }
        bl.destroy();
      }
    });

    /* animation state machine — switch ONLY on state change; calling
       stop()/setTexture() every frame fought the animator = flicker.
       Fall pose is JUMP-KEYED (set where the jump key fires velocity,
       cleared on landing): keypress = a deliberate jump; merely leaving
       the ground (walking off a ledge) keeps the run cycle instead of
       snapping to the spread-leg pose. */
    var airborne = !this.player.body.blocked.down;
    if (!airborne) {
      this.jumpPose = false;
      /* landed mid-flip: cancel the tween and restore the feet anchor
        NOW, or the sprite stays center-rotated for the rest of the run */
      if (this.flipTween && this.flipTween.isActive()) {
        this.flipTween.stop();
        this.flipTween = null;
        this.player.rotation = 0;
        this.player.setOrigin(0.5, 1);
        this.player.y += 48;
      }
    }
    /* one-shot jump anim on first jump (pet sheet row 4); hold its last
       frame through the arc. Double jump = spin tween (see jump input).
       Falling WITHOUT a keypress keeps the run cycle. While a one-shot
       (jump/wave) is playing, the anim switcher below stands aside. */
    var jumpingAnim = this.player.anims.currentAnim &&
      this.player.anims.currentAnim.key === 'jump';
    var wantAnim = (airborne && this.jumpPose && !jumpingAnim &&
                    !(this.flipTween && this.flipTween.isActive())) ? 'fall'
      : (airborne && this.jumpPose) ? 'jump'
      : (mv && !airborne) ? 'run'
      : airborne ? 'run'
      : 'idle';
    var cur = this.player.anims.currentAnim ? this.player.anims.currentAnim.key : null;
    /* one-shot guard: while 'jump'/'wave' is ACTIVELY playing, the state
       machine must not stomp it. At jump input time blocked.down is
       STILL true (physics steps after update), so the machine would
       otherwise replay idle/run on the very frame the one-shot starts
       = the anim never became visible ("没加上"). */
    var oneShotLive = this.player.anims.isPlaying &&
      (cur === 'jump' || cur === 'wave');
    if (!oneShotLive) {
      if (wantAnim === 'fall') {
        if (cur !== null) { this.player.anims.stop(); }
        this.player.setFrame(FALL_FRAME_IDX);
      } else if (cur !== wantAnim) {
        this.player.anims.play(wantAnim, true);
      }
      /* run cadence scales with horizontal effort (grounded only now) */
      if (wantAnim === 'run') {
        this.player.anims.timeScale = mv ? 1 : 0.6;
      }
    }

    /* dig hold */
    var p = this.input.activePointer;
    if (this.digging && p.isDown && !p.rightButtonDown()) { digAt(this, p); digTick(this); }

    /* ALTAR (the flag): with enough crystals the Kraken Lord RISES to
     guard the ritual — the win now requires beating the boss first.
     Without crystals it pings a hint (rate-limited). */
    /* approach guidance: within 5 tiles of the altar, show what to do
       next. Ready = boss warning; not ready = gem count reminder. This
       runs BEFORE the touch check so players see the prompt as they
       walk up, not only after the boss already spawned. */
    if (!flagHit) {
      var nearAx = Math.abs(this.player.x - (world.flag[0] * TILE + 16)) < 160 &&
                   Math.abs(this.player.y - (world.flag[1] * TILE)) < 170;
      if (nearAx && !this.boss) {
        if (crystalsGot >= CRYSTALS_NEED) {
          showAltarPrompt(this, true);    /* ready: warn the fight */
        } else if (!this.altarHintT || this.time.now - this.altarHintT > 4000) {
          this.altarHintT = this.time.now;
          showAltarPrompt(this, false);   /* missing gems */
        }
      } else {
        hideAltarPrompt(this);
      }
    }
    if (!flagHit && !this.boss && Math.abs(this.player.x - (world.flag[0] * TILE + 16)) < 26 &&
        Math.abs(this.player.y - (world.flag[1] * TILE)) < 64) {
      if (crystalsGot >= CRYSTALS_NEED) {
        bossSpawn(this);
        burst(this, world.flag[0] * TILE + 16, world.flag[1] * TILE, 0x9a6cff, 26);
      } else if (!this.altarHintT || this.time.now - this.altarHintT > 4000) {
        this.altarHintT = this.time.now;
        tone(220, 0.18, 'sine', 0.07, 180);
        showAltarHint(this, CRYSTALS_NEED - crystalsGot);
      }
    }
    /* boss AI tick + victory watch */
    if (this.boss) { bossBrain(this); }
    altarCompassUpdate(this);
    /* chest E */
    if (this.keysE && Phaser.Input.Keyboard.JustDown(this.keysE)) {
      var pc = this.player;
      for (var ci = 0; ci < world.chests.length; ci++) {
        var c = world.chests[ci];
        if (openedChests[c[0] + ',' + c[1]]) { continue; }
        var cx = c[0] * TILE + 16, cy = c[1] * TILE + 16;
        if (Math.abs(pc.x - cx) < 70 && Math.abs(pc.y - cy) < 70) {
          openedChests[c[0] + ',' + c[1]] = true;
          var i = c[1] * WORLD_W + c[0];
          world.tile[i] = 15;
          stats.chests += 1;
          var roll = Math.random();
          if (roll < 0.25) { giveItem(42, 1); crystalsGot += 1; drawHotbar(this); burst(this, cx, cy, 0xb48cff, 10); }
          else if (roll < 0.55) { giveItem(12, 15); }
          else if (roll < 0.8) { giveItem(7, 20); }
          else { giveItem(10, 5); giveItem(11, 3); }
          refreshStrip(this, c[0]);
          SFX.chest();
          /* victory wave (pet sheet row 3, one-shot) — grounded only so
             it doesn't fight the jump/flip state machine */
          if (pc.body.blocked.down) { pc.anims.play('wave', true); }
        }
      }
    }
  };

  /* ---- boot ---------------------------------------------------------- */
  function startGame() {
    if (!META) { setTimeout(startGame, 150); return; }
    if (game) { return; }   /* double-boot guard: game is nulled in leave() */
    /* A/B flags for flicker triage: #canvas forces the Canvas renderer,
       #nolight keeps WebGL but skips the Light2D pipeline. Default = the
       full v50 path (WebGL + Light2D). */
    var h = (location.hash || '').toLowerCase();
    var forceCanvas = h.indexOf('canvas') >= 0;
    var noLight = h.indexOf('nolight') >= 0;
    window.__digNoLight = noLight;
    window.__digStartT = h.indexOf('noon') >= 0 ? 0.25
      : h.indexOf('night') >= 0 ? 0.75 : 0.06;
    dayT = window.__digStartT;   /* dayT is declared later but assigned here */
    game = new Phaser.Game({
      type: forceCanvas ? Phaser.CANVAS : Phaser.AUTO,
      /* WebGL preferred (Light2D pipeline); falls back to Canvas — the
         flood-field shadow overlay is renderer-independent */
      parent: chat,
      width: Math.max(320, chat.clientWidth),
      height: Math.max(240, chat.clientHeight),
      backgroundColor: '#7aa8e8',
      transparent: true,     /* game canvas is see-through: the sky layer
                                (DOM, below) shows through as background */
      pixelArt: true,
      physics: { default: 'arcade', arcade: { gravity: { y: 1500 } } },
      scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
      scene: [MainScene]
    });
    running = true;
    runStartT = Date.now();
  }

  var running = false;
  function enter() {
    if (running) { return; }
    /* class must live on .hero-demo (win) — all egg CSS scopes to it */
    win.classList.add('egg-mode');
    win.scrollIntoView({ block: 'center' });
    if (input) { input.style.display = 'none'; }
    /* pause the marketing typewriter that shares #demoChat */
    window.__aulosDemoPaused = true;
    titleEl.textContent = 'Aulos Dig';
    startGame();
  }
  function leave() {
    if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
    running = false;
    win.classList.remove('egg-mode');
    if (input) { input.style.display = ''; }
    titleEl.textContent = 'Aulos';
    window.__aulosDemoPaused = false;
    /* remove the DOM overlays (sky + HUD) so a re-enter starts clean */
    var so = document.getElementById('eggSkyOverlay');
    var ho = document.getElementById('eggHudOverlay');
    if (so) { so.parentNode.removeChild(so); }
    if (ho) { ho.parentNode.removeChild(ho); }
    /* banner divs (tutorial/death/altar/boss…) are appended to the page
       by scene code and fade out via Phaser timers — leaving before a
       timer fires cancels it and the text stays stuck on the marketing
       page. Nuke them all on exit; bannerEl() recreates on demand. */
    for (var i = 0; i < BANNER_IDS.length; i++) {
      var b = document.getElementById(BANNER_IDS[i]);
      if (b) { b.parentNode.removeChild(b); }
    }
    if (game) { game.destroy(true); game = null; }
  }
  function toggle() { if (running) { leave(); } else { enter(); } }

  /* the ONLY way in: double-click the Feibi pet — js/pet.js calls
     window.AulosDig.toggle(). #egg-run hash stays as a dev backdoor.
     Pill click closes the game; the fullscreen button just fullscreens
     (it used to launch the game, which surprised visitors). */
  pill.addEventListener('click', function () {
    if (running) { leave(); }
  });
  document.addEventListener('keydown', function (e) {
    if (running && e.key === 'Escape' && !document.fullscreenElement) { leave(); }
  });
  fsBtn.addEventListener('click', function () {
    if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
    else {
      win.requestFullscreen().then(function () { if (game) { game.scale.refresh(); } }).catch(function () {});
    }
  });
  /* pet hook (see js/pet.js dblclick handler) */
  window.AulosDig = {
    toggle: toggle,
    enter: enter,
    leave: leave,
    running: function () { return running; }
  };
  if ((location.hash || '').indexOf('egg-run') >= 0) {
    window.addEventListener('load', function () { setTimeout(enter, 300); });
  }
})();
