"""Real-time dream loop: scene + build FSM + async director + jsonl log (spec 4-6, 8, 10).
usage: cd h0/dream && python3 sim.py --profile A --fake --speed 20 --max-transitions 2
"""

import argparse
import json
import os
import random
import sys
import time
import re
import tempfile
import threading
import math

from clock import Clock
from director import Director
from fsm import BuildFSM
from inputs import sanitize
from memory import Memory
from fake import FakeTransport
try:
    from llm import get_spent, IMAGE_PER_PIC
except ImportError:
    from .llm import get_spent, IMAGE_PER_PIC
try:
    from images import background_prompt, portrait_prompt
except ImportError:
    from .images import background_prompt, portrait_prompt

VOICES = {"old_woman", "old_man", "woman", "man", "child", "creature"}

def _load_start():
    """scenes/start.json is the opening scene (spec 9): place, objects, actors
    with their voices. The sim, the background prompt and TTS all read it."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scenes", "start.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


START = _load_start()
START_SCENE = {
    "objects": list(START["objects"]),
    "actors": [a["name"] for a in START["actors"]],
}
START_VOICES = {a["name"]: a.get("voice") for a in START["actors"]}
HOOK_INDEX = {"A": 0, "B": 3, "C": 5}
START_PLACE = START["place"]


def load_profile(pid):
    """Profile soul file (spec 2): hero name and hero voice for playback."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles",
                        str(pid) + ".json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _gen_next_scene(n):
    return {"actors": [{"name": "Visitor%d" % n, "voice": "old_woman"}],
            "objects": ["item%d_%d" % (n, i) for i in range(5)]}


def _scripted_decisions(profile, n):
    """One decision per transition; each bridge comes from the scene active at
    that point (R6) -- the first one is read out of START_SCENE itself, not a
    separately maintained string, so it can't drift out of sync with it."""
    decisions = []
    bridge = START_SCENE["objects"][HOOK_INDEX.get(profile, 0)]
    for i in range(n):
        ns = _gen_next_scene(i)
        decisions.append({
            "bridge": bridge, "destination": "place %d" % i, "why": "soul reason",
            "hero_next": {"changes": False}, "messages": [], "next_scene": ns,
            "facts_update": [], "abort_build": None, "wake_up": None,
        })
        bridge = ns["objects"][0]
    return decisions


def line_duration(text, audio_seconds=None):
    """Unscaled playback slot; media can supply its measured duration later."""
    if audio_seconds is not None:
        if not math.isfinite(audio_seconds) or audio_seconds < 0:
            raise ValueError("audio duration must be finite and nonnegative")
        return audio_seconds + 0.4
    try:
        from voice import strip_tags
    except ImportError:
        from .voice import strip_tags
    spoken = strip_tags(text)
    return len(spoken.split()) / 2.5 + 1.0


class Logger:
    def __init__(self, path):
        self.path = path
        self.seq = 0
        self._lock = threading.Lock()

    def write_event(self, ev):
        with self._lock:
            return self._write_event(ev)

    def _write_event(self, ev):
        self.seq += 1
        row = {"seq": self.seq, "t": ev.get("t", 0.0), "type": ev["type"]}
        row.update({k: v for k, v in ev.items() if k not in ("seq", "t", "type")})
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        return row


