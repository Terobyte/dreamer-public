"""Stage `world`: brief + refs -> world/task/TASK.md -> `pipe2 run` (or the fixture with --fake)."""
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

H0 = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).resolve().parent / "testdata" / "world_run"
DEFAULT_CAPS = {"usd": 20.0, "calls": 400, "tokens": 4_000_000}
_FLOORS = {0: "ground floor", 1: "second floor", 2: "third floor"}


def _floor(level):
    return _FLOORS.get(level, f"floor {level + 1}")


def _fmt(x):
    return str(int(x)) if float(x) == int(x) else str(x)


def build_task_md(brief):
    """TASK.md text from the brief. No titles, no cast, no names: only places, sizes, style."""
    places = brief["places"]
    levels = sorted({p["level"] for p in places})
    multi = len(levels) > 1
    if any(p["type"] == "yard" for p in places):
        out = ["Build a small walkable scene of rooms and outdoor yards (private test scene, never shipped):",
               "all places walkable; houses open onto the yards by doors" + (", floors by stairs." if multi else "."),
               "Places of type `yard` are outdoors: a room with `open: true` (no walls, ceiling or height), "
               "an `outdoor` sky and ground, and a `facade` and `roof` on every house room touching a yard "
               "(see \"Как описать улицу\" in the engine spec). Never a tall closed room.", ""]
    else:
        out = ["Build the whole interior of a small set of rooms (private test scene, never shipped):",
               "all rooms walkable and connected by doors" + (" and stairs." if multi else "."), ""]
    out.append("Floors and rooms (ids are suggestions, keep them without `_`):")
    for lv in levels:
        out.append(f"- L{lv} {_floor(lv)}")
        for p in sorted((p for p in places if p["level"] == lv), key=lambda p: p["id"]):
            w, h = p["size_m"]
            nb = ", ".join(f"`{n}`" for n in p["next_to"]) or None
            near = f"next to {nb}." if nb else "no neighbours named."
            out.append(f"  - `{p['id']}` (about {_fmt(w)} x {_fmt(h)} m, {p['type']}): {near}")
    out.append("")
    if multi:
        ys = ", ".join(f"L{lv} y={3 * lv}" for lv in levels)
        out += ["Levels and stairs (the engine is strict here): floor-to-floor 3.0 m on every level "
                f"({ys}).",
                "A staircase cuts its stairwell only in the floor of the room it leads to, so its whole run "
                "must lie under that room's footprint.",
                "Keep stairs straight and along a wall.", ""]
    style = brandless((brief.get("style") or "").strip().rstrip("."))
    out += [f"Style for every image prompt (tiles, decals, objects): {style}.",
            "Nobody lives in the scene: no people, animals or characters in any image. In asset prompts never "
            "write show, character or brand names: describe only what the object looks like "
            "(shape, colour, material).", "",
            "Each room should be recognisable from its reference images (see cues.md and refs/ next to this "
            "file). A few large signature objects per room beat many small ones."]
    return "\n".join(out) + "\n"


# L80: a brief's style names a studio or a show ("Studio Ghibli"); image models filter brand names or
# copy the brand. The look it stands for goes into TASK.md instead.
BRAND_LOOKS = {
    "studio ghibli": "soft hand-painted watercolour animation look, warm natural light",
    "ghibli": "soft hand-painted watercolour animation look, warm natural light",
    "pixar": "smooth stylised 3D animation look, soft rounded shapes",
    "dreamworks": "stylised 3D animation look, saturated colours",
    "disney": "classic hand-drawn animation look, clean outlines",
    "nickelodeon": "bright flat cartoon look, bold outlines",
    "spongebob": "bright underwater cartoon look, bold outlines",
    "wes anderson": "symmetrical pastel storybook look, flat frontal compositions",
    "studio trigger": "bold cel-shaded anime look, strong colours",
    "makoto shinkai": "luminous painted anime look, detailed skies",
}


