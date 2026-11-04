"""Dreamer Home catalog: our ready scenes (scenes.json) + the guest's own scenes (runs/home-*).

Every path a page can reach goes through here: the server never takes a path from a request,
only an id that this module maps to a path it checked.
"""
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # meta/
WORKSPACE = ROOT.parent
# where catalog paths may point: meta itself and the two sibling checkouts that hold our built runs
ALLOWED = (ROOT, WORKSPACE / "anymove", WORKSPACE / "meta-place")
CATALOG = Path(__file__).with_name("scenes.json")
RUNS = ROOT / "runs"
RUN_ID = re.compile(r"home-\d{8}-\d{6}")
MODES = ("book", "freestyle")
KINDS = ("play", "place")


def _under(p: Path, base: Path) -> bool:
    try:
        return p.resolve().is_relative_to(base.resolve())
    except OSError:
        return False


def allowed(p: Path, root: Path = ROOT) -> bool:
    """inside meta (root) or one of its two allowed siblings"""
    bases = (root, root.parent / "anymove", root.parent / "meta-place")
    return any(_under(p, b) for b in bases)


STATIC = Path(__file__).with_name("static")


def _cover(rel):
    """cover file under home/static (covers ship with Home, they do not depend on a run), or None"""
    if not rel:
        return None
    p = (STATIC / str(rel))
    return p.resolve() if p.is_file() and _under(p, STATIC) else None


def _stage(run: Path):
    try:
        return json.loads((run / "stage" / "stage.json").read_text())
    except (OSError, ValueError):
        return None


_CAST_OK = {}


def _cast_errors(cs: Path):
    """make's own cast check (GLBs, heights, voices), cached by the newest file mtime in the cast"""
    key = (str(cs), max(f.stat().st_mtime for f in cs.rglob("*") if f.is_file()))
    if key not in _CAST_OK:
        from make.cast import check_cast
        _CAST_OK[key] = check_cast(cs)
    return _CAST_OK[key]


def page_dir(run: Path):
    """the engine page dir of a play run, as make.play serves it"""
    from make.play import dist_of
    return dist_of(run)


def _check(e, root: Path):
    """-> (abs run dir or None, why-not-ready or None)"""
    run = (root / str(e.get("run") or "")).resolve()
    if not e.get("run") or not allowed(run, root):
        return None, "run path leaves the workspace"
    if not run.is_dir():
        return run, "run folder is missing"
    if e["kind"] == "play":
        sj = _stage(run)
        if sj is None:
            return run, "no stage/stage.json"
        if "book" in e["modes"] and sj.get("mode") != "book":
            return run, "book mode needs a book run"
        if not (run / page_dir(run) / "index.html").is_file():
            return run, "no engine page (dist/index.html)"
    if e["kind"] == "place" and not (run / "world" / "dist" / "index.html").is_file():
        return run, "no world/dist/index.html"
    return run, None


def load(path: Path = CATALOG, root: Path = ROOT):
    """-> {"scenes": [...], "worlds": [...]}; a broken entry stays with ready=False and a reason."""
    data = json.loads(Path(path).read_text())
    scenes = []
    for e in data.get("scenes") or []:
        e = dict(e)
        bad = None
        if not isinstance(e.get("id"), str) or not re.fullmatch(r"[a-z0-9-]{1,40}", e["id"]) or RUN_ID.fullmatch(e["id"]):
            continue   # an id that could be confused with a path or a guest run is dropped, not shown
        if e.get("kind") not in KINDS:
            bad = "unknown kind"
        modes = [m for m in e.get("modes") or [] if m in MODES]
        if not modes:
            bad = bad or "no modes"
        if e.get("kind") == "place" and modes != ["freestyle"]:
            bad = bad or "a place has only freestyle"
        e["modes"] = modes
        run, why = (None, bad) if bad else _check(e, root)
        e["_run"] = run
        e["_cover"] = _cover(e.get("cover"))
        e["ready"] = why is None
        e["why"] = why
        scenes.append(e)
    worlds = []
    for w in data.get("worlds") or []:
        if not isinstance(w.get("id"), str) or not re.fullmatch(r"[a-z0-9-]{1,40}", w["id"]):
            continue
        d, bk, cs = ((root / str(w.get(k) or "")).resolve() for k in ("dir", "book", "cast"))
        why = None
        if not all(w.get(k) for k in ("dir", "book", "cast")) or not all(allowed(x, root) for x in (d, bk, cs)):
            why = "world paths leave the workspace"
        elif not ((d / "scene.json").is_file() and (d / "dist" / "geometry.json").is_file()):
            why = "no scene.json + dist/geometry.json (what make --world links)"
        elif not (bk / "book.json").is_file():
            why = "no book.json"
        elif not (cs / "cast.json").is_file():
            why = "no cast.json"
        elif _cast_errors(cs):
            why = "cast: " + "; ".join(_cast_errors(cs))[:200]
        elif not w.get("who") or not isinstance(w["who"], list):
            why = "no cast names"
        cov = _cover(w.get("cover"))
        worlds.append(dict(w, _dir=d, _book=bk, _cast=cs, _cover=cov, ready=why is None, why=why))
    return {"scenes": scenes, "worlds": worlds, "create": data.get("create", True) is not False}


