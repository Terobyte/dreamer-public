"""Parallel pipeline: the asset worker (Muse Image -> SAM3D) runs while Spark critiques and fixes.

  Spark A: write scene -> check -> fix ...      asset worker: polls scene.json; every new asset key ->
  build on placeholders -> Spark layout review     image at once, objects -> SAM3D as soon as their image is done
  (prompts frozen)                                 (repeats while the scene changes)
  wait for assets -> real build -> Spark critique -> missing assets -> final build

python3 pipe.py <out_dir_name>
"""
import json, shutil, subprocess, sys, threading, time
from pathlib import Path
import author
D = author.D
E = author.ENGINE
stop = threading.Event()
log = lambda *a: print(time.strftime("%H:%M:%S"), *a, flush=True)

def fill():
    r = subprocess.run(["python3", str(D / "assets.py")], capture_output=True, text=True)
    return (r.stdout + r.stderr).strip().splitlines()[-1:] or ["?"]

def worker():
    seen = None
    while not stop.is_set():
        s = D / "scene.json"
        if s.exists() and s.stat().st_mtime != seen:
            seen = s.stat().st_mtime
            log("assets: pass for scene", time.ctime(seen)[11:19], "->", *fill())
            continue
        time.sleep(3)

def build(tag, assets):
    out = D / "dist"
    if out.exists(): shutil.rmtree(out)
    a = ["--assets", "cache", "--cache", str(D / "cache")] if assets else ["--assets", "none"]
    subprocess.run(["node", "--import", "tsx", "bin/dreamer.ts", "build", str(D / "scene.json"), "--out", str(out), *a], cwd=E, check=True)
    subprocess.run(["node", "--import", "tsx", "bin/dreamer.ts", "shots", str(out), "--size", "960x720"], cwd=E, check=True)
    shutil.copytree(out, D / f"work/dist_{tag}", dirs_exist_ok=True)
    log("built", tag)

def review(tag, note):
    messages = json.loads((D / "work/chat.json").read_text())
    code, out = author.check(built=True)
    content = [{"type": "text", "text": f"""{note}
Attached: the sheet (each reference frame next to the same camera in the built scene) and the top view.
`dreamer check --built` exit {code}:
```
{out}
```
Send the whole scene again in one ```json block."""}]
    for p in ("dist/sheet.png", "dist/top.png"):
        if (D / p).exists(): content.append(author.img(D / p))
    messages.append({"role": "user", "content": content})
    txt = author.call(messages)
    messages.append({"role": "assistant", "content": txt}); author.save(messages)
    (D / f"work/raw_{tag}.txt").write_text(txt)
    scene = author.scene_of(txt)
    if tag == "p":  # layout review on placeholders: prompts stay what the worker is already generating
        old = json.loads((D / "scene.json").read_text()).get("assets", {})
        for k, v in scene.get("assets", {}).items():
            if k in old: v["prompt"] = old[k]["prompt"]
    (D / f"work/scene_{tag}.json").write_text(json.dumps(scene, ensure_ascii=False, indent=1))
    prev = (D / "scene.json").read_text()
    (D / "scene.json").write_text(json.dumps(scene, ensure_ascii=False, indent=1))
    code, out = author.check()
    log(f"review {tag}: check exit {code}")
    if code != 0:  # a review must not leave a broken scene behind
        (D / "scene.json").write_text(prev)
        log(f"review {tag}: reverted, check said:\n" + out[-1500:])

if __name__ == "__main__":
    t0 = time.time()
    w = threading.Thread(target=worker, daemon=True); w.start()
    ok = author.stage_a(); log("stage A", "OK" if ok else "NOT OK")
    build("p", assets=False)
    review("p", "The engine built your scene with coloured placeholder boxes (assets are still generating). "
                "Check the LAYOUT only against the references: room shape, positions, sizes, facing, cameras. "
                "Do not change asset prompts (they are already being generated).")
    while True:  # wait until the worker has caught up with the current scene
        time.sleep(5)
        r = subprocess.run(["node", "--import", "tsx", str(D / "work/keys.ts"), str(D / "scene.json")], cwd=E, capture_output=True, text=True)
        keys = json.loads(r.stdout)
        if all((D / "cache" / (k["key"] + (".glb" if k["kind"] == "object" else ".png"))).exists() for k in keys): break
    build("a", assets=True)
    review("b", "The engine built your scene with the generated assets. Compare the built views with the references and fix "
                "what is wrong: layout, placement, sizes, colours, missing things. Keep asset prompts unchanged unless an "
                "asset is clearly wrong (a changed prompt regenerates that asset).")
    stop.set(); log("final assets:", *fill())
    build("final", assets=True)
    log(f"PIPELINE DONE in {time.time()-t0:.0f}s")
