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

import lang
from clock import Clock
from dialogue import (ACTOR_STREAK_MAX, ADDRESS_HOLD, SILENT_CAP,
                      THRESHOLD, TICK, W_ADDRESSED, W_EVENT_HIT, W_GOAL_OPEN,
                      W_SILENT, W_SPOKE_LAST)
from director import Director
from fsm import BuildFSM
from inputs import resolve_touch, sanitize
from memory import Memory
from safety import SOFT_NOTE
from safety import match as safety_match
from fake import FakeTransport
try:
    from llm import get_spent, IMAGE_PER_PIC, set_talk_model, set_cap
except ImportError:
    from .llm import get_spent, IMAGE_PER_PIC, set_talk_model, set_cap
try:
    from images import background_prompt, portrait_prompt
except ImportError:
    from .images import background_prompt, portrait_prompt

VOICES = {"old_woman", "old_man", "woman", "man", "child", "creature"}

def _load_start(name="start"):
    """scenes/<name>.json is the opening scene (spec 9): place, objects, actors
    with their voices, looks and personas, and the hero's situation. The sim,
    the background prompt and TTS all read it."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scenes", name + ".json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


HERO_SELF = "__hero__"  # a scene names the hero only through its own hero block


def use_scene(name="start"):
    """Pick the opening scene before a Sim is built (--scene)."""
    global START, START_SCENE, START_VOICES, START_LOOKS, START_PERSONAS, START_PLACE
    START = _load_start(name)
    # 1.3: the hero's reason to be here is not a start value but the first event of
    # the schedule, so it reaches him the same way everything else in the world does
    events = list(START.get("events") or [])
    if START.get("situation_hero"):
        hero = START.get("hero")
        who = [hero["name"]] if isinstance(hero, dict) and hero.get("name") else [HERO_SELF]
        events.insert(0, {"t": 0, "what": START["situation_hero"], "who": who,
                          "kind": "world"})
    START_SCENE = {
        "objects": list(START["objects"]),
        "actors": [a["name"] for a in START["actors"]],
        "events": events,
        "goals": list(START.get("goals") or []),
    }
    START_VOICES = {a["name"]: a.get("voice") for a in START["actors"]}
    # Muse Image refuses known character names (content_policy_violation): portraits
    # are drawn from a look description, the name stays only in the log and the comic
    START_LOOKS = {a["name"]: a["look"] for a in START["actors"] if a.get("look")}
    START_PERSONAS = {a["name"]: a["persona"] for a in START["actors"] if a.get("persona")}
    START_PLACE = START["place"]


use_scene("start")
HOOK_INDEX = {"A": 0, "B": 3, "C": 5}
DIRECTOR_PER_CALL = 0.02  # one Wonder consult, measured: bank r2, 6 consults ~ $0.12


SOUL_KEYS = ("diary", "wants", "fears", "past_dream", "facts")


def load_profile(pid):
    """Profile soul file (spec 2): hero name and hero voice for playback. A scene
    with a hero of its own (scenes/roof.json: just a man on a roof) replaces the
    profile's hero, and its soul too -- a diary about the fryer has no place there."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles",
                        str(pid) + ".json")
    try:
        with open(path, encoding="utf-8") as f:
            prof = json.load(f)
    except (OSError, ValueError):
        prof = {}
    hero = START.get("hero")
    if isinstance(hero, dict):
        prof = dict(prof)
        if hero.get("soul"):
            for k in SOUL_KEYS:
                prof.pop(k, None)
            prof.update({k: v for k, v in hero["soul"].items() if k in SOUL_KEYS})
        for src, dst in (("name", "hero"), ("voice", "hero_voice"), ("look", "hero_look")):
            if hero.get(src):
                prof[dst] = hero[src]
    return prof


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
        # 2.2: a safety phrase from the human holds the whole dream until /continue
        self.safety_paused = False
        self._voice = self.media.get("voice")
        self._images = self.media.get("images")
        self._audio_dir = self._image_dir = None
        self._image_threads = []
        self._held_images = []
        self._image_lock = threading.Lock()
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
        # 2.1: who owns the hero's turn -- the loop (npc) or the player (human)
        self.hero_owner = "npc"
        # live dialogue (spec 6): hero and actors speak through Dialogue; without
        # it (tests, --fake) the loop keeps its numbered placeholder lines
        self.dialogue = dialogue
        if dialogue is not None and hasattr(dialogue, "heard"):
            dialogue.on_memory = self._on_memory
        if dialogue is not None and getattr(dialogue, "event_sink", None) is None:
            dialogue.event_sink = self._diagnostic  # lock_reject lands in the log (1.1)
        # 1.1: both attempts refused by the lock -> turn_skip, no generation before
        # clock.scale(4), and that speaker's pressure is 0 for one free tick (1.2b)
        self._gen_not_before = -1e9
        self._skip_once = None
        # 1.4: actor goals -- done_when is checked by code, judge: true goes
        # through a background YES/NO ask; form and log are spec 7.2 row 1.4
        self._goal_open = {}   # actor -> goal dict, one at a time, in list order
        self._goal_order = []  # goals of the scene not yet closed
        self._judge_yes = 0    # YES answers in a row for the current goal
        self._judge_last_line = 0  # line_count of the last judge call
        self._judge_thread = None
        self._judge_lock = threading.Lock()
        self._judge_pending = []  # answers landed, applied on the next _tick
        # 1.2b: who speaks is decided by pressure, not by rotation
        self._spoke_last = None
        self._silent_ticks = {}
        self._addressed = {}
        self._event_hits = {}  # 1.3: an event raises its recipients' pressure
        self._actor_streak = 0
        self._said_count = {}
        self._last_pressure = None
        self.place = START_PLACE
        self.transcript = []
        self._notes = {}
        # 1.3: "Just now" is a queue per recipient -- the hero's is _hero_world,
        # every actor has his own, and a queue nobody owns reaches nobody
        self._hero_world = []
        self._pending = {}
        self._schedule = []
        self._fired = set()
        self._discard_reason = "human"
        self._gen_thread = None
        self._gen_who = None
        self._gen_epoch = None
        self._gen_result = None
        self._gen_lock = threading.Lock()
        self._turn_epoch = 0
        self._last_tick = -1e9
        self._prepared_meta = None
        self._inbox = queue.Queue()
        self.stopped = False
        self.clock = Clock(speed=speed)
        self.scene_start = self.clock.now()
        self.scene = dict(START_SCENE)
        self.actors = list(self.scene["actors"])
        self._load_goals(emit=False)
        self.fsm = BuildFSM(self.scene["objects"], voices=VOICES, speed=speed,
                             now=self.clock.now(), params=fsm_params,
                             actors=list(self.actors), hero=self.hero)
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
                                 outdir=outdir, clock=self.clock, fake=fake,
                                 paused_check=lambda: self.safety_paused,
                                 pause_lock=self._image_lock)
        self.n_transitions = 0
        self.stop_reason = None  # why the last run() loop ended (F7: main trusts this, not the wall clock)
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
                                      "max_dollars": self.max_dollars,
                                      "hero_owner": self.hero_owner})
        self._start_schedule()
        self._load_goals()

    # --- event schedule (spec 7.2 row 1.3) ----------------------------------
    def _start_schedule(self):
        """A scene starts with its whole schedule in the log: what is going to
        happen and when, in simulated seconds from this scene's start."""
        self.scene_start = self.clock.now()
        self._fired = set()
        self._schedule = []
        for ev in self.scene.get("events") or []:
            if not isinstance(ev, dict):
                continue
            who = ev.get("who")
            if who != "all":
                who = [self.hero if w == HERO_SELF else w for w in (who or [])]
            self._schedule.append({"t": float(ev.get("t") or 0),
                                   "what": str(ev.get("what") or ""),
                                   "who": who, "kind": ev.get("kind") or "world"})
        self._diagnostic({"type": "schedule", "events": self._schedule})

    def _recipients(self, ev):
        """`who: "all"` is every actor on stage and the hero; a name that is not
        here any more is nobody -- his "Just now" is dropped, not handed on."""
        who = ev["who"]
        names = [self.hero] + list(self.actors) if who == "all" else list(who)
        return [n for n in names if n == self.hero or n in self.actors]

    def _fire_due_events(self):
        """Checked on every loop step, not only on a free tick: an event is due at
        its own second even if nobody has said a word since the scene started."""
        t_sim = (self.clock.now() - self.scene_start) * self.speed
        for i, ev in enumerate(self._schedule):
            if i in self._fired or ev["t"] > t_sim:
                continue
            self._fired.add(i)
            who = self._recipients(ev)
            for name in who:
                if name == self.hero:
                    self._hero_world.append(ev["what"])
                else:
                    self._pending.setdefault(name, []).append(ev["what"])
                self._event_hits[name] = ADDRESS_HOLD
            # 1.2a: a line already in flight from someone the event did not reach
            # answers a world that no longer exists, so its turn is over.
            # Review Focus 1: a human line that already moved the turn on wins --
            # the event must not steal its discard reason
            if (self._gen_who is not None and self._gen_who not in who
                    and self._turn_epoch == (self._gen_epoch
                                             if self._gen_epoch is not None else -1)):
                self._turn_epoch += 1
                self._discard_reason = "event"
            self._diagnostic({"type": "event", "what": ev["what"], "who": who,
                              "kind": ev["kind"]})

    def _load_goals(self, emit=True):
        """One open goal per actor, in scene list order (7.2 row 1.4)."""
        self._goal_open = {}
        self._goal_order = [g for g in (self.scene.get("goals") or [])
                            if isinstance(g, dict)]
        self._judge_yes = 0
        self._judge_last_line = 0
        self._judge_pending = []
        if not emit:
            for g in self._goal_order:
                actor = g.get("actor")
                if actor and actor in self.actors and actor not in self._goal_open:
                    self._goal_open[actor] = g
            return
        for g in self._goal_order:
            actor = g.get("actor")
            if actor and actor in self.actors and actor not in self._goal_open:
                self._goal_open[actor] = g
                self._emit({"type": "goal", "actor": actor,
                            "status": "open", "goal": g.get("goal") or ""})

    def _goal_words(self, cond):
        return [str(w or "").lower() for w in (cond.get("any") or [])
                if str(w or "").strip()]

    def _mentions(self, text, words):
        low = " " + re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower()) + " "
        out = []
        for w in words:
            w = re.sub(r"[^a-z0-9 ]+", " ", str(w or "").lower()).strip()
            out.append(" " + w + " " if w else "")
        return any(w and w in low for w in out)

    def _check_done_when(self, goal, who, text):
        """Code closes done_when goals: the named speaker says any of the words,
        and the last line of `not_after.speaker` carries none of its words.
        Only the last line of that speaker counts as "they asked" -- anything
        older is a new try, the actor may have moved on."""
        cond = goal.get("done_when") or {}
        if (not isinstance(cond, dict) or who != cond.get("speaker")
                or not self._mentions(text, self._goal_words(cond))):
            return False
        na = cond.get("not_after") or {}
        if isinstance(na, dict) and na.get("speaker"):
            prev = ([t for w, t in self.transcript if w == na.get("speaker")] or [""])[-1]
            if self._mentions(prev, self._goal_words(na)):
                return False
        return True

    def _close_goal(self, actor, by):
        self._goal_order = [g for g in self._goal_order
                            if not (g.get("actor") == actor
                                    and g is self._goal_open.get(actor))]
        goal = self._goal_open.pop(actor, None)
        self._emit({"type": "goal", "actor": actor, "status": "done",
                    "by": by, "goal": (goal or {}).get("goal") or ""})
        self._judge_yes = 0
        for g in self._goal_order:
            nxt = g.get("actor")
            if nxt and nxt in self.actors and nxt not in self._goal_open:
                self._goal_open[nxt] = g
                self._emit({"type": "goal", "actor": nxt,
                            "status": "open", "goal": g.get("goal") or ""})
                break

    def _maybe_check_goals(self, who, text):
        """After every spoken line: code first, then the judge queue."""
        if not who:
            return
        for actor, goal in list(self._goal_open.items()):
            if not goal.get("judge") and self._check_done_when(goal, who, text):
                self._close_goal(actor, "code")
        self._maybe_ask_judge()

    def _maybe_ask_judge(self):
        """One background YES/NO ask per 4 lines at most; the answer lands in a
        pending queue and is applied on the next _tick, never on the line path."""
        with self._judge_lock:
            if (self._judge_thread is not None and self._judge_thread.is_alive()):
                return
            open_judge = [(a, g) for a, g in self._goal_open.items()
                          if g.get("judge")]
            if (not open_judge or self.line_count - self._judge_last_line < 4
                    or self.dialogue is None
                    or not hasattr(self.dialogue, "judge")):
                return
            actor, goal = open_judge[0]
            last4 = list(self.transcript[-4:])
            self._judge_last_line = self.line_count

        def work():
            answer = "NO"
            try:
                answer = self.dialogue.judge(goal.get("goal") or "", last4)
            except Exception:
                answer = "NO"
            answer = "YES" if str(answer or "") == "YES" else "NO"
            with self._judge_lock:
                self._judge_pending.append((actor, answer))

        self._judge_thread = threading.Thread(target=work, daemon=True)
        self._judge_thread.start()

    def _apply_judge(self):
        """Apply answers landed since the last tick: log + count + maybe close."""
        with self._judge_lock:
            pending, self._judge_pending = self._judge_pending, []
        for actor, answer in pending:
            if actor not in self._goal_open or not self._goal_open[actor].get("judge"):
                continue
            self._diagnostic({"type": "judge", "actor": actor, "answer": answer})
            if answer == "YES":
                self._judge_yes += 1
            else:
                self._judge_yes = 0
            if self._judge_yes >= 2:
                self._close_goal(actor, "judge")

    def _join_judge(self, timeout=5):
        th = self._judge_thread
        if th is not None:
            th.join(timeout)

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
        self._join_judge()
        self.memory.wait()
        if self.dialogue is not None and hasattr(self.dialogue, "wait"):
            self.dialogue.wait()
        self.wait_images()
        self._drain_director()
        if self._storage is not None:
            self._storage.cleanup()
            self._storage = None

    # --- turn management (human replaces npc, spec 5a) ---------------------
    def _count_line(self):
        self.line_count += 1
        if (self.line_count % 4 == 0 and not self.safety_paused
                and not self.director.in_flight
                and (self.fake or self._budget_ok())):
            self.director.consult_async(self.clock.now())

    def _budget_ok(self):
        """Spec 13: --max-dollars holds spending, it does not just notice an
        overrun afterwards. The first refusal wakes the hero once, so the dream
        ends inside the budget instead of finishing paid work beyond it."""
        with self._reserve_lock:
            committed = get_spent() + self._reserved
        # room for one more paid unit plus a director consult that may be in flight
        # (it lands after this check: bank runs ended $0.01-0.03 over the cap)
        director = 0.0 if getattr(self.director, "fake", True) else DIRECTOR_PER_CALL
        if committed + IMAGE_PER_PIC + director <= self.max_dollars + 1e-9:
            return True
        if not self.budget_wake:
            self.budget_wake = True
            for e in self.fsm.budget_wakeup(self.clock.now()):
                self._emit(e)
        return False

    def _on_memory(self, who, mind, n_lines, error):
        """Dialogue folded n_lines into who's memory (background thread; the
        logger has its own lock). A failed fold keeps the lines for the next one."""
        if mind is None:
            self._diagnostic({"type": "memory_compact_fail", "who": who,
                              "lines": n_lines, "error": str(error)[:300]})
        else:
            self._diagnostic({"type": "memory_compact", "who": who, "lines": n_lines, **mind})

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
        elif kind == "door":
            # the door is a world fact the hero hears about: open on ready (the only
            # road to [[TOUCH]]), locked when he tries it early; actors get no cue
            obj = event.get("object") or self.fsm.bridge
            if obj and event.get("state") == "open":
                self._hero_world.append("the %s has swung open" % obj)
            elif obj:
                self._hero_world.append("the %s is locked, it would not budge" % obj)

    def _start_line(self, line, audio_seconds=None):
        """The only playback entry point: timing, journal and memory agree."""
        res = None
        if (self._voice is not None and self.logger is not None and not self.fake
                and not self.safety_paused and self._budget_ok()):
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
            for key in ("remarks", "level", "look", "touch", "impulse"):
                if line.get(key) is not None:
                    event[key] = line[key]
        if res is not None and line.get("dur") is not None:
            event["dur"] = line["dur"]
            if line.get("audio"):
                event["audio"] = os.path.relpath(line["audio"], self.outdir)
            else:
                event["silent"] = True
        if res is not None and not res["ok"]:
            err = res.get("error") or {}
            self._diagnostic({"type": "tts_fail",
                              "error": str(err.get("error") if isinstance(err, dict) else err)})
        self._emit(event)
        # 1.2b: only a spoken line moves the pressure state (a human line = the hero's)
        self._note_line(event.get("who") or (self.hero if line["owner"] == "human"
                                             else None),
                        event.get("role") or ("hero" if line["owner"] == "human"
                                              else "actor"),
                        line["text"])
        # 1.1: the line is really spoken, so now it counts for the speaker's loop
        # state; a generated line dropped on the way (old scene, a human line in
        # between, a reserved turn) leaves no turn, no cut and no loop_cut (F1)
        if line["owner"] == "npc" and hasattr(self.dialogue, "accept"):
            self.dialogue.accept(dict(line, who=event.get("who")))
        # a loop cut is logged after the line it was found on, before the next
        for item in line.get("cuts") or []:
            self._diagnostic({"type": "loop_cut", "who": event.get("who"), "item": item})
        # Speech input is remembered on arrival, including while it is queued.
        if line["owner"] == "npc":
            self.memory.add_line(line.get("who") or "npc", line["text"])
        if self.dialogue is not None:
            self.transcript.append((event.get("who") or "?", line["text"]))
            if hasattr(self.dialogue, "heard"):
                self.dialogue.heard(event.get("who") or "?", line["text"])
                self.dialogue.compact([self.hero] + list(self.actors), seen=len(self.transcript))
        self._count_line()
        self._maybe_check_goals(event.get("who") or None, line["text"])
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
            event = {"type": "line_discarded", "turn_owner": "npc", "text": line,
                     "who": (meta or {}).get("who"), "reason": "human"}
            self._emit(event)
        return [event]

    def _safety_check(self, text):
        """2.2: the one place where human input meets the safety list. A hit pauses
        the dream (clock included); while paused anything else is dropped. True means
        the caller returns at once -- before any _emit, so the line is in no journal,
        no memory, no turn and no consult."""
        hit = safety_match(text)
        if hit:
            # F9: the flag goes up (and the clock stops) under _image_lock first,
            # before the journal write -- a write is slow enough for an in-flight
            # consult or image to slip through an unpaused dream otherwise.
            with self._image_lock:
                if not self.safety_paused:
                    self.safety_paused = True
                    self.clock.pause()
            self._diagnostic({"type": "safety_pause", "matched": hit})
            return True
        if self.safety_paused:
            self._diagnostic({"type": "input_dropped", "reason": "safety"})
            return True
        return False

    def safety_continue(self):
        """POST /continue: the dream goes on from the same second, and every actor
        on stage gets the one soft note. A second /continue is nothing."""
        if not self.safety_paused:
            return []
        self.safety_paused = False
        self.clock.resume()
        held = []
        with self._image_lock:
            held, self._held_images = self._held_images, []
        for ev in held:
            if self.logger:
                self.logger.write_event(ev)
        out = [{"type": "message", "to": a, "note": SOFT_NOTE} for a in self.actors]
        for e in out:
            self._emit(e)
        return out

    def human_say(self, text):
        clean, ev = sanitize(text, "human")
        if self._safety_check(clean):
            return []
        out = list(ev)
        if self.prepared_npc is not None:
            out.append({"type": "turn_replace", "turn_owner": "human", "text": clean,
                        "replaced": self.prepared_npc})
            self.prepared_npc = None
            self._prepared_meta = None
            self._prepared_audio_seconds = None
        self._turn_epoch += 1
        self._discard_reason = "human"
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
            # 2.2: a picture finished under a safety pause is held, not logged,
            # until /continue -- the pause stops pictures, it does not rerun them.
            # The lock covers the decision and the flag flip in _safety_check, not
            # the write: holding it across the write would make the pause itself
            # wait on a picture, and a row landing after safety_pause is in order.
            with self._image_lock:
                if self.safety_paused:
                    self._held_images.append(ev)
                    return
            self.logger.write_event(ev)

        th = threading.Thread(target=work, daemon=True)
        self._image_threads.append(th)
        th.start()

    def _media_live(self):
        return (self._images is not None and not self.fake and self.logger is not None
                and not self.safety_paused)

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
        self._hero_world = ["you have just arrived in %s" % self.place]
        if ns:
            # 1.4b: the director's reason for the hero to be here is not a start
            # value either -- it is the first event of this scene's schedule
            events = list(ns.get("events") or [])
            if ns.get("hero_reason"):
                events.insert(0, {"t": 0, "what": str(ns["hero_reason"]),
                                  "who": [self.hero], "kind": "world"})
            self.scene = {"objects": list(ns["objects"]), "actors": list(ns["actors"]),
                          "events": events,
                          "goals": list(ns.get("goals") or []),
                          "hero_reason": ns.get("hero_reason")}
            self.actors = [a["name"] for a in ns["actors"] if isinstance(a, dict)]
            self._actor_voices = {a["name"]: a.get("voice") for a in ns["actors"]
                                  if isinstance(a, dict)}
            self._personas = {a["name"]: str(a.get("persona") or "")[:400] for a in ns["actors"]
                              if isinstance(a, dict)}
            self.director.actors = self.actors
            self.director.notes_given = []
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
        else:
            self.scene = dict(self.scene, events=[], goals=[])
        # a "Just now" left for someone who is not on this stage is dropped here:
        # the queue is keyed by its recipient, so it can never be handed to another
        self._pending = {k: v for k, v in self._pending.items() if k in self.actors}
        self._start_schedule()
        self._load_goals()

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
            # 1.2a: the step that ends a line is itself a free tick
            self._last_tick = now - self.clock.scale(TICK)
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
        if self.safety_paused:
            return
        if self.dialogue is not None:
            return self._dialogue_turn()
        now = self.clock.now()
        if (self.active_line is None and self.next_line is None
                and self.prepared_npc is None
                and now - self._last_line_gen >= self.clock.scale(1.0)):
            self._last_line_gen = now
            self.npc_start("npc line %d" % (self.line_count + 1))

    # --- who speaks (spec 7.2 row 1.2b): pressure, not rotation --------------
    def _cast(self):
        """Everyone whose pressure is counted: the actors and the NPC hero."""
        return list(self.actors) + [self.hero]

    def _pressure(self, name):
        """The pressure fields of the `pressure` event (7.4) for one participant."""
        addressed = 1 if self._addressed.get(name, 0) > 0 else 0
        event_hit = 1 if self._event_hits.get(name, 0) > 0 else 0
        goal_open = 1 if name in self._goal_open else 0
        silent = self._silent_ticks.get(name, 0)
        spoke_last = 1 if name == self._spoke_last else 0
        p = (W_ADDRESSED * addressed + W_EVENT_HIT * event_hit
             + W_GOAL_OPEN * goal_open + W_SILENT * min(silent, SILENT_CAP)
             + W_SPOKE_LAST * spoke_last)
        return {"p": round(p, 3), "addressed": addressed, "event_hit": event_hit,
                "goal_open": goal_open, "silent": silent, "spoke_last": spoke_last}

    def _note_line(self, who, role, text):
        """A line really spoken moves the pressure state: its author stops being
        silent and becomes `spoke_last`, everyone it names by name is addressed.
        A human line arrives here as the hero's line (owner/role set in _start_line)."""
        if not who:
            return
        self._spoke_last = who
        self._silent_ticks[who] = 0
        self._addressed.pop(who, None)
        self._event_hits.pop(who, None)
        self._actor_streak = self._actor_streak + 1 if role == "actor" else 0
        self._said_count[who] = self._said_count.get(who, 0) + 1
        for other in self._cast():
            if other != who and re.search(r"\b%s\b" % re.escape(other), text or "",
                                          re.I):
                self._addressed[other] = ADDRESS_HOLD

    def _pick_speaker(self):
        """One free tick: silence grows for everyone, pressure is logged, and the
        loudest above THRESHOLD speaks. After ACTOR_STREAK_MAX actor lines in a row
        no actor is picked -- their pressure is still counted and written, but only
        the hero (or, from 1.3, an event) breaks through; the hero gets there on the
        silence term alone. Nobody above the threshold -> (None, None) and `silence`."""
        # 2.1: while the player owns the hero he is not in the cast at all --
        # neither picked nor written into `pressure`
        human = self.hero_owner == "human"
        if not self.actors:
            if human:
                return None, None
            self._silent_ticks[self.hero] = self._silent_ticks.get(self.hero, 0) + 1
            return self.hero, "hero"
        cast = [n for n in self._cast() if not (human and n == self.hero)]
        for name in cast:
            self._silent_ticks[name] = self._silent_ticks.get(name, 0) + 1
        table = {name: self._pressure(name) for name in cast}
        if self._skip_once in table:
            # 1.1: the lock refused both attempts, so p = 0 for one free tick
            table[self._skip_once]["p"] = 0.0
            self._skip_once = None
        for marks in (self._addressed, self._event_hits):
            for name in list(marks):
                marks[name] -= 1
                if marks[name] <= 0:
                    del marks[name]
        if table != self._last_pressure:
            self._last_pressure = table
            self._diagnostic({"type": "pressure", "pressure": table})
        # F4: an event can still reach its addressee through the block --
        # only an actor with no event_hit is held back by the streak
        blocked = self._actor_streak >= ACTOR_STREAK_MAX
        # ties on p (spec 7.2, row 1.3): whoever has been silent longer, then
        # the actors in scene order, the hero last (on the roof Dan speaks
        # first; two t=0 events reach Dan before Max) -- then whoever has
        # spoken least, then by name, so the choice never depends on dict
        # order. Raw silent ticks, not the capped term: the silence term
        # saturates at SILENT_CAP, and the longer-quiet one must still win.
        order = sorted(table.items(),
                       key=lambda kv: (-kv[1]["p"],
                                       -kv[1]["silent"],
                                       kv[0] == self.hero,
                                       self.actors.index(kv[0]) if kv[0] in self.actors else -1,
                                       self._said_count.get(kv[0], 0), kv[0]))
        for name, row in order:
            if row["p"] < THRESHOLD:
                break
            if blocked and (human or (name != self.hero and not row["event_hit"])):
                # 2.1: the actors wait for the player exactly as they waited for
                # the hero -- an event cannot buy a third line in a row either
                continue
            return name, ("hero" if name == self.hero else "actor")
        self._diagnostic({"type": "silence", "pressure": table})
        return None, None

    def _dialogue_turn(self):
        """Pick up a finished line, or start one on a free tick (1.2a: nothing
        playing, nothing queued, no worker running, scale(TICK) since the last
        start). A line from an old scene, or
        one overtaken by a human line, is dropped."""
        if self.safety_paused:
            return
        with self._gen_lock:
            res, self._gen_result = self._gen_result, None
        if res is not None:
            line, scene_no, epoch, who = res
            self._gen_who = None
            self._gen_epoch = None
            if line is not None and scene_no == self.n_transitions and epoch == self._turn_epoch:
                self.npc_start(line)
            elif line is not None and epoch != self._turn_epoch:
                # 1.2a: the turn moved on while this line was in flight -- a human
                # line took it, or an event this speaker never saw changed the world
                self._emit({"type": "line_discarded", "turn_owner": "npc",
                            "text": line["text"] if isinstance(line, dict) else line,
                            "who": who, "reason": self._discard_reason})
                self._discard_reason = "human"
            elif line is None:
                self._diagnostic({"type": "turn_skip", "who": who})
                self._gen_not_before = self.clock.now() + self.clock.scale(TICK)
                self._skip_once = who
        busy = self._gen_thread is not None and self._gen_thread.is_alive()
        # 1.2a: a free tick -- nothing playing, nothing queued, no worker running
        if (busy or self.active_line is not None or self.prepared_npc is not None
                or self.next_line is not None):
            return
        if self.fsm.awake or self.stopped or not self._budget_ok():
            return
        now = self.clock.now()
        if now - self._last_tick < self.clock.scale(TICK):
            return
        self._last_tick = now
        if now < self._gen_not_before:
            return
        who, role = self._pick_speaker()
        if who is None:
            return
        world = {"place": self.place, "objects": list(self.scene["objects"]),
                 "actors": list(self.actors)}
        transcript = list(self.transcript)
        if role == "hero":
            world_events, self._hero_world = self._hero_world, []
            args = (world, transcript, world_events)
            fn = self.dialogue.hero_line
        else:
            locked = self.fsm.state in ("building", "ready")
            state = {"build_pct": self.fsm.build_pct(now),
                     "bridge": self.fsm.bridge if locked else None}
            events = self._pending.pop(who, [])
            args = (who, world, transcript, state, list(self._notes.get(who, [])), events,
                    self._personas.get(who, ""))
            fn = self.dialogue.actor_line
        scene_no, epoch = self.n_transitions, self._turn_epoch

        def work():
            line = None
            try:
                line = fn(*args)
            except Exception as e:
                self._diagnostic({"type": "line_fail", "who": who,
                                  "error": "%s: %s" % (type(e).__name__, e)})
            with self._gen_lock:
                self._gen_result = (line, scene_no, epoch, who)

        self._gen_who = who
        self._gen_epoch = epoch
        self._gen_thread = threading.Thread(target=work, daemon=True)
        self._gen_thread.start()

    # --- world input (spec 5a): click, POST /event, stop ---------------------
    def submit(self, kind, payload=None):
        """Thread-safe entry for the server: the main loop applies it on its next tick."""
        self._inbox.put((kind, payload))

    def set_pov(self, owner):
        """2.1: the player takes the hero's turn, or gives it back. While the
        player owns him the NPC hero never speaks, so a hero line already in
        flight or prepared is thrown away the same way a human line throws one
        away -- by moving the turn on."""
        owner = "human" if str(owner) == "human" else "npc"
        self.hero_owner = owner
        out = []
        if owner == "human":
            if (self._gen_who == self.hero
                    and self._turn_epoch == (self._gen_epoch
                                             if self._gen_epoch is not None else -1)):
                self._turn_epoch += 1
                self._discard_reason = "human"
            if (self.prepared_npc is not None
                    and (self._prepared_meta or {}).get("who") == self.hero):
                out.append({"type": "line_discarded", "turn_owner": "npc",
                            "text": self.prepared_npc, "who": self.hero,
                            "reason": "human"})
                self.prepared_npc = None
                self._prepared_meta = None
                self._prepared_audio_seconds = None
        out.append({"type": "pov", "hero_owner": owner})
        for e in out:
            self._emit(e)
        return out

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
            elif kind == "pov":
                self.set_pov(payload)
            elif kind == "continue":
                self.safety_continue()
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
        outcome_raw = payload.get("outcome")
        outcome = ""
        if outcome_raw is not None:
            outcome, more = sanitize(str(outcome_raw), "human")
            rejected += more
        if self._safety_check(value):
            return []
        if outcome and self._safety_check(outcome):
            return []
        if source == "click":
            return self.click(value)
        ev = {"type": "input", "source": source, "value": value}
        if outcome_raw is not None:
            ev["outcome"] = outcome
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
        # 2.1: seq is read BEFORE hero_owner. set_pov assigns the owner and only
        # then logs its pov row, so an owner read after seq is never older than
        # the log at seq -- a pov row the viewer has not seen yet has seq > this
        # and still lands. Read the other way round, a row could hide behind it.
        seq = self.logger.seq if self.logger else 0
        owner = self.hero_owner
        return {"type": "snapshot", "t": now, "live": True,
                "scene": list(self.scene["objects"]), "actors": list(self.scene["actors"]),
                "place": self.place, "hero": self.hero, "speed": self.speed,
                "build_state": self.fsm.state, "bridge": self.fsm.bridge,
                "destination": self.fsm.destination,
                "build_start": self.fsm.build_start,
                "build_pct": self.fsm.build_pct(now), "dollars": get_spent(),
                "max_dollars": self.max_dollars,
                "hero_owner": owner,
                "seq": seq}

    def _tick(self):
        now = self.clock.now()
        self._drain_inbox()
        # 2.2: everything below is the dream running -- lines, fsm timers, scene
        # events, pictures. Only the inbox above keeps working, or "continue" could
        # never arrive.
        if self.safety_paused:
            return []
        self._apply_judge()
        self._fire_due_events()
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
        if self.safety_paused or self.director.in_flight:
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
        # F7: name why the loop ended while the clock is still at the loop end;
        # a `timeout` row in the log is the only proof the limit was reached.
        if self.n_transitions >= max_transitions:
            self.stop_reason = "transitions"
        elif self.clock.now() - start >= max_seconds:
            self.stop_reason = "timeout"
            if self.logger:
                self.logger.write_event({"t": self.clock.now(), "type": "timeout",
                                         "reason": "max_seconds"})
        elif self.stopped:
            self.stop_reason = "stopped"
        elif self.dialogue is not None and self.fsm.awake:
            self.stop_reason = "awake"
        elif not self._budget_ok():
            self.stop_reason = "budget"
        else:
            self.stop_reason = "done"
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


