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
BASE_Y = H - 60           # trunk roots sit ~60px above the band bottom =
                          # mean surface - 28px: just touching the mean
                          # grass-top line, slightly tucked. Band art tiles
                          # every 1536px so the anchor must be UNIFORM —
                          # rooting at the very bottom (mean+32) buried the
                          # trunks a full tile+ wherever terrain runs high
                          # (USER: "这些树带埋得太深"). NO meadow strip
                          # (USER: "我不想要草甸").
MARGIN = 70               # keep trees clear of the tiling edges


def main():
    rng = random.Random(7)
    band = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    trees = [Image.open(SRC.format(i)).convert('RGBA') for i in range(16)]

    from PIL import ImageFilter

    def sharpen(img, pct):
        """Unsharp-mask the RGB only (sharpening alpha would fringe the
        transparent boundary)."""
        r, g2, b2, a2 = img.split()
        rgb = Image.merge('RGB', (r, g2, b2)).filter(
            ImageFilter.UnsharpMask(radius=2, percent=pct, threshold=2))
        return Image.merge('RGBA', (*rgb.split(), a2))

    def place(x, idx, scale, flip=False, sink=4):
        t = trees[idx]
        tw, th = int(t.width * scale), int(t.height * scale)
        if (tw, th) != t.size:
            t = t.resize((tw, th), Image.LANCZOS)
        t = sharpen(t, 170 if scale < 1.0 else 120)
        if flip:
            t = t.transpose(Image.FLIP_LEFT_RIGHT)
        band.alpha_composite(t, (int(x - tw / 2), BASE_Y - th + sink))

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

    # tiling audit: all content (trees only now) stays clear of the edges
    a = np.asarray(band)[:, :, 3]
    lg = int((a[:, :30] > 0).sum())
    rg = int((a[:, -30:] > 0).sum())
    print('tree pixels in left/right 30px gutters:', lg, rg, '(must be 0)')
    print('wrote', OUT, band.size)


if __name__ == '__main__':
    main()
