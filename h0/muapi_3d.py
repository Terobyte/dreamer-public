"""PNG -> .glb via muapi (Tripo3D / Meshy). Usage: muapi_3d.py <model-slug> <out_dir> <png>..."""
import json, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import requests

API = "https://api.muapi.ai/api/v1"
ENV = Path.home() / "Desktop/Projects/Active/music-video/.env"
KEY = next(l.split("=", 1)[1].strip() for l in ENV.read_text().splitlines() if l.startswith("MUAPI_API_KEY="))
H = {"x-api-key": KEY}


def run(slug, png, outdir):
    t = time.time()
    with open(png, "rb") as f:
        up = requests.post(f"{API}/upload_file", headers=H, files={"file": (png.name, f, "image/png")}, timeout=60).json()
    url = up.get("url") or up.get("data", {}).get("url")
    r = requests.post(f"{API}/{slug}", headers=H, json={"image_url": url}, timeout=60)
    if r.status_code >= 400:
        return png.stem, f"submit {r.status_code}: {r.text[:300]}"
    rid = r.json().get("request_id") or r.json().get("id")
    while time.time() - t < 600:
        time.sleep(5)
        d = requests.get(f"{API}/predictions/{rid}/result", headers=H, timeout=30).json()
        st = d.get("status")
        if st in ("completed", "succeeded"):
            outs = d.get("outputs") or d.get("output") or []
            outs = outs if isinstance(outs, list) else [outs]
            glb = next((o for o in outs if isinstance(o, str) and ".glb" in o), outs[0] if outs else None)
            json.dump(d, open(outdir / f"{png.stem}.json", "w"), indent=1)
            (outdir / f"{png.stem}.glb").write_bytes(requests.get(glb, timeout=120).content)
            return png.stem, f"ok {round(time.time() - t)}s"
        if st in ("failed", "error"):
            return png.stem, f"failed: {json.dumps(d)[:300]}"
    return png.stem, "timeout"


if __name__ == "__main__":
    slug, outdir = sys.argv[1], Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(5) as ex:
        for r in ex.map(lambda p: run(slug, Path(p), outdir), sys.argv[3:]):
            print(*r)
