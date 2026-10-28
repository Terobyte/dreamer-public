"""H16 squid v2: the kit room rebuilt from reference frames instead of memory (memory got colours, shape and
furniture wrong). Cues read off two episode frames: a ROUND room, dark olive mottled walls, pink-mauve plank
parquet in square blocks, olive ceiling with wooden beams, yellow-bamboo furniture with blue upholstery, bamboo
doors, framed self-portraits, a pink shell lamp, an easel, a coral in a pot. Test-only (SpongeBob never ships).
usage: python h16_squid2.py   (tiles + decals + prop images, all in parallel; props then go to sam3d_modal.py)
"""
import base64, io, json, os, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw
import numpy as np

API = "https://api.meta.ai/v1/images/generations"
OUT = Path(__file__).parent / "out" / "h16" / "sq2"
STYLE = "2000s TV cartoon background painting style, flat painted colours, thick dark outlines. "
TILE = "Seamless tileable texture, front orthographic view, flat even lighting, no shadows, no perspective, no objects, the pattern repeats with no visible edges. " + STYLE
DECAL = "Front orthographic view, flat even lighting, no perspective, centred, filling the frame, plain flat white background. " + STYLE
OBJ = "A single object, the whole object visible, three-quarter front view, centred, plain flat white background, no shadow, no floor. " + STYLE
BAMBOO = "frame made of yellow bamboo poles with bamboo curls, upholstered in blue fabric with darker blue stripes"
JOBS = {
    "t_wall": TILE + "Dark olive green wall of mottled sponge-like painted stone, darker green blotches and lighter green speckles.",
    "t_floor": TILE + "Pinkish mauve wooden floor: square blocks of parallel planks, alternating direction like basket-weave parquet, dark plank lines.",
    "t_ceiling": TILE + "Smooth olive-yellow plaster ceiling with faint brush strokes.",
    "t_beam": TILE + "Brown painted wood grain of a wooden beam, long grain lines.",
    "d_door": DECAL + "A tall narrow door made of vertical yellow bamboo poles tied together, rectangular.",
    "d_portrait": DECAL + "A framed portrait painting of a grumpy pale cyan cartoon octopus man with a long droopy nose and half-closed eyes, in a dark green square frame.",
    "d_window": DECAL + "A wide window of four tall blue glass panes in a yellow bamboo frame, blue ocean water seen through it.",
    "p_sofa": OBJ + f"A long sofa with a {BAMBOO}.",
    "p_armchair": OBJ + f"An armchair with a high back, {BAMBOO}.",
    "p_table": OBJ + "A round dining table with a pale lavender top and a thick yellow bamboo pedestal, a golden candelabra on it.",
    "p_chair": OBJ + f"A dining chair with a very tall narrow back, {BAMBOO}.",
    "p_easel": OBJ + "A painter's easel of yellow bamboo poles holding a blank canvas.",
    "p_vase": OBJ + "A tall round-bellied blue ceramic vase.",
    "p_coral": OBJ + "A purple branching coral plant in a dark green square pot.",
    "p_stand": OBJ + "A black clarinet lying on a small round dark teal stool, next to a lavender music stand on bamboo legs.",
    "p_lamp": OBJ + "A hanging ceiling lamp shaped like a pink scallop shell, on a short cord.",
}


def gen(name):
    size = {"d_door": "1024x2048", "d_window": "2048x1024"}.get(name, "1024x1024")
    body = json.dumps({"model": "muse-image-1.0", "prompt": JOBS[name], "n": 1, "size": size}).encode()
    for _ in range(3):  # sporadic 400 on a valid prompt (H13)
        try:
            req = urllib.request.Request(API, body, {"Authorization": f"Bearer {os.environ['META_MODEL_API_KEY']}",
                                                     "Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=180))
            img = Image.open(io.BytesIO(base64.b64decode(d["data"][0]["b64_json"]))).convert("RGB")
            if name.startswith("d_"):  # decal: flood the white background from the corners, it goes transparent
                w, h = img.size
                for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
                    ImageDraw.floodfill(img, seed, (255, 0, 255), thresh=40)
                a = np.asarray(img); key = (a[..., 0] == 255) & (a[..., 1] == 0) & (a[..., 2] == 255)
                img = Image.fromarray(np.dstack([a, np.where(key, 0, 255).astype(np.uint8)]), "RGBA")
            img.save(OUT / f"{name}.png")
            return name
        except Exception as e:
            err = e
    return f"{name} FAILED {err}"


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(len(JOBS)) as ex:
        print(list(ex.map(gen, [n for n in JOBS if not (OUT / f"{n}.png").exists()])))
