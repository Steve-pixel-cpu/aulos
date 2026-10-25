# -*- coding: utf-8 -*-
"""build_terraria_tiles.py — Terraria-palette reskin of the egg-game tileset.

Strategy (decided 2026-10-25):
  133/155 atlas cells are byte-identical to CC0 sources in src/*.zip, so we
  KEEP every tile's hand-drawn SHAPE and remap COLORS only:
    1. GLOBAL palette LUT  — exact-hex mapping old color -> Terraria color,
       applied to the whole atlas (grass/dirt/stone/ore/gems/coral...).
    2. PER-TILE overpaint  — tiles not found in the zips (torch/chest/lava/
       gravel/bedrock/walls) are redrawn procedurally in Terraria style.
  Layout & tiles.meta.js untouched: same 256x160 atlas, same atlasIndex.

Run:  python tools/build_terraria_tiles.py   (cwd = repo root or website/)
Output: website/assets/mc/tiles.png  (tiles_classic.png = original backup)
"""
import json
import os
import sys
from collections import Counter

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
MC = os.path.normpath(os.path.join(HERE, "..", "assets", "mc"))
ATLAS = os.path.join(MC, "tiles.png")
CLASSIC = os.path.join(MC, "tiles_classic.png")
META = os.path.join(MC, "tiles.json")

# ----------------------------------------------------------------------------
# 1. GLOBAL PALETTE LUT — Terraria-flavored exact-hex remap.
#    Keyed by 0xRRGGBB int; alpha channel never touched.
#    Only colors that actually appear in the atlas are listed (surveyed).
# ----------------------------------------------------------------------------
def h(s):
    return int(s.replace("#", ""), 16)

PALETTE = {
    # --- grass greens -> Terraria mushroom-biome teal-green (vivid) ---
    h("94ad39"): h("1ea861"),   # grass light blade
    h("849a33"): h("17a054"),   # grass mid
    h("74892a"): h("128b47"),   # grass dark
    h("697c25"): h("0d7f3e"),   # grass deepest
    # --- dirt browns -> Terraria forest dirt ---
    h("825646"): h("97694a"),
    h("785041"): h("8b5e42"),
    h("8b635d"): h("a3764f"),
    h("78463d"): h("7d5238"),
    h("6d4e4b"): h("6f4a32"),
    h("684039"): h("62402a"),
    # --- stone grays -> Terraria neutral blue-gray rock ---
    h("bac9cd"): h("8094a2"),
    h("8d99a4"): h("6f8494"),
    h("696f80"): h("5b7182"),
    h("414453"): h("43586b"),
    h("3f333b"): h("3a4d5e"),
    # --- wood/log browns -> Terraria bark ---
    h("867066"): h("6e4b2e"),
    h("b49d7e"): h("9c6e42"),
    h("7d595d"): h("5d3c22"),
    h("b77862"): h("875a33"),
    # --- sand -> Terraria desert pale gold ---
    h("e1a845"): h("eecf8a"),
    h("eecb90"): h("f7e5ab"),
    h("c57835"): h("d3a968"),
    h("8d4830"): h("a5834e"),
    # --- amethyst/gem purple -> Terraria glowing-mushroom purple ---
    h("b8a1c2"): h("b58fd9"),
    h("7e659b"): h("8a54b0"),
    h("5c3a6f"): h("5f2d8f"),
    h("4e1a49"): h("42116b"),
    # --- gold ore: stone base (above) + teal nugget -> gold ---
    # NOTE 63c4cc / 3d80a3 are SHARED by ice_glacier/ice_icicles — the ice
    # tiles get their own per-tile map in OVERRIDES, so the gold mapping is
    # scoped there, NOT global (global would paint glaciers gold).
    # (63c4cc -> ffd76e / 3d80a3 -> d9a032 live in the tile-10 override.)
    # --- diamond ore: deep purple rock + pale flecks -> cyan gem rock ---
    h("e5efef"): h("e5efef"),   # keep white sparkle
    # --- coral (brain green/gold plants) -> Terraria pink coral ---
    h("a5c67c"): h("ff6ea0"),
    h("739a70"): h("d94f85"),
    # --- coal: gold sparkle colors were reused; map them dark (coal chunks)
    #     NOTE applied AFTER gold mapping via per-tile fixup, see OVERRIDES.
    # --- glass frost tones -> Terraria clear glass ---
    h("9ae5d5"): h("cfeef7"),
    # --- mushroom red cap stays (regular red mushroom) ---
    # --- clay -> Terraria terracotta ---
    h("533b41"): h("976b56"),
    # --- misc warm wood tones used by limestone/marble walls ---
    h("c4c6b8"): h("c9b7a0"),
    h("e3e6ac"): h("e8d9a0"),
}

