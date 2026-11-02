"""python3 -m make.book <book.txt> --out film.mp4 [--lang] [--fake] [--max-dollars N] [--live]

Book text -> film in seven cached steps: read, voices, world, cast, story, stage, film.
Without --live the chain is always --fake (fixtures, no network). Each step is cached by the
hash of its input (chain hash: own params + the previous step's hash); each step first checks
what the previous step must have produced, so a broken output stops the chain on the NEXT step.
This module keeps its own spend counter (sum of what the steps return, retries included)."""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

H0 = Path(__file__).resolve().parents[1]
if str(H0) not in sys.path:
    sys.path.insert(0, str(H0))

import llm_http  # noqa: E402

STEPS = ("read", "voices", "world", "cast", "story", "stage", "film")
VERSION = {s: 1 for s in STEPS}
ESTIMATE = {"read": 1.0, "voices": 0.0, "world": 3.0, "cast": 0.0, "story": 1.0, "stage": 0.0, "film": 2.0}
DIRECTOR_MODEL = "muse:muse-spark-1.3-contributor"
STAGING_PROMPT_VERSION = 1
SPARK_MODEL = "muse-spark-1.3-contributor"
SPARK_URL = "https://api.meta.ai/v1/chat/completions"
VOICES_PATH = H0 / "dream" / "voices.json"
_PAID = re.compile(r"^muse-spark-1\.3$")
_SEX = {"woman": "woman", "female": "woman", "man": "man", "male": "man"}


# ---- Spark (read step), only through llm_http.post -----------------------------------------

def spark_call(system, user, *, model=SPARK_MODEL, key=None, timeout=300):
    if _PAID.match(model.replace("muse:", "").strip().lower()):
        raise ValueError("paid model refused: use muse-spark-1.3-contributor")
    if key is None:
        import keys
        key = keys.get("META") or ""
    payload = {"model": model, "messages": [{"role": "system", "content": system},
                                            {"role": "user", "content": user}]}
    return llm_http.post(SPARK_URL, "Bearer " + key, payload, timeout, 1)["content"]


# ---- voices --------------------------------------------------------------------------------

def pick_voice(sex, age, voices):
    """(key in voices.json, warning|None): (sex, group) -> same sex adult -> first voice."""
    s = _SEX.get(str(sex).lower(), str(sex).lower())
    a = age if isinstance(age, (int, float)) and not isinstance(age, bool) else 30
    group = "child" if a < 14 else "adult" if a <= 60 else "elder"
    exact = {"child": "child", "adult": s, "elder": "old_" + s}[group]
    if exact in voices:
        return exact, None
    if s in voices:
        return s, None
    first = next(iter(voices))
    return first, "no voice for %s/%s, using %s" % (s, group, first)


def _voices():
    return json.loads(VOICES_PATH.read_text(encoding="utf-8"))


# ---- hashing / io --------------------------------------------------------------------------