class Sim:
    """Minimal real-time loop driving BuildFSM + async Director on fakes (spec 4-6, 10)."""

    def __init__(self, profile="A", fake=True, speed=1.0, outdir=None, script=None,
                 delay=0.0, fsm_params=None, memory=None, media=None,
                 max_dollars=20.0):
        self.profile = profile
        self.speed = speed
        self.fake = fake
        self.max_dollars = float(max_dollars)
        self.media = media or {}
        self._voice = self.media.get("voice")
        self._images = self.media.get("images")
        self._audio_dir = self._image_dir = None
        self._image_threads = []
        self._line_seq = 0
        self._bg_seq = 0
        self._portrait_seq = 0
        self._bg_done = set()
        self._portraits = set()
        self._hero_desc = ""
        self._actor_voices = dict(START_VOICES)
        self._reserved = 0.0
        self._reserve_lock = threading.Lock()
        prof = load_profile(profile)
        self.hero = prof.get("hero") or "the hero"
        self.hero_voice = prof.get("hero_voice") or "child"
        self.budget_wake = False
        self.clock = Clock(speed=speed)
        self.scene = dict(START_SCENE)
        self.actors = list(self.scene["actors"])
        self.fsm = BuildFSM(self.scene["objects"], voices=VOICES, speed=speed,
                             now=self.clock.now(), params=fsm_params,
                             actors=list(self.actors))
        self.script = script if script is not None else _scripted_decisions(profile, 8)
        self.outdir = outdir
        if outdir:
            os.makedirs(outdir, exist_ok=True)
            self._audio_dir = os.path.join(outdir, "audio")
            self._image_dir = os.path.join(outdir, "images")
            os.makedirs(self._audio_dir, exist_ok=True)
            os.makedirs(self._image_dir, exist_ok=True)
        self.logger = Logger(os.path.join(outdir, "log.jsonl")) if outdir else None
        self._storage = tempfile.TemporaryDirectory() if not outdir and memory is None else None
        self.memory = memory if memory is not None else Memory(
            os.path.join(outdir or self._storage.name, "memory"),
            transport=FakeTransport(["WHAT HAPPENED: simulated dialogue\n"
                                     "HERO WANTED: continue the dream\n"
                                     "HERO REACTION: listened\n"
                                     "BRIDGE AND WHY: scripted transition"]) if fake else None,
            event_sink=self._diagnostic)
        self.memory.set_scene("start", self.scene["objects"])
        self.director = Director(self.fsm, memory=self.memory, actors=self.actors,
                                 delay=delay, speed=speed, script=self.script,
                                 outdir=outdir, clock=self.clock, fake=fake)
        self.n_transitions = 0
        self.playing = False
        self.active_line = None
        self.next_line = None
        self.prepared_npc = None
        self._prepared_audio_seconds = None
        self.line_count = 0
        self.hero_next = None
        self._line_started_at = None
        self._line_duration = None
        self._last_line_gen = -1e9
        if self.logger:
            self.logger.write_event({"t": self.clock.now(), "type": "snapshot",
                                     "scene": list(self.scene["objects"]),
                                     "actors": list(self.scene["actors"])})

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        """Finish owned workers before releasing temporary memory files."""
        self.director.wait(timeout=None)
        self.memory.wait()
        self.wait_images()
        self._drain_director()
        if self._storage is not None:
            self._storage.cleanup()
            self._storage = None

    # --- turn management (human replaces npc, spec 5a) ---------------------
    def _count_line(self):
        self.line_count += 1
        if (self.line_count % 4 == 0 and not self.director.in_flight
                and (self.fake or self._budget_ok())):
            self.director.consult_async(self.clock.now())

    def _budget_ok(self):
        """Spec 13: --max-dollars holds spending, it does not just notice an
        overrun afterwards. The first refusal wakes the hero once, so the dream
        ends inside the budget instead of finishing paid work beyond it."""
        with self._reserve_lock:
            committed = get_spent() + self._reserved
        # room for at least one more paid unit, counting images still in flight
        if committed + IMAGE_PER_PIC <= self.max_dollars + 1e-9:
            return True
        if not self.budget_wake:
            self.budget_wake = True
            for e in self.fsm.budget_wakeup(self.clock.now()):
                self._emit(e)
        return False

    def _diagnostic(self, event):
        if self.logger:
            self.logger.write_event({"t": self.clock.now(), **event})

    def wait_images(self):
        """Join background image workers (spec 9: logged files exist on exit)."""
        for th in list(self._image_threads):
            th.join()
        self._image_threads = []

    def _emit(self, event):
        self._diagnostic(event)
        self.memory.add_event(event)

    def _start_line(self, line, audio_seconds=None):
        """The only playback entry point: timing, journal and memory agree."""
        res = None
        if (self._voice is not None and self.logger is not None and not self.fake
                and self._budget_ok()):
            self._line_seq += 1
            voice_label = line.get("voice")
            if not voice_label:
                if line["owner"] == "human":
                    voice_label = self.hero_voice
                else:
                    actor_name = line.get("actor") or (self.actors[0] if self.actors else None)
                    voice_label = self._actor_voices.get(actor_name) or "man"
            path = os.path.join(self._audio_dir, "line_%03d.wav" % self._line_seq)
            res = self._voice.synthesize(line["text"], voice_label, path)
            if res["ok"]:
                audio_seconds = res["seconds"]
                line = dict(line, audio=res.get("audio"), dur=res["pause"])
            else:
                audio_seconds = None
                line = dict(line, audio=None, dur=res["pause"])
        duration = self.clock.scale(line_duration(line["text"], audio_seconds))
        self.active_line = line
        self.playing = True
        self._line_started_at = self.clock.now()
        self._line_duration = duration
        event = {"type": "line", "turn_owner": line["owner"], "text": line["text"]}
        if res is not None and line.get("dur") is not None:
            event["dur"] = line["dur"]
            if line.get("audio"):
                event["audio"] = os.path.relpath(line["audio"], self.outdir)
            else:
                event["silent"] = True
        if res is not None and not res["ok"]:
            self._diagnostic({"type": "tts_fail", "error": res["error"]["error"]})
        self._emit(event)
        # Speech input is remembered on arrival, including while it is queued.
        if line["owner"] == "npc":
            self.memory.add_line("npc", line["text"])
        self._count_line()
        return event

    def npc_start(self, line, audio_seconds=None):
        """Start an NPC line only when no human turn is waiting."""
        if self.active_line is None and self.next_line is None:
            event = self._start_line({"owner": "npc", "text": line}, audio_seconds)
        elif self.next_line is None:
            self.prepared_npc = line
            self._prepared_audio_seconds = audio_seconds
            event = {"type": "line_prepared", "turn_owner": "npc", "text": line}
            self._emit(event)
        else:
            # A generated NPC reply cannot reclaim a turn reserved by the human.
            event = {"type": "line_discarded", "turn_owner": "npc", "text": line}
            self._emit(event)
        return [event]

    def human_say(self, text):
        clean, ev = sanitize(text, "human")
        out = list(ev)
        if self.prepared_npc is not None:
            out.append({"type": "turn_replace", "turn_owner": "human", "text": clean,
                        "replaced": self.prepared_npc})
            self.prepared_npc = None
            self._prepared_audio_seconds = None
        out.append({"type": "line_queued", "turn_owner": "human", "text": clean})
        input_ev = {"type": "input", "source": "speech", "value": clean}
        out.append(input_ev)
        self.next_line = {"owner": "human", "text": clean}
        self.memory.add_line("human", clean)
        for e in out:
            self._emit(e)
        self.director.consult_async(self.clock.now(), events=[input_ev])
        return out

    def _rel(self, path):
        """Log paths relative to outdir, like line audio does."""
        if path and self.outdir:
            try:
                return os.path.relpath(path, self.outdir)
            except ValueError:
                return path
        return path

    def _gen_image(self, kind, prompt, path, name):
        """Images.generate takes the place/character its fallback must carry
        (spec 9); a stand-in without that parameter is called without it."""
        fn = self._images.generate
        names = getattr(getattr(fn, "__code__", None), "co_varnames", ())
        if "name" in names:
            return fn(kind, prompt, path, fallback=None, name=name)
        return fn(kind, prompt, path, fallback=None)

    def _start_image(self, kind, prompt, path, name, who=None):
        """Spec 9: the dream never waits on a picture. Generate in a worker
        (Images caps parallelism at 2) and log the event only once the file is
        on disk; close() finishes the workers we own."""
        img_start = self.clock.now()
        with self._reserve_lock:
            self._reserved += IMAGE_PER_PIC

        def work():
            try:
                img = self._gen_image(kind, prompt, path, name)
            finally:
                with self._reserve_lock:
                    self._reserved -= IMAGE_PER_PIC
            ev = {"t": img_start, "type": "image", "kind": kind,
                  "path": self._rel(img["path"]),
                  "dur": self.clock.now() - img_start}
            if who:
                ev["who"] = who
            if not img["ok"]:
                ev["fallback"] = self._rel(img.get("fallback") or img["path"])
            self.logger.write_event(ev)

        th = threading.Thread(target=work, daemon=True)
        self._image_threads.append(th)
        th.start()

    def _media_live(self):
        return self._images is not None and not self.fake and self.logger is not None

    def _start_background_image(self, place):
        path = os.path.join(self._image_dir, "scene_%d.png" % self._bg_seq)
        self._bg_seq += 1
        desc = place
        if place == START_PLACE:
            desc = "%s with %s" % (place, ", ".join(START["objects"]))
        self._start_image("background", background_prompt(desc), path, place)

    def _request_background(self, place):
        """One background per place: the build start asks first (spec 9), so the
        picture is ready by the transition; the transition only fills in when no
        build announced the place."""
        if place in self._bg_done or not self._budget_ok():
            return False
        self._bg_done.add(place)
        self._start_background_image(place)
        return True

    def _maybe_start_scene_background(self):
        """Spec 9: the opening scene has a background from the start, and the
        destination's background is requested when the build begins, not after
        the hero has already arrived."""
        if not self._media_live():
            return
        self._request_background(self.fsm.destination or START_PLACE)
        if self.n_transitions == 0:
            self._start_scene_portraits()

    def _start_portrait(self, who, prev="", name=None):
        """Spec 9 R2-R3: a new actor and a changed hero get a portrait; prev is
        the hero's previous look so he stays recognizable."""
        if not self._budget_ok():
            return False
        self._portrait_seq += 1
        path = os.path.join(self._image_dir, "portrait_%03d.png" % self._portrait_seq)
        self._start_image("portrait", portrait_prompt(who, prev), path, name or who,
                          who=self.hero if name else who)
        return True

    def _start_scene_portraits(self):
        """Hero and actors on stage are introduced once each; a changed hero
        (hero_next.changes) is redrawn from the new look, the old look is only a
        reference, and he speaks with the new voice from then on."""
        hn = self.hero_next if isinstance(self.hero_next, dict) else {}
        if (self.hero not in self._portraits and not hn.get("changes")
                and self._start_portrait(self.hero)):
            self._portraits.add(self.hero)
        for name in self.actors:
            if name not in self._portraits and self._start_portrait(name):
                self._portraits.add(name)
        if hn.get("changes"):
            self._portraits.add(self.hero)
            new_desc = hn.get("description") or self._hero_desc
            prev = self._hero_desc or self.hero
            who = "%s, %s" % (self.hero, new_desc) if new_desc else self.hero
            self._start_portrait(who, prev, name=who)
            self._hero_desc = new_desc
            if hn.get("voice"):
                self.hero_voice = hn["voice"]

    # --- scene transition ---------------------------------------------------
    def _apply_transition(self):
        self.n_transitions += 1
        ns = self.fsm.next_scene
        self.hero_next = self.fsm.hero_next
        if ns:
            self.scene = {"objects": list(ns["objects"]), "actors": list(ns["actors"])}
            self.actors = [a["name"] for a in ns["actors"] if isinstance(a, dict)]
            self._actor_voices = {a["name"]: a.get("voice") for a in ns["actors"]
                                  if isinstance(a, dict)}
            self.director.actors = self.actors
            self.memory.set_scene(self.fsm.destination or "scene %d" % self.n_transitions,
                                  self.scene["objects"])
            self.memory.select_facts_background()
            self.memory.merge_background()
            if self._media_live():
                self._request_background(self.fsm.destination or "next place")
                self._start_scene_portraits()
            for e in self.fsm.new_scene(self.clock.now(), self.scene["objects"],
                                        actors=self.actors):
                if self.logger:
                    self.logger.write_event(e)
            if self.logger:
                self.logger.write_event({"t": self.clock.now(), "type": "snapshot",
                                         "scene": list(self.scene["objects"]),
                                         "actors": list(self.scene["actors"])})

    # --- main loop -----------------------------------------------------------
    def _drain_director(self):
        events = self.director.drain_events()
        for e in events:
            self._emit(e)
        return events

    def _cycle_line(self):
        """End the active line after its slot, then start the queued one: the human's
        line first (it already replaced the prepared NPC line), else the prepared NPC
        line (spec 5a turn order). A queued line also starts when nothing is playing."""
        now = self.clock.now()
        if self.active_line is not None:
            if self._line_started_at is not None and now - self._line_started_at < self._line_duration:
                return
            self.active_line = None
        queued = None
        audio_seconds = None
        if self.next_line is not None:
            queued, self.next_line = self.next_line, None
        elif self.prepared_npc is not None:
            queued = {"owner": "npc", "text": self.prepared_npc}
            self.prepared_npc = None
            audio_seconds, self._prepared_audio_seconds = self._prepared_audio_seconds, None
        if queued is not None:
            self._start_line(queued, audio_seconds)
        else:
            self.playing = False
            self._line_started_at = self._line_duration = None

    def _maybe_generate_line(self):
        """Keep NPC dialogue flowing so every 4th line triggers a consult (F5/F20)."""
        now = self.clock.now()
        if (self.active_line is None and self.next_line is None
                and self.prepared_npc is None
                and now - self._last_line_gen >= self.clock.scale(1.0)):
            self._last_line_gen = now
            self.npc_start("npc line %d" % (self.line_count + 1))

    def _tick(self):
        now = self.clock.now()
        self._maybe_start_scene_background()
        self._cycle_line()
        events = self.fsm.tick(now)
        for e in events:
            self._emit(e)
            if e["type"] == "transition":
                self._apply_transition()
        self._drain_director()
        return events

    def _maybe_consult(self, last_consult):
        """Due events (nudge/force/abort) or an idle consult every min_interval: only idle
        picks a bridge (R6). Locked builds still hear from the director via the 4-line rhythm."""
        now = self.clock.now()
        if self.director.in_flight:
            return last_consult
        if not self.fake and not self._budget_ok():
            return last_consult
        due = self.fsm.due(now)
        if due or (self.fsm.state == "idle" and now - last_consult > self.fsm.p["min_interval"]):
            self.director.consult_async(now)
            return now
        return last_consult

    def run(self, max_transitions=2, max_seconds=90.0):
        start = self.clock.now()
        last_consult = -1e9
        last_cost = -1e9
        while self.n_transitions < max_transitions and self.clock.now() - start < max_seconds:
            self._tick()
            if self.n_transitions >= max_transitions or self.clock.now() - start >= max_seconds:
                break
            if not self._budget_ok():
                break
            if self.clock.now() - last_cost >= self.clock.scale(60.0):
                last_cost = self.clock.now()
                if self.logger:
                    self.logger.write_event({"t": self.clock.now(), "type": "cost",
                                             "dollars": get_spent(),
                                             "max_dollars": self.max_dollars})
            self._maybe_generate_line()
            last_consult = self._maybe_consult(last_consult)
            self.clock.real_sleep(0.01)
        self.director.wait(timeout=max(5.0, self.director.delay + 2.0))
        self._drain_director()
        self.memory.wait(timeout=5.0)
        # spec 13: the last cost row comes after every worker that can still charge
        self.wait_images()
        if self.logger:
            self.logger.write_event({"t": self.clock.now(), "type": "cost",
                                     "dollars": get_spent(),
                                     "max_dollars": self.max_dollars})
        return self.n_transitions


