"""Bible objects -> Muse Image PNGs (one object, plain background) for SAM 3D."""
import base64, json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
import urllib.request

API = "https://api.meta.ai/v1/images/generations"
KEY = os.environ["META_MODEL_API_KEY"]


def gen(obj, style, outdir):
    prompt = f"{obj['image_prompt']}. Style: {style}. Single isolated object, centered, full view, plain white background. No ground, no base, no sand, no plants or decorations around it."
    body = json.dumps({"model": "muse-image-1.0", "prompt": prompt, "n": 1}).encode()
    req = urllib.request.Request(API, body, {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    t = time.time()
    for attempt in range(3):  # Muse Image sporadically returns 400 on a valid prompt; retry succeeds
        try:
            d = json.load(urllib.request.urlopen(req, timeout=180))
            open(f"{outdir}/{obj['id']}.png", "wb").write(base64.b64decode(d["data"][0]["b64_json"]))
            return obj["id"], round(time.time() - t, 1), f"ok (attempt {attempt + 1})"
        except Exception as e:
            err = e
    return obj["id"], round(time.time() - t, 1), f"FAIL {err}"


if __name__ == "__main__":
    bible, outdir = json.load(open(sys.argv[1])), sys.argv[2]
    todo = [o for o in bible["objects"] if not os.path.exists(f"{outdir}/{o['id']}.png")]
    with ThreadPoolExecutor(5) as ex:
        for r in ex.map(lambda o: gen(o, bible["world"]["style"], outdir), todo):
            print(*r)
