"""H16 kit: the room is real geometry (a box of known size), Muse Image only paints materials and decals.
A drawn 360 panorama is not a consistent room (bowed walls, a round floor), so no box fits it; tileable wall/floor/
ceiling textures on a real box stay put from anywhere, and the details (window, carving) are flat decals on the walls.
usage: python h16_kit.py
"""
import base64, io, json, os, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw

API = "https://api.meta.ai/v1/images/generations"
OUT = Path(__file__).parent / "out" / "h16"
TILE = ("Seamless tileable texture, front orthographic view, flat even lighting, no shadows, no perspective, "
        "no objects, the pattern repeats with no visible edges. ")
DECAL = "Front orthographic view, flat even lighting, no perspective, centred, filling the frame, plain flat white background. "
JOBS = {  # SpongeBob places are test-only (never in the submission)
    "kit_wall": TILE + "Cartoon teal stone brick wall, big rounded bricks with dark outlines, a few small barnacles "
                       "and green moss spots, painterly style.",
    "kit_ceiling": TILE + "Cartoon teal stone ceiling slabs with carved tiki glyph patterns, dark outlines, painterly.",
    "kit_porthole": DECAL + "A round brass ship porthole window with rivets, looking out into a bright cartoon "
                            "underwater scene with fish, bubbles and seaweed.",
    "kit_tiki": DECAL + "A tall carved teal stone tiki totem panel with an angry face, cartoon style, dark outlines.",
}


def gen(name):
    size = "1024x1024" if name != "kit_tiki" else "1024x2048"
    body = json.dumps({"model": "muse-image-1.0", "prompt": JOBS[name], "n": 1, "size": size}).encode()
    for _ in range(3):  # sporadic 400 on a valid prompt (H13)
        try:
            req = urllib.request.Request(API, body, {"Authorization": f"Bearer {os.environ['META_MODEL_API_KEY']}",
                                                     "Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=180))
            img = Image.open(io.BytesIO(base64.b64decode(d["data"][0]["b64_json"]))).convert("RGBA")
            if name == "kit_porthole":  # round decal: cut a circle, the white corners go transparent
                m = Image.new("L", img.size, 0); w, h = img.size; r = min(w, h) * 0.47
                ImageDraw.Draw(m).ellipse((w / 2 - r, h / 2 - r, w / 2 + r, h / 2 + r), fill=255); img.putalpha(m)
            img.save(OUT / f"{name}.png")
            return name, img.size
        except Exception as e:
            err = e
    raise RuntimeError(f"{name}: {err}")


if __name__ == "__main__":
    with ThreadPoolExecutor(len(JOBS)) as ex:
        print(list(ex.map(gen, [n for n in JOBS if not (OUT / f"{n}.png").exists()])))