# per-tile extra LUT applied AFTER global palette (id -> {from: to})
OVERRIDES = {
    # gold(10): stone base (already blue-gray via global) + teal nuggets -> gold
    10: {h("63c4cc"): h("ffd76e"), h("3d80a3"): h("d9a032")},
    # ice(55,56): teal->pale terraria ice (shared colors with gold — scoped!)
    55: {h("63c4cc"): h("a8dcf0"), h("3d80a3"): h("5b9cc4")},
    56: {h("63c4cc"): h("a8dcf0"), h("3d80a3"): h("5b9cc4")},
    # diamond(11): keyed on RAW colors (checked BEFORE palette) — purple gem
    # family -> terraria cyan crystal
    11: {
        h("b8a1c2"): h("a8ecdf"),   # pale fleck -> pale cyan
        h("7e659b"): h("37a8b0"),   # mid -> mid cyan
        h("5c3a6f"): h("14707f"),   # deep -> deep cyan
        h("4e1a49"): h("0e5f6e"),   # rock base -> dark cyan
    },
    # coal(8): raw sparkle colors are sand-family (e1a845/c57835) — map to
    # dark chunks before the global sand remap gets them
    8: {
        h("e1a845"): h("2e3540"),
        h("c57835"): h("232830"),
        h("eecb90"): h("3c4552"),
        h("8d4830"): h("171b21"),
    },
    # hay stays golden but warmer terraria shade (already ok via sand map)
    # glowing mushroom(39): red cap -> Terraria glowing-mushroom teal
    39: {
        h("c33c40"): h("26c6da"),
        h("8d3649"): h("178f9e"),
    },
    # snow grass accent mint -> crisp terraria snow (keep), grass_snowy base
    # follows dirt via global map already.
    # leaves get per-species maps below (see LEAF_MAPS)
}

# per-tile leaf recolors: id -> {RAW old: new}. Checked BEFORE PALETTE so a
# species can escape the global grass-green mapping. RAW colors surveyed from
# tiles_classic.png (leaves do NOT share the grass palette):
#   oak  5c7836/7fa356/b29a4d/8dbb74/7a722c   beech 4d6659/a5c67c/5f7132/94ad39/739a70
#   pine 4d6659/5f7132/343f41/3f4328/8d4830/684039   maple 94ad39/5f7132/3f4328
#   euc  739a70/a5c67c/4d6659/5f7132
LEAF_MAPS = {
    # oak(6): vivid terraria green (fresh, brighter than grass)
    6: {
        h("5c7836"): h("17a054"), h("7fa356"): h("3fbf6c"),
        h("b29a4d"): h("128b47"), h("8dbb74"): h("5cd47f"),
        h("7a722c"): h("0d7f3e"),
    },
    # beech(29): light yellow-green
    29: {
        h("4d6659"): h("1d8a44"), h("a5c67c"): h("8ce06e"),
        h("5f7132"): h("2aa251"), h("94ad39"): h("5cc95a"),
        h("739a70"): h("25954a"),
    },
    # pine(31): deep blue-green conifer
    31: {
        h("4d6659"): h("164a38"), h("5f7132"): h("1d6e50"),
        h("343f41"): h("0f382a"), h("3f4328"): h("175c42"),
        h("8d4830"): h("123f2e"), h("684039"): h("0d3324"),
    },
    # maple(33): terraria autumn orange
    33: {
        h("94ad39"): h("e8823c"), h("5f7132"): h("c25f24"),
        h("3f4328"): h("8f3f16"),
    },
    # eucalyptus(35): blue-gray green
    35: {
        h("739a70"): h("5d9d8b"), h("a5c67c"): h("7fbcae"),
        h("4d6659"): h("3d7869"), h("5f7132"): h("4d8a7a"),
    },
}
OVERRIDES.update(LEAF_MAPS)

