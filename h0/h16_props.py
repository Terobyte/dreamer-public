"""H16 props: object images on plain white for SAM3D (floor objects of the kit room), generated in parallel.
usage: python h16_props.py  then  modal run sam3d_modal.py --out out/h16/props --pngs <the pngs>
"""
import base64, io, json, os, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

API = "https://api.meta.ai/v1/images/generations"
OUT = Path(__file__).parent / "out" / "h16" / "props"
OBJ = ("A single object, the whole object visible, three-quarter front view, centred, plain flat white background, "
       "no shadow, no floor, cartoon style with soft shading. ")
JOBS = {  # SpongeBob places are test-only (never in the submission)
    "armchair": OBJ + "A stiff old-fashioned upholstered armchair, brown-maroon fabric, wooden legs.",
    "clarinet": OBJ + "A black clarinet standing upright on a small wooden music stand, with a sheet of music.",
    "bookshelf": OBJ + "A tall narrow wooden bookshelf full of colourful books.",
    "side_table": OBJ + "A small round wooden side table with a table lamp with a cream shade on it.",
}


def gen(name):
    body = json.dumps({"model": "muse-image-1.0", "prompt": JOBS[name], "n": 1, "size": "1024x1024"}).encode()
    for _ in range(3):  # sporadic 400 on a valid prompt (H13)
        try:
            req = urllib.request.Request(API, body, {"Authorization": f"Bearer {os.environ['META_MODEL_API_KEY']}",
                                                     "Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=180))
            Image.open(io.BytesIO(base64.b64decode(d["data"][0]["b64_json"]))).convert("RGB").save(OUT / f"{name}.png")
            return name
        except Exception as e:
            err = e
    raise RuntimeError(f"{name}: {err}")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(len(JOBS)) as ex:
        print(list(ex.map(gen, [n for n in JOBS if not (OUT / f"{n}.png").exists()])))