def public(entry):
    """what the page may see of an entry: no private paths"""
    return {k: v for k, v in entry.items() if not k.startswith("_")}


def home_json(run: Path):
    try:
        return json.loads((run / "home.json").read_text())
    except (OSError, ValueError):
        return {}


def build_status(run: Path, proc_alive=False, exit_code=None):
    """status of a guest build from make.json (+ the build process, when this Home started it).
    stages in pipeline order; status: running | ok | failed"""
    try:
        man = json.loads((run / "make.json").read_text())
    except (OSError, ValueError):
        man = {"stages": {}}
    order = ["brief", "refs", "world", "cast", "story", "stage", "shotplan"]
    st = man.get("stages") or {}
    stages = []
    for name in order + [n for n in st if n not in order]:
        r = st.get(name)
        if r is None:
            if name in order:
                stages.append({"name": name, "status": "waiting", "seconds": None, "usd": None})
            continue
        sec = None
        if r.get("started"):
            end = r.get("finished") or (time.time() if r.get("status") == "running" else None)
            sec = round(end - r["started"], 1) if end else None
        err = r.get("error") or ("over the money cap" if r.get("reason") == "budget" else None)
        stages.append({"name": name, "status": r.get("status") or "waiting", "seconds": sec,
                       "usd": r.get("usd"), "error": err})
    failed = next((s for s in stages if s["status"] == "failed"), None)
    playable = _stage(run) is not None
    if failed:
        status = "failed"
    elif proc_alive:
        status = "running"
    elif exit_code not in (None, 0):
        status = "failed"
    elif playable:
        status = "ok"
    else:
        status = "failed"   # no live process and nothing to play (also: a dead build from an earlier Home)
    usd = round(sum(s["usd"] or 0 for s in stages), 4)
    out = {"run_id": run.name, "status": status, "stages": stages, "usd": usd}
    if failed:
        out["error"] = failed.get("error") or "stage %s failed" % failed["name"]
    elif status == "failed":
        out["error"] = "build exited with code %s" % exit_code if exit_code else "build stopped"
    return out


def mine(runs: Path = RUNS):
    """the guest's finished scenes: runs/home-* with a stage.json, newest first"""
    out = []
    if not runs.is_dir():
        return out
    for run in sorted(runs.glob("home-*"), reverse=True):
        if not RUN_ID.fullmatch(run.name) or not run.is_dir():
            continue
        sj = _stage(run)
        if sj is None:
            continue
        h = home_json(run)
        modes = ["book", "freestyle"] if sj.get("mode") == "book" else ["freestyle"]
        shots = sorted((run / "world" / "run" / "dist" / "shots").glob("*.png")) \
            if (run / "world" / "run" / "dist" / "shots").is_dir() else []
        out.append({"id": run.name, "title": h.get("title") or (h.get("prompt") or run.name)[:60],
                    "prompt": h.get("prompt"), "cast": h.get("cast"), "world": h.get("world"),
                    "modes": modes, "kind": "play", "ready": True,
                    "_run": run.resolve(), "_cover": shots[0].resolve() if shots else None})
    return out
