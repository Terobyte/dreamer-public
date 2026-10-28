"""H16 fit: recover the painted room's floor plan from the panorama itself, no LLM.

For each panorama column, walk up from the bottom while the pixel still looks like floor; the first non-floor row
is where the wall meets the floor. Eye height is known (1.6 m), so the depression angle of that row gives the
horizontal distance to the wall along that azimuth: dist = 1.6 / tan(depression). All columns together give the
room outline seen from the capture point. The ceiling line, found the same way from the top, gives the height.
Output: out/h16/<room>_fit.json (outline + height) and <room>_plan.png (top view), read by view.html?fit=1.
usage: python h16_fit.py room_flat_empty
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

OUT = Path(__file__).parent / "out" / "h16"
EYE = 1.6
COLS = 360  # one outline point per degree of azimuth


def boundary(a, ref, from_bottom):
    """row index per column where the band of `ref`-coloured pixels (floor or ceiling) ends"""
    h = a.shape[0]
    if from_bottom:  # wood/carpet is saturated, walls and baseboards are not; brightness varies with the grain
        sat = (a.max(2) - a.min(2)) / np.maximum(a.max(2), 1)
        near = sat > 0.5 * float((ref.max() - ref.min()) / max(ref.max(), 1))
    else:
        near = np.linalg.norm(a - ref, axis=2) < 38
    pad = np.pad(near, 6, mode="edge")  # closing erodes from a False border, which ate the bottom row
    near = ndimage.binary_closing(pad, np.ones((9, 3)))[6:-6, 6:-6]  # parquet seams and grain are not walls
    rows = np.arange(h)
    out = []
    for c in range(a.shape[1]):
        col = near[::-1, c] if from_bottom else near[:, c]
        stop = np.argmin(col) if not col.all() else h // 2  # first row that is no longer floor/ceiling
        out.append(h - 1 - stop if from_bottom else stop)
    return ndimage.median_filter(np.array(out, float), 31, mode="wrap")


def fit(room):
    img = Image.open(OUT / f"{room}.png").convert("RGB")
    w, h = img.size
    a = np.asarray(img.resize((COLS, 180)), np.float32)
    floor = boundary(a, np.median(a[-8:].reshape(-1, 3), 0), True)
    ceil = boundary(a, np.median(a[:8].reshape(-1, 3), 0), False)
    az = (np.arange(COLS) + 0.5) / COLS * 2 * math.pi - math.pi  # matches view.html: u=0.5 -> -z
    dep = (floor + 0.5) / 180 * math.pi - math.pi / 2           # below horizon, radians
    dist = EYE / np.tan(np.clip(dep, math.radians(8), None))
    x, z = dist * np.sin(az), -dist * np.cos(az)
    elev = math.pi / 2 - (ceil + 0.5) / 180 * math.pi
    height = float(np.median(EYE + dist * np.tan(np.clip(elev, 0, None))))
    res = {"room": room, "eye": EYE, "height": round(height, 2),
           "outline": [[round(float(p), 3), round(float(q), 3)] for p, q in zip(x, z)],
           "extent": {"x": [round(float(x.min()), 2), round(float(x.max()), 2)],
                      "z": [round(float(z.min()), 2), round(float(z.max()), 2)]},
           "dist_min_max": [round(float(dist.min()), 2), round(float(dist.max()), 2)]}
    (OUT / f"{room}_fit.json").write_text(json.dumps(res))
    s, c = 80, 300  # px per metre, canvas centre
    plan = Image.new("RGB", (600, 600), "white")
    d = ImageDraw.Draw(plan)
    d.polygon([(c + p * s, c + q * s) for p, q in zip(x, z)], outline="black")
    d.ellipse((c - 4, c - 4, c + 4, c + 4), fill="red")
    d.text((8, 8), f"{room}  h={height:.2f} m  1 grid = 1 m  red = capture point, up = -z", fill="black")
    for m in range(-3, 4):
        d.line((c + m * s, 0, c + m * s, 600), fill=(220, 220, 220)); d.line((0, c + m * s, 600, c + m * s), fill=(220, 220, 220))
    plan.save(OUT / f"{room}_plan.png")
    return {k: v for k, v in res.items() if k != "outline"}


if __name__ == "__main__":
    print(json.dumps(fit(sys.argv[1])))
