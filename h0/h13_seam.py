"""H13 seam fix: roll the panorama by half, blank a band over the seam, let Muse Image edits fill it, feather it back.
usage: python h13_seam.py <name> [band_px]   (reads out/h13/<name>_rolled.png from h13_sky.py)
"""
import json, os, io, base64, uuid, urllib.request, urllib.error, time, sys
import numpy as np
from PIL import Image
KEY = os.environ["META_MODEL_API_KEY"]
name, gap = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 160
src = Image.open(f"out/h13/{name}_rolled.png"); w, h = src.size
crop = np.asarray(src.crop((w//2 - h//2, 0, w//2 + h//2, h))).copy()
crop[:, h//2 - gap//2: h//2 + gap//2] = 128                       # blank band over the seam
B = uuid.uuid4().hex
def part(n, data, fn=None, ct=None):
    head = f'Content-Disposition: form-data; name="{n}"' + (f'; filename="{fn}"' if fn else "")
    return (f"--{B}\r\n{head}\r\n" + (f"Content-Type: {ct}\r\n" if ct else "") + "\r\n").encode() + data + b"\r\n"
buf = io.BytesIO(); Image.fromarray(crop).save(buf, "PNG")
body = (part("model", b"muse-image-1.0") + part("prompt", b"Fill the flat gray vertical band in the middle so the scene continues seamlessly from the left half into the right half. Do not change anything outside the gray band.")
        + part("image", buf.getvalue(), "img.png", "image/png") + f"--{B}--\r\n".encode())
req = urllib.request.Request("https://api.meta.ai/v1/images/edits", body, {"Authorization": f"Bearer {KEY}", "Content-Type": f"multipart/form-data; boundary={B}"})
t = time.time()
ed = Image.open(io.BytesIO(base64.b64decode(json.load(urllib.request.urlopen(req, timeout=240))["data"][0]["b64_json"]))).convert("RGB").resize((h, h))
print("edit", round(time.time() - t, 1), "s")
ed.save(f"out/h13/{name}_gap_raw.png")
a, b = crop.astype(np.float32), np.asarray(ed, np.float32)
x = np.abs(np.arange(h) - h / 2)
alpha = np.clip(1 - (x - gap / 2) / 80, 0, 1)[None, :, None]       # band fully from edit, 80 px feather outside
out = np.asarray(src, np.float32).copy()
out[:, w//2 - h//2: w//2 + h//2] = a * (1 - alpha) + b * alpha
Image.fromarray(out.astype(np.uint8)).save(f"out/h13/{name}_fixed_rolled.png")
Image.fromarray(np.roll(out, -(w//2), axis=1).astype(np.uint8)).save(f"out/h13/{name}_fixed.png")
