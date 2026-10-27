"""Build candidate tiles.png from a.png (user's new art) + 12.png fallback.

a.png = 1586x992 raw export, 9 row-bands, ~135 tiles. This script slices it,
fits each tile into a 16x16 cell, applies the mapping below, and keeps
12.png art for every atlasIndex not mapped (incl. walls 154/155).
"""
import json
import numpy as np
from PIL import Image, ImageDraw

MC = 'website/assets/mc'

BANDS = [(24, 124), (137, 234), (248, 344), (359, 455), (469, 562),
         (580, 668), (687, 773), (789, 878), (892, 966)]
SPANS = {
    0: [(12, 108), (122, 219), (232, 330), (343, 443), (456, 558), (571, 671), (685, 784), (799, 902), (916, 1017), (1030, 1131), (1144, 1242), (1254, 1353), (1366, 1465), (1479, 1575)],
    1: [(12, 108), (122, 219), (232, 330), (343, 443), (456, 558), (571, 671), (685, 784), (799, 901), (916, 1017), (1030, 1131), (1144, 1242), (1254, 1353), (1366, 1465), (1479, 1575)],
    2: [(12, 108), (122, 220), (232, 330), (343, 443), (456, 558), (571, 671), (684, 784), (799, 901), (916, 1017), (1030, 1131), (1144, 1242), (1254, 1353), (1365, 1465), (1479, 1575)],
    3: [(12, 108), (122, 219), (232, 330), (343, 443), (456, 558), (571, 671), (685, 784), (799, 902), (916, 1017), (1030, 1131), (1144, 1242), (1254, 1353), (1366, 1465), (1479, 1575)],
    4: [(12, 107), (124, 216), (234, 329), (345, 438), (456, 557), (572, 639), (651, 719), (733, 787), (799, 883), (897, 966), (979, 1062), (1075, 1151), (1166, 1247), (1263, 1353), (1366, 1465), (1479, 1575)],
    5: [(0, 97), (119, 193), (209, 285), (298, 398), (409, 484), (501, 580), (598, 666), (680, 746), (764, 826), (846, 923), (941, 1029), (1045, 1139), (1162, 1223), (1243, 1306), (1326, 1401), (1417, 1478), (1501, 1585)],
    6: [(0, 86), (110, 178), (206, 265), (291, 357), (387, 443), (468, 535), (560, 626), (651, 718), (740, 800), (824, 883), (903, 953), (975, 1060), (1075, 1150), (1164, 1242), (1261, 1343), (1362, 1460), (1487, 1585)],
    7: [(0, 83), (109, 162), (189, 250), (280, 358), (386, 442), (464, 534), (565, 621), (645, 731), (750, 823), (847, 922), (944, 1027), (1048, 1123), (1147, 1227), (1254, 1329), (1349, 1431), (1451, 1585)],
    8: [(0, 96), (120, 188), (220, 285), (315, 346), (366, 425), (460, 510), (545, 600), (643, 693), (726, 792), (817, 902), (933, 999), (1038, 1101), (1146, 1585)],
}

# a.png tile index -> atlasIndex in tiles.png
MAPPING = {
    1: 1,    # dirt
    3: 2,    # grass
    10: 3,   # stone
    9: 4,    # sand
    23: 5,   # wood
    75: 6,   # leaf
    24: 7,   # plank
    42: 8,   # coal
    44: 9,   # iron
    46: 10,  # gold
    47: 11,  # diamond
    65: 12,  # torch
    69: 13,  # chest
    55: 16,  # lava
    53: 20,  # obsidian
    0: 21,   # gravel
    21: 23,  # sandstone
    56: 26,  # glass
    15: 27,  # cobble_mossy
    100: 37, # plant_fern
    79: 39,  # plant_mushroom
    78: 40,  # plant_brown_mushroom
    50: 42,  # crystal_amethyst
    7: 44,   # cobblestone
    18: 45,  # cobble_bricks
    19: 46,  # cobble_bricks_mossy
    5: 52,   # grass_top
    13: 55,  # ice_glacier
    22: 84,  # oak_log_top
    25: 89,  # beech_planks
    126: 93, # grass_short
    96: 94,  # grass_med
    85: 98,  # flower_agapanthus
    97: 105, # cattail
    89: 134, # flower_lupine
    107: 149,# sapling_pine
    124: 126,# plant_fiddleneck
    93: 127, # flower_forget_me_not
    87: 139, # plant_mustard
    88: 136, # flower_mayflower
    84: 100, # flower_aster
}


