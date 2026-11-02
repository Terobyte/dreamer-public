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
    from pipe2.ledger import Ledger, load_prices
    from pipe2.spark import Spark
    ledger = Ledger(ctx.out / "events.jsonl", load_prices(), float("inf"), 2)
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
    from pipe2.ledger import Ledger, load_prices
    from pipe2.spark import Spark
    ledger = Ledger(ctx.out / "events.jsonl", load_prices(), float("inf"), 2)
    spark = Spark(core._spark_transport(), ledger)

    def director(prompt):
        msgs = [{"role": "system", "content": "You are a stage director. Answer one JSON object as the user's "
                 "instruction says; use only the given actor and place names."},
                {"role": "user", "content": prompt}]
        ans = spark.ask("story", "stage", 0, msgs, "medium")
        ctx.spend(ledger.spent)
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
        score = _book.score_scene(b["dir"], b["scene"], places=places, director=director,
                                  cache_dir=ctx.run_dir / "story")
        if places is None:
            score = dict(score, warnings=list(score.get("warnings") or [])
                         + ["story: no world, staging without places"])
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
    sj = {"dist": "world/run/dist", "places": "stage/places.json", "cast": "cast/cast.json",
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


def run_sim(stage_json, run=None, freestyle=False):
    """stage.json -> sim.run(...): freestyle is a play-time flag, not a stage.json field
    (older stage.json files may still carry it; the explicit argument wins)."""
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
    kw = {"freestyle": bool(freestyle or sj.get("freestyle"))}
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