def brandless(style):
    """The style with every known studio/show/director name replaced by the look it stands for."""
    out = style
    for name in sorted(BRAND_LOOKS, key=len, reverse=True):
        out = re.sub(r"(?i)(?:in the style of\s+|à la\s+)?\b%s\b(?:['’]s)?(?:\s+style)?" % re.escape(name),
                     BRAND_LOOKS[name], out)
    return re.sub(r"\s{2,}", " ", out).strip()


def pipe2_argv(task_dir, run_dir, *, usd=None, calls=None, tokens=None, effort=None, resume=False, mesh=None):
    """argv for `pipe2 run`: all three --cap-* always."""
    a = [sys.executable, "-m", "pipe2", "run", str(task_dir), "--run-dir", str(run_dir),
         "--cap-usd", str(float(usd if usd is not None else DEFAULT_CAPS["usd"])),
         "--cap-calls", str(int(calls if calls is not None else DEFAULT_CAPS["calls"])),
         "--cap-tokens", str(int(tokens if tokens is not None else DEFAULT_CAPS["tokens"]))]
    if effort:
        a += ["--effort", str(effort)]
    if mesh:
        a += ["--mesh", str(mesh)]
    if resume:
        a.append("--resume")
    return a


def _write_task(ctx, brief):
    task = ctx.out / "task"
    task.mkdir(exist_ok=True)
    (task / "TASK.md").write_text(build_task_md(brief))
    refs = ctx.run_dir / "refs"
    if (refs / "cues.md").is_file():
        shutil.copyfile(refs / "cues.md", task / "cues.md")
    if refs.is_dir():
        for d in sorted(p for p in refs.iterdir() if p.is_dir()):
            shutil.copytree(d, task / "refs" / d.name, dirs_exist_ok=True)
    return task


_READY_FILES = ("scene.json", "dist/geometry.json", "dist/nav.json")


def ready_inputs(world_dir):
    """[[name, sha]] of what a ready world feeds the later stages: rebuild the world -> story and stage rerun."""
    import hashlib
    w = Path(world_dir)
    return [[f, hashlib.sha256((w / f).read_bytes()).hexdigest()] for f in _READY_FILES if (w / f).is_file()]


def _link_ready(ctx, world_dir):
    """`make --world DIR`: the engine already built this world (scene.json + dist/): link it, generate nothing.
    The link is absolute: make moves world.tmp into .pub/ and a relative one breaks (Squidward, Nov 3)."""
    w = Path(world_dir).resolve()
    if not all((w / f).is_file() for f in _READY_FILES[:2]):
        raise RuntimeError(f"--world {w}: no scene.json + dist/geometry.json (run `dreamer build` first)")
    link = ctx.out / "run"
    if link.is_symlink() or link.is_file():
        link.unlink()  # a kept world.tmp from an earlier try
    link.symlink_to(w)
    (ctx.out / "marker.txt").write_text(json.dumps({"start": time.time(), "end": time.time(), "ready": str(w)}))
    return 0.0


def run_world(ctx, runner=subprocess.run):
    if ctx.opts.get("world"):
        return _link_ready(ctx, ctx.opts["world"])
    brief = json.loads((ctx.run_dir / "brief" / "brief.json").read_text())
    task = _write_task(ctx, brief)
    run = ctx.out / "run"
    if ctx.params.get("fake"):
        shutil.copytree(FIXTURE, run, dirs_exist_ok=True)
    else:
        # a pipe2 that died before its skeleton (e.g. bad argv) has nothing to resume
        resume = ctx.resume and (run / "skeleton.json").is_file()
        if ctx.resume and not resume and run.exists():
            shutil.rmtree(run)  # nothing to resume; pipe2 refuses a dir that holds a dead run
        argv = pipe2_argv(task, run, usd=ctx.budget_usd, effort=ctx.opts.get("effort"), resume=resume,
                          mesh=ctx.opts.get("mesh"))
        r = runner(argv, cwd=str(H0))
        if r.returncode != 0:
            raise RuntimeError(f"pipe2 run failed (exit {r.returncode}); world.tmp kept for --resume")
    (ctx.out / "marker.txt").write_text(json.dumps({"start": time.time(), "end": time.time()}))
    return 0.0
