"""Renders the PNG icons from the same geometry as src/web/public/favicon.svg.

Browsers that can't use the SVG favicon (and iOS home screens) need PNGs. Run after
changing the logo:  python -I scripts/render_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'src' / 'web' / 'public'
SS = 8  # supersampling, for smooth edges

# Mirrors favicon.svg (64x64 units).
START = (9, 27)
CURVES = [
    ((16, 14), (23, 16), (28, 28)),
    ((32, 38), (35, 44.5), (40, 44)),
    ((46, 43.5), (50, 27), (53.5, 16)),
]
STOPS = [(0.0, (0x1E, 0x40, 0xAF)), (0.55, (0x2A, 0x78, 0xD6)), (1.0, (0x10, 0xB9, 0x81))]


def gradient_color(t):
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
    return STOPS[-1][1]


def bezier(p0, p1, p2, p3, n=400):
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        yield (u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
               u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1])


def render(size, rounded=True):
    s = size * SS
    k = s / 64
    # Diagonal gradient tile.
    tile = Image.new('RGB', (s, s))
    px = tile.load()
    for y in range(s):
        for x in range(s):
            px[x, y] = gradient_color((x + y) / (2 * (s - 1)))
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=round(15 * k) if rounded else 0, fill=255)
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    img.paste(tile, (0, 0), mask)

    d = ImageDraw.Draw(img, 'RGBA')
    # Floor: a dashed line (round-capped dashes, 4 on, 4 off).
    r = 1.5 * k
    x = 9.0
    while x <= 55:
        x1 = min(x + 4, 55)
        d.rounded_rectangle([x * k - r, 49 * k - r, x1 * k + r, 49 * k + r], radius=r, fill=(255, 255, 255, 140))
        x += 8
    # Balance line: a round brush stamped densely along the curve (smooth joins and caps).
    pts = [START]
    p = START
    for c in CURVES:
        pts += list(bezier(p, *c))[1:]
        p = c[2]
    h = 3 * k
    for a, b in pts:
        d.ellipse([a * k - h, b * k - h, a * k + h, b * k + h], fill='white')
    # End dot.
    cx, cy = 53.5 * k, 16 * k
    d.ellipse([cx - 5.5 * k, cy - 5.5 * k, cx + 5.5 * k, cy + 5.5 * k], fill='white')
    d.ellipse([cx - 2.4 * k, cy - 2.4 * k, cx + 2.4 * k, cy + 2.4 * k], fill=(0x10, 0xB9, 0x81))
    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    render(32).save(OUT / 'favicon-32.png')
    # iOS rounds the corners itself.
    render(180, rounded=False).convert('RGB').save(OUT / 'apple-touch-icon.png')
    render(256).save(OUT / 'logo-256.png')
    print('wrote', OUT)
