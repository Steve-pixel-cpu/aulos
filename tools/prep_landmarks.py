"""Prep the maple tree + building showcase art (枫树.png / 建筑.png,
ChatGPT, already alpha-keyed) for the dig game: trim to content bbox,
RGB-only unsharp (painterly source — same blur treatment as the tree
band), save as ASCII-named assets under assets/big/.

Run: uv run python tools/prep_landmarks.py
"""
import numpy as np
from PIL import Image, ImageFilter

JOBS = [
    ('website/assets/mc/枫树.png', 'website/assets/big/maple.png'),
    ('website/assets/mc/建筑.png', 'website/assets/big/building.png'),
]


def sharpen_rgb(img, pct=120):
    r, g, b, a = img.split()
    rgb = Image.merge('RGB', (r, g, b)).filter(
        ImageFilter.UnsharpMask(radius=2, percent=pct, threshold=2))
    return Image.merge('RGBA', (*rgb.split(), a))


for src, dst in JOBS:
    im = Image.open(src).convert('RGBA')
    a = np.asarray(im)[:, :, 3]
    ys, xs = np.where(a > 40)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    out = sharpen_rgb(im.crop(box))
    out.save(dst)
    print(f'{dst}: {out.size[0]}x{out.size[1]} (from {src} bbox {box})')
