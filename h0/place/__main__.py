"""A real place as an engine world: address point + Street View frames -> dist.

  cd h0 && python3 -m place --run ../runs/yard-kozb7 --lat 50.40734 --lon 80.25444 --yard-at -18.4,57.4 \
      --house "Козбагарова 7" --refs ~/.dreamer-bench/tasks/03-kozb7-yard/refs/clean [--from plan] [--until compile]

Steps (each cached in the run folder, `--from X` redoes X and after):
  osm      Overpass buildings + roads, Esri satellite, the yard frame (s along the house's yard wall, n into the yard)
  read     Spark looks at the frames -> features.json (what is there: materials, objects, which frame shows each)
  plan     Spark lays it out on the satellite in the yard frame -> plan.json (where things stand)
  compile  code -> world/scene.json (code = space, Muse = surfaces, SAM3D = objects from the frames)
  assets   every picture and mesh at once (pipe2 AssetQueue) -> world/cache
  build    dreamer build --assets cache --apply-fixes -> world/dist
Progress for the page: <run>/progress.jsonl (see progress.py).
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image

from . import assets as A, compile as C, geo, prompts, sheets, spark, topview
from .progress import Progress

STEPS = ["osm", "read", "plan", "compile", "assets", "build", "critic"]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--yard-at", required=True, help="x,y metres from lat/lon of a point inside the yard")
    ap.add_argument("--house", required=True, help="end of the OSM name of the main house, e.g. 'Козбагарова 7'")
    ap.add_argument("--refs", required=True)
    ap.add_argument("--radius", type=float, default=170)
    ap.add_argument("--from", dest="from_", choices=STEPS)
    ap.add_argument("--until", choices=STEPS)
    ap.add_argument("--effort", default="high")
    a = ap.parse_args(argv)
    run, refs = Path(a.run), Path(a.refs).expanduser()
    run.mkdir(parents=True, exist_ok=True)
    todo = STEPS[STEPS.index(a.from_) if a.from_ else 0: STEPS.index(a.until) + 1 if a.until else None]
    fresh = lambda step, f: step in todo and (a.from_ is not None and STEPS.index(step) >= STEPS.index(a.from_) or not f.exists())
    stages = [s for s in ("read", "plan", "compile", "assets", "build", "critic") if s in todo]
    prog = Progress(run / "progress.jsonl", stages or ["compile"], label=a.house)

    fr = geo.Frame(a.lat, a.lon)
    layout = geo.osm_layout(geo.overpass(a.lat, a.lon, a.radius, run / "osm.json"), fr)
    house = next(b for b in layout["buildings"] if b["name"].endswith(a.house))
    yx, yy = (float(v) for v in a.yard_at.split(","))
    sn = geo.SN(*geo.edge_frame(house["poly"], (yx, yy)))
    if fresh("osm", run / "top_sn.png"):
        img, to_px = geo.satellite(fr, a.radius, 17, run / "sat.jpg")
        topview.render(img, to_px, sn, (-30, sn.L + 15, -12, 62), layout, mpp=0.15).save(run / "top_sn.png")
        raw = topview.render(img, to_px, sn, (-30, sn.L + 15, -12, 62), layout, mpp=0.15, marks=False)
        cr = [(round(s, 2), round(n, 2), round(f, 2)) for s, n, f in topview.crowns(raw, (-30, sn.L + 15, -12, 62), 0.15)]
        (run / "crowns.json").write_text(json.dumps(cr))
        (run / "frame.json").write_text(json.dumps({"F": sn.F.tolist(), "L": sn.L, "d": sn.d.tolist(), "n": sn.n.tolist()}))
    sh = sheets.make(refs, run / "sheets") if not (run / "sheets").exists() else [(p, []) for p in sorted((run / "sheets").glob("sheet_*.jpg"))]

    try:
        if "read" in stages:
            prog.start("read", "looking at the photos")
            if fresh("read", run / "features.json"):
                feat, meta = spark.ask(prompts.READ, ["Frames of the courtyard:"] + [spark.img_part(Image.open(p), 1536) for p, _ in sh],
                                       effort=a.effort, log=run / "read.txt")
                (run / "features.json").write_text(json.dumps(feat, ensure_ascii=False, indent=1))
        feat = json.loads((run / "features.json").read_text())
        if "plan" in stages:
            prog.start("plan", "laying out the yard")
            if fresh("plan", run / "plan.json"):
                parts = [f"Satellite in the yard frame (s right, n up, grid 10 m). The main house wall runs along n = 0 from s = 0 "
                         f"to s = {sn.L:.1f}; the house is below it (n < 0).",
                         spark.img_part(Image.open(run / "top_sn.png"), 1400),
                         "Visual notes from Street View:\n" + json.dumps(feat, ensure_ascii=False), "Frames:"] + \
                        [spark.img_part(Image.open(p), 1280) for p, _ in sh]
                plan, meta = spark.ask(prompts.PLAN, parts, effort=a.effort, log=run / "plan.txt")
                (run / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1))
        plan = json.loads((run / "plan.json").read_text())
        world = run / "world"
        if "compile" in stages:
            prog.start("compile", "space from code")
            views = json.loads((run / "views.json").read_text()) if (run / "views.json").exists() else []
            crowns = json.loads((run / "crowns.json").read_text()) if (run / "crowns.json").exists() else []
            C.compile_scene(feat, plan, layout, sn, a.house, refs, world, name=a.house,
                            cameras=C.cameras_from_views(views, fr, sn), crowns=crowns)
        scene = json.loads((world / "scene.json").read_text())
        if "assets" in stages:
            prog.start("assets", "surfaces and objects")
            res = A.fill_cache(scene, world, world / "cache", prog, cutouts=[k for k in scene["assets"] if k.startswith("tb_")])
            (world / "assets.json").write_text(json.dumps(res, indent=1))
        if "build" in stages:
            prog.start("build", "engine build")
            code = A.build_dist(world / "scene.json", world / "dist", world / "cache")
            if code == 0 and A.fit_props(world / "scene.json", world / "dist"):
                prog.set(0.5, "fitting wide objects")
                code = A.build_dist(world / "scene.json", world / "dist", world / "cache")
            if code != 0:
                raise RuntimeError(f"dreamer build failed ({code}), see {world / 'build.log'}")
        if "critic" in stages:
            # look -> fix, one round: shots from the Street View panos, Spark names what to redo, rebuild
            prog.start("critic", "comparing with the photos")
            import subprocess
            subprocess.run(["node", "--import", "tsx", "bin/dreamer.ts", "shots", str((world / "dist").resolve()), "--size", "1280x720"],
                           cwd=A.ENGINE, capture_output=True)
            from . import critic
            critic.critique(run, refs, effort=a.effort)
            views = json.loads((run / "views.json").read_text()) if (run / "views.json").exists() else []
            crowns = json.loads((run / "crowns.json").read_text()) if (run / "crowns.json").exists() else []
            C.compile_scene(feat, json.loads((run / "plan.json").read_text()), layout, sn, a.house, refs, world, name=a.house,
                            cameras=C.cameras_from_views(views, fr, sn), crowns=crowns)
            scene = json.loads((world / "scene.json").read_text())
            A.fill_cache(scene, world, world / "cache", None, cutouts=[k for k in scene["assets"] if k.startswith("tb_")])
            code = A.build_dist(world / "scene.json", world / "dist", world / "cache")
            if code == 0 and A.fit_props(world / "scene.json", world / "dist"):
                code = A.build_dist(world / "scene.json", world / "dist", world / "cache")
            if code != 0:
                raise RuntimeError(f"dreamer build after critic failed ({code})")
        prog.finish(True)
        print(json.dumps({"status": "done", "dist": str(world / "dist"), "took": prog.took}))
        return 0
    except Exception as e:
        prog.finish(False, str(e)[:300])
        raise


if __name__ == "__main__":
    sys.exit(main())
