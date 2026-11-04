"""Engine asset keys -> pipe2 AssetQueue (Muse pictures + SAM3D meshes, all at once) -> cache; progress by files."""
import subprocess
import time
from pathlib import Path

from pipe2.assets import MESH_APPS, MESH_TIMEOUT_S, AssetQueue, ModalMesh, MuseImage
from pipe2.engine import Engine
from pipe2.ledger import Ledger, load_prices

REPO = Path(__file__).resolve().parents[2]
ENGINE = REPO / "engine"


def fill_cache(scene, scene_dir: Path, cache: Path, prog=None, cap_usd=15.0, log=None):
    eng = Engine(ENGINE, shots=False)
    keys = eng.asset_keys(scene, scene_dir)
    ledger = Ledger(scene_dir / "events.jsonl", load_prices(), cap_usd, 600, None, resume=(scene_dir / "events.jsonl").exists())
    q = AssetQueue(cache, MuseImage(), ModalMesh(*MESH_APPS["sam3d"]), ledger, mesh_timeout_s=MESH_TIMEOUT_S["sam3d"], workers=32)
    weight = {k["key"]: (4 if k["kind"] == "object" else 1) for k in keys}
    total = sum(weight.values()) or 1
    q.put("place", keys)
    try:
        while True:
            have = sum(weight[k["key"]] for k in keys if q._cached(k))
            if prog:
                prog.set(have / total, f"{have}/{total}")
            if q.done("place"):
                break
            time.sleep(1.0)
    finally:
        q.close()
        ledger.close()
    missing = [k["id"] for k in keys if not q._cached(k)]
    return {"keys": len(keys), "missing": missing}


def build_dist(scene_path: Path, out: Path, cache: Path):
    r = subprocess.run(["node", "--import", "tsx", "bin/dreamer.ts", "build", str(scene_path.resolve()), "--out", str(out.resolve()),
                        "--assets", "cache", "--cache", str(cache.resolve()), "--apply-fixes"],
                       cwd=ENGINE, capture_output=True, text=True)
    (out.parent / "build.log").write_text((r.stdout or "") + (r.stderr or ""))
    return r.returncode


def fit_props(scene_path: Path, dist: Path, slack=1.25):
    """The engine scales a mesh by its height; a wide low thing (a canopy) then balloons. Shrink h until the built
    footprint fits the asked w x d (with slack). Returns how many props changed."""
    import json
    scene = json.loads(scene_path.read_text())
    facts = json.loads((dist / "build.json").read_text()).get("props", {})
    n = 0
    for p in scene.get("props", []):
        f = (facts.get(p["id"]) or {}).get("fact")
        if not f or not f.get("w"):
            continue
        k = min(1.0, slack * p["size"]["w"] / max(f["w"], 1e-6), slack * p["size"]["d"] / max(f.get("d") or 1e-6, 1e-6))
        k = max(k, 0.25)
        if k < 0.9:
            p["size"]["h"] = round(p["size"]["h"] * k, 3)
            n += 1
    scene_path.write_text(json.dumps(scene, ensure_ascii=False, indent=1))
    return n
