"""Stage `story`: brief -> story/score.json (book) or story/seed.txt (seed); sim hand-off."""
import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

DREAM = Path(__file__).resolve().parents[1] / "dream"


def _dream():
    if str(DREAM) not in sys.path:
        sys.path.insert(0, str(DREAM))


SPEAKING = ("line", "narration")


def fake_translate(texts, lang):
    """Offline stand-in for Spark (--fake): deterministic, no network."""
    return [f"[{lang}] {t}" for t in texts]


def _spark_translate(ctx):
    """texts, lang -> translated texts: one Spark call in JSON mode (pipe2)."""
    from . import core
    h0 = str(Path(__file__).resolve().parents[1])
    if h0 not in sys.path:
        sys.path.insert(0, h0)
    from pipe2.spark import Spark
    ledger = core.spark_ledger(ctx, 2)
    spark = Spark(core._spark_transport(), ledger)
    names = {"ru": "Russian"}

    def translate(texts, lang):
        msgs = [{"role": "system", "content": f"Translate each string of the JSON list into {names.get(lang, lang)}, "
                 "keep tone and speaker voice. Answer one JSON object {\"texts\": [...]} with the same length "
                 "and order."},
                {"role": "user", "content": json.dumps(texts, ensure_ascii=False)}]
        ans = spark.ask("story", "translate", 0, msgs, "medium")
        ctx.spend(ledger.spent)
        out = (ans.scene or {}).get("texts") if ans.valid and isinstance(ans.scene, dict) else None
        if not (isinstance(out, list) and len(out) == len(texts) and all(isinstance(t, str) for t in out)):
            raise ValueError("translate: Spark did not return a list of the same length")
        return out
    return translate


def _spark_director(ctx):
    """prompt -> JSON text of the staging: one Spark call (pipe2), same wiring as `_spark_translate`."""
    from . import core
    h0 = str(Path(__file__).resolve().parents[1])
    if h0 not in sys.path:
        sys.path.insert(0, h0)
    from pipe2.spark import Spark
    ledger = core.spark_ledger(ctx, 2)
    spark = Spark(core._spark_transport(), ledger)

    paid = [0.0]  # ledger.spent is cumulative: charge only the growth

    def director(prompt):
        msgs = [{"role": "system", "content": "You are a stage director. Answer one JSON object as the user's "
                 "instruction says; use only the given actor and place names."},
                {"role": "user", "content": prompt}]
        ans = spark.ask("story", "stage", 0, msgs, "medium")
        ctx.spend(ledger.spent - paid[0])
        paid[0] = ledger.spent
        return json.dumps(ans.scene, ensure_ascii=False) if ans.valid and isinstance(ans.scene, dict) else ""
    return director


def translate_score(ctx, score, lang):
    """score -> the same score with line/narration texts in `lang`. One call per scene; the answer is cached
    in story/tr-<sha256(texts + lang)>.json (copied over from the previous story, so a rebuild stays free)."""
    idx = [i for i, b in enumerate(score["beats"]) if b.get("kind") in SPEAKING and isinstance(b.get("text"), str)]
    texts = [score["beats"][i]["text"] for i in idx]
    key = hashlib.sha256(json.dumps({"texts": texts, "lang": lang}, ensure_ascii=False).encode()).hexdigest()
    name = f"tr-{key}.json"
    for d in (ctx.run_dir / "story", ctx.out):
        if (d / name).is_file():
            done = json.loads((d / name).read_text())
            break
    else:
        fn = fake_translate if ctx.params.get("fake") else _spark_translate(ctx)
        done = fn(texts, lang)
        if len(done) != len(texts):
            raise ValueError("translate: wrong number of texts")
    (ctx.out / name).write_text(json.dumps(done, ensure_ascii=False))
    beats = [dict(b) for b in score["beats"]]
    for i, t in zip(idx, done):
        beats[i]["text"] = t
    return dict(score, beats=beats)