# ----------------------------------------------------------------------------
# 2. PROCEDURAL TILES — tiles absent from the CC0 zips, drawn by hand here.
# ----------------------------------------------------------------------------
def T(v):
    """clamp to byte"""
    return max(0, min(255, int(v)))

def put(px, x, y, rgb, a=255):
    px[x, y] = (T(rgb[0]), T(rgb[1]), T(rgb[2]), a)

def mul(c, k):
    return (c[0] * k, c[1] * k, c[2] * k)

# deterministic pseudo-random (no deps)
_SEED = [0x5EED]
def rnd():
    _SEED[0] = (_SEED[0] * 1103515245 + 12345) & 0x7FFFFFFF
    return _SEED[0] / 0x7FFFFFFF

def draw_speckle(px, base, dark, light, density=0.16):
    """Terraria signature: flat base + speckled grain."""
    for y in range(16):
        for x in range(16):
            r = rnd()
            if r < density * 0.45:
                put(px, x, y, dark)
            elif r < density:
                put(px, x, y, light)
            else:
                put(px, x, y, base)

def draw_blotches(px, base, dark, light, n=14):
    """Terraria-authentic texture: LARGE soft blobs (2x2/3x2), not fine
    1px noise like MC. Every terraria terrain tile reads as chunky."""
    for y in range(16):
        for x in range(16):
            put(px, x, y, base)
    for _ in range(n):
        bx, by = int(rnd() * 16), int(rnd() * 16)
        bw, bh = 2 + int(rnd() * 2), 1 + int(rnd() * 2)
        col = light if rnd() < 0.45 else dark
        for y in range(by, min(16, by + bh)):
            for x in range(bx, min(16, bx + bw)):
                if rnd() > 0.18:
                    put(px, x, y, col)

def bevel_solid(px, top=1.14, bottom=0.84, left=1.06, right=0.90):
    """Terraria bevel: lit top edge, shaded bottom, subtle sides.
    Applied per-tile since our atlas has no autotile."""
    for x in range(16):
        for k in (0, 1):
            p = px[x, k];  put(px, x, k, mul(p[:3], top), p[3])
        for k in (14, 15):
            p = px[x, k];  put(px, x, k, mul(p[:3], bottom), p[3])
    for y in range(16):
        p = px[0, y];  put(px, 0, y, mul(p[:3], left), p[3])
        p = px[15, y]; put(px, 15, y, mul(p[:3], right), p[3])

GRASS_GREEN   = (30, 168, 84)    # 1ea854 vivid cap
GRASS_GREEN_L = mul(GRASS_GREEN, 1.22)
GRASS_GREEN_D = mul(GRASS_GREEN, 0.62)

def tile_dirt_terraria(px):
    """Forest dirt: chunky blotch texture + terraria bevel."""
    draw_blotches(px, DIRT, mul(DIRT, 0.80), mul(DIRT, 1.18), 15)
    bevel_solid(px)

def tile_grass_cap(px, cap, cap_dark):
    """generic cap-block: dirt body + colored top cap (grass/snow)."""
    cap_l = mul(cap, 1.15)
    tile_dirt_terraria(px)
    for x in range(16):
        depth = 4 + (1 if (x * 7 + 3) % 5 < 2 else 0)
        for y in range(depth):
            col = cap_l if y == 0 else (cap if y < depth - 1 else cap_dark)
            put(px, x, y, col)
        if (x * 13 + 5) % 11 == 0:
            put(px, x, depth, cap_dark)

