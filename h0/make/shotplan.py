"""Стадия shotplan: Spark выбирает на каждый бит приём камеры и субъекта -> shotplan/moves.json.
Точки камеры считает режиссёр рантайма по живым актёрам; здесь ни координат, ни комнат."""
import json
import subprocess
import sys
import time
from pathlib import Path

H0 = Path(__file__).resolve().parents[1]
ENGINE = H0.parent / "engine"
UNSUPPORTED = {"oner", "rhythm_cut", "open_from_light"}  # схемы, которые рантайм не исполняет
ROOM_MOVES = {"wide", "master", "establishing"}
DEFAULT_STYLE = "storybook"
SPEAKING = ("line", "dialogue")


def catalog():
    """Ответ моста `bin/moves.ts --catalog` (полоса A). Нет моста или упал -> исключение."""
    if not (ENGINE / "bin" / "moves.ts").is_file():
        raise FileNotFoundError("engine/bin/moves.ts")
    r = subprocess.run(["node", "--import", "tsx", "bin/moves.ts", "--catalog"], cwd=ENGINE,
                       capture_output=True, text=True, timeout=120, check=True)
    return json.loads(r.stdout)


def allowed(cat):
    """{id: смысл} только разрешённых приёмов."""
    out = {}
    for group in ("moves", "schemes", "records"):
        for k, v in (cat.get(group) or {}).items():
            if group == "schemes" and k in UNSUPPORTED:
                continue
            out[k] = v
    return out


def _load(run_dir, rel):
    return json.loads((Path(run_dir) / rel).read_text())


def _places(run_dir):
    p = _load(run_dir, "stage/places.json")
    return p.get("places", []) if isinstance(p, dict) else p


def _act(s):
    t = f"{s.get('who')}: {s.get('action')}"
    if s.get("place"):
        t += f" {s['place']}"
    if s.get("pose"):
        t += f", pose {s['pose']}"
    if s.get("look"):
        t += f", look {s['look']}"
    return t


def _changed(s, last):
    if s.get("action") in ("goto", "enter", "exit"):
        return True
    return bool(s.get("pose")) and last.get(s.get("who")) not in (None, s["pose"])


def prompt(run_dir, cat, style):
    score = _load(run_dir, "story/score.json")
    names = [p.get("name") for p in _places(run_dir)]
    ids = allowed(cat)
    last = {s["who"]: s.get("pose") for s in score.get("start") or [] if s.get("who")}
    L = ["You are the cinematographer of one short scene. For every beat choose ONE camera move "
         "from the list and the subject it films, or hold the previous plan.", ""]
    L.append("Actors: " + ", ".join(score.get("cast") or []))
    L.append("Places: " + ", ".join(n for n in names if n))
    L.append("Start: " + "; ".join(f"{s['who']}: {s.get('place')}, {s.get('pose')}"
                                    for s in score.get("start") or []))
    L += ["", "Beats:"]
    for i, b in enumerate(score["beats"]):
        who = f" {b['who']}" if b.get("kind") in SPEAKING and b.get("who") else ""
        row = f"Beat {i} [{b.get('kind')}]{who}: {b.get('text', '')}"
        stage = b.get("stage") or []
        if stage:
            row += " | " + "; ".join(_act(s) for s in stage)
        if any(_changed(s, last) for s in stage):
            row += " | CHANGE (СМЕНА МИЗАНСЦЕНЫ)"
        for s in stage:
            if s.get("pose"):
                last[s["who"]] = s["pose"]
        L.append(row)
    L += ["", "Allowed move ids:"] + [f"- {k}: {v}" for k, v in ids.items()]
    w = (cat.get("weights") or {}).get(style) or {}
    L += ["", f"Scene style: {style}", "Style weights (higher = used more often): "
          + ", ".join(f"{k}={v}" for k, v in w.items() if k in ids)]
    L += ["", "Rules:",
          "- A beat that changes the staging (goto, enter, exit, or a new pose) is filmed with the actor "
          "who enters that change as the subject.",
          "- Subject is {\"actor\": name}, {\"pair\": [name, name]} (two different) or {\"room\": true}; "
          "room only for wide, master, establishing.",
          "- A beat may be skipped (the director chooses) or {\"hold\": true} (never on beat 0).",
          "", "Answer one JSON object:",
          '{"style": "<optional style id>", "beats": [{"beat": 2, "move": "<id>", "subject": {"actor": "Mama"}}, '
          '{"beat": 3, "hold": true}]}']
    return "\n".join(L)