def run(profile="A", fake=True, speed=1.0, max_transitions=2, seed=0, max_seconds=None,
        media=None, max_dollars=20.0, dialogue=None, serve=None, on_sim=None):
    """serve=port (0 = any) starts the comic viewer on the live run (spec 11);
    the dream then goes on until "stop", the budget or a wake_up.
    max_seconds=None: 90 s, or long enough for one full build (420/speed + 120);
    an explicit value is kept as given (the bench passes 67.5)."""
    random.seed(seed)
    base = os.path.join(os.path.dirname(__file__), "..", "out", "dream", profile)
    os.makedirs(base, exist_ok=True)
    # bank.py starts several sims in the same millisecond: take the next free name
    stamp = int(time.time() * 1000) % 1000000
    while True:
        outdir = os.path.join(base, "run_%d_%d" % (seed, stamp))
        try:
            os.makedirs(outdir)
            break
        except FileExistsError:
            stamp += 1
    if serve is not None:
        max_seconds = float("inf")
    elif max_seconds is None:
        # one full build alone takes 420/speed sim-seconds (spec 5); fake or
        # live, the run must at least outlive it plus line playback.
        max_seconds = 90.0
        if max_transitions > 0:
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
    """Slow fake director in a fast world + random TOUCH: races consult_stale (spec 5).
    Nothing leaves `ready` by itself any more, so the runner itself throws a
    [[TOUCH]] at the open door after READY_TOUCH sim-seconds."""
    random.seed(seed)
    rep = {"consult_stale": 0, "bridge_changes_in_building": 0, "exceptions": 0}
    small = {"build": 40, "ready_timeout": 8, "nudge": 10, "force": 20, "min_interval": 1}
    READY_TOUCH = 4.0
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
        ready_since = None
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
            if sim.fsm.state == "ready" and sim.fsm.bridge:
                if ready_since is None:
                    ready_since = sim.clock.now()
                elif sim.clock.now() - ready_since >= sim.clock.scale(READY_TOUCH):
                    sim._touch(sim.fsm.bridge, "stress")
                    ready_since = None
            else:
                ready_since = None
            if sim.fsm.objects and random.random() < 0.3:
                sim._touch(random.choice(sim.fsm.objects), "stress")
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
    ap.add_argument("--scene", default="start", help="opening scene: scenes/<name>.json")
    ap.add_argument("--text", action="store_true",
                    help="dialogue only: no Fish voice, no Muse images (scene bank runs)")
    ap.add_argument("--talk", default="spark-open",
                    help="model for hero/actors/compress: spark-open (free) | spark | wonder")
    ap.add_argument("--max-seconds", type=float, default=None,
                    help="stop after this many real seconds (bench: 67.5); "
                         "default 420/speed + 120, i.e. one full build")
    ap.add_argument("--lang", default="en", choices=lang.LANGS,
                    help="spike 1.5: ru plays the dream in Russian (7.2 row 1.5)")
    args = ap.parse_args()
    lang.set_lang(args.lang)  # spike 1.5: before any prompt is built
    use_scene(args.scene)
    set_talk_model(args.talk)
    set_cap(args.max_dollars)
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
        media = {} if args.text else {"voice": Voice(), "images": Images()}
    outdir, logpath = run(profile=args.profile, fake=args.fake, speed=args.speed,
                           max_transitions=args.max_transitions, media=media,
                           max_dollars=args.max_dollars, dialogue=dialogue,
                           serve=args.port if args.serve else None,
                           max_seconds=args.max_seconds)
    rows = [json.loads(l) for l in open(logpath, encoding="utf-8")]
    transitions = sum(1 for r in rows if r["type"] == "transition")
    stopped = any(r["type"] in ("stop", "wake_up") for r in rows)
    report = verify_run(outdir, logpath, args.max_dollars, actual_spent=get_spent())
    print("outdir=%s transitions=%d files=%d spent=%s"
          % (outdir, transitions, report["checked_files"], report["spent"]))
    for issue in report["issues"]:
        print("issue: " + issue)
    # a run that ran out its --max-seconds is a finished run (debt D5): the number
    # of transitions goes on the sheet, it is not a gate. Only the loop itself
    # confirms the timeout (a `timeout` row in the log): the wall clock around
    # run() also covers waits and checks, so an early budget stop reads as done.
    timed_out = (args.max_seconds is not None
                 and any(r.get("type") == "timeout" for r in rows))
    done = transitions >= args.max_transitions or (args.serve and stopped) or timed_out
    sys.exit(0 if done and report["ok"] else 1)


if __name__ == "__main__":
    main()
