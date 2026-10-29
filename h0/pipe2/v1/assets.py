"""Fill the engine's asset cache for scene.json with the real providers (Muse Image on api.meta.ai, SAM3D on Modal).
Keys and full prompts come from the engine itself (work/keys.ts), so `dreamer build --assets cache` picks them up.
The engine's own live providers point at a host that does not exist yet, hence this filler."""
import base64, io, json, os, shutil, subprocess, tempfile, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image
D = Path(__file__).parent
C = D / "cache"
MW = "/Users/terobyte/Desktop/Projects/Active/meta-world"
C.mkdir(exist_ok=True)
refs = json.loads(subprocess.run(["node", "--import", "tsx", str(D / "work/keys.ts"), str(D / "scene.json")],
                                 cwd=f"{MW}/engine", capture_output=True, text=True, check=True).stdout)

def gen(prompt, size, out):
    if out.exists(): return f"{out.name} cached"
    body = json.dumps({"model": "muse-image-1.0", "prompt": prompt, "n": 1, "size": size}).encode()
    err = None
    for _ in range(3):
        try:
            req = urllib.request.Request("https://api.meta.ai/v1/images/generations", body,
                {"Authorization": f"Bearer {os.environ['META_MODEL_API_KEY']}", "Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=180))
            Image.open(io.BytesIO(base64.b64decode(d["data"][0]["b64_json"]))).convert("RGB").save(out)
            return out.name
        except Exception as e: err = e
    return f"{out.name} FAILED {type(err).__name__}"

jobs = []
for r in refs:
    if r["kind"] == "object":
        if not (C / f"{r['key']}.glb").exists(): jobs.append((r["prompt"], r["size"], C / f"{r['key']}.src.png"))
    else:
        jobs.append((r["prompt"], r["size"], C / f"{r['key']}.png"))
with ThreadPoolExecutor(32) as ex: print(*ex.map(lambda j: gen(*j), jobs), sep="\n")

todo = [r for r in refs if r["kind"] == "object" and not (C / f"{r['key']}.glb").exists() and (C / f"{r['key']}.src.png").exists()]
if todo:
    tmp = Path(tempfile.mkdtemp(dir=D / "work"))
    for r in todo: shutil.copy(C / f"{r['key']}.src.png", tmp / f"{r['key']}.png")
    out = tmp / "glb"
    subprocess.run(["modal", "run", "h0/sam3d_modal.py", "--out", str(out), "--pngs", ",".join(str(p) for p in sorted(tmp.glob("*.png")))],
                   cwd=MW, check=False)
    for g in out.glob("*.glb"): shutil.move(str(g), C / g.name)
    shutil.rmtree(tmp)
names = {r["key"]: r["id"] for r in refs}
have = [names[k.stem] for k in C.glob("*.glb") if k.stem in names]
print("objects with mesh:", len(have), "/", sum(r["kind"] == "object" for r in refs))
(D / "work/asset_ids.json").write_text(json.dumps(names, indent=1))