def slice_tiles():
    img = Image.open(f'{MC}/a.png').convert('RGBA')
    tiles = []
    for bi, (y0, y1) in enumerate(BANDS):
        for (x0, x1) in SPANS[bi]:
            tiles.append(img.crop((x0, y0, x1 + 1, y1 + 1)))
    return tiles


def fit16(tile, min_alpha=100):
    """bbox-crop on solid alpha, aspect-preserving fit into 16x16, centered."""
    a = np.array(tile)
    solid = a[:, :, 3] >= min_alpha
    if not solid.any():
        return None
    ys, xs = np.nonzero(solid)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    crop = tile.crop((x0, y0, x1 + 1, y1 + 1))
    w, h = crop.size
    s = 16.0 / max(w, h)
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    small = crop.resize((nw, nh), Image.BOX)
    sa = np.array(small).astype(np.int32)
    sa[:, :, 3] = np.where(sa[:, :, 3] >= 100, 255, 0)
    out = np.zeros((16, 16, 4), dtype=np.uint8)
    ox, oy = (16 - nw) // 2, (16 - nh) // 2
    out[oy:oy + nh, ox:ox + nw] = sa.astype(np.uint8)
    return out


def main():
    meta = json.load(open(f'{MC}/tiles.json'))
    names = {t['atlasIndex']: t['name'] for t in meta['tiles']}
    tiles = slice_tiles()
    print('sliced', len(tiles), 'tiles from a.png')

    old = np.array(Image.open(f'{MC}/12.png').convert('RGBA'))
    new = old.copy()
    used = set()
    for aidx, atlas_idx in sorted(MAPPING.items()):
        cell = fit16(tiles[aidx])
        if cell is None:
            print(f'  !! a{aidx} empty, skip')
            continue
        r, c = divmod(atlas_idx, 16)
        new[r * 16:(r + 1) * 16, c * 16:(c + 1) * 16] = cell
        used.add(atlas_idx)
        print(f'  a{aidx:3d} -> {atlas_idx:3d} {names.get(atlas_idx)}')

    Image.fromarray(new).save(f'{MC}/tiles_candidate.png')

    # preview: changed cells old|new side by side, zoomed x6, labeled
    Z = 6
    changed = sorted(used)
    cols = 7
    rows = (len(changed) + cols - 1) // cols
    cw, ch = 16 * Z * 2 + 30, 16 * Z + 24
    sheet = Image.new('RGBA', (cols * cw, rows * ch), (25, 25, 28, 255))
    d = ImageDraw.Draw(sheet)
    for k, i in enumerate(changed):
        r, c = divmod(k, cols)
        rr, cc = divmod(i, 16)
        for j, src in enumerate([old, new]):
            cell = src[rr * 16:rr * 16 + 16, cc * 16:cc * 16 + 16]
            tile = Image.fromarray(cell).resize((16 * Z, 16 * Z), Image.NEAREST)
            x0 = c * cw + 4 + j * (16 * Z + 8)
            y0 = r * ch + 4
            sheet.paste(tile, (x0, y0), tile)
        d.text((c * cw + 4, r * ch + 16 * Z + 6),
               f'{i}:{names.get(i, "?")} a{[a for a,ix in MAPPING.items() if ix==i][0]}',
               fill=(255, 220, 0, 255))
    sheet.save(f'{MC}/_preview.png')
    print('candidate + preview written;', len(changed), 'cells changed')


if __name__ == '__main__':
    main()
