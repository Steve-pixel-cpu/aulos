"""Prep the maple tree + building showcase art (枫树.png / 建筑.png,
ChatGPT, already alpha-keyed) for the dig game: trim to content bbox,
RGB-only unsharp (painterly source — same blur treatment as the tree
band), save as ASCII-named assets under assets/big/.

Also crops moon.png (USER: "月亮贴图去掉包裹的光圈" — the art ships a
soft glow rim around the disc; thresholding alpha at 200 keeps only the
solid disc body) to assets/mc/moon_hard.png, which game2 loads as moonImg.

Run: uv run python tools/prep_landmarks.py
"""
import numpy as np
from PIL import Image, ImageFilter

JOBS = [
    ('website/assets/mc/枫树.png', 'website/assets/big/maple.png', 'sharpen'),
    ('website/assets/mc/建筑.png', 'website/assets/big/building.png', 'sharpen'),
    ('website/assets/mc/深绿色阔叶古树.png', 'website/assets/big/ancient.png', 'sharpen'),
    ('website/assets/mc/tree_user.png', 'website/assets/big/tree1.png', 'sharpen'),
    ('website/assets/mc/木制公告亭.png', 'website/assets/big/notice.png', 'sharpen'),
    ('website/assets/mc/喷泉.png', 'website/assets/big/fountain.png', 'sharpen'),
    ('website/assets/mc/moon.png', 'website/assets/mc/moon_hard.png', 'harden'),
]


def sharpen_rgb(img, pct=120):
    r, g, b, a = img.split()
    rgb = Image.merge('RGB', (r, g, b)).filter(
        ImageFilter.UnsharpMask(radius=2, percent=pct, threshold=2))
    return Image.merge('RGBA', (*rgb.split(), a))


def harden(img, thr=200):
    """Keep only the solid disc: alpha < thr -> 0, >= thr -> original."""
    a = np.asarray(img).copy()
    a[:, :, 3] = np.where(a[:, :, 3] >= thr, a[:, :, 3], 0)
    out = Image.fromarray(a, 'RGBA')
    ys, xs = np.where(a[:, :, 3] > 0)
    return out.crop((int(xs.min()), int(ys.min()),
                     int(xs.max()) + 1, int(ys.max()) + 1))


for src, dst, mode in JOBS:
    im = Image.open(src).convert('RGBA')
    if mode == 'sharpen':
        a = np.asarray(im)[:, :, 3]
        ys, xs = np.where(a > 40)
        out = sharpen_rgb(im.crop((int(xs.min()), int(ys.min()),
                                   int(xs.max()) + 1, int(ys.max()) + 1)))
    else:
        out = harden(im)
    out.save(dst)
    print(f'{dst}: {out.size[0]}x{out.size[1]} (from {src})')