def tile_stone_bricks(px):
    """stone/brick terrain: chunky blotches + bevel (terraria rock)."""
    draw_blotches(px, STONE, mul(STONE, 0.62), mul(STONE, 1.30), 12)
    bevel_solid(px)

def tile_grass_terraria(px):
    """Terraria grass block: dirt body + THICK cap (top 5px) with scalloped
    fringe dipping into the dirt + 1px highlight line on the very top."""
    tile_grass_cap(px, GRASS_GREEN, GRASS_GREEN_D)

DIRT  = (151, 105, 74)    # 97694a
DIRT_D = mul(DIRT, 0.78)
DIRT_L = mul(DIRT, 1.16)
STONE = (111, 132, 148)   # 6f8494
STONE_D = mul(STONE, 0.72)
STONE_L = mul(STONE, 1.18)

def tile_dirt(px):
    draw_speckle(px, DIRT, DIRT_D, DIRT_L, 0.22)

def tile_gravel(px):
    """chunky gray stones in dirt matrix (terraria): gray blobs on brown."""
    draw_speckle(px, DIRT, DIRT_D, DIRT_L, 0.15)
    for _ in range(9):
        cx, cy = int(rnd() * 16), int(rnd() * 16)
        r = 2 + int(rnd() * 2)
        col = (STONE, STONE_D, STONE_L)[int(rnd() * 3)]
        for y in range(max(0, cy - r), min(16, cy + r + 1)):
            for x in range(max(0, cx - r), min(16, cx + r + 1)):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r and rnd() > 0.15:
                    put(px, x, y, mul(col, 0.9 + rnd() * 0.25))

def tile_bedrock(px):
    """unbreakable dark stone: near-black slabs, terraria underworld floor."""
    base = (42, 47, 58)     # 2a2f3a
    dark = (30, 35, 44)     # 1e232c
    light = (57, 66, 78)    # 39424e
    draw_blotches(px, base, dark, light, 18)
    # slab seams
    for y0 in (0, 5, 10, 15):
        for x in range(16):
            if rnd() > 0.2:
                put(px, x, y0, mul(dark, 0.8))
    bevel_solid(px, 1.1, 0.8, 1.0, 0.9)

def tile_wall_dirt(px):
    """background wall = 55%-darkened blotchy dirt, low contrast."""
    draw_blotches(px, mul(DIRT, 0.52), mul(DIRT, 0.44), mul(DIRT, 0.60), 10)

def tile_wall_stone(px):
    draw_blotches(px, mul(STONE, 0.50), mul(STONE, 0.42), mul(STONE, 0.58), 10)

def tile_lava(px):
    """terraria lava: orange sea with bright-yellow churn patches."""
    base = (255, 110, 30)     # ff6e1e
    dark = (214, 62, 18)      # d63e12
    hot = (255, 190, 60)      # ffbe3c
    core = (255, 244, 160)    # fff4a0
    for y in range(16):
        for x in range(16):
            put(px, x, y, base)
    # horizontal flow bands
    for y in range(16):
        r = rnd()
        if r < 0.3:
            for x in range(16):
                if rnd() > 0.4:
                    put(px, x, y, dark)
    # hot churn blobs
    for _ in range(7):
        cx, cy = int(rnd() * 16), int(rnd() * 16)
        w = 2 + int(rnd() * 3)
        for y in range(max(0, cy - 1), min(16, cy + 2)):
            for x in range(max(0, cx - w), min(16, cx + w + 1)):
                if rnd() > 0.3:
                    put(px, x, y, hot)
    for _ in range(4):
        cx, cy = int(rnd() * 16), int(rnd() * 16)
        for y in range(max(0, cy - 1), min(16, cy + 2)):
            for x in range(max(0, cx - 1), min(16, cx + 2)):
                if rnd() > 0.4:
                    put(px, x, y, core)