def run(profile="A", fake=True, speed=1.0, max_transitions=2, seed=0, max_seconds=90.0,
        media=None, max_dollars=20.0):
    random.seed(seed)
    base = os.path.join(os.path.dirname(__file__), "..", "out", "dream", profile)
    os.makedirs(base, exist_ok=True)
    outdir = os.path.join(base, "run_%d_%d" % (seed, int(time.time() * 1000) % 1000000))
    os.makedirs(outdir, exist_ok=True)
    if max_seconds == 90.0 and max_transitions > 0:
        # one full build alone takes 420/speed sim-seconds (spec 5); fake or
        # live, the run must at least outlive it plus line playback.
        max_seconds = max(max_seconds, 420.0 / max(speed, 0.01) + 120.0)
    with Sim(profile=profile, fake=fake, speed=speed, outdir=outdir, media=media,
             max_dollars=max_dollars) as sim:
        sim.run(max_transitions=max_transitions, max_seconds=max_seconds)
    return outdir, os.path.join(outdir, "log.jsonl")


def run_stress(delay=8.0, speed=20.0, seed=0, max_seconds=12.0):
    """Slow fake director in a fast world + random TOUCH: races consult_stale (spec 5)."""
    random.seed(seed)
    rep = {"consult_stale": 0, "bridge_changes_in_building": 0, "exceptions": 0}
    small = {"build": 40, "ladder": (0, 10, 20, 30), "l4": 2, "auto_touch": 4,
             "nudge": 10, "force": 20, "cooldown": 5, "min_interval": 1}
    sim = None
    try:
        sim = Sim(profile="A", fake=True, speed=speed, delay=delay,
                  script=_scripted_decisions("A", 20), fsm_params=small)
        # start mid-build right away: a slow director consult must race a
        # live build/ready/transition, not spend its whole delay on idle.
        sim.fsm.start_build(sim.clock.now(), sim.fsm.objects[0], "stress")
        orig_finish = sim.fsm.finish_consult

        def tracking_finish(now, ticket, decision):
            evs = orig_finish(now, ticket, decision)
            for e in evs:
                if e["type"] == "consult_stale":
                    rep["consult_stale"] += 1
            return evs
        sim.fsm.finish_consult = tracking_finish

        start = sim.clock.now()
        last_consult = -1e9
        building_bridge = None
        while sim.clock.now() - start < max_seconds:
            for e in sim._tick():
                pass
            if sim.fsm.state == "building":
                if building_bridge is None:
                    building_bridge = sim.fsm.bridge
                elif sim.fsm.bridge != building_bridge:
                    rep["bridge_changes_in_building"] += 1
            else:
                building_bridge = None
            if sim.fsm.objects and random.random() < 0.3:
                sim.fsm.touch(sim.clock.now(), random.choice(sim.fsm.objects))
            # unlike Sim._maybe_consult, also consult while locked: that's
            # exactly the race (in-flight consult outlives a ready->transition)
            # this stress test is hunting for.
            now = sim.clock.now()
            if not sim.director.in_flight and now - last_consult > sim.fsm.p["min_interval"]:
                sim.director.consult_async(now)
                last_consult = now
            sim.clock.real_sleep(0.005)
        sim.director.wait(timeout=max(5.0, delay + 2.0))
        rep["exceptions"] += len(sim.director.errors)
    except Exception:
        rep["exceptions"] += 1
    finally:
        if sim is not None:
            sim.close()
    return rep


