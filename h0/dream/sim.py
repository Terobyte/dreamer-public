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
import queue

from clock import Clock
from director import Director
from fsm import BuildFSM
from inputs import resolve_touch, sanitize
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
# Muse Image refuses known character names (content_policy_violation): portraits
# are drawn from a look description, the name stays only in the log and the comic
START_LOOKS = {a["name"]: a["look"] for a in START["actors"] if a.get("look")}
START_PERSONAS = {a["name"]: a["persona"] for a in START["actors"] if a.get("persona")}
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
                 max_dollars=20.0, dialogue=None):
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
        self._looks = dict(START_LOOKS)
        self._personas = dict(START_PERSONAS)
        if prof.get("hero_look"):
            self._looks[self.hero] = prof["hero_look"]
        self.budget_wake = False
        # live dialogue (spec 6): hero and actors speak through Dialogue; without
        # it (tests, --fake) the loop keeps its numbered placeholder lines
        self.dialogue = dialogue
        self.place = START_PLACE
        self.transcript = []
        self._notes = {}
        self._hero_world = []
        self._actor_events = []
        self._stalled = False
        self._gen_thread = None
        self._gen_result = None
        self._gen_lock = threading.Lock()
        self._human_epoch = 0
        self._prepared_meta = None
        self._inbox = queue.Queue()
        self.stopped = False
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
        if prof and not self.memory.facts:
            self._load_soul(prof)
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
                                     "actors": list(self.scene["actors"]),
                                     "place": self.place, "hero": self.hero,
                                     "profile": self.profile, "speed": self.speed,
                                     "max_dollars": self.max_dollars})

    def _load_soul(self, prof):
        """Spec 7: the core holds the hero's main desire and fear, the facts layer
        the rest of the soul -- diary, past dream and facts hidden from the hero
        (spec 12: the director reads what the hero does not)."""
        self.memory.set_core(desire="; ".join(prof.get("wants") or []),
                             anxiety="; ".join(prof.get("fears") or []))
        facts = []
        if prof.get("diary"):
            facts.append({"title": "today's diary", "text": prof["diary"]})
        if prof.get("past_dream"):
            facts.append({"title": "past dream", "text": prof["past_dream"]})
        for f in prof.get("facts") or []:
            text = f.get("text") if isinstance(f, dict) else str(f)
            if text and text not in (prof.get("past_dream") or ""):
                facts.append({"title": " ".join(text.split()[:5]), "text": text})
        self.memory.apply_facts([{"op": "ADD", "fact": f} for f in facts])

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        """Finish owned workers before releasing temporary memory files."""
        self.director.wait(timeout=None)
        if self._gen_thread is not None:
            self._gen_thread.join()
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
        kind = event.get("type")
        if kind == "message" and event.get("to"):
            self._notes.setdefault(event["to"], []).append(str(event.get("note") or ""))
        elif kind == "hint" and event.get("level") == 4 and self.fsm.bridge:
            # L4 is a world event (spec 4): the hero sees it, the actor reacts
            self._hero_world.append("the %s glows and hums, pulling at you" % self.fsm.bridge)
            self._actor_events.append("the %s glows and hums on its own" % self.fsm.bridge)
        elif kind == "stall":
            self._stalled = True
            self._actor_events.append("%s reached for the %s" % (self.hero, event.get("object")))

    def _start_line(self, line, audio_seconds=None):
        """The only playback entry point: timing, journal and memory agree."""
        res = None
        if (self._voice is not None and self.logger is not None and not self.fake
                and self._budget_ok()):
            self._line_seq += 1
            voice_label = line.get("voice")
            if not voice_label:
                if line["owner"] == "human" or line.get("role") == "hero":
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
        if self.dialogue is not None or line.get("who"):
            who = line.get("who") or (self.hero if line["owner"] == "human" else None)
            event["who"] = who
            event["role"] = line.get("role") or ("hero" if line["owner"] == "human" else "actor")
            for key in ("remarks", "level", "look", "touch"):
                if line.get(key) is not None:
                    event[key] = line[key]
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
            self.memory.add_line(line.get("who") or "npc", line["text"])
        if self.dialogue is not None:
            self.transcript.append((event.get("who") or "?", line["text"]))
            if event.get("role") == "actor":
                self._stalled = False
        self._count_line()
        if line.get("touch"):
            self._touch(line["touch"], "hero")
        return event

    def npc_start(self, line, audio_seconds=None):
        """Start an NPC line only when no human turn is waiting. line is the text,
        or a Dialogue line dict (who, role, remarks, look/touch)."""
        meta = None
        if isinstance(line, dict):
            meta = {k: v for k, v in line.items() if k not in ("text", "raw")}
            line = line["text"]
        if self.active_line is None and self.next_line is None:
            event = self._start_line(dict(meta or {}, owner="npc", text=line), audio_seconds)
        elif self.next_line is None:
            self.prepared_npc = line
            self._prepared_meta = meta
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
            self._prepared_meta = None
            self._prepared_audio_seconds = None
        self._human_epoch += 1
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
            if name:
                ev["name"] = name
            if not img["ok"]:
                ev["fallback"] = self._rel(img.get("fallback") or img["path"])
                err = img.get("error") or img.get("diagnostic")
                if isinstance(err, dict) and err.get("error"):
                    ev["error"] = str(err["error"])[:200]
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
        look = self._looks.get(who, who)
        self._start_image("portrait", portrait_prompt(look, prev), path, name or who,
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
            prev = self._hero_desc or self._looks.get(self.hero, self.hero)
            look = new_desc or self._looks.get(self.hero, self.hero)
            label = "%s, %s" % (self.hero, new_desc) if new_desc else self.hero
            self._start_portrait(look, prev, name=label)
            self._hero_desc = new_desc
            if hn.get("voice"):
                self.hero_voice = hn["voice"]

    # --- scene transition ---------------------------------------------------
    def _apply_transition(self):
        self.n_transitions += 1
        ns = self.fsm.next_scene
        self.hero_next = self.fsm.hero_next
        self.place = self.fsm.destination or "scene %d" % self.n_transitions
        self.transcript = self.transcript[-2:]
        self._notes = {}
        self._actor_events = []
        self._stalled = False
        self._hero_world = ["you have just arrived in %s" % self.place]
        if ns:
            self.scene = {"objects": list(ns["objects"]), "actors": list(ns["actors"])}
            self.actors = [a["name"] for a in ns["actors"] if isinstance(a, dict)]
            self._actor_voices = {a["name"]: a.get("voice") for a in ns["actors"]
                                  if isinstance(a, dict)}
            self._personas = {a["name"]: str(a.get("persona") or "")[:400] for a in ns["actors"]
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
                                         "actors": list(self.scene["actors"]),
                                         "place": self.place, "hero": self.hero,
                                         "hero_voice": self.hero_voice,
                                         "hero_desc": self._hero_desc})

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
            queued = dict(self._prepared_meta or {}, owner="npc", text=self.prepared_npc)
            self.prepared_npc = None
            self._prepared_meta = None
            audio_seconds, self._prepared_audio_seconds = self._prepared_audio_seconds, None
        if queued is not None:
            self._start_line(queued, audio_seconds)
        else:
            self.playing = False
            self._line_started_at = self._line_duration = None

    def _maybe_generate_line(self):
        """Keep NPC dialogue flowing so every 4th line triggers a consult (F5/F20)."""
        if self.dialogue is not None:
            return self._dialogue_turn()
        now = self.clock.now()
        if (self.active_line is None and self.next_line is None
                and self.prepared_npc is None
                and now - self._last_line_gen >= self.clock.scale(1.0)):
            self._last_line_gen = now
            self.npc_start("npc line %d" % (self.line_count + 1))

    # --- live dialogue (spec 4-6): one line ahead, in a worker ---------------
    def _next_speaker(self):
        last = self.transcript[-1][0] if self.transcript else None
        if not self.actors:
            return self.hero, "hero"
        if last == self.hero or last is None and self.n_transitions == 0:
            spoken = [w for w, _ in self.transcript]
            # rotate between actors, least recently heard first
            pick = min(self.actors, key=lambda a: max(
                [i for i, w in enumerate(spoken) if w == a] or [-1]))
            return pick, "actor"
        return self.hero, "hero"

    def _dialogue_turn(self):
        """Pick up a finished line, or start the next one while the current one
        plays (spec 5: generate one line ahead). A line from an old scene, or
        one overtaken by a human line, is dropped."""
        with self._gen_lock:
            res, self._gen_result = self._gen_result, None
        if res is not None:
            line, scene_no, epoch = res
            if line is not None and scene_no == self.n_transitions and epoch == self._human_epoch:
                self.npc_start(line)
        busy = self._gen_thread is not None and self._gen_thread.is_alive()
        if busy or self.prepared_npc is not None or self.next_line is not None:
            return
        if self.fsm.awake or self.stopped or not self._budget_ok():
            return
        who, role = self._next_speaker()
        now = self.clock.now()
        world = {"place": self.place, "objects": list(self.scene["objects"]),
                 "actors": list(self.actors)}
        transcript = list(self.transcript)
        if role == "hero":
            world_events, self._hero_world = self._hero_world, []
            args = (world, transcript, world_events)
            fn = self.dialogue.hero_line
        else:
            locked = self.fsm.state in ("building", "ready")
            state = {"hint_level": self.fsm.hint_level(now), "build_pct": self.fsm.build_pct(now),
                     "stalled": self._stalled, "bridge": self.fsm.bridge if locked else None}
            events, self._actor_events = self._actor_events, []
            args = (who, world, transcript, state, list(self._notes.get(who, [])), events,
                    self._personas.get(who, ""))
            fn = self.dialogue.actor_line
        scene_no, epoch = self.n_transitions, self._human_epoch

        def work():
            line = None
            try:
                line = fn(*args)
            except Exception as e:
                self._diagnostic({"type": "line_fail", "who": who,
                                  "error": "%s: %s" % (type(e).__name__, e)})
            with self._gen_lock:
                self._gen_result = (line, scene_no, epoch)

        self._gen_thread = threading.Thread(target=work, daemon=True)
        self._gen_thread.start()

    # --- world input (spec 5a): click, POST /event, stop ---------------------
    def submit(self, kind, payload=None):
        """Thread-safe entry for the server: the main loop applies it on its next tick."""
        self._inbox.put((kind, payload))

    def _drain_inbox(self):
        while True:
            try:
                kind, payload = self._inbox.get_nowait()
            except queue.Empty:
                return
            if kind == "say":
                self.human_say(str(payload or ""))
            elif kind == "event":
                self.post_event(payload if isinstance(payload, dict) else {})
            elif kind == "stop":
                self.stop()

    def _touch(self, obj, source):
        events = self.fsm.touch(self.clock.now(), obj)
        for e in events:
            e.setdefault("source", source)
            self._emit(e)
        if any(e["type"] == "transition" for e in events):
            self._apply_transition()
        return events

    def click(self, value):
        """Click on an object in the comic (spec 5a): resolve_touch, then the
        hero's TOUCH under the same FSM rules; a miss is plain input."""
        clean, out = sanitize(str(value or ""), "human")
        for e in out:
            self._emit(e)
        obj, evs = resolve_touch(clean, self.fsm.objects)
        for e in evs:
            self._emit(e)
        if obj is not None:
            return self._touch(obj, "click")
        ev = {"type": "input", "source": "click", "value": clean}
        self._emit(ev)
        self.director.consult_async(self.clock.now(), events=[ev])
        return evs + [ev]

    def post_event(self, payload):
        """POST /event (spec 5a): any community tool's action, outcome included,
        reaches the director's next consult; every text field is sanitized."""
        source = sanitize(str(payload.get("source") or "tool"), "human")[0][:40]
        value, rejected = sanitize(str(payload.get("value") or ""), "human")
        if source == "click":
            return self.click(value)
        ev = {"type": "input", "source": source, "value": value}
        if payload.get("outcome") is not None:
            outcome, more = sanitize(str(payload["outcome"]), "human")
            ev["outcome"] = outcome
            rejected += more
        for e in rejected:
            self._emit(e)
        self._emit(ev)
        self.director.consult_async(self.clock.now(), events=[ev])
        return [ev]

    def stop(self, by="human"):
        if not self.stopped:
            self.stopped = True
            self._diagnostic({"type": "stop", "by": by})

    def status(self):
        """Live state for the server's 30 s snapshot (spec 11)."""
        now = self.clock.now()
        return {"type": "snapshot", "t": now, "live": True,
                "scene": list(self.scene["objects"]), "actors": list(self.scene["actors"]),
                "place": self.place, "hero": self.hero, "speed": self.speed,
                "build_state": self.fsm.state, "bridge": self.fsm.bridge,
                "destination": self.fsm.destination,
                "build_start": self.fsm.build_start, "hint_level": self.fsm.hint_level(now),
                "build_pct": self.fsm.build_pct(now), "dollars": get_spent(),
                "max_dollars": self.max_dollars,
                "seq": self.logger.seq if self.logger else 0}

    def _tick(self):
        now = self.clock.now()
        self._drain_inbox()
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
            if self.stopped or (self.dialogue is not None and self.fsm.awake):
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
        media=None, max_dollars=20.0, dialogue=None, serve=None, on_sim=None):
    """serve=port (0 = any) starts the comic viewer on the live run (spec 11);
    the dream then goes on until "stop", the budget or a wake_up."""
    random.seed(seed)
    base = os.path.join(os.path.dirname(__file__), "..", "out", "dream", profile)
    os.makedirs(base, exist_ok=True)
    outdir = os.path.join(base, "run_%d_%d" % (seed, int(time.time() * 1000) % 1000000))
    os.makedirs(outdir, exist_ok=True)
    if serve is not None:
        max_seconds = float("inf")
    elif max_seconds == 90.0 and max_transitions > 0:
        # one full build alone takes 420/speed sim-seconds (spec 5); fake or
        # live, the run must at least outlive it plus line playback.
        max_seconds = max(max_seconds, 420.0 / max(speed, 0.01) + 120.0)
    with Sim(profile=profile, fake=fake, speed=speed, outdir=outdir, media=media,
             max_dollars=max_dollars, dialogue=dialogue) as sim:
        viewer = None
        if serve is not None:
            from server import Viewer
            viewer = Viewer(sim=sim, run="%s/%s" % (profile, os.path.basename(outdir)))
            port = viewer.start(serve)
            print("dream viewer: http://localhost:%d/?run=%s" % (port, viewer.run), flush=True)
            sim.viewer = viewer
        if on_sim is not None:
            on_sim(sim)
        try:
            sim.run(max_transitions=max_transitions, max_seconds=max_seconds)
        finally:
            if viewer is not None:
                sim.stopped = True
                time.sleep(0.5)  # let open streams send their "end"
                viewer.stop()
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
    ap.add_argument("--max-transitions", type=int, default=None,
                    help="default 2; with --serve unlimited (until stop)")
    ap.add_argument("--max-dollars", type=float, default=20.0)
    ap.add_argument("--serve", action="store_true", help="live comic viewer (spec 11)")
    ap.add_argument("--port", type=int, default=8770)
    args = ap.parse_args()
    if args.max_transitions is None:
        args.max_transitions = 10 ** 6 if args.serve else 2
    media = None
    dialogue = None
    if not args.fake:
        from dialogue import Dialogue
        dialogue = Dialogue(load_profile(args.profile))
        # live run: real Fish voice (wav, spec 6) and real Muse Image (spec 9);
        # media failures fall back per module, never stop the dream.
        from voice import Voice
        from images import Images
        media = {"voice": Voice(), "images": Images()}
    outdir, logpath = run(profile=args.profile, fake=args.fake, speed=args.speed,
                           max_transitions=args.max_transitions, media=media,
                           max_dollars=args.max_dollars, dialogue=dialogue,
                           serve=args.port if args.serve else None)
    rows = [json.loads(l) for l in open(logpath, encoding="utf-8")]
    transitions = sum(1 for r in rows if r["type"] == "transition")
    stopped = any(r["type"] in ("stop", "wake_up") for r in rows)
    report = verify_run(outdir, logpath, args.max_dollars, actual_spent=get_spent())
    print("outdir=%s transitions=%d files=%d spent=%s"
          % (outdir, transitions, report["checked_files"], report["spent"]))
    for issue in report["issues"]:
        print("issue: " + issue)
    done = transitions >= args.max_transitions or (args.serve and stopped)
    sys.exit(0 if done and report["ok"] else 1)


if __name__ == "__main__":
    main()