def tile_torch(px):
    """terraria torch: bark stick + layered flame."""
    for y in range(16):
        for x in range(16):
            put(px, x, y, (0, 0, 0), 0)
    # stick
    for y in range(6, 16):
        put(px, 7, y, (110, 75, 46))    # 6e4b2e
        put(px, 8, y, (93, 60, 34))     # 5d3c22
    # flame layers
    flame = [
        (3, (255, 154, 60)),    # ff9a3c outer
        (4, (255, 215, 110)),   # ffd76e
        (5, (255, 246, 200)),   # fff6c8 core
    ]
    for y, col in flame:
        wdt = {3: 2, 4: 2, 5: 1}[y]
        for x in range(8 - wdt, 8 + wdt):
            put(px, x, y, col)
    put(px, 7, 2, (255, 190, 80))
    put(px, 8, 2, (255, 215, 110))

def tile_chest(px, open_lid=False):
    """terraria gold chest: wood body, gold trim, lock."""
    WOOD = (110, 75, 46)     # 6e4b2e
    WOOD_D = (93, 60, 34)    # 5d3c22
    GOLD = (217, 160, 50)    # d9a032
    GOLD_L = (255, 215, 110) # ffd76e
    OUT = (58, 42, 20)       # 3a2a14
    for y in range(16):
        for x in range(16):
            put(px, x, y, (0, 0, 0), 0)
    # body 5..14 x 2..13
    for y in range(5, 15):
        for x in range(2, 14):
            put(px, x, y, WOOD if (x + y) % 7 else WOOD_D)
    # outline
    for x in range(2, 14):
        put(px, x, 5, OUT); put(px, x, 14, OUT)
    for y in range(5, 15):
        put(px, 2, y, OUT); put(px, 13, y, OUT)
    # lid area (dark interior when open)
    if open_lid:
        for y in range(6, 9):
            for x in range(3, 13):
                put(px, x, y, (42, 28, 16))
    else:
        for y in range(6, 9):
            for x in range(3, 13):
                put(px, x, y, WOOD_D if y == 6 else WOOD)
    # gold band + lock
    for x in range(2, 14):
        put(px, x, 9, GOLD)
    put(px, 7, 10, GOLD_L); put(px, 8, 10, GOLD_L)
    put(px, 7, 11, GOLD_L); put(px, 8, 11, (74, 45, 18))
    # corner studs
    for cx, cy in ((3, 6), (12, 6), (3, 13), (12, 13)):
        put(px, cx, cy, GOLD)

# ----------------------------------------------------------------------------
# 3. PLANT TOUCH-UPS — vivid terraria flower accents (small per-tile recolors)
# ----------------------------------------------------------------------------
PLANT_ACCENTS = {
    # red/pink poppy-style accents on plain plants; keep shapes
    38: {h("e5efef"): h("ff5f6b")},              # plant_flower: white->red bloom
    124: {h("e5efef"): h("ffd94f")},             # dandelion: ->yellow
    127: {h("e5efef"): h("6ea8ff")},             # forget_me_not: ->blue
    141: {h("e5efef"): h("ff8ac2")},             # orchid_ground: ->pink
    98: {h("e5efef"): h("8a6cf0")},              # agapanthus: ->violet
    101: {h("e5efef"): h("ff5f6b")},             # bird_of_paradise
    102: {h("e5efef"): h("ff6e4c")},             # bottlebrush
    104: {h("eecf8a"): h("4fae5c")},             # cactus_pricklypear pad green
}
OVERRIDES.update(PLANT_ACCENTS)

PROCEDURAL = {
    1: tile_dirt_terraria,         # dirt
    2: tile_grass_terraria,        # grass (dirt + thick cap) — override the zip MC grass!
    3: tile_stone_bricks,          # stone: blotch+bevel replaces MC noisy stone
    44: tile_stone_bricks,         # cobblestone
    45: tile_stone_bricks,         # cobble_bricks
    46: tile_stone_bricks,         # cobble_bricks_mossy
    47: tile_stone_bricks,         # diorite
    49: tile_stone_bricks,         # gabbro
    50: tile_stone_bricks,         # granite
    12: tile_torch,        # torch
    13: lambda px: tile_chest(px, False),    # chest
    14: tile_bedrock,      # bedrock
    15: lambda px: tile_chest(px, True),     # chest_open
    16: tile_lava,         # lava
    21: tile_gravel,       # gravel
    200: tile_wall_dirt,   # wall_dirt
    201: tile_wall_stone,  # wall_stone
}

# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def main():
    im = Image.open(CLASSIC if os.path.exists(CLASSIC) else ATLAS).convert("RGBA")
    assert im.size == (256, 160), "atlas must stay 256x160, got %s" % (im.size,)
    meta = json.load(open(META))
    tiles = meta["tiles"]
    by_id = {t["id"]: t for t in tiles}

    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    px_out = out.load()

    stats = {"lut_hits": 0, "lut_pixels": 0, "proc": []}

    for t in tiles:
        tid, name, ai = t["id"], t["name"], t["atlasIndex"]
        ax, ay = (ai % 16) * 16, (ai // 16) * 16
        cell = im.crop((ax, ay, ax + 16, ay + 16))
        px = cell.load()

        if tid in PROCEDURAL:
            PROCEDURAL[tid](px)
            stats["proc"].append(name)
        else:
            # global palette LUT then per-tile override, exact-hex only
            for y in range(16):
                for x in range(16):
                    p = px[x, y]
                    if p[3] == 0:
                        continue
                    key = (p[0] << 16) | (p[1] << 8) | p[2]
                    np = None
                    if tid in OVERRIDES:      # species maps WIN over global
                        np = OVERRIDES[tid].get(key)
                    if np is None:
                        np = PALETTE.get(key)
                    if np is not None:
                        stats["lut_pixels"] += 1
                        px[x, y] = ((np >> 16) & 255, (np >> 8) & 255, np & 255, p[3])
            stats["lut_hits"] += 1

        out.paste(cell, (ax, ay))

    # wallTex entries (200/201) already procedural — nothing special.
    out.save(ATLAS)

    # ---- integrity checks ----
    chk = Image.open(ATLAS).convert("RGBA")
    assert chk.size == (256, 160)
    empty = []
    for t in tiles:
        ai = t["atlasIndex"]
        ax, ay = (ai % 16) * 16, (ai // 16) * 16
        c = chk.crop((ax, ay, ax + 16, ay + 16))
        if not any(p[3] > 0 for p in c.getdata()):
            empty.append(t["name"])
    assert not empty, "empty tiles after reskin: %s" % empty

    # transparency preserved on the same cells as classic (non-wall/plants)
    for t in tiles:
        ai = t["atlasIndex"]
        ax, ay = (ai % 16) * 16, (ai // 16) * 16
        cc = im.crop((ax, ay, ax + 16, ay + 16))
        nc = chk.crop((ax, ay, ax + 16, ay + 16))
        tr_c = sum(1 for p in cc.getdata() if p[3] == 0)
        tr_n = sum(1 for p in nc.getdata() if p[3] == 0)
        if t["id"] not in PROCEDURAL:
            assert tr_c == tr_n, "alpha changed on %s: %d->%d" % (t["name"], tr_c, tr_n)

    diff_tiles = 0
    for t in tiles:
        ai = t["atlasIndex"]
        ax, ay = (ai % 16) * 16, (ai // 16) * 16
        cc = list(im.crop((ax, ay, ax + 16, ay + 16)).getdata())
        nc = list(chk.crop((ax, ay, ax + 16, ay + 16)).getdata())
        d = sum(abs(a[i] - b[i]) for a, b in zip(cc, nc) for i in range(3))
        if d / 256 > 20000:
            raise AssertionError("tile %s changed too much: %d" % (t["name"], d / 256))
        if d > 0:
            diff_tiles += 1

    print("OK: %d tiles, %d changed, LUT cells %d (pixels %d)" %
          (len(tiles), diff_tiles, stats["lut_hits"], stats["lut_pixels"]))
    print("procedural:", ", ".join(stats["proc"]))

if __name__ == "__main__":
    sys.exit(main())
