"""Stage `story`: brief -> story/score.json (book) or story/seed.txt (seed); sim hand-off."""
import json
import shutil
import sys
import time
from pathlib import Path

DREAM = Path(__file__).resolve().parents[1] / "dream"


def _dream():
    if str(DREAM) not in sys.path:
        sys.path.insert(0, str(DREAM))


def run_story(ctx):
    brief = json.loads((ctx.run_dir / "brief" / "brief.json").read_text())
    if brief.get("mode") == "book" and brief.get("book"):
        _dream()
        import book as _book
        b = brief["book"]
        score = _book.score_scene(b["dir"], b["scene"])
        edited = ctx.run_dir / "story" / "score.edited.json"
        if edited.is_file():
            ed = json.loads(edited.read_text())
            if ed.get("scene") != b["scene"]:
                raise ValueError(f"score.edited.json is for scene {ed.get('scene')!r}, "
                                 f"brief wants {b['scene']!r}")
            shutil.copyfile(edited, ctx.out / "score.edited.json")
            score = ed
        (ctx.out / "score.json").write_text(json.dumps(score, ensure_ascii=False, indent=2))
    else:
        want = " ".join(((brief.get("scene") or {}).get("want") or brief.get("title") or "look around").split())
        (ctx.out / "seed.txt").write_text(want + "\n")
    (ctx.out / "marker.txt").write_text(json.dumps({"start": time.time(), "end": time.time()}))
    return 0.0


def run_stage(ctx):
    """Stage `stage` (partial, M3): the story half of stage.json. places/cast/voices come in M4."""
    rd = ctx.run_dir
    brief_p = rd / "brief" / "brief.json"
    brief = json.loads(brief_p.read_text()) if brief_p.is_file() else {}
    sj = {"dist": "world/run/dist", "places": "stage/places.json", "cast": "cast/cast.json",
          "mode": brief.get("mode"), "book": None, "seed": None,
          "freestyle": bool(ctx.opts.get("freestyle")), "narrator_voice": None}
    if brief.get("mode") == "book" and brief.get("book"):
        b = brief["book"]
        sj["book"] = {"dir": b["dir"], "scene": b["scene"], "score": "story/score.json"}
        try:
            _dream()
            import book as _book
            sj["narrator_voice"] = _book.load_book(b["dir"]).get("narrator_voice") or "old_man"
        except (OSError, ValueError):
            pass
    elif (rd / "story" / "seed.txt").is_file():
        sj["seed"] = (rd / "story" / "seed.txt").read_text().strip()
    if (rd / "world" / "run" / "dist" / "geometry.json").is_file():
        from . import stage as _stage
        extra = _stage.write_stage(rd, ctx.out, brief=brief, freestyle=sj["freestyle"])
        sj.update({k: extra[k] for k in ("objects", "voices", "start")})
    (ctx.out / "stage.json").write_text(json.dumps(sj, ensure_ascii=False, indent=2))
    (ctx.out / "marker.txt").write_text(json.dumps({"start": time.time(), "end": time.time()}))
    return 0.0


def run_sim(stage_json, run=None):
    """stage.json -> sim.run(...): the freestyle flag goes through as is."""
    stage_json = Path(stage_json)
    sj = json.loads(stage_json.read_text())
    # stage.json обычно симлинк run/stage -> .pub/stage-N: resolve() увёл бы
    # корень в run/.pub, поэтому сначала пробуем путь без резолва, затем резолв,
    # затем их родителей; берём первого кандидата с признаком корня прогона.
    abs_p = stage_json.absolute()
    cands = [abs_p.parent.parent]
    try:
        cands.append(abs_p.resolve().parent.parent)
    except OSError:
        pass
    cands += [c.parent for c in list(cands)]
    root = cands[0]
    for c in cands:
        if (c / "story" / "score.json").is_file() or (c / "make.json").is_file():
            root = c
            break
    kw = {"freestyle": bool(sj.get("freestyle"))}
    if sj.get("book"):
        kw["book"] = sj["book"]["dir"]
        kw["scenes"] = [sj["book"]["scene"]]
        sc = root / sj["book"]["score"]
        if sc.is_file():
            kw["score"] = json.loads(sc.read_text())
    if run is None:
        _dream()
        import sim
        run = sim.run
    return run(**kw)
