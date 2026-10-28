"""Build the mid-ground tree band (website/assets/scenery/bg/tree_band.png)
from the treeSet slices: trees composited side-by-side on a soft ground
strip, transparent gutters at the left/right edges so the band tiles
seamlessly. Aerial perspective (slight blur + haze) is applied IN GAME by
the BK_DEFS bake (buildPhaserBackdrop), not here.

USER context: the ChatGPT trees read slightly blurry up close as surface
trees, but that softness suits mid-ground — so they became a backdrop
band in front of the far mountains instead.

Run: uv run --with numpy python tools/build_tree_band.py
"""
import random
import numpy as np
from PIL import Image

SRC = 'website/assets/mc/tree_set{}.png'
OUT = 'website/assets/scenery/bg/tree_band.png'
W, H = 1536, 440          # native 1:1 in game (no upscale)
GROUND_H = 48             # mean meadow height at the band bottom
BASE_Y = H - GROUND_H + 10   # trunks root 10px INTO the meadow
MARGIN = 70               # keep trees clear of the tiling edges


def build_madow(rng):
    """Undulating meadow strip at the band's bottom: periodic ground curve
    (integer harmonics over W -> tiles seamlessly), mottled two-tone grass,
    sparse lighter tufts poking above the curve, alpha-feathered bottom
    edge. Replaces the flat gradient strip (USER: "还是需要的，但是你得
    做好看点")."""
    from PIL import ImageDraw
    g = np.zeros((H, W, 4), np.float64)
    xs = np.arange(W, dtype=np.float64)
    curve = np.zeros(W)
    for k, amp, ph in [(2, 6, 1.1), (3, 4, 4.2), (5, 3, 2.6), (9, 2, 0.4)]:
        curve += amp * np.sin(2 * np.pi * k * xs / W + ph)
    curve = np.round((GROUND_H + curve) / 2) * 2      # 2px pixel quantize
    # mottling: periodic coarse cell values (index wraps -> seam-safe)
    cell, ncell = 16, W // 16
    vals = [rng.random() for _ in range(ncell)]
    tops = (H - curve).astype(int)
    for x in range(W):
        top = tops[x]
        v = vals[(x // cell) % ncell]
        depth = H - top
        for y in range(top, H):
            f = (y - top) / max(1.0, depth)
            m = (v - 0.5)
            r = 50 - 22 * f + 14 * m
            gg = 110 - 40 * f + 24 * m
            b = 62 - 20 * f + 12 * m
            a = 255.0 if f < 0.7 else 255.0 * max(0.0, (1 - f) / 0.3)
            g[y, x] = (r, gg, b, a)
    img = Image.fromarray(np.clip(g, 0, 255).round().astype(np.uint8), 'RGBA')
    # grass tufts above the curve: 2-3 blades each, kept off the seam
    dr = ImageDraw.Draw(img)
    tx = 60
    while tx < W - 60:
        top = tops[tx]
        for bidx in range(3):
            bx = tx + bidx * 5 - 5 + rng.randint(-2, 2)
            bh = 5 + rng.randint(0, 6)
            bw = 2
            col = (66 + rng.randint(-6, 10), 128 + rng.randint(-8, 14),
                   76 + rng.randint(-6, 8), 235)
            dr.polygon([(bx, top + 2), (bx + bw, top + 2),
                        (bx + bw // 2 + rng.randint(-1, 1), top - bh)], col)
        tx += 46 + rng.randint(0, 70)
    return img, tops


def main():
    rng = random.Random(7)
    band = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    meadow, ground_tops = build_madow(random.Random(11))
    band.alpha_composite(meadow)

    trees = [Image.open(SRC.format(i)).convert('RGBA') for i in range(16)]

    from PIL import ImageFilter

    def sharpen(img, pct):
        """Unsharp-mask the RGB only (sharpening alpha would fringe the
        transparent boundary)."""
        r, g2, b2, a2 = img.split()
        rgb = Image.merge('RGB', (r, g2, b2)).filter(
            ImageFilter.UnsharpMask(radius=2, percent=pct, threshold=2))
        return Image.merge('RGBA', (*rgb.split(), a2))

    def place(x, idx, scale, flip=False, sink=6):
        t = trees[idx]
        tw, th = int(t.width * scale), int(t.height * scale)
        if (tw, th) != t.size:
            t = t.resize((tw, th), Image.LANCZOS)
        t = sharpen(t, 170 if scale < 1.0 else 120)
        if flip:
            t = t.transpose(Image.FLIP_LEFT_RIGHT)
        # LOCAL anchoring: root each trunk a few px into the meadow at
        # ITS OWN x (the undulating curve made the old fixed BASE_Y bury
        # trunks 20px+ in the high bumps — USER: "树底部可能还得上来点")
        base = int(ground_tops[int(max(0, min(W - 1, x)))]) + sink
        band.alpha_composite(t, (int(x - tw / 2), base - th))

    # back row: smaller, slightly deeper — depth inside the line itself.
    # FRONT ROW AT NATIVE 1:1 — any downscale of the painterly treeSet
    # reads blurry (USER: "目前还是太糊"), so fewer, full-size trees.
    back = [(150, 5, 0.75, True), (540, 13, 0.7, False),
            (940, 1, 0.72, True), (1320, 9, 0.68, False)]
    for x, i, s, f in back:
        place(x, i, s, f, sink=12)
    front = [(120, 0, 1.0, False), (420, 6, 1.0, True),
             (745, 2, 1.0, False), (1040, 14, 1.0, False),
             (1395, 10, 1.0, True)]
    for x, i, s, f in front:
        place(x, i, s, f, sink=5)

    # aerial perspective BAKED HERE, saturation-preserving (the in-game
    # flat gray haze washed the band out — USER: "太灰了吧"): +30% chroma,
    # then a gentle 12% lift toward a cool distance tone. BK_DEFS runs
    # this band with blur 0 / haze 0.
    arr = np.asarray(band).astype(np.float64)
    lit = arr[:, :, 3:4] > 0
    mean = arr[:, :, :3].mean(axis=2, keepdims=True)
    arr[:, :, :3] = np.where(lit, mean + (arr[:, :, :3] - mean) * 1.3,
                             arr[:, :, :3])
    haze = np.array([150.0, 180.0, 190.0])
    arr[:, :, :3] = np.where(lit,
                             arr[:, :, :3] * 0.88 + haze * 0.12,
                             arr[:, :, :3])
    band = Image.fromarray(np.clip(arr, 0, 255).round().astype(np.uint8),
                           'RGBA')

    band.save(OUT)

    # tiling audit: trees stay clear of the edges; the meadow is periodic
    # so its seam must continue (alpha profile of col 0 vs col W-1 close)
    a = np.asarray(band)[:, :, 3]
    tree_zone = a[:H - GROUND_H - 12]
    lg = int((tree_zone[:, :30] > 0).sum())
    rg = int((tree_zone[:, -30:] > 0).sum())
    seam = float(np.abs(a[:, 0].astype(int) - a[:, -1].astype(int)).mean())
    print('tree pixels in left/right 30px gutters:', lg, rg, '(must be 0)')
    print('meadow seam mean |dAlpha|:', round(seam, 2), '(periodic curve, '
          'small is fine)')
    print('wrote', OUT, band.size)


if __name__ == '__main__':
    main()
