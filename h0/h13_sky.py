"""H13: sky and floor straight from Muse Image.

Sky: a 2:1 equirectangular panorama (size=2048x1024 comes back 2240x1120). Floor: a seamless tileable texture.
The seam is scored numerically: the jump between the right and left edge (where the image wraps around)
divided by the typical jump between neighbouring columns inside the image. ~1 = invisible, >3 = a visible line.
Previews: the panorama rolled by half (the wrap seam lands in the middle) and the floor tiled 3x3.
usage: python h13_sky.py
"""
import base64
import io
import json
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

API = "https://api.meta.ai/v1/images/generations"
KEY = os.environ["META_MODEL_API_KEY"]
OUT = Path(__file__).parent / "out" / "h13"

SKY = ("Equirectangular 360 degree panorama, 2:1, seamless where the left and right edges meet, "
       "horizon exactly at the vertical middle, no people, no text. ")
FLOOR = ("Seamless tileable texture, top-down orthographic view, flat even lighting, no shadows, "
         "no perspective, no objects, the pattern repeats with no visible edges. ")
JOBS = {
    "sky_bikini": SKY + "Bright cartoon underwater world seen from the sea floor: turquoise water fading to light "
                        "above, sun rays from the surface, distant coral hills and flower-shaped clouds of bubbles.",
    "sky_dusk": SKY + "Dreamlike dusk sky over an endless calm plain: soft pink and violet clouds, a few early stars, "
                      "faint distant mountains on the horizon.",
    "sky_city": SKY + "Surreal dream city at night seen from a rooftop: glowing windows, floating paper lanterns, "
                      "a huge pale moon, painterly style.",
    "floor_sand": FLOOR + "Pale cartoon sea-floor sand with tiny pebbles and small shells, soft warm color.",
    "floor_grass": FLOOR + "Soft dreamy meadow grass seen from above, painterly, muted greens.",
}


def gen(name):
    size = "2048x1024" if name.startswith("sky") else "1024x1024"
    body = json.dumps({"model": "muse-image-1.0", "prompt": JOBS[name], "n": 1, "size": size}).encode()
    t = time.time()
    for attempt in range(3):  # sporadic 400 on a valid prompt, a retry passes
        try:
            req = urllib.request.Request(API, body, {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=180))
            Image.open(io.BytesIO(base64.b64decode(d["data"][0]["b64_json"]))).convert("RGB").save(OUT / f"{name}.png")
            return name, round(time.time() - t, 1)
        except Exception as e:
            err = e
    raise RuntimeError(f"{name}: {err}")


def seam(a, axis):
    """jump across the wrap edge / median jump between neighbours, along one axis"""
    inner = np.abs(np.diff(a, axis=axis)).mean(axis=2)
    edge = np.abs(np.take(a, 0, axis) - np.take(a, -1, axis)).mean(axis=1)
    return float(edge.mean() / np.median(inner.mean(axis=1 - axis)))


def score(name):
    img = Image.open(OUT / f"{name}.png")
    a = np.asarray(img, np.float32)
    if name.startswith("sky"):
        np_roll = np.roll(a, a.shape[1] // 2, axis=1).astype(np.uint8)
        Image.fromarray(np_roll).save(OUT / f"{name}_rolled.png")
        return {"size": img.size, "seam_lr": round(seam(a, 1), 2)}
    Image.fromarray(np.tile(a.astype(np.uint8), (3, 3, 1))).resize((1536, 1536)).save(OUT / f"{name}_tiled.png")
    return {"size": img.size, "seam_lr": round(seam(a, 1), 2), "seam_tb": round(seam(a, 0), 2)}


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    todo = [n for n in JOBS if not (OUT / f"{n}.png").exists()]
    with ThreadPoolExecutor(5) as ex:
        for name, s in ex.map(gen, todo):
            print(f"{name}: {s} s", flush=True)
    report = {n: score(n) for n in JOBS}
    for n, r in report.items():
        print(n, r)
    (OUT / "report.json").write_text(json.dumps(report, indent=1))
