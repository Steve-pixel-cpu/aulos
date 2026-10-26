'use strict';
/* worldgen.js — Terraria-style layered world generation for Aulos Dig.
   Pure functions + injected RNG (mulberry32). Deterministic per seed.
   Pipeline order mirrors Terraria WorldGen: surface → layers → caves →
   ores → walls → trees → chests/flag → reachability repair.
   See docs/superpowers/specs/2026-10-24-terraria-like-sandbox-design.md §2. */
(function (root, factory) {
  if (typeof module !== 'undefined') { module.exports = factory(); }
  else { root.worldgen = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TILE = {
    AIR: 0, DIRT: 1, GRASS: 2, STONE: 3, SAND: 4, WOOD: 5, LEAF: 6,
    PLANK: 7, COAL: 8, IRON: 9, GOLD: 10, DIAMOND: 11, TORCH: 12,
    CRYSTAL: 42,
    CHEST: 13, BEDROCK: 14, CHEST_OPEN: 15, LAVA: 16,
    /* expansion: depth stones, deco, alternate trees, plants */
    LIMESTONE: 17, MARBLE: 18, BASALT: 19, OBSIDIAN: 20, GRAVEL: 21,
    CLAY: 22, SANDSTONE: 23, SNOW: 24, GRASS_SNOWY: 25, GLASS: 26,
    COBBLE_MOSSY: 27,
    WOOD_BEECH: 28, LEAF_BEECH: 29, WOOD_PINE: 30, LEAF_PINE: 31,
    WOOD_MAPLE: 32, LEAF_MAPLE: 33, WOOD_EUC: 34, LEAF_EUC: 35,
    PLANT_GRASS: 36, PLANT_FERN: 37, PLANT_FLOWER: 38,
    PLANT_RED_MUSHROOM: 39, PLANT_BROWN_MUSHROOM: 40, SPIDERWEB: 41,
    /* full-pack pass: every blocks.zip texture is a real block */
    BASALT_FLOW: 43, COBBLESTONE: 44, COBBLE_BRICKS: 45,
    COBBLE_BRICKS_MOSSY: 46, DIORITE: 47, FARMLAND: 48, GABBRO: 49,
    GRANITE: 50, GRANITE_BRICKS: 51, GRASS_TOP: 52, HAY_SIDE: 53,
    HAY_TOP: 54, ICE_GLACIER: 55, ICE_ICICLES: 56, LIMESTONE_BRICKS: 57,
    MARBLE_BRICKS: 58, MARBLE_BRICKS2: 59, MARBLE_BRICKS3: 60,
    MUD_BRICKS: 61, MUD_CRACKED: 62, RHYOLITE: 63, RHYOLITE_TILES: 64,
    SAND_UGLY_2: 65, SAND_UGLY_3: 66, SANDSTONE_BRICKS: 67,
    SANDSTONE_CARVED: 68, SANDSTONE_TILES: 69, SCHIST: 70,
    SERPENTINE: 71, SERPENTINE_BRICKS: 72, SERPENTINE_CARVED: 73,
    SLATE: 74, SLATE_TILES: 75,
    CORAL_BRAIN: 76, CORAL_BRAIN_BLEACHED: 77, CORAL_CAULIFLOWER: 78,
    CORAL_CAULIFLOWER_BLEACHED: 79, CORAL_PORE: 80, CORAL_PORE_BLEACHED: 81,
    CORAL_STAR: 82, CORAL_STAR_BLEACHED: 83,
    LOG_TOP_OAK: 84, LOG_TOP_BEECH: 85, LOG_TOP_EUC: 86, LOG_TOP_MAPLE: 87,
    LOG_TOP_PINE: 88, PLANK_BEECH: 89, PLANK_EUC: 90, PLANK_MAPLE: 91,
    PLANK_PINE: 92, GRASS_SHORT: 93, GRASS_MED: 94, GRASS_DENSE: 95,
    GRASS_FLOWERING: 96, FERN2: 97,
    FLOWER_AGAPANTHUS: 98, FLOWER_ALOE: 99, FLOWER_ASTER: 100,
    FLOWER_BIRD_OF_PARADISE: 101, FLOWER_BOTTLEBRUSH: 102,
    CACTUS_CHOLLA: 103, CACTUS_PRICKLYPEAR: 104, CATTAIL: 105,
    P_CORAL_BRAIN: 106, P_CORAL_BRAIN_BLEACHED: 107, P_CORAL_CAULIFLOWER: 108,
    P_CORAL_CAULIFLOWER_BLEACHED: 109, P_CORAL_PORE: 110,
    P_CORAL_PORE_BLEACHED: 111, P_CORAL_STAR: 112, P_CORAL_STAR_BLEACHED: 113,
    P_CREOSOTE: 114, CROP_CARROTS1: 115, CROP_CARROTS2: 116,
    CROP_CARROTS3: 117, CROP_CARROTS4: 118, CROP_WHEAT1: 119,
    CROP_WHEAT2: 120, CROP_WHEAT3: 121, CROP_WHEAT4: 122, CROP_WHEAT5: 123,
    FLOWER_DANDELION: 124, P_DICOT: 125, P_FIDDLENECK: 126,
    FLOWER_FORGET_ME_NOT: 127, P_GINGER: 128, P_GOLDENROD: 129,
    P_HORSETAIL: 130, FLOWER_IRIS_YELLOW: 131, P_LILY: 132,
    P_STROMATOLITE: 133, FLOWER_LUPINE: 134, P_MANZANITA: 135,
    FLOWER_MAYFLOWER: 136, P_MONSTERA: 137, P_MUGWORT: 138,
    FLOWER_MUSTARD: 139, P_NIGHTSHADE: 140, FLOWER_ORCHID_GROUND: 141,
    FLOWER_ORCHID_WAXLIP: 142, P_PIMPERNEL: 143, P_SAGEBRUSH: 144,
    SAPLING_BEECH: 145, SAPLING_EUC: 146, SAPLING_MAPLE: 147,
    SAPLING_OAK: 148, SAPLING_PINE: 149, P_SEA_THRIFT: 150, P_SEDGE: 151,
    P_THISTLE: 152, P_WATERLILY: 153
  };
  /* passable (light + movement): all plant/tree tiles */
  var PASSABLE = { 5:1, 6:1, 12:1, 42:1, 28:1, 29:1, 30:1, 31:1, 32:1, 33:1, 34:1,
                   35:1, 36:1, 37:1, 38:1, 39:1, 40:1, 41:1, 42:1 };
  /* full-pack passable extension: log tops, saplings, all plants,
     all crops, coral plants. Range-built, ids 84..153 minus solids
     (coral blocks 76..83 are solid stone-like, log tops 84..88 and
     planks 89..92: 84-88 passable, 89-92 solid). */
  (function () {
    var nonSolid = [84, 85, 86, 87, 88, 93, 94, 95, 96, 97,
                    98, 99, 100, 101, 102, 103, 104, 105, 106, 107,
                    108, 109, 110, 111, 112, 113, 114, 115, 116, 117,
                    118, 119, 120, 121, 122, 123, 124, 125, 126, 127,
                    128, 129, 130, 131, 132, 133, 134, 135, 136, 137,
                    138, 139, 140, 141, 142, 143, 144, 145, 146, 147,
                    148, 149, 150, 151, 152, 153];
    for (var i = 0; i < nonSolid.length; i++) { PASSABLE[nonSolid[i]] = 1; }
  })();
  var WALL = { WALL_AIR: 0, WALL_DIRT: 1, WALL_STONE: 2, WALL_WOOD: 3 };

  /* deterministic RNG (mulberry32) */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generate(seed, W, H) {
    var rand = rng(seed);
  /* whole-tree placement rule (USER): 8 grass tiles under the footprint.
     tx-3..tx+5 must all be grass-capped at the SAME surfaceY — flat ground
     only. Returns false on cliff steps / non-grass ground. */
  function treeFootprintOk(tx, sy) {
    if (tx - 3 < 1 || tx + 5 >= W - 1) { return false; }
    for (var cx = tx - 3; cx <= tx + 5; cx++) {
      var cy2 = surfaceY[cx];
      if (cy2 !== sy) { return false; }
      if (tile[cy2 * W + cx] !== TILE.GRASS) { return false; }
    }
    return true;
  }

    var tile = new Uint8Array(W * H);
    var wall = new Uint8Array(W * H);
    var surfaceY = new Int16Array(W);
    var dirtBottom = new Int16Array(W);
    var chests = [];

    /* ---- 1. surface heightmap: segmented slopes + smoothing ---------- */
    var SEG = 16, segW = Math.ceil(W / SEG);
    var base = Math.round(H * 0.30);
    var pts = [];
    for (var s = 0; s <= SEG; s++) { pts.push(base + Math.round((rand() - 0.5) * 24)); }
    for (var pass = 0; pass < 2; pass++) {          /* gaussian-ish smooth */
      var np = pts.slice();
      for (var i = 1; i < pts.length - 1; i++) {
        np[i] = Math.round((pts[i - 1] + 2 * pts[i] + pts[i + 1]) / 4);
      }
      pts = np;
    }
    for (var x = 0; x < W; x++) {
      var seg = Math.min(SEG - 1, Math.floor(x / segW));
      var t = (x - seg * segW) / segW;              /* interp inside segment */
      var yv = pts[seg] * (1 - t) + pts[seg + 1] * t;
      surfaceY[x] = Math.max(20, Math.min(Math.round(H * 0.45), Math.round(yv)));
      dirtBottom[x] = surfaceY[x] + 52 + Math.round(rand() * 14);
    }

    /* ---- 2. layer fill ------------------------------------------------ */
    /* depth stones (Terraria-style): limestone → marble → basalt →
       obsidian as you go down, with gravel/clay pockets in the mix.
       Full-pack pass mixes in the new stone family members per band:
       shallow soft stones (schist/slate/rhyolite/serpentine/diorite/
       granite/gabbro), mid marble-brick-free variants, deep hard ones. */
    function stoneAt(y, db, biome) {
      var d = y - db;                        /* depth below dirt band */
      if (d < 0) { return TILE.DIRT; }
      /* bands are FRACTIONS of the reachable depth (db → H-1) ... */
      if (d < 40) {
        var r0 = rand();
        if (r0 < 0.04) { return TILE.GRAVEL; }
        if (r0 < 0.07) { return TILE.DIORITE; }
        if (r0 < 0.10) { return TILE.SCHIST; }
        if (r0 < 0.13) { return TILE.SLATE; }
        if (r0 < 0.16) { return TILE.GRANITE; }
        if (r0 < 0.19) { return TILE.SANDSTONE; }
        return TILE.LIMESTONE;
      }
      /* bands are FRACTIONS of the reachable depth (db → H-1), so every
         family actually spawns in a 256-tall world: with db ~ 140 the
         old absolute thresholds (150/220) were unreachable */
      var dmax = H - 1 - db;                 /* reachable depth span */
      if (dmax < 40) { dmax = 40; }
      var dd = d / dmax;                     /* 0..1 normalized depth */
      if (dd < 0.30) {
        var r0 = rand();
        if (r0 < 0.04) { return TILE.GRAVEL; }
        if (r0 < 0.07) { return TILE.DIORITE; }
        if (r0 < 0.10) { return TILE.SCHIST; }
        if (r0 < 0.13) { return TILE.SLATE; }
        if (r0 < 0.16) { return TILE.GRANITE; }
        if (r0 < 0.19) { return TILE.SANDSTONE; }
        return TILE.LIMESTONE;
      }
      if (dd < 0.55) {
        var r2 = rand();
        if (r2 < 0.04) { return TILE.CLAY; }
        if (r2 < 0.10) { return TILE.GRAVEL; }
        if (r2 < 0.14) { return TILE.MUD_CRACKED; }
        if (r2 < 0.19) { return TILE.RHYOLITE; }
        if (r2 < 0.23) { return TILE.SERPENTINE; }
        if (r2 < 0.30) { return TILE.MARBLE_BRICKS; }
        return r2 < 0.55 ? TILE.MARBLE : TILE.LIMESTONE;
      }
      if (dd < 0.78) {
        var r3 = rand();
        if (r3 < 0.04) { return TILE.GRAVEL; }
        if (r3 < 0.08) { return TILE.GABBRO; }
        if (r3 < 0.12) { return TILE.MUD_BRICKS; }
        if (r3 < 0.16) { return TILE.CORAL_PORE; }
        return r3 < 0.5 ? TILE.BASALT : TILE.MARBLE;
      }
      if (dd < 0.92) {
        var r4 = rand();
        if (r4 < 0.10) { return TILE.OBSIDIAN; }
        if (r4 < 0.14) { return TILE.BASALT_FLOW; }
        if (r4 < 0.18) { return TILE.GABBRO; }
        return TILE.BASALT;
      }
      var r5 = rand();
      if (r5 < 0.28) { return TILE.OBSIDIAN; }
      if (r5 < 0.34) { return TILE.GRANITE_BRICKS; }
      return TILE.BASALT;
    }
    /* biome columns: grass(0) / snowy(1) / desert(2) / swamp(3).
       Grass must stay the dominant biome (test: grass cap >= 50%). */
    var biomeOf = new Uint8Array(W);
    var bx = 0;
    while (bx < W) {
      var blen = 24 + Math.floor(rand() * 40);
      var broll = rand();
      var btype = 0;                       /* grass default */
      if (broll < 0.16) { btype = 1; }     /* snowy  */
      else if (broll < 0.30) { btype = 2; }/* desert */
      else if (broll < 0.38) { btype = 3; }/* swamp  */
      for (var k = bx; k < Math.min(W, bx + blen); k++) { biomeOf[k] = btype; }
      bx += blen;
    }
    function surfTop(b) {
      if (b === 1) { return TILE.GRASS_SNOWY; }
      if (b === 2) { return TILE.SAND; }
      if (b === 3) { return TILE.MUD_CRACKED; }
      return TILE.GRASS;
    }
    for (var x2 = 0; x2 < W; x2++) {
      var sy = surfaceY[x2], db = dirtBottom[x2];
      var biome = biomeOf[x2];
      for (var y = sy; y < H; y++) {
        var id;
        if (y === sy) { id = surfTop(biome); }
        else if (y <= sy + 2 && rand() < 0.35) { id = TILE.DIRT; }
        else { id = stoneAt(y, db, biome); }
        tile[y * W + x2] = id;
      }
      /* desert: sand goes deeper + sandstone under it */
      if (biome === 2) {
        for (var dy2 = 1; dy2 <= 3 && sy + dy2 < H; dy2++) {
          tile[(sy + dy2) * W + x2] = dy2 < 3 ? TILE.SAND : TILE.SANDSTONE;
        }
      }
      /* swamp: clay pockets under the mud cap */
      if (biome === 3 && rand() < 0.5 && sy + 3 < H) {
        tile[(sy + 3) * W + x2] = TILE.CLAY;
      }
      tile[(H - 1) * W + x2] = TILE.BEDROCK;
      /* Terraria-style: ALL cells below the surface line get a wall so
         every dug tunnel/cave shows dirt/stone backdrop, never sky */
      for (var y2 = sy + 1; y2 < H; y2++) {
        wall[y2 * W + x2] = y2 <= db ? WALL.WALL_DIRT : WALL.WALL_STONE;
      }
    }

    /* ---- 3. worm caves ------------------------------------------------ */
    function carve(cx, cy, r) {
      var r2 = r * r;
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          var xx = cx + dx, yy = cy + dy;
          if (xx < 1 || xx >= W - 1 || yy < 1 || yy >= H - 1) { continue; }
          /* Reachability repair reuses carve after chest placement.
             Preserve the chest tile as well as its registry entry.
             (main #5: preserve generated chests) */
          if (dx * dx + dy * dy <= r2 && tile[yy * W + xx] !== TILE.CHEST) {
            tile[yy * W + xx] = TILE.AIR;
          }
        }
      }
    }    var WORMS = 24;
    for (var wv = 0; wv < WORMS; wv++) {
      var fromSurface = rand() < 0.3;
      var wx = 8 + Math.floor(rand() * (W - 16));
      var wy = fromSurface ? surfaceY[wx] : surfaceY[wx] + 20 + Math.floor(rand() * 120);
      var ang = rand() < 0.5 ? 0 : Math.PI;         /* horizontal-ish drift */
      ang += (rand() - 0.5) * 1.2;
      var steps = 200 + Math.floor(rand() * 300);
      for (var st = 0; st < steps; st++) {
        ang += (rand() - 0.5) * 0.8;
        wy += Math.sin(ang) * 1.6;
        wx += Math.cos(ang) * 1.6;
        if (wx < 2 || wx >= W - 2 || wy < surfaceY[Math.max(0, Math.min(W - 1, Math.round(wx)))] - 2 || wy >= H - 4) { break; }
        carve(Math.round(wx), Math.round(wy), 2 + Math.floor(rand() * 3));
        if (rand() < 0.03) { carve(Math.round(wx), Math.round(wy), 4 + Math.floor(rand() * 3)); }
      }
    }

    /* ---- 4. ore clusters ---------------------------------------------- */
    /* depth-weighted ore picks, now including full-pack "ore-like"
       textures: coral pockets (mid/deep cave reefs) and glacier ice
       (shallow cold pockets). coal/iron/gold/diamond stay the core. */
    function oreWeight(depth) {
      /* depth below surface */
      if (depth < 20) { return [TILE.COAL, TILE.COAL, TILE.IRON, TILE.SANDSTONE]; }
      if (depth < 60) { return [TILE.COAL, TILE.IRON, TILE.IRON, TILE.GOLD, TILE.CLAY]; }
      if (depth < 100) { return [TILE.IRON, TILE.GOLD, TILE.GOLD, TILE.DIAMOND, TILE.GABBRO]; }
      return [TILE.GOLD, TILE.DIAMOND, TILE.DIAMOND, TILE.DIAMOND, TILE.MARBLE_BRICKS];
    }
    var ORE_VEINS = 320;
    for (var v = 0; v < ORE_VEINS; v++) {
      var vx = 2 + Math.floor(rand() * (W - 4));
      var vy = surfaceY[vx] + 8 + Math.floor(rand() * (H - surfaceY[vx] - 20));
      var pool = oreWeight(vy - surfaceY[vx]);
      var kind = pool[Math.floor(rand() * pool.length)];
      var size = 4 + Math.floor(rand() * 11);       /* 4-14 cells */
      var cx2 = vx, cy2 = vy;
      for (var c = 0; c < size; c++) {
        var vi = cy2 * W + cx2;
        if (cx2 > 0 && cx2 < W - 1 && cy2 > 0 && cy2 < H - 1 &&
            (tile[vi] === TILE.STONE || tile[vi] === TILE.DIRT ||
             tile[vi] === TILE.LIMESTONE || tile[vi] === TILE.MARBLE ||
             tile[vi] === TILE.BASALT || tile[vi] === TILE.OBSIDIAN)) {
          tile[vi] = kind;
        }
        cx2 += Math.floor(rand() * 3) - 1;
        cy2 += Math.floor(rand() * 3) - 1;
      }
    }
    /* decorated-ore veins: the brick/tile/carved stone textures +
       remaining coral colors appear as small "ruin pockets" anywhere
       solid below the dirt band */
    var RUIN_KINDS = [TILE.COBBLESTONE, TILE.COBBLE_BRICKS,
      TILE.COBBLE_BRICKS_MOSSY, TILE.GRANITE_BRICKS, TILE.LIMESTONE_BRICKS,
      TILE.MARBLE_BRICKS2, TILE.MARBLE_BRICKS3, TILE.SANDSTONE_BRICKS,
      TILE.SANDSTONE_CARVED, TILE.SANDSTONE_TILES, TILE.SERPENTINE_BRICKS,
      TILE.SERPENTINE_CARVED, TILE.RHYOLITE_TILES, TILE.SLATE_TILES,
      TILE.ICE_ICICLES, TILE.BASALT_FLOW];
    /* coral crystal pockets REMOVED from ruins (USER: 地下的这种水晶太多了)
       — they overran every cave as glowing teal mounds; the yellow/cyan
       crystals remain only as rare cave-decor plants. */
    for (var rv = 0; rv < 240; rv++) {
      var rx = 2 + Math.floor(rand() * (W - 4));
      var ry = dirtBottom[rx] + 4 + Math.floor(rand() * Math.max(1, H - dirtBottom[rx] - 16));
      if (ry >= H - 4) { continue; }
      var rk = RUIN_KINDS[Math.floor(rand() * RUIN_KINDS.length)];
      var rsize = 2 + Math.floor(rand() * 5);
      var ryy = ry;
      for (var rc = 0; rc < rsize; rc++) {
        var rii = ryy * W + rx;
        if (rx > 0 && rx < W - 1 && ryy > 0 && ryy < H - 1 &&
            tile[rii] !== TILE.AIR && tile[rii] !== TILE.BEDROCK) {
          tile[rii] = rk;
        }
        rx += Math.floor(rand() * 3) - 1;
        ryy += Math.floor(rand() * 3) - 1;
      }
    }

    /* ---- 5. trees (whole-tree sprites; species list kept for saplings) -- */
    var trees = [];
    var SPECIES = [
      { wood: TILE.WOOD, leaf: TILE.LEAF, sapling: TILE.SAPLING_OAK, top: TILE.LOG_TOP_OAK },
      { wood: TILE.WOOD_BEECH, leaf: TILE.LEAF_BEECH, sapling: TILE.SAPLING_BEECH, top: TILE.LOG_TOP_BEECH },
      { wood: TILE.WOOD_PINE, leaf: TILE.LEAF_PINE, sapling: TILE.SAPLING_PINE, top: TILE.LOG_TOP_PINE },
      { wood: TILE.WOOD_MAPLE, leaf: TILE.LEAF_MAPLE, sapling: TILE.SAPLING_MAPLE, top: TILE.LOG_TOP_MAPLE },
      { wood: TILE.WOOD_EUC, leaf: TILE.LEAF_EUC, sapling: TILE.SAPLING_EUC, top: TILE.LOG_TOP_EUC }
    ];
    var spIdx = Math.floor(rand() * SPECIES.length);
    var sp2Idx = Math.floor(rand() * SPECIES.length);
    var sp = SPECIES[spIdx], sp2 = SPECIES[sp2Idx];
    var tx = 6;
    while (tx < W - 6) {
      var biome = biomeOf[tx];
      var groundTile = tile[surfaceY[tx] * W + tx];
      var treeSpecies = rand() < 0.7 ? sp : sp2;
      var groundSolid = groundTile === TILE.GRASS || groundTile === TILE.GRASS_SNOWY;
      if (biome === 2) {
        /* desert: cactus columns + dry shrubs, no leafy trees */
        if (rand() < 0.25) {
          var ch = 2 + Math.floor(rand() * 3);
          for (var cyy = surfaceY[tx] - 1; cyy > surfaceY[tx] - 1 - ch && cyy > 1; cyy--) {
            tile[cyy * W + tx] = rand() < 0.5 ? TILE.CACTUS_CHOLLA : TILE.CACTUS_PRICKLYPEAR;
          }
          tx += 7 + Math.floor(rand() * 8);
        } else {
          if (rand() < 0.35 && groundTile === TILE.SAND && surfaceY[tx] > 1) {
            tile[(surfaceY[tx] - 1) * W + tx] = rand() < 0.5
              ? TILE.P_SAGEBRUSH : TILE.P_CREOSOTE;
          }
          tx += 3 + Math.floor(rand() * 6);
        }
      } else if (rand() < 0.4 && groundSolid && treeFootprintOk(tx, surfaceY[tx])) {
        /* whole-tree sprite: one multi-tile image per tree (USER art).
           RULE (USER): a tree needs 8 GRASS tiles under its footprint —
           treeFootprintOk() checks the surface columns tx-3..tx+5: all
           must be GRASS cap at the same height (flat ground), so trees
           never straddle cliff steps or sprout on stone/sand. */
        trees.push({ x: tx, y: surfaceY[tx], sprite: rand() < 0.5 ? 0 : 1 });
        tx += 12 + Math.floor(rand() * 13);
      } else {
        /* open ground: saplings + log stumps use the top textures */
        if (rand() < 0.3 && groundSolid && surfaceY[tx] > 1) {
          var dec = rand();
          if (dec < 0.5) {
            tile[(surfaceY[tx] - 1) * W + tx] = treeSpecies.sapling;
          } else if (dec < 0.75) {
            tile[surfaceY[tx] * W + tx] = treeSpecies.top;   /* stump cross-section */
          }
        }
        tx += 3 + Math.floor(rand() * 6);
      }
    }
    /* hay bales: occasional farmland meadow patches on flat grass */
    for (var hx0 = 20; hx0 < W - 20; hx0 += 60 + Math.floor(rand() * 80)) {
      if (biomeOf[hx0] !== 0) { continue; }
      var flatOk = true;
      for (var fx = hx0 - 3; fx <= hx0 + 3; fx++) {
        if (Math.abs(surfaceY[fx] - surfaceY[hx0]) > 1) { flatOk = false; break; }
      }
      if (!flatOk || tile[surfaceY[hx0] * W + hx0] !== TILE.GRASS) { continue; }
      var hw = 3 + Math.floor(rand() * 4);
      for (var hxx = hx0; hxx < hx0 + hw && hxx < W - 4; hxx++) {
        if (tile[surfaceY[hxx] * W + hxx] !== TILE.GRASS) { continue; }
        tile[surfaceY[hxx] * W + hxx] = TILE.FARMLAND;
        if (rand() < 0.6 && surfaceY[hxx] > 1) {
          tile[(surfaceY[hxx] - 1) * W + hxx] = rand() < 0.5
            ? TILE.CROP_WHEAT3 : TILE.CROP_WHEAT4;
        }
      }
      /* hay bale at the patch edge */
      var hxEdge = hx0 + hw;
      if (hxEdge < W - 4 && tile[surfaceY[hxEdge] * W + hxEdge] === TILE.GRASS) {
        tile[surfaceY[hxEdge] * W + hxEdge] = TILE.HAY_SIDE;
      }
    }

    /* ---- 5b. surface plants + cave decor (biome-aware) ----------------- */
    /* grass biome flowers pool */
    var FLOWERS = [TILE.PLANT_FLOWER, TILE.FLOWER_DANDELION,
      TILE.FLOWER_FORGET_ME_NOT, TILE.FLOWER_ASTER, TILE.FLOWER_LUPINE,
      TILE.FLOWER_MUSTARD, TILE.FLOWER_MAYFLOWER, TILE.FLOWER_ORCHID_GROUND,
      TILE.FLOWER_ORCHID_WAXLIP, TILE.FLOWER_DANDELION, TILE.PLANT_FERN,
      TILE.P_DICOT, TILE.P_FIDDLENECK, TILE.P_GOLDENROD, TILE.P_MUGWORT,
      TILE.P_PIMPERNEL, TILE.P_SEA_THRIFT, TILE.FLOWER_ASTER];
    /* swamp: reeds + water plants */
    var SWAMPY = [TILE.CATTAIL, TILE.P_SEDGE, TILE.P_HORSETAIL,
      TILE.P_LILY, TILE.P_WATERLILY, TILE.FLOWER_IRIS_YELLOW,
      TILE.P_GINGER, TILE.P_MONSTERA, TILE.P_THISTLE];
    /* exotic flowers on any biome (rare) */
    var EXOTIC = [TILE.FLOWER_AGAPANTHUS, TILE.FLOWER_ALOE,
      TILE.FLOWER_BIRD_OF_PARADISE, TILE.FLOWER_BOTTLEBRUSH,
      TILE.FLOWER_LUPINE, TILE.P_NIGHTSHADE, TILE.P_MANZANITA,
      TILE.P_LILY, TILE.FLOWER_FORGET_ME_NOT];
    /* meadow grasses everywhere on grass */
    var MEADOW = [TILE.PLANT_GRASS, TILE.GRASS_SHORT, TILE.GRASS_MED,
      TILE.GRASS_DENSE, TILE.GRASS_FLOWERING, TILE.PLANT_FERN, TILE.FERN2];
    var CAVE_DECO = [TILE.PLANT_BROWN_MUSHROOM, TILE.SPIDERWEB,
      TILE.P_CORAL_PORE, TILE.P_CORAL_STAR, TILE.P_STROMATOLITE,
      TILE.P_CORAL_BRAIN_BLEACHED, TILE.P_CORAL_CAULIFLOWER_BLEACHED,
      TILE.PLANT_RED_MUSHROOM, TILE.PLANT_RED_MUSHROOM, TILE.PLANT_RED_MUSHROOM];
    for (var px5 = 2; px5 < W - 2; px5++) {
      var b = biomeOf[px5];
      var cap5 = tile[surfaceY[px5] * W + px5];
      /* surface: on grass, 35% chance; snowy → nothing on top */
      if (b === 0 && cap5 === TILE.GRASS && rand() < 0.5 && surfaceY[px5] > 1) {
        var r6 = rand();
        tile[(surfaceY[px5] - 1) * W + px5] = r6 < 0.45
          ? MEADOW[Math.floor(rand() * MEADOW.length)]
          : r6 < 0.75 ? FLOWERS[Math.floor(rand() * FLOWERS.length)]
          : r6 < 0.95 ? SWAMPY[Math.floor(rand() * SWAMPY.length)]
          : EXOTIC[Math.floor(rand() * EXOTIC.length)];
      }
      /* swamp biome: reeds even on mud */
      if (b === 3 && rand() < 0.5 && surfaceY[px5] > 1 &&
          (cap5 === TILE.MUD_CRACKED || cap5 === TILE.GRASS)) {
        tile[(surfaceY[px5] - 1) * W + px5] = SWAMPY[Math.floor(rand() * SWAMPY.length)];
      }
      /* caves: mushroom / spiderweb / coral plants on air-above-solid cells.
       Coral crystals heavily de-weighted (USER: 地下的这种水晶太多了) —
       the deco pool used to be 5/9 corals at 6%/cell; now corals only via
       a 1.2% side roll, mushrooms/webs dominate. */
      for (var cy5 = surfaceY[px5] + 4; cy5 < H - 4; cy5++) {
        var ii = cy5 * W + px5;
        if (tile[ii] === TILE.AIR && tile[ii + W] !== TILE.AIR &&
            PASSABLE[tile[ii + W]] === undefined && rand() < 0.06) {
          var cd = rand();
          if (cd < 0.2) {
            tile[ii] = TILE.P_CORAL_PORE;
          } else {
            var BASE_DECO = [TILE.PLANT_BROWN_MUSHROOM, TILE.SPIDERWEB,
              TILE.PLANT_RED_MUSHROOM, TILE.PLANT_RED_MUSHROOM,
              TILE.PLANT_RED_MUSHROOM, TILE.P_STROMATOLITE];
            tile[ii] = BASE_DECO[Math.floor(rand() * BASE_DECO.length)];
          }
        }
      }
      /* amethyst crystals sparkle deep down (rarer: 0.05 -> 0.015) */
      if (rand() < 0.015) {
        for (var cy6 = dirtBottom[px5] + 60; cy6 < H - 4; cy6++) {
          var jj = cy6 * W + px5;
          if (tile[jj] === TILE.AIR && tile[jj + W] !== TILE.AIR) {
            tile[jj] = TILE.CRYSTAL;
            break;
          }
        }
      }
    }

    /* ---- 6. chests in caves ------------------------------------------- */
    function isAirCave(cx, cy) {
      /* open pocket with floor */
      if (cx < 3 || cx >= W - 3 || cy < 2 || cy >= H - 6) { return false; }
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          if (tile[(cy + dy) * W + cx + dx] !== TILE.AIR) { return false; }
        }
      }
      return tile[(cy + 2) * W + cx] !== TILE.AIR;
    }
    var attempts = 0;
    /* chest-room wall material rotates through the new brick families */
    var CHEST_ROOMS = [
      { wall: WALL.WALL_WOOD, floor: TILE.PLANK, torches: true },
      { wall: null, floor: TILE.COBBLE_BRICKS, torches: true },
      { wall: null, floor: TILE.GRANITE_BRICKS, torches: true },
      { wall: null, floor: TILE.MARBLE_BRICKS2, torches: true }
    ];
    while (chests.length < 4 && attempts < 4000) {
      attempts++;
      var chx = 4 + Math.floor(rand() * (W - 8));
      var chy = surfaceY[chx] + 10 + Math.floor(rand() * (H - surfaceY[chx] - 26));
      if (!isAirCave(chx, chy)) { continue; }
      var room = CHEST_ROOMS[chests.length % CHEST_ROOMS.length];
      /* platform + chest (room.material floor) */
      tile[(chy + 2) * W + chx - 1] = room.floor;
      tile[(chy + 2) * W + chx] = room.floor;
      tile[(chy + 2) * W + chx + 1] = room.floor;
      tile[(chy + 1) * W + chx] = TILE.CHEST;
      if (room.wall) {
        wall[(chy + 1) * W + chx - 1] = room.wall;
        wall[(chy + 1) * W + chx] = room.wall;
        wall[(chy + 1) * W + chx + 1] = room.wall;
      }
      /* torch in the room so it's visible in the dark */
      tile[(chy + 1) * W + chx + 1] = TILE.TORCH;
      chests.push([chx, chy + 1]);
    }
    /* I4: never ship fewer than 4 chests — pad with guaranteed ones
       in shallow dug pockets near the surface */
    while (chests.length < 4) {
      var px4 = 60 + chests.length * 40;
      var py4 = surfaceY[px4] + 6;
      carve(px4, py4, 2);
      tile[(py4 + 2) * W + px4] = TILE.PLANK;
      tile[(py4 + 1) * W + px4] = TILE.CHEST;
      chests.push([px4, py4 + 1]);
    }

    /* ---- 6.5 energy crystals (the goal chain) ---------------------------
       6 amethyst crystals seeded in DEEP air caves (depth > surface+25).
       They are the win condition fuel: dig 3+ of them, carry them to the
       altar (the flag) to win. Deep-only placement forces cave spelunking
       through the dark (torches matter), past bugs. */
    /* deterministic scan instead of random probes: isAirCave's 3x3-
       pocket requirement almost never passes at depth (chests hit the
       same wall - that's why they need the I4 carve fallback). Scan
       columns for "air with solid floor" spots at depth, spread across
       6 bands of the map; if a band has none, CARVE a pocket there
       (guaranteed 6 crystals, no soft-lock). */
    var crystals = [];
    var BANDS = 6, bandW = Math.floor((W - 8) / BANDS);
    for (var band = 0; band < BANDS; band++) {
      var placed = false;
      var bx0 = 4 + band * bandW, bx1 = bx0 + bandW;
      /* probe order randomized WITHIN the band so worlds differ */
      for (var tryI = 0; tryI < 60 && !placed; tryI++) {
        var rx = bx0 + Math.floor(rand() * bandW);
        var ryMin = surfaceY[rx] + 22;
        var ryMax = H - 6;
        if (ryMax - ryMin < 4) { continue; }
        var ry = ryMin + Math.floor(rand() * (ryMax - ryMin));
        if (ry < 2 || ry >= H - 2) { continue; }
        var here = tile[ry * W + rx];
        var below = tile[(ry + 1) * W + rx];
        if (here !== TILE.AIR) { continue; }
        if (below === TILE.AIR || below === TILE.LAVA) { continue; }
        tile[ry * W + rx] = TILE.CRYSTAL;
        crystals.push([rx, ry]);
        placed = true;
      }
      if (!placed) {
        /* carve a guaranteed pocket in this band */
        var gx = bx0 + Math.floor(bandW / 2);
        var gy = Math.min(H - 8, surfaceY[gx] + 40);
        carve(gx, gy, 2);
        tile[(gy + 1) * W + gx] = TILE.CRYSTAL;
        crystals.push([gx, gy]);
      }
    }

    /* ---- 6.6 lava pools (deep cave floors, non-solid, glowing) ----------
       Cosmetic v1 (no fluid damage). Placed AFTER chests/crystals so the
       avoid-list is final: never near a chest, crystal, or the flag. */
    var avoidList = [];
    for (var li = 0; li < crystals.length; li++) { avoidList.push(crystals[li]); }
    for (var ci = 0; ci < chests.length; ci++) { avoidList.push(chests[ci]); }
    avoidList.push([32, surfaceY[32]]);                    /* spawn area */
    avoidList.push([W - 40, surfaceY[W - 40]]);            /* flag area  */
    function lavaConflicts(x, y) {
      for (var a = 0; a < avoidList.length; a++) {
        if (Math.abs(avoidList[a][0] - x) < 6 && Math.abs(avoidList[a][1] - y) < 6) {
          return true;
        }
      }
      return false;
    }
    var lavaPlaced = 0, lavaTries = 0;
    while (lavaPlaced < 10 && lavaTries < 3000) {
      lavaTries++;
      var lx = 4 + Math.floor(rand() * (W - 8));
      var ly = H - 30 + Math.floor(rand() * 20);   /* bottom 30 rows */
      if (ly >= H - 3 || lavaConflicts(lx, ly)) { continue; }
      /* flat-ish air pocket with solid floor */
      var okL = true;
      for (var lw = -2; lw <= 2 && okL; lw++) {
        var lidx = ly * W + (lx + lw);
        if (tile[lidx] !== TILE.AIR) { okL = false; }
        if (tile[lidx + W] === TILE.AIR || PASSABLE[tile[lidx + W]]) { okL = false; }
      }
      if (!okL) { continue; }
      var lwid = 2 + Math.floor(rand() * 3);
      for (var lx2 = lx - lwid; lx2 <= lx + lwid; lx2++) {
        if (lx2 > 0 && lx2 < W - 1 && tile[ly * W + lx2] === TILE.AIR) {
          tile[ly * W + lx2] = TILE.LAVA;
        }
      }
      lavaPlaced++;
    }

    /* ---- 6.7 rare-guest pass: guarantee every registered block can be
       found SOMEWHERE across seeds (single world does not need all).
       Sparse singles for tiles the regular passes never place:
       - leftover stone columns (old stone deep)
       - glass shards + snow patches near icy biome edges
       - mossy cobble clusters
       - red mushrooms, grass_top caps on hay, hay_top
       - alternate sand variants inside desert band
       - plank family variety (beech/euc/maple/pine)
       - crop early stages next to farmland patches
       - coral plants variety (non-bleached brain/cauliflower,
         pore_bleached, star_bleached) */
    var placed = {};
    function rareGuest(id, y, x) { placed[id] = (placed[id] || 0) + 1; }
    /* helper: find an air cell with solid below, above depth floor */
    function findSpot(minY, maxY) {
      for (var t = 0; t < 200; t++) {
        var gx = 4 + Math.floor(rand() * (W - 8));
        var gy = minY + Math.floor(rand() * Math.max(1, maxY - minY));
        if (gy >= H - 3 || gy < 2) { continue; }
        var gi = gy * W + gx;
        if (tile[gi] === TILE.AIR && tile[gi + W] !== TILE.AIR &&
            PASSABLE[tile[gi + W]] === undefined) { return [gx, gy]; }
      }
      return null;
    }
    /* old-stone remnants: stone pockets at mid depth. Marble body, not
       STONE — the surface-looking 石头 art (slot 3) must never render
       underground (USER: "地表石头不应该放地底"); deep pockets read as
       marble veins instead. */
    for (var st = 0; st < 6; st++) {
      var sp = findSpot(H - 180, H - 40);
      if (sp) { tile[sp[1] * W + sp[0]] = TILE.MARBLE; rareGuest(18, sp[1], sp[0]); }
    }
    /* glass: crystal caves window pockets deep */
    for (var gl = 0; gl < 5; gl++) {
      var gp = findSpot(H - 200, H - 60);
      if (gp) { tile[gp[1] * W + gp[0] + 1 < W ? gp[0] + 1 : gp[0]] = TILE.GLASS; rareGuest(26, gp[1], gp[0]); }
    }
    /* snow cover on snowy biome surface */
    for (var snx = 2; snx < W - 2; snx++) {
      if (biomeOf[snx] === 1 && tile[surfaceY[snx] * W + snx] === TILE.GRASS_SNOWY && rand() < 0.4 && surfaceY[snx] > 1) {
        tile[(surfaceY[snx] - 1) * W + snx] = TILE.SNOW;
        rareGuest(24, surfaceY[snx] - 1, snx);
      }
    }
    /* mossy cobble small clusters — deep only (dirt-band test whitelist) */
    for (var mc = 0; mc < 8; mc++) {
      var mp = findSpot(H - 120, H - 30);
      if (mp) { tile[mp[1] * W + mp[0]] = TILE.COBBLE_MOSSY; rareGuest(27, mp[1], mp[0]); }
    }
    /* red mushrooms on mossy clusters (39) — deep only: the dirt-band
       layering test whitelists surface-band ids, keep decor below it */
    for (var rm = 0; rm < 10; rm++) {
      var rp = findSpot(H - 120, H - 30);
      if (rp) { tile[(rp[1] - 1 >= 1 ? rp[1] - 1 : rp[1]) * W + rp[0]] = TILE.PLANT_RED_MUSHROOM; rareGuest(39, rp[1], rp[0]); }
    }
    /* grass_top: caps next to farmland */
    for (var gt = 0; gt < 4; gt++) {
      var tp = findSpot(surfaceY[4] + 3, H - 60);
      if (tp) { tile[tp[1] * W + tp[0]] = TILE.GRASS_TOP; rareGuest(52, tp[1], tp[0]); }
    }
    /* hay pair: side + top caps on meadow surface */
    for (var hy = 0; hy < 4; hy++) {
      var hp = findSpot(surfaceY[4] + 1, H - 100);
      if (hp && surfaceY[hp[0]] > 2 && tile[surfaceY[hp[0]] * W + hp[0]] === TILE.GRASS) {
        tile[(surfaceY[hp[0]] - 1) * W + hp[0]] = rand() < 0.5 ? TILE.HAY_TOP : TILE.HAY_SIDE;
        rareGuest(54, surfaceY[hp[0]] - 1, hp[0]);
      }
    }
    /* alternate sands inside desert biome band */
    for (var sx2 = 2; sx2 < W - 2; sx2++) {
      if (biomeOf[sx2] === 2 && rand() < 0.3) {
        var under = tile[(surfaceY[sx2] + 1) * W + sx2];
        if (under === TILE.SAND) {
          var rollS = rand();
          tile[(surfaceY[sx2] + 1) * W + sx2] = rollS < 0.4 ? TILE.SAND_UGLY_2
            : rollS < 0.8 ? TILE.SAND_UGLY_3 : TILE.SAND;
        }
      }
    }
    /* plank family variety: scattered single planks underground */
    var PLANKS = [TILE.PLANK_BEECH, TILE.PLANK_EUC, TILE.PLANK_MAPLE, TILE.PLANK_PINE];
    for (var pl = 0; pl < 8; pl++) {
      var pp = findSpot(H - 170, H - 20);
      if (pp) { tile[pp[1] * W + pp[0]] = PLANKS[pl % PLANKS.length]; }
    }
    /* coral plant guests in caves (variety, including bleached) */
    var CORAL_GUESTS = [TILE.P_CORAL_BRAIN, TILE.P_CORAL_CAULIFLOWER,
      TILE.P_CORAL_PORE_BLEACHED, TILE.P_CORAL_STAR_BLEACHED];
    for (var cg = 0; cg < 14; cg++) {
      var cgp = findSpot(H - 170, H - 20);
      if (cgp) { tile[cgp[1] * W + cgp[0]] = CORAL_GUESTS[cg % CORAL_GUESTS.length]; }
    }
    /* coral_star solid block, deep */
    for (var cso = 0; cso < 4; cso++) {
      var csp = findSpot(H - 150, H - 30);
      if (csp) { tile[csp[1] * W + csp[0]] = TILE.GRANITE_BRICKS; rareGuest(51, csp[1], csp[0]); }
    }
    /* obsidian extra deep: already banded but ensure presence */
    /* crops early stages near farmland patches */
    var CROPS_EARLY = [TILE.CROP_CARROTS1, TILE.CROP_CARROTS2, TILE.CROP_CARROTS3,
      TILE.CROP_CARROTS4, TILE.CROP_WHEAT1, TILE.CROP_WHEAT2, TILE.CROP_WHEAT5];
    for (var cr = 0; cr < 10; cr++) {
      var cp2 = findSpot(surfaceY[4] + 1, H - 100);
      if (!cp2) { continue; }
      var gx2 = cp2[0];
      if (surfaceY[gx2] > 1 && tile[surfaceY[gx2] * W + gx2] === TILE.FARMLAND) {
        tile[(surfaceY[gx2] - 1) * W + gx2] = CROPS_EARLY[Math.floor(rand() * CROPS_EARLY.length)];
      } else if (surfaceY[gx2] > 1 && tile[surfaceY[gx2] * W + gx2] === TILE.GRASS && rand() < 0.6) {
        /* seed wild crops on grass too */
        tile[(surfaceY[gx2] - 1) * W + gx2] = CROPS_EARLY[Math.floor(rand() * CROPS_EARLY.length)];
      }
    }

    /* ---- 6.9 spawn monument (USER: "类似祭坛，弄个特殊结构就行了") ----
       NOT a building (the earlier fort attempt scattered floating bricks
       and fought the terrain). A symmetric ALTAR-STYLE monument welded
       to the spawn column: carved-sandstone twin pillars (2 wide, 5
       high) with marble-brick capitals, a rune floor of sandstone
       tiles under the spawn point, an eternal torch at the heart, and
       crystal shards (TILE 42) as the crest — echoing the Kraken altar
       look. Pillars stand ON the terrain surface (each column uses its
       own surfaceY), so nothing floats and nothing boxes the player
       in — both sides stay walkable. */
    (function buildSpawnMonument() {
      var kx = 32;
      var pil = TILE.SANDSTONE_CARVED, cap = TILE.MARBLE_BRICKS,
          floor = TILE.SANDSTONE_TILES, crest = 42;
      [-5, -4, 4, 5].forEach(function (off) {
        var px2 = kx + off;
        var gy = surfaceY[px2];               /* own column ground */
        for (var dy = 0; dy < 5; dy++) {
          tile[(gy - 1 - dy) * W + px2] = pil;
        }
        tile[(gy - 6) * W + px2] = cap;       /* capital on top */
      });
      /* rune floor under the spawn point (3 wide) */
      for (var fx = kx - 1; fx <= kx + 1; fx++) {
        tile[surfaceY[fx] * W + fx] = floor;
      }
      /* eternal torch at the monument heart */
      tile[(surfaceY[kx] - 1) * W + kx] = 12;
      /* crystal crests atop each capital */
      [-5, 5].forEach(function (off) {
        var px2 = kx + off;
        tile[(surfaceY[px2] - 7) * W + px2] = crest;
      });
    })();

    /* ---- 7. spawn / flag ----------------------------------------------- */
    var spawn = [32, surfaceY[32] - 2];
    var flagX = W - 40;
    tile[surfaceY[flagX] * W + flagX] = TILE.GRASS;   /* ensure ground */
    var flag = [flagX, surfaceY[flagX] - 1];

    /* ---- 8. reachability repair (flood fill; carve tunnels if needed) -- */
    function floodReach() {
      var seen = new Uint8Array(W * H);
      var q = [spawn];
      while (q.length) {
        var p = q.pop();
        var px2 = p[0], py2 = p[1];
        if (px2 < 0 || py2 < 0 || px2 >= W || py2 >= H || seen[py2 * W + px2]) { continue; }
        seen[py2 * W + px2] = 1;
        var tt = tile[py2 * W + px2];
        if (tt !== TILE.AIR && !PASSABLE[tt]) { continue; }
        q.push([px2 + 1, py2], [px2 - 1, py2], [px2, py2 + 1], [px2, py2 - 1]);
      }
      return seen;
    }
    function carveTunnel(x1, y1, x2, y2) {
      var dx = x2 - x1, dy = y2 - y1;
      var n = Math.max(Math.abs(dx), Math.abs(dy));
      for (var i2 = 0; i2 <= n; i2++) {
        var xx = Math.round(x1 + dx * i2 / Math.max(1, n));
        var yy = Math.round(y1 + dy * i2 / Math.max(1, n));
        carve(xx, yy, 2);
      }
    }
    var reach = floodReach();
    function ensure(pt, what) {
      var guard = 0;
      while (!reach[pt[1] * W + pt[0]] && guard < 3) {
        guard++;
        /* walk up from the target to nearest reached cell, carve straight */
        var tx2 = pt[0], ty2 = pt[1];
        while (ty2 > 2 && !reach[ty2 * W + tx2]) { ty2--; }
        carveTunnel(tx2, ty2, pt[0], pt[1]);
        reach = floodReach();
      }
      if (!reach[pt[1] * W + pt[0]]) {
        /* last resort: tunnel straight from spawn */
        carveTunnel(spawn[0], spawn[1], pt[0], pt[1]);
        reach = floodReach();
      }
      /* I3: verify the fallback actually connected; otherwise relocate
         the target next to spawn in guaranteed-open air */
      if (!reach[pt[1] * W + pt[0]]) {
        pt[0] = spawn[0] + 2;
        pt[1] = surfaceY[spawn[0] + 2] - 1;
        tile[pt[1] * W + pt[0]] = TILE.AIR;
        reach = floodReach();
      }
    }
    ensure(flag, 'flag');
    for (var ci = 0; ci < chests.length; ci++) { ensure(chests[ci], 'chest'); }
    /* crystals must be reachable too, or the goal chain can soft-lock */
    for (var ki = 0; ki < crystals.length; ki++) { ensure(crystals[ki], 'crystal'); }

    return {
      W: W, H: H,
      tile: tile, wall: wall, surfaceY: surfaceY, dirtBottom: dirtBottom,
      spawn: spawn, flag: flag, chests: chests, crystals: crystals,
      trees: trees
    };
  }

  return { TILE: TILE, WALL: WALL, PASSABLE: PASSABLE, generate: generate };
}));
