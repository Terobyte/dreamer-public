"""The satellite seen in the yard frame, with a metre grid and OSM outlines: what Spark reads positions off."""
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .geo import SN

FONT = None
for f in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf"):
    try:
        FONT = ImageFont.truetype(f, 15)
        break
    except OSError:
        pass


def render(sat: Image.Image, to_px, sn: SN, box, layout, mpp=0.2, grid=10):
    """box = (s0, s1, n0, n1) metres; image rows go from n1 (top) to n0 (bottom), s left to right."""
    s0, s1, n0, n1 = box
    W, H = int((s1 - s0) / mpp), int((n1 - n0) / mpp)
    ss = s0 + (np.arange(W) + 0.5) * mpp
    nn = n1 - (np.arange(H) + 0.5) * mpp
    S, N = np.meshgrid(ss, nn)
    X = sn.F[0] + S * sn.d[0] + N * sn.n[0]
    Y = sn.F[1] + S * sn.d[1] + N * sn.n[1]
    # to_px works on scalars; linear in a small area, so fit it once from 3 points
    o = np.array(to_px(0, 0)), np.array(to_px(1, 0)), np.array(to_px(0, 1))
    U = o[0][0] + X * (o[1][0] - o[0][0]) + Y * (o[2][0] - o[0][0])
    V = o[0][1] + X * (o[1][1] - o[0][1]) + Y * (o[2][1] - o[0][1])
    src = np.asarray(sat)
    out = cv2.remap(src, U.astype(np.float32), V.astype(np.float32), cv2.INTER_LINEAR)
    img = Image.fromarray(out)
    d = ImageDraw.Draw(img, "RGBA")
    px = lambda s, n: ((s - s0) / mpp, (n1 - n) / mpp)
    for b in layout["buildings"]:
        pts = [px(*sn.sn(x, y)) for x, y in b["poly"]]
        d.polygon(pts, outline=(255, 60, 60, 255), width=2)
        c = np.mean(pts, axis=0)
        if 0 < c[0] < W and 0 < c[1] < H:
            d.text((c[0] - 30, c[1]), b["name"].replace("улица ", ""), fill=(255, 255, 0, 255), font=FONT)
    for s in range(int(np.ceil(s0 / grid)) * grid, int(s1) + 1, grid):
        d.line([px(s, n0), px(s, n1)], fill=(255, 255, 255, 110 if s % 50 else 200), width=1)
        d.text((px(s, n0)[0] + 2, H - 18), f"s{s}", fill=(255, 255, 255, 255), font=FONT)
    for n in range(int(np.ceil(n0 / grid)) * grid, int(n1) + 1, grid):
        d.line([px(s0, n), px(s1, n)], fill=(255, 255, 255, 110 if n % 50 else 200), width=1)
        d.text((2, px(s0, n)[1] - 16), f"n{n}", fill=(255, 255, 255, 255), font=FONT)
    return img