def _subject_ok(s, move, cast):
    if not isinstance(s, dict):
        return False
    if set(s) == {"actor"}:
        return isinstance(s["actor"], str) and s["actor"] in cast
    if set(s) == {"pair"}:
        p = s["pair"]
        return (isinstance(p, list) and len(p) == 2 and all(isinstance(n, str) and n in cast for n in p)
                and p[0] != p[1])
    if set(s) == {"room"}:
        return s["room"] is True and move in ROOM_MOVES
    return False


def parse(scene, cat, score):
    """-> (план | None, предупреждения). None: ответ непригоден, в предупреждениях текст ошибки."""
    if not isinstance(scene, dict):
        return None, ["answer is not a JSON object"]
    if not isinstance(scene.get("beats"), list):
        return None, ["'beats' is not a list"]
    ids, cast, n = allowed(cat), set(score.get("cast") or []), len(score["beats"])
    beats, warns, seen = {}, [], set()
    for el in scene["beats"]:
        i = el.get("beat") if isinstance(el, dict) else None
        if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < n or i in seen:
            warns.append(f"BEAT_INVALID B{i if isinstance(i, (int, str)) else '?'}")
            continue
        seen.add(i)
        if el.get("hold") is True:
            if i == 0:
                warns.append("HOLD_FIRST")
            else:
                beats[str(i)] = {"hold": True}
            continue
        mv = el.get("move")
        if not isinstance(mv, str) or mv not in ids:
            warns.append(f"MOVE_UNKNOWN B{i} {mv}")
            continue
        if not _subject_ok(el.get("subject"), mv, cast):
            warns.append(f"SUBJECT_INVALID B{i}")
            continue
        beats[str(i)] = {"move": mv, "subject": el["subject"]}
    return {"style": scene.get("style"), "beats": beats}, warns


def _make_spark(ctx):
    from . import core
    if str(H0) not in sys.path:
        sys.path.insert(0, str(H0))
    from pipe2.ledger import Ledger, load_prices
    from pipe2.spark import Spark
    ledger = Ledger(ctx.out / "events.jsonl", load_prices(), float("inf"), 2)
    return Spark(core._spark_transport(), ledger), ledger


def _style(want, answered, cat, warns):
    known = (cat or {}).get("styles") or []
    pick = want or answered
    if not pick:
        return DEFAULT_STYLE
    if cat is None or pick in known:
        return pick
    warns.append(f"STYLE_UNKNOWN {pick}")
    return DEFAULT_STYLE


def _write(ctx, scene, style, beats, warns):
    body = {"version": 1, "scene": scene, "style": style, "beats": beats, "warnings": warns}
    (ctx.out / "moves.json").write_text(json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False) + "\n")


def _note(ctx, warns):
    if warns:
        (ctx.out / "warnings.json").write_text(json.dumps(warns, ensure_ascii=False, indent=2) + "\n")
        for w in warns:
            print(f"shotplan: {w}", flush=True)


def run_shotplan(ctx):
    want = ctx.opts.get("camera_style")
    fake = bool(ctx.params.get("fake") or ctx.opts.get("fake"))
    try:
        score = _load(ctx.run_dir, "story/score.json")
    except (OSError, ValueError):
        score = None
    warns = []
    try:
        cat = catalog()
    except Exception as e:  # нет моста / упал: стадия ok без файла
        cat = None
        if not fake:
            _note(ctx, [f"SHOTPLAN_NO_CATALOG {e}"])
    if fake:
        w = []
        _write(ctx, (score or {}).get("scene"), _style(want, None, cat, w), {}, w)
    elif cat is not None and score is not None:
        _ask(ctx, score, cat, want)
    _done(ctx)
    return 0.0


def _done(ctx):
    (ctx.out / "marker.txt").write_text(json.dumps({"start": time.time(), "end": time.time()}))


def _ask(ctx, score, cat, want):
    spark, ledger = _make_spark(ctx)
    style0 = want if want in (cat.get("styles") or []) else DEFAULT_STYLE
    base = prompt(ctx.run_dir, cat, style0)
    msgs = [{"role": "system", "content": "You are a cinematographer. Answer one JSON object as the "
             "user's instruction says; use only the given ids and names."},
            {"role": "user", "content": base}]
    plan = None
    try:
        for attempt in range(2):
            ans = spark.ask("shotplan", "moves", attempt, msgs, "high")
            plan, warns = parse(ans.scene if ans.valid else None, cat, score)
            if plan is not None:
                break
            msgs = msgs[:1] + [{"role": "user", "content": base + "\n\nYour previous answer was rejected: "
                                + warns[0] + ". Answer again, one valid JSON object."}]
    finally:
        ctx.spend(ledger.spent)
    if plan is None:
        _note(ctx, ["SHOTPLAN_INVALID " + warns[0]])
        return
    style = _style(want, plan["style"], cat, warns)
    _write(ctx, score.get("scene"), style, plan["beats"], warns)
    _note(ctx, [])
