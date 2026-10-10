# -*- coding: utf-8 -*-
"""Aulos 图标渲染: 主方案「双管 + 声波」SVG 构图 → Pillow 光栅重现。
输出: static/icon.png (512 母版) + src-tauri/icons 全套 + electron 用的 256。
圆角半径 116/512 与现 icon.png 一致(Win11 风格圆角窗口配套)。"""
from PIL import Image, ImageDraw
import os, math

S = 512
R = 116  # 圆角

# ---- 调色(与 SVG 设计稿一致) ----
BG_TOP = (29, 30, 38); BG_BOT = (17, 18, 24)
GLOW = (246, 201, 100)
PIPE_L = [(248, 217, 138), (234, 181, 79), (201, 138, 46)]   # 左管横渐变
PIPE_R = [(238, 192, 101), (181, 118, 31)]                    # 右管
MOUTH = (138, 84, 22)      # 哨口
HOLE = (122, 74, 18); HOLE_R = (110, 66, 15)
WAVE = (246, 201, 100)
LINE = (246, 201, 100)

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def rounded_bg(size, glow=True):
    """圆角深色底 + 中下部金色微光晕"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 垂直渐变底
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        gd.line([(0, y), (size, y)], fill=lerp(BG_TOP, BG_BOT, y / size) + (255,))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(R * size / S), fill=255)
    img.paste(grad, (0, 0), mask)
    if glow:
        # 径向光晕: 以 (0.5, 0.62) 为心
        glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        gdr = ImageDraw.Draw(glow)
        cx, cy, rr = size * .5, size * .62, size * .55
        steps = 48
        for i in range(steps, 0, -1):
            t = i / steps
            alpha = int(56 * (1 - t) ** 1.6)
            gdr.ellipse([cx - rr * t, cy - rr * t, cx + rr * t, cy + rr * t], fill=GLOW + (alpha,))
        img.alpha_composite(glow)
    return img

def vgrad_rect(img, x0, y0, x1, y1, radius, colors, horizontal=True):
    """在 img 上画一个 (横/纵)向多段渐变圆角矩形"""
    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
    w, h = x1 - x0, y1 - y0
    tile = Image.new("RGBA", (max(w, 1), max(h, 1)))
    td = ImageDraw.Draw(tile)
    n = len(colors) - 1
    for i in range(n):
        c0, c1 = colors[i], colors[i + 1]
        seg = (w if horizontal else h) / n
        for p in range(int(seg)):
            t = p / max(seg - 1, 1)
            c = lerp(c0, c1, t) + (255,)
            if horizontal: td.line([(int(i * seg + p), 0), (int(i * seg + p), h)], fill=c)
            else: td.line([(0, int(i * seg + p)), (w, int(i * seg + p))], fill=c)
    if not horizontal: tile = tile.transpose(Image.TRANSPOSE)
    mask = Image.new("L", tile.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    img.paste(tile, (int(x0), int(y0)), mask)

def arc(img, cx, cy, r, a0, a1, color, width, alpha):
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    bbox = [cx - r, cy - r, cx + r, cy + r]
    d.arc(bbox, start=a0, end=a1, fill=color + (alpha,), width=width)
    # 端点圆头
    for ang in (a0, a1):
        ex = cx + r * math.cos(math.radians(ang)); ey = cy + r * math.sin(math.radians(ang))
        rr = width / 2
        d.ellipse([ex - rr, ey - rr, ex + rr, ey + rr], fill=color + (alpha,))
    img.alpha_composite(overlay)

def render(size):
    k = size / S
    img = rounded_bg(size)
    d = ImageDraw.Draw(img)

    # ---- 声波弧(左右各两道, 圆心在管间中部 y=256) ----
    waves = [  # (起点半径, 宽度, 透明度)  弧心 x=256
        (138, 13, 140), (180, 13, 62),
    ]
    for r0, w, a in waves:
        r = r0 * k; wd = max(int(w * k), 2)
        # 左弧: 从 118,206 到 118,306 → 圆心 (256,256) 半径 138, 角度 128°~232°
        arc(img, 256 * k, 256 * k, r, 128, 232, WAVE, wd, a)
        arc(img, 256 * k, 256 * k, r, -52, 52, WAVE, wd, a)

    # ---- A monogram: 双管交叉构成字母 A ----
    # 两根圆头粗管从顶点 (256,110) 张开到底部 (166,404)/(346,404),
    # 中段一条深色横杠封口; 管身沿走向做三段渐变(亮→中→深)。
    APEX = (256, 110)
    FOOT_L = (166, 404)
    FOOT_R = (346, 404)
    W_PIPE = 52          # 管宽
    segs = [(0.0, 0.45, PIPE_L[0], PIPE_L[1]),   # 上段: 亮金→中金
            (0.45, 1.0, PIPE_L[1], PIPE_L[2])]   # 下段: 中金→深金

    def draw_pipe(foot, colors_l2r):
        """沿 apex→foot 画一根渐变圆头管。colors_l2r: (管左侧色, 管右侧色)"""
        ax, ay = APEX; fx, fy = foot
        dx, dy = fx - ax, fy - ay
        L = math.hypot(dx, dy)
        ux, uy = dx / L, dy / L           # 走向单位向量
        nx, ny = -uy, ux                  # 法向(管宽方向)
        steps = 64
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        for i in range(steps):
            t0 = i / steps; t1 = (i + 1) / steps
            # 沿程渐变: 顶部亮、底部深
            c = lerp(colors_l2r[0], colors_l2r[1], t0) + (255,)
            # 每小段是一个粗圆点, 连续铺成管
            for tt in (t0, t1):
                px = ax + dx * tt; py = ay + dy * tt
                hw = (W_PIPE / 2) * k
                od.ellipse([px * k - hw, py * k - hw, px * k + hw, py * k + hw], fill=c)
        img.alpha_composite(overlay)

    draw_pipe(FOOT_L, (PIPE_L[0], PIPE_L[1]))   # 左撇: 亮→中
    draw_pipe(FOOT_R, (PIPE_L[1], PIPE_L[2]))   # 右捺: 中→深

    # 横杠: y=318 处, 宽度覆盖两管内缘, 深褐圆角条
    bar_y = 318 * k
    bar_hw = 34 * k                     # 半高
    d.rounded_rectangle([190 * k, bar_y - bar_hw, 322 * k, bar_y + bar_hw],
                        radius=bar_hw, fill=MOUTH + (255,))
    return img

def main():
    out_master = r"D:\pyworkplace\learn_claude\aulos\static\icon.png"
    out_icons = r"D:\pyworkplace\learn_claude\aulos\src-tauri\icons"
    master = render(512)
    master.save(out_master)
    print("saved", out_master)
    # src-tauri 全套
    os.makedirs(out_icons, exist_ok=True)
    for name, sz in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256),
                     ("icon.png", 512), ("icon@2x.png", 256)]:
        master.resize((sz, sz), Image.LANCZOS).save(os.path.join(out_icons, name))
        print("saved", name, sz)
    # Windows .ico (多尺寸)
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save(os.path.join(out_icons, "icon.ico"), format="ICO",
                sizes=[(s, s) for s in ico_sizes])
    print("saved icon.ico")
    # electron 窗口图标
    master.resize((256, 256), Image.LANCZOS).save(
        r"D:\pyworkplace\learn_claude\aulos\static\icon-256.png")
    print("saved static/icon-256.png")

if __name__ == "__main__":
    main()