def cast_clips(run_dir):
    """{actor: [clip names]} from the built cast (cast/cast.json), None when there is no cast yet: the staging
    director names the clip a beat plays (Koshakan meadow, Nov 3: text words never fired the run or the lap)."""
    p = Path(run_dir) / "cast" / "cast.json"
    try:
        cast = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    out = {n: sorted((c.get("clips") or {}).keys()) for n, c in cast.items() if isinstance(c, dict)}
    return {n: v for n, v in out.items() if v} or None


def run_story(ctx):
    brief = json.loads((ctx.run_dir / "brief" / "brief.json").read_text())
    if brief.get("mode") == "book" and brief.get("book"):
        _dream()
        import book as _book
        b = brief["book"]
        # B14: the place bank comes from the built world (story runs after `world`);
        # stage/places.json does not exist yet on a clean run
        places = None
        world_run = ctx.run_dir / "world" / "run"
        if (world_run / "dist" / "geometry.json").is_file():
            from . import stage as _stage
            places = _stage.build_places(world_run)
        director = None
        if ctx.params.get("fake"):
            director = lambda p: json.dumps({"start": [], "stage": []})
        else:
            director = _spark_director(ctx)
        # B51: the staging cache lives in ctx.out, so it is published with the story (run/story itself is
        # replaced by _publish); the previous story's answers are copied in, as the tone cache below.
        # A fake director's empty staging is never cached, so a live run cannot reuse it.
        cache = None
        if not ctx.params.get("fake"):
            cache = ctx.out
            for f in (ctx.run_dir / "story").glob("stage_*.json"):
                shutil.copyfile(f, ctx.out / f.name)
        clips = cast_clips(ctx.run_dir)
        score = _book.score_scene(b["dir"], b["scene"], places=places, director=director,
                                  cache_dir=cache, **({"clips": clips} if clips else {}))
        if places is None:
            score = dict(score, warnings=list(score.get("warnings") or [])
                         + ["story: no world, staging without places"])
        if not ctx.params.get("fake"):
            # each line's delivery for drama-3 (dream/voice_tone); the previous story's answer is reused
            import voice_tone as _tone
            for f in (ctx.run_dir / "story").glob("tone-*.json"):
                shutil.copyfile(f, ctx.out / f.name)
            score, tw = _tone.add_tones(score, director, cache_dir=str(ctx.out))
            if tw:
                score = dict(score, warnings=list(score.get("warnings") or []) + tw)
        edited = ctx.run_dir / "story" / "score.edited.json"
        if edited.is_file():
            ed = json.loads(edited.read_text())
            if ed.get("scene") != b["scene"]:
                raise ValueError(f"score.edited.json is for scene {ed.get('scene')!r}, "
                                 f"brief wants {b['scene']!r}")
            shutil.copyfile(edited, ctx.out / "score.edited.json")
            score = ed
        (ctx.out / "score.json").write_text(json.dumps(score, ensure_ascii=False, indent=2))
        lang = ctx.opts.get("lang")
        if lang and lang != "en":
            (ctx.out / "score.ru.json").write_text(
                json.dumps(translate_score(ctx, score, lang), ensure_ascii=False, indent=2))
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
    sj = {"dist": "world/run/dist", "places": "stage/places.json", "cast": "cast/cast.json", "moves": "shotplan/moves.json",
          "mode": brief.get("mode"), "book": None, "seed": None,
          "narrator_voice": None}
    if brief.get("mode") == "book" and brief.get("book"):
        b = brief["book"]
        sj["book"] = {"dir": b["dir"], "scene": b["scene"], "score": "story/score.json"}
        if ctx.opts.get("lang"):
            sj["lang"] = ctx.opts["lang"]
            sj["book"]["score"] = "story/score.ru.json"
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
        extra = _stage.write_stage(rd, ctx.out, brief=brief, lang=ctx.opts.get("lang") or "en")
        sj.update({k: extra[k] for k in ("objects", "voices", "start", "start_pose") if k in extra})
    (ctx.out / "stage.json").write_text(json.dumps(sj, ensure_ascii=False, indent=2))
    (ctx.out / "marker.txt").write_text(json.dumps({"start": time.time(), "end": time.time()}))
    return 0.0
