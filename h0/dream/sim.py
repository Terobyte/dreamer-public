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

VOICES = {"old_woman", "old_man", "woman", "man", "child", "creature"}

START_SCENE = {
    "objects": ["clarinet", "old radio", "music stand", "framed photo of a friend",
                "photo album", "suitcase", "postcard with an airplane", "armchair"],
    "actors": ["Squidward"],
}
HOOK_INDEX = {"A": 0, "B": 3, "C": 5}


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
    spoken = re.sub(r"\[[^\]]*\]", " ", text)
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
                 delay=0.0, fsm_params=None, memory=None):
        self.profile = profile
        self.speed = speed
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
                                 outdir=outdir, clock=self.clock)
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
        self._drain_director()
        if self._storage is not None:
            self._storage.cleanup()
            self._storage = None

    # --- turn management (human replaces npc, spec 5a) ---------------------
    def _count_line(self):
        self.line_count += 1
        if self.line_count % 4 == 0 and not self.director.in_flight:
            self.director.consult_async(self.clock.now())

    def _diagnostic(self, event):
        if self.logger:
            self.logger.write_event({"t": self.clock.now(), **event})

    def _emit(self, event):
        self._diagnostic(event)
        self.memory.add_event(event)

    def _start_line(self, line, audio_seconds=None):
        """The only playback entry point: timing, journal and memory agree."""
        duration = self.clock.scale(line_duration(line["text"], audio_seconds))
        self.active_line = line
        self.playing = True
        self._line_started_at = self.clock.now()
        self._line_duration = duration
        event = {"type": "line", "turn_owner": line["owner"], "text": line["text"]}
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

    # --- scene transition ---------------------------------------------------
    def _apply_transition(self):
        self.n_transitions += 1
        ns = self.fsm.next_scene
        self.hero_next = self.fsm.hero_next
        if ns:
            self.scene = {"objects": list(ns["objects"]), "actors": list(ns["actors"])}
            self.actors = [a["name"] for a in ns["actors"] if isinstance(a, dict)]
            self.director.actors = self.actors
            self.memory.set_scene(self.fsm.destination or "scene %d" % self.n_transitions,
                                  self.scene["objects"])
            self.memory.select_facts_background()
            self.memory.merge_background()
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
        due = self.fsm.due(now)
        if due or (self.fsm.state == "idle" and now - last_consult > self.fsm.p["min_interval"]):
            self.director.consult_async(now)
            return now
        return last_consult

    def run(self, max_transitions=2, max_seconds=90.0):
        start = self.clock.now()
        last_consult = -1e9
        while self.n_transitions < max_transitions and self.clock.now() - start < max_seconds:
            self._tick()
            if self.n_transitions >= max_transitions or self.clock.now() - start >= max_seconds:
                break
            self._maybe_generate_line()
            last_consult = self._maybe_consult(last_consult)
            self.clock.real_sleep(0.01)
        self.director.wait(timeout=max(5.0, self.director.delay + 2.0))
        self._drain_director()
        self.memory.wait(timeout=5.0)
        return self.n_transitions


def run(profile="A", fake=True, speed=1.0, max_transitions=2, seed=0, max_seconds=90.0):
    random.seed(seed)
    base = os.path.join(os.path.dirname(__file__), "..", "out", "dream", profile)
    os.makedirs(base, exist_ok=True)
    outdir = os.path.join(base, "run_%d_%d" % (seed, int(time.time() * 1000) % 1000000))
    os.makedirs(outdir, exist_ok=True)
    with Sim(profile=profile, fake=fake, speed=speed, outdir=outdir) as sim:
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="A")
    ap.add_argument("--fake", action="store_true")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--max-transitions", type=int, default=2)
    ap.add_argument("--max-dollars", type=float, default=20.0)
    args = ap.parse_args()
    outdir, logpath = run(profile=args.profile, fake=args.fake, speed=args.speed,
                          max_transitions=args.max_transitions)
    rows = [json.loads(l) for l in open(logpath, encoding="utf-8")]
    transitions = sum(1 for r in rows if r["type"] == "transition")
    print("outdir=%s transitions=%d" % (outdir, transitions))
    sys.exit(0 if transitions >= args.max_transitions else 1)


if __name__ == "__main__":
    main()
