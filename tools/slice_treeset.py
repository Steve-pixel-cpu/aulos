"""Slice treeSet.png (ChatGPT-generated, 1536x1024, flat blue background)
into individual keyed tree sprites for the dig game's tree layer.

Background is a baked flat blue (~(74,130,164)) — keyed by color distance
with a soft feather (trees are teal-green and sit ~85 from the bg color,
so the transparent threshold stays well below that). Connected components
on the keyed mask give the individual trees; each is cropped to its bbox
and saved as website/assets/mc/tree_set<N>.png with alpha.

Run: uv run --with numpy python tools/slice_treeset.py
"""
import numpy as np
from PIL import Image

SRC = 'website/assets/mc/treeSet.png'
OUT = 'website/assets/mc/tree_set{}.png'
OUT_BUSH = 'website/assets/mc/bush_set{}.png'
BG = np.array([74.0, 130.0, 164.0])
T_KEY = 34.0        # below this distance -> fully transparent
T_KEEP = 84.0       # above -> fully opaque (tree bodies sit ~85+)
MIN_TREE_H = 150    # px; taller components are trees
MIN_BUSH_H = 40     # px; 40..150 = the undergrowth/bush rows


def main():
    im = Image.open(SRC).convert('RGB')
    arr = np.asarray(im).astype(np.float64)
    h, w = arr.shape[:2]

    dist = np.sqrt(((arr - BG) ** 2).sum(axis=2))
    alpha = np.clip((dist - T_KEY) / (T_KEEP - T_KEY), 0.0, 1.0)
    solid = alpha > 0.5

    # connected components (4-neighbour, iterative flood on a bool grid)
    lab = np.zeros((h, w), np.int32)
    cur = 0
    from collections import deque
    for y0 in range(h):
        row = solid[y0]
        for x0 in range(w):
            if row[x0] and lab[y0, x0] == 0:
                cur += 1
                q = deque([(y0, x0)])
                lab[y0, x0] = cur
                while q:
                    cy, cx = q.popleft()
                    if cx > 0 and solid[cy, cx - 1] and lab[cy, cx - 1] == 0:
                        lab[cy, cx - 1] = cur; q.append((cy, cx - 1))
                    if cx + 1 < w and solid[cy, cx + 1] and lab[cy, cx + 1] == 0:
                        lab[cy, cx + 1] = cur; q.append((cy, cx + 1))
                    if cy > 0 and solid[cy - 1, cx] and lab[cy - 1, cx] == 0:
                        lab[cy - 1, cx] = cur; q.append((cy - 1, cx))
                    if cy + 1 < h and solid[cy + 1, cx] and lab[cy + 1, cx] == 0:
                        lab[cy + 1, cx] = cur; q.append((cy + 1, cx))

    # collect components big enough to be a tree
    comps = []
    for k in range(1, cur + 1):
        ys, xs = np.where(lab == k)
        if len(ys) < 2000:            # noise specks
            continue
        y1, y2, x1, x2 = ys.min(), ys.max(), xs.min(), xs.max()
        comps.append((x1, y1, x2, y2, len(ys)))
    # reading order: rows top->bottom, then x
    comps.sort(key=lambda c: (c[1] // 400, c[0]))

    kept = 0
    manifest = []
    bushes = []
    for (x1, y1, x2, y2, npix) in comps:
        ch = y2 - y1 + 1
        sub_a = alpha[y1:y2 + 1, x1:x2 + 1] * 255.0
        out = np.dstack([arr[y1:y2 + 1, x1:x2 + 1], sub_a]).round().astype(np.uint8)
        if ch >= MIN_TREE_H:
            Image.fromarray(out, 'RGBA').save(OUT.format(kept))
            manifest.append({'i': kept, 'w': int(x2 - x1 + 1), 'h': int(ch)})
            print(f'tree_set{kept}: {x2 - x1 + 1}x{ch}  (bbox x{x1}-{x2} y{y1}-{y2})')
            kept += 1
        elif ch >= MIN_BUSH_H:
            # undergrowth rows of the sheet — foreground bushes
            # (USER: "灌木丛直接作为前景插入游戏"). Sharpened here: the
            # raw painterly blobs read 模糊的色块 at close range (USER).
            from PIL import ImageFilter
            img = Image.fromarray(out, 'RGBA')
            r, g2, b2, a2 = img.split()
            rgb = Image.merge('RGB', (r, g2, b2)).filter(
                ImageFilter.UnsharpMask(radius=2, percent=160, threshold=2))
            Image.merge('RGBA', (*rgb.split(), a2)).save(
                OUT_BUSH.format(len(bushes)))
            bushes.append({'i': len(bushes), 'w': int(x2 - x1 + 1), 'h': int(ch)})
            print(f'bush_set{len(bushes) - 1}: {x2 - x1 + 1}x{ch}')
    print(f'wrote {kept} trees, {len(bushes)} bushes')
    import json
    with open('website/assets/mc/_tree_set.json', 'w') as f:
        json.dump(manifest, f)
    with open('website/assets/mc/_bush_set.json', 'w') as f:
        json.dump(bushes, f)


if __name__ == '__main__':
    main()