DUR_TOLERANCE = 0.05


def verify_run(outdir, logpath, max_dollars, actual_spent=None):
    """Spec 15 step 4: a finished run checks its own journal -- every logged
    path is a file on disk, every spoken line's `dur` is the wav header length
    within 0.05 s, and `cost` stayed inside --max-dollars. Returns
    {ok, issues, checked_files, spent}; the CLI exits nonzero on issues."""
    try:
        from voice import wav_seconds
    except ImportError:
        from .voice import wav_seconds
    issues = []
    checked = 0
    spent = None
    with open(logpath, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    for row in rows:
        for key in ("audio", "path", "fallback"):
            rel = row.get(key)
            if not rel:
                continue
            path = rel if os.path.isabs(rel) else os.path.join(outdir, rel)
            if not os.path.isfile(path):
                issues.append("%s %s: file is missing: %s"
                              % (row.get("type"), key, rel))
                continue
            checked += 1
        if row.get("type") == "line" and row.get("audio") and row.get("dur") is not None:
            path = os.path.join(outdir, row["audio"])
            if os.path.isfile(path):
                try:
                    real = wav_seconds(path)
                except Exception as e:
                    issues.append("line audio %s is not readable wav: %s"
                                  % (row["audio"], e))
                    continue
                if abs(real - float(row["dur"])) > DUR_TOLERANCE:
                    issues.append("line dur %.3f != wav %.3f (%s)"
                                  % (float(row["dur"]), real, row["audio"]))
        if row.get("type") == "cost":
            spent = row.get("dollars")
    if spent is not None and max_dollars is not None and spent > max_dollars + 1e-9:
        issues.append("cost $%.4f over --max-dollars $%.4f" % (spent, max_dollars))
    if actual_spent is not None:
        if spent is None or abs(actual_spent - spent) > 1e-6:
            issues.append("actual spent $%.4f != journal cost $%s"
                          % (actual_spent, "none" if spent is None else "%.4f" % spent))
        if max_dollars is not None and actual_spent > max_dollars + 1e-9:
            issues.append("actual spent $%.4f over --max-dollars $%.4f"
                          % (actual_spent, max_dollars))
    return {"ok": not issues, "issues": issues, "checked_files": checked,
            "spent": spent}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="A")
    ap.add_argument("--fake", action="store_true")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--max-transitions", type=int, default=2)
    ap.add_argument("--max-dollars", type=float, default=20.0)
    args = ap.parse_args()
    media = None
    if not args.fake:
        # live run: real Fish voice (wav, spec 6) and real Muse Image (spec 9);
        # media failures fall back per module, never stop the dream.
        from voice import Voice
        from images import Images
        media = {"voice": Voice(), "images": Images()}
    outdir, logpath = run(profile=args.profile, fake=args.fake, speed=args.speed,
                           max_transitions=args.max_transitions, media=media,
                           max_dollars=args.max_dollars)
    rows = [json.loads(l) for l in open(logpath, encoding="utf-8")]
    transitions = sum(1 for r in rows if r["type"] == "transition")
    report = verify_run(outdir, logpath, args.max_dollars, actual_spent=get_spent())
    print("outdir=%s transitions=%d files=%d spent=%s"
          % (outdir, transitions, report["checked_files"], report["spent"]))
    for issue in report["issues"]:
        print("issue: " + issue)
    sys.exit(0 if transitions >= args.max_transitions and report["ok"] else 1)


if __name__ == "__main__":
    main()