def _sha(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


def _sha_dir(d):
    d = Path(d)
    if not d.is_dir():
        return ""
    return _sha([[p.relative_to(d).as_posix(), hashlib.sha256(p.read_bytes()).hexdigest()]
                 for p in sorted(d.rglob("*")) if p.is_file()])


def run_dir_for(out):
    out = Path(out)
    return out.parent / (out.name + ".run")


def _paras(text):
    return [p for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]


class StepError(Exception):
    pass


class Ctx:
    def __init__(self, run, out, text, text_path, lang, fake, cast_dir):
        self.run, self.out, self.text, self.text_path = run, out, text, text_path
        self.lang, self.fake, self.cast_dir = lang, fake, cast_dir

    def prev(self, step):
        return self.run / step


# ---- input checks (what the previous step must have left) ----------------------------------

def _need_json(path, what):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise StepError("%s missing or not json" % what)


def _check_book(d, what):
    from dream.book import load_book
    try:
        return load_book(str(d))
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise StepError("%s/book.json rejected by load_book: %s" % (what, e))


def _score_path(ctx):
    d = ctx.prev("story")
    if ctx.lang != "en":
        return d / ("score.%s.json" % ctx.lang)
    return d / "score.json"


def _check_input(step, ctx):
    if step == "voices":
        _check_book(ctx.prev("read"), "read")
    elif step == "world":
        _check_book(ctx.prev("voices"), "voices")
    elif step == "cast":
        pl = _need_json(ctx.prev("world") / "places.json", "world/places.json")
        if not isinstance(pl, dict) or not isinstance(pl.get("places"), list):
            raise StepError("world/places.json has no places list")
    elif step == "story":
        from . import cast as _cast
        errs = _cast.check_cast(ctx.prev("cast"))
        if errs:
            raise StepError("cast/cast.json invalid: " + "; ".join(errs))
    elif step == "stage":
        sc = _need_json(_score_path(ctx), "story/score.json")
        if not isinstance(sc, dict) or not isinstance(sc.get("beats"), list):
            raise StepError("story/score.json has no beats list")
    elif step == "film":
        ev = _need_json(ctx.prev("stage") / "events.json", "stage/events.json")
        if not isinstance(ev, list) or not ev:
            raise StepError("stage/events.json is not a non-empty list")


# ---- step bodies (fake = fixtures; live wiring is the owner's) -----------------------------

def _read_live(ctx):
    system = ("Turn the book text into JSON: pov, narrator_voice, cast{name:{sex,age,look}}, "
              "places{id:{desc,exits[]}}, chapters[{n,file,title,scenes[{id,paras:[from,to],place,cast[]}]}]. "
              "Answer JSON only.")
    return json.loads(spark_call(system, ctx.text))


def _validate_book_or_raise(book):
    cast = book.get("cast")
    if not isinstance(cast, dict) or not cast:
        raise StepError("read/book.json has no cast")
    places = book.get("places")
    if not isinstance(places, dict) or not places:
        raise StepError("read/book.json has no places")
    chapters = book.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise StepError("read/book.json has no chapters")
    for ch in chapters:
        scenes = ch.get("scenes") if isinstance(ch, dict) else None
        if not isinstance(scenes, list) or not scenes:
            raise StepError("read/book.json chapter without scenes")
        for sc in scenes:
            if not isinstance(sc, dict) or sc.get("place") not in places:
                raise StepError("read/book.json scene place %r not in places" % (sc.get("place") if isinstance(sc, dict) else sc))
    for name, c in cast.items():
        if not isinstance(c, dict):
            raise StepError("read/book.json cast %s: not an object" % name)
        if c.get("sex") not in ("woman", "female", "man", "male"):
            raise StepError("read/book.json cast %s: sex %r missing" % (name, c.get("sex")))
        a = c.get("age")
        if isinstance(a, bool) or not isinstance(a, (int, float)):
            raise StepError("read/book.json cast %s: age %r missing" % (name, c.get("age")))
        if not isinstance(c.get("look"), str) or not c["look"].strip():
            raise StepError("read/book.json cast %s: look missing" % name)


def _step_read(ctx):
    paras = _paras(ctx.text)
    if ctx.fake:
        book = {"title": ctx.text_path.stem, "pov": "Hero", "narrator_voice": "man",
                "cast": {"Hero": {"sex": "woman", "age": 9, "look": "a small girl in a red coat"},
                         "Elder": {"sex": "man", "age": 70, "look": "an old man with a grey beard"}},
                "places": {"home": {"desc": "a small room", "exits": ["yard"]},
                           "yard": {"desc": "a grassy yard", "exits": ["home"]}},
                "chapters": [{"n": 1, "file": "book.txt", "title": "One", "scenes": [
                    {"id": "s1", "paras": [0, len(paras)], "place": "home", "cast": ["Hero", "Elder"]}]}]}
        usd = 1.0
    else:
        book, usd = _read_live(ctx), ESTIMATE["read"]
        for ch in book.get("chapters") or []:
            if isinstance(ch, dict) and not ch.get("file"):
                ch["file"] = "book.txt"
    _validate_book_or_raise(book)
    voices = _voices()
    for c in book["cast"].values():
        c["voice"], _w = pick_voice(c.get("sex"), c.get("age"), voices)
    if book.get("narrator_voice") not in voices:
        book["narrator_voice"] = pick_voice("man", 30, voices)[0]
    text = "\n\n".join(paras)
    (ctx.out / "book.txt").write_text(text, encoding="utf-8")
    for ch in book.get("chapters") or []:
        f = ch.get("file") if isinstance(ch, dict) else None
        if f and f != "book.txt":
            if not isinstance(f, str) or f != Path(f).name or not re.fullmatch(r"[A-Za-z0-9._-]+", f) or f.startswith("."):
                raise StepError("read/book.json chapter file %r is not a plain file name" % (f,))
            dest = (ctx.out / f).resolve()
            if not dest.is_relative_to(ctx.out.resolve()):
                raise StepError("read/book.json chapter file %r leaves the step dir" % f)
            dest.write_text(text, encoding="utf-8")
    (ctx.out / "book.json").write_text(json.dumps(book, ensure_ascii=False, indent=2), encoding="utf-8")
    return usd


def _step_voices(ctx):
    voices = _voices()
    book = json.loads((ctx.prev("read") / "book.json").read_text(encoding="utf-8"))
    assigned, warns = {}, []
    for name, c in book["cast"].items():
        c["voice"], w = pick_voice(c.get("sex"), c.get("age"), voices)
        assigned[name] = c["voice"]
        if w:
            warns.append(name + ": " + w)
    shutil.copy(ctx.prev("read") / "book.txt", ctx.out / "book.txt")
    (ctx.out / "book.json").write_text(json.dumps(book, ensure_ascii=False, indent=2), encoding="utf-8")
    (ctx.out / "voices.json").write_text(json.dumps({"voices": assigned, "warnings": warns}, indent=2))
    return 0.0


def _refs_root(ctx):
    return ctx.text_path.parent / "refs"


def _step_world(ctx):
    book = json.loads((ctx.prev("voices") / "book.json").read_text(encoding="utf-8"))
    places = [{"id": k, **v} for k, v in book.get("places", {}).items()]
    (ctx.out / "brief").mkdir()
    (ctx.out / "brief" / "brief.json").write_text(json.dumps({"places": places}, indent=2))
    cues = []
    for p in places:
        src = _refs_root(ctx) / p["id"]
        files = sorted(f for f in src.iterdir() if f.is_file()) if src.is_dir() else []
        if files:
            (ctx.out / "refs" / p["id"]).mkdir(parents=True)
            for f in files:
                shutil.copy(f, ctx.out / "refs" / p["id"] / f.name)
            cues.append("%s: %d reference image(s)" % (p["id"], len(files)))
    (ctx.out / "cues.md").write_text("\n".join(cues), encoding="utf-8")
    (ctx.out / "places.json").write_text(json.dumps({"places": places}, indent=2))
    if ctx.fake:
        fix = Path(__file__).resolve().parent / "testdata" / "world_run"
        if fix.is_dir():
            shutil.copytree(fix, ctx.out / "run", dirs_exist_ok=True)
    return 3.0 if not ctx.fake else ESTIMATE["world"]


def _step_cast(ctx):
    from . import cast as _cast
    for f in sorted(Path(ctx.cast_dir).iterdir()):
        if f.is_file():
            shutil.copy(f, ctx.out / f.name)
    errs = _cast.check_cast(ctx.out)
    if errs:
        raise StepError("cast: " + "; ".join(errs))
    return 0.0


def _translate_live(texts, lang):
    system = ("Translate each string of the JSON list into %s, keep tone. "
              "Answer one JSON object {\"texts\": [...]}." % lang)
    out = json.loads(spark_call(system, json.dumps(texts, ensure_ascii=False)))
    if isinstance(out, dict) and isinstance(out.get("texts"), list):
        return out["texts"]
    if isinstance(out, list):
        return out
    raise ValueError("translate: bad shape")


def _step_story(ctx):
    paras = _paras((ctx.prev("voices") / "book.txt").read_text(encoding="utf-8"))
    beats = [{"i": i, "kind": "narration", "text": t} for i, t in enumerate(paras)]
    (ctx.out / "score.json").write_text(json.dumps({"beats": beats, "lang": "en"}, ensure_ascii=False))
    if ctx.lang != "en":
        if ctx.fake:
            from . import story as _story
            done = _story.fake_translate([b["text"] for b in beats], ctx.lang)
        else:
            try:
                done = _translate_live([b["text"] for b in beats], ctx.lang)
            except Exception as e:
                raise StepError("story: live translation failed: %s" % e)
            if len(done) != len(beats) or not all(isinstance(t, str) for t in done):
                raise StepError("story: live translation returned %d items for %d beats" % (len(done), len(beats)))
        ru = [dict(b, text=t) for b, t in zip(beats, done)]
        (ctx.out / ("score.%s.json" % ctx.lang)).write_text(
            json.dumps({"beats": ru, "lang": ctx.lang}, ensure_ascii=False))
    return ESTIMATE["story"]


def _step_stage(ctx):
    score = json.loads(_score_path(ctx).read_text(encoding="utf-8"))
    ev = [{"t": b["i"] * 4.0, "kind": b["kind"], "text": b["text"]} for b in score["beats"]]
    (ctx.out / "events.json").write_text(json.dumps(ev, ensure_ascii=False))
    (ctx.out / "stage.json").write_text(json.dumps(
        {"score": "story/" + Path(_score_path(ctx)).name, "events": "events.json",
         "beats": len(ev), "lang": ctx.lang}, ensure_ascii=False))
    return 0.0


def _step_film(ctx):
    ev = json.loads((ctx.prev("stage") / "events.json").read_text(encoding="utf-8"))
    if ctx.fake:
        (ctx.out / "film.mp4").write_bytes(
            b"\x00\x00\x00\x20ftypisom\x00\x00\x00\x00FAKECHAIN:%d\n" % len(ev))
        (ctx.out / "critic.json").write_text(json.dumps({"events": len(ev), "verdict": "fake"}))
        return ESTIMATE["film"]
    (ctx.out / "film.mp4").write_bytes(
        b"\x00\x00\x00\x20ftypisom\x00\x00\x00\x00LIVECHAIN:%d\n" % len(ev))
    (ctx.out / "critic.json").write_text(
        json.dumps({"events": len(ev), "verdict": "live-stub", "lang": ctx.lang}))
    return ESTIMATE["film"]


BODIES = {"read": _step_read, "voices": _step_voices, "world": _step_world, "cast": _step_cast,
          "story": _step_story, "stage": _step_stage, "film": _step_film}


def _params(step, ctx):
    if step == "read":
        return {"text": hashlib.sha256(ctx.text.encode()).hexdigest(), "fake": ctx.fake}
    if step == "voices":
        return {"voices": hashlib.sha256(VOICES_PATH.read_bytes()).hexdigest()}
    if step == "world":
        return {"refs": _sha_dir(_refs_root(ctx))}
    if step == "cast":
        return {"cast": _sha_dir(ctx.cast_dir)}
    if step == "story":
        return {"lang": ctx.lang, "director": DIRECTOR_MODEL, "prompt": STAGING_PROMPT_VERSION}
    if step == "stage":
        return {"lang": ctx.lang}
    return {}


def run_book(text_path, out, *, lang="en", fake=True, max_dollars=12.0, live=False,
             cast_dir=None, steps=None):
    """-> {status: {step: ran|cached|failed}, failed: step|None, reason, usd}."""
    fake = True if not live else bool(fake)
    text_path, out = Path(text_path), Path(out)
    run = run_dir_for(out)
    run.mkdir(parents=True, exist_ok=True)
    mpath = run / "book_manifest.json"
    man = json.loads(mpath.read_text()) if mpath.is_file() else {"steps": {}}
    ctx = Ctx(run, None, text_path.read_text(encoding="utf-8"), text_path, lang, fake,
              Path(cast_dir) if cast_dir else None)
    bodies = dict(BODIES, **(steps or {}))
    status, failed, reason, prev_hash = {}, None, "", ""
    spent = 0.0  # this chain: cached steps' recorded cost + what ran now

    def fail(step, why):
        nonlocal failed, reason
        failed, reason = step, why

    for step in STEPS:
        if step == "world" and not (ctx.cast_dir and (ctx.cast_dir / "cast.json").is_file()):
            fail(step, "CAST_MISSING: cast.json not found in --cast-dir")
            break
        h = _sha([step, VERSION[step], _params(step, ctx), prev_hash])
        rec = man["steps"].get(step, {})
        if rec.get("hash") == h and (run / step).is_dir():
            try:
                _check_input(step, ctx)
            except StepError as e:
                status[step] = "failed"
                fail(step, "%s: %s" % (type(e).__name__, e))
                break
            status[step], prev_hash = "cached", h
            spent += float(rec.get("usd") or 0.0)
            if step == "film":
                src = run / "film" / "film.mp4"
                if src.is_file():
                    shutil.copy(src, out)
            continue
        if spent + ESTIMATE[step] > max_dollars:
            status[step] = "failed"
            fail(step, "budget: %.2f + %.2f exceeds --max-dollars %.2f" % (spent, ESTIMATE[step], max_dollars))
            break
        tmp = run / (step + ".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir()
        ctx.out = tmp
        try:
            _check_input(step, ctx)
            usd = float(bodies[step](ctx) or 0.0)
        except Exception as e:  # a failed step stops the chain with its reason
            shutil.rmtree(tmp, ignore_errors=True)
            status[step] = "failed"
            fail(step, "%s: %s" % (type(e).__name__, e))
            break
        spent += usd
        shutil.rmtree(run / step, ignore_errors=True)
        tmp.rename(run / step)
        man["steps"][step] = {"hash": h, "usd": usd}
        mpath.write_text(json.dumps(man, indent=2))
        status[step], prev_hash = "ran", h
        if step == "film":
            shutil.copy(run / "film" / "film.mp4", out)
    mpath.write_text(json.dumps(man, indent=2))
    return {"status": status, "failed": failed, "reason": reason, "usd": spent}


def main(argv=None):
    ap = argparse.ArgumentParser(prog="make.book")
    ap.add_argument("book")
    ap.add_argument("--out", required=True)
    ap.add_argument("--lang", default="en")
    ap.add_argument("--fake", action="store_true")
    ap.add_argument("--max-dollars", type=float, default=12.0)
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--cast-dir")
    a = ap.parse_args(argv)
    res = run_book(a.book, a.out, lang=a.lang, fake=a.fake or not a.live, max_dollars=a.max_dollars,
                   live=a.live, cast_dir=a.cast_dir)
    for s, v in res["status"].items():
        print("%s: %s" % (s, v))
    crit = run_dir_for(a.out) / "film" / "critic.json"
    if crit.is_file():
        print("critic:", crit.read_text())
    if res["failed"]:
        print("FAILED %s: %s" % (res["failed"], res["reason"]), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
