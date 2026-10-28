"""Key the baked sky out of yuanjing_far.png so the DOM day/night gradient,
sun/moon and stars show through down to the mountain silhouette line —
while the baked CLOUDS stay solid and the land gets a CRISP cut.

The art ships a light-blue sky gradient + soft cloud blobs baked into the
PNG. Only the top ~300px had been keyed transparent; from there to the
peaks the opaque baked sky met the live gradient in a horizontal seam that
read as a hard dividing line at dusk/night. Cloud/ghost history (kept so
the next tweak doesn't re-litigate it):
  * clouds at distance-keyed (semi-transparent) alpha -> ghost 残影;
  * everything above the ridge cut + drifting sprite clouds -> rejected
    (USER: "云效果很差，还是用原来的静态云吧");
  * solid clouds restored but a WIDE distance feather kept far-peak haze
    + horizon haze semi-transparent -> "云和山峰之间…山峰和云的残影,
    夜晚更加明显" (USER);
  * FINAL: per-column hard land cut — the silhouette top is the first row
    where darker-than-sky land holds for 3 rows; above it alpha is 0
    OUTRIGHT (only solid clouds survive there), below it land is opaque
    with a 1px AA rim. No semi-transparent zones exist between clouds
    and peaks at any hour.

Run: uv run --with numpy python tools/key_yuanjing_sky.py
(overwrites website/assets/scenery/bg/yuanjing_far.png in place; the
original stays recoverable from git history)
"""
import numpy as np
from PIL import Image

PNG = 'website/assets/scenery/bg/yuanjing_far.png'
TRACK_BAND = 40.0          # pixels within this of the anchor count as sky
TRACK_STEP = 3.0           # max reference drift per row
FIT_LO, FIT_HI = 150, 430  # rows whose medians fit the anchor line
RIDGE_ROW = 437            # first landscape row (per-column minimum)


def median3(a):
    """3x3 median filter (edge-replicated) on a 2D float array."""
    p = np.pad(a, 1, mode='edge')
    stack = np.stack([p[i:i + a.shape[0], j:j + a.shape[1]]
                      for i in range(3) for j in range(3)])
    return np.median(stack, axis=0)


def main():
    im = Image.open(PNG).convert('RGBA')
    arr = np.asarray(im).astype(np.float64)
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3]

    # anchor line per channel, from sky-dominated rows
    med = np.array([np.median(rgb[y], axis=0) for y in range(h)])
    ys = np.arange(FIT_LO, FIT_HI + 1)
    anchor = np.stack([
        np.polyval(np.polyfit(ys, med[FIT_LO:FIT_HI + 1, c], 1), np.arange(h))
        for c in range(3)], axis=1)                       # (h,3)

    # per-row reference: candidates near the anchor, clamped drift
    refs = np.zeros((h, 3))
    refs[0] = med[0]
    for y in range(1, h):
        d = np.sqrt(((rgb[y] - anchor[y]) ** 2).sum(axis=1))
        cand = rgb[y][d < TRACK_BAND]
        if len(cand):
            refs[y] = np.clip(np.median(cand, axis=0),
                              refs[y - 1] - TRACK_STEP,
                              refs[y - 1] + TRACK_STEP)
        else:
            refs[y] = refs[y - 1]

    dist = np.sqrt(((rgb - refs[:, None, :]) ** 2).sum(axis=2))
    adv = (rgb - refs[:, None, :]).mean(axis=2)   # + = brighter than sky

    # CLOUDS: bright blobs live in rows < CLOUD_ROW_MAX (verified: the
    # horizon-haze band starts ~340 and is NOT cloud). Solid restore with
    # a 1-2px rim — semi-transparent cloud bodies/fringes read 残影.
    CLOUD_ROW_MAX = 320
    cloud_alpha = np.where(
        np.arange(h)[:, None] < CLOUD_ROW_MAX,
        np.clip((adv - 3.0) / 6.0, 0.0, 1.0), 0.0)
    is_cloud = cloud_alpha > 0.5

    # LAND: darker-than-sky pixels (mountains are ALWAYS darker than the
    # sky reference; only clouds are brighter). Per column, the silhouette
    # top = first row where land holds for LAND_RUN rows; everything above
    # is cut to alpha 0 outright — the wide distance feather used before
    # kept far-peak haze + horizon haze semi-transparent, which glowed
    # over the night gradient as 峰/云残影 between clouds and peaks.
    LAND_D, LAND_RUN = 55.0, 3
    is_land = (dist > LAND_D) & ~is_cloud
    land_top = np.full(w, RIDGE_ROW, dtype=int)
    run = np.zeros(w, dtype=int)
    for y in range(h):
        run = np.where(is_land[y], run + 1, 0)
        fresh = (run == LAND_RUN)
        land_top[fresh] = y - LAND_RUN + 1

    # alpha: steep AA smoothstep, hard 0 above the column's land top,
    # solid clouds layered back on top
    alpha = np.clip((dist - 45.0) / 30.0, 0.0, 1.0)
    cut = np.arange(h)[:, None] < (land_top - 1)[None, :]
    alpha[cut] = 0.0
    alpha = np.maximum(alpha, cloud_alpha)

    alpha = median3(alpha)                       # speckle cleanup
    arr[:, :, 3] = alpha * 255.0

    out = Image.fromarray(arr.round().astype(np.uint8), 'RGBA')
    out.save(PNG)

    # report: opaque fraction per landmark row + residual semi audit
    a8 = arr[:, :, 3]
    for y in (0, 160, 240, 340, 400, 440, 470, 500, 550, 600, 700, 850):
        print(f'row {y:4d}  opaque(>200) {100 * (a8[y] > 200).mean():5.1f}%  '
              f'semi(50..200) {100 * ((a8[y] >= 50) & (a8[y] <= 200)).mean():5.1f}%')
    sky_zone = a8[:437]
    print(f'above-ridge semi(30..200) pixels: '
          f'{100 * ((sky_zone >= 30) & (sky_zone < 200)).mean():.2f}% '
          f'(should be ~0: cloud rims only)')
    print(f'land_top range: {land_top.min()}..{land_top.max()}')
    print(f'wrote {PNG}')


if __name__ == '__main__':
    main()
