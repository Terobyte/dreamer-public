"""make play: stage/stage.json -> sim.run(...) on the engine page's world; `duo.py` is not used.

  cd h0 && python3 -m make.play runs/<id> [--freestyle] [--fake] [--port N]

mode book: the book plan with the world's places as the scene's objects; mode seed: the director
builds the first scene out of one line, its objects replaced by the places. One world: no_build.
--fake: no network, no keys; the dialogue and the director are scripted.
"""
import argparse
import copy
import functools
import http.server
import json
import random
import sys
import threading
from pathlib import Path

DREAM = Path(__file__).resolve().parents[1] / "dream"
EXPECT = Path(__file__).resolve().parent / "testdata" / "expect_touch.json"


def _dream():
    if str(DREAM) not in sys.path:
        sys.path.insert(0, str(DREAM))


def static_url(run_dir, static_port, sim_port):
    return (f"http://127.0.0.1:{static_port}/world/run/dist/index.html"
            f"?sim=http://127.0.0.1:{sim_port}&stage=../../../stage/stage.json")


def serve_static(run_dir, port=0):
    """stdlib http.server over runs/<id>/ in a daemon thread -> (server, port)."""
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(run_dir))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _fake_remark():
    """book --fake: the narrator's remark of expect_touch case 3 opens the scene."""
    for c in json.loads(EXPECT.read_text())["cases"]:
        if c.get("narrator"):
            return c["narrator"]
    return None


def _fake_touch_reply():
    """seed --fake: dialogue reply carrying the fixture's scripted touch tag."""
    for c in json.loads(EXPECT.read_text())["cases"]:
        line = c.get("line") or ""
        if "[[TOUCH:" in line and c.get("place"):
            return f"[warm] Let us look at the {c['place']}. {line}"
    return '[warm] Let us look at the armchair. [[TOUCH:armchair]]'


def _seed_reply(objects):
    return json.dumps({
        "destination": "a small house",
        "why": "they were told to wait here",
        "next_scene": {
            "objects": list(objects) or ["armchair"],
            "actors": [{"name": "Stranger", "voice": "man", "persona": "wants to know who lives here"}],
            "events": [{"t": 0, "what": "the door shuts behind them", "who": "all", "kind": "world"}],
            "goals": [],
            "hero_reason": "you came in out of the rain",
        },
    })


def _wait_for_viewer(timeout):
    def on_sim(sim):
        v = getattr(sim, 'viewer', None)
        if v is not None and not v.wait_client(timeout):
            print(f'WARN no viewer after {timeout:g}s, starting anyway', flush=True)
    return on_sim


def play(run_dir, fake=False, freestyle=None, serve=None, max_seconds=None, run=None,
         wait_viewer=False, wait_timeout=120, lang="en"):
    """-> (outdir, log.jsonl path) as sim.run. `serve`: port (0 = any) for the sim's SSE server."""
    run_dir = Path(run_dir)
    sj = json.loads((run_dir / "stage" / "stage.json").read_text())
    freestyle = bool(sj.get("freestyle")) if freestyle is None else freestyle
    _dream()
    import sim
    from dialogue import Dialogue
    from fake import FakeTransport
    from voice import Voice, load_pool  # no network at import; Fish is only called by Voice.say
    objects = list(sj.get("objects") or [])
    run = run or sim.run
    media, kw = None, {}
    if not fake:
        media = {"voice": Voice(pool={**load_pool(), **(sj.get("voices") or {})})}
    dlg = None
    if fake:
        touch = _fake_touch_reply()
        dlg = Dialogue(sim.load_profile(None), transport=FakeTransport(reply=lambda *a: touch),
                       rng=random.Random(0))
        dlg.background = False
        kw.update(speed=100.0, max_transitions=2, max_seconds=max_seconds or 1.6)  # 160 sim-seconds
    elif max_seconds:
        kw["max_seconds"] = max_seconds
    if wait_viewer and serve is not None and not fake:
        kw["on_sim"] = _wait_for_viewer(wait_timeout)
    if sj["mode"] == "book":
        b = sj["book"]
        if lang == "ru":
            score_p = run_dir / "story" / "score.ru.json"
            if not score_p.is_file():
                raise FileNotFoundError(f"{score_p}: run `make --lang ru` first")
        else:
            score_p = run_dir / "story" / "score.json"
            if not score_p.is_file():
                raise FileNotFoundError(f"{score_p}: the story stage left no score")
        score = json.loads(score_p.read_text())
        plan = sim._load_book_plan(b["dir"], [b["scene"]], score)
        for sc in plan["scenes"]:
            sc["dict"]["objects"] = list(objects)
        if sj.get("narrator_voice"):
            plan["narrator_voice"] = sj["narrator_voice"]
        if fake and _fake_remark():
            plan["scenes"][0]["beats"] = [{"kind": "narration", "who": None, "text": _fake_remark()}] \
                + list(plan["scenes"][0]["beats"])
        return run(plan=plan, book=b["dir"], scenes=[b["scene"]], score=score, profile=None,
                   label="make_book", freestyle=freestyle, media=media, serve=serve, no_build=True,
                   fake=fake, dialogue=dlg, **kw)
    transport = FakeTransport([_seed_reply(objects)]) if fake else sim.SEED_TRANSPORT
    scene, first = sim.seed_start(sj["seed"], transport, objects)
    return run(profile=None, label="make_seed", first_events=first, dialogue=dlg or Dialogue(sim.load_profile(None)),
               media=media, serve=serve, no_build=True, fake=fake, **kw)


def _hold():
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


def main(argv=None, hold=_hold):
    ap = argparse.ArgumentParser(prog="make.play")
    ap.add_argument("run")
    ap.add_argument("--fake", action="store_true")
    ap.add_argument("--freestyle", action="store_true")
    ap.add_argument("--port", type=int, default=0, help="sim SSE port (0 = any)")
    ap.add_argument("--static-port", type=int, default=0)
    ap.add_argument("--wait-viewer", dest="wait_viewer", action="store_true", default=None,
                    help="start the sim when a page connects (default on unless --fake)")
    ap.add_argument("--no-wait-viewer", dest="wait_viewer", action="store_false")
    ap.add_argument("--lang", choices=["en", "ru"], default="en", help="ru: play story/score.ru.json")
    a = ap.parse_args(argv)
    wait = (not a.fake) if a.wait_viewer is None else (a.wait_viewer and not a.fake)
    srv = None
    sim_port = a.port
    if not a.fake:
        srv, sp = serve_static(a.run, a.static_port)
        print(static_url(a.run, sp, sim_port or 8770), flush=True)
    try:
        out, log = play(a.run, fake=a.fake, freestyle=a.freestyle or None,
                        serve=None if a.fake else (sim_port or 8770), wait_viewer=wait,
                        **({"lang": a.lang} if a.lang != "en" else {}))
        print(log)
        if wait:
            hold()
    finally:
        if srv:
            srv.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
