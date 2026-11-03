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
from dialogue import PROMPT_VERSION
from dialogue import Dialogue
from dialogue import (ACTOR_STREAK_MAX, ADDRESS_HOLD, SILENT_CAP, names_in,
                      THRESHOLD, TICK, W_ADDRESSED, W_EVENT_HIT, W_GOAL_OPEN,
                      W_SILENT, W_SPOKE_LAST)
from director import Director, seed_scene
from fsm import BuildFSM
from ideas import ACK_NOT_DELIVERED, IdeaQueue
from inputs import resolve_touch, sanitize
from memory import Memory
from safety import SOFT_NOTE
from safety import match as safety_match
from fake import FakeTransport
import book as bookmod
try:
    from llm import get_spent, IMAGE_PER_PIC, set_talk_model, set_cap, talk_model_name
except ImportError:
    from .llm import get_spent, IMAGE_PER_PIC, set_talk_model, set_cap, talk_model_name
try:
    from images import background_prompt, portrait_prompt
except ImportError:
    from .images import background_prompt, portrait_prompt

VOICES = {"old_woman", "old_man", "woman", "man", "child", "creature"}

def _load_start(name="start"):
    """scenes/<name>.json is the opening scene (spec 9): place, objects, actors
    with their voices, looks and personas, and the hero's situation. The sim,
    the background prompt and TTS all read it. 3.1a: a scene may also come as a
    path (relative to this file, so test fixtures live outside scenes/) or as the
    dict itself -- scenes/ stays the bank's shelf (bank.main)."""
    if isinstance(name, dict):
        return name
    here = os.path.dirname(os.path.abspath(__file__))
    if name.endswith(".json") or os.sep in name:
        path = name if os.path.isabs(name) else os.path.join(here, name)
    else:
        path = os.path.join(here, "scenes", name + ".json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


HERO_SELF = "__hero__"  # a scene names the hero only through its own hero block


def use_scene(name="start"):
    """Pick the opening scene before a Sim is built (--scene): a name in scenes/,
    a path to a json file, or a scene dict."""
    global START, START_SCENE, START_VOICES, START_LOOKS, START_PERSONAS, START_PLACE
    global START_VOICE_IDS
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
    # a scene written by author.py brings voices of its own: {label: Fish id}; only
    # well-formed ids get in, a label never turns into a raw id from a reply
    START_VOICE_IDS = {k: v for k, v in (START.get("voice_ids") or {}).items()
                       if isinstance(v, str) and re.fullmatch(r"[0-9a-f]{32}", v)}


use_scene("start")
HOOK_INDEX = {"A": 0, "B": 3, "C": 5}
DIRECTOR_PER_CALL = 0.02  # one Wonder consult, measured: bank r2, 6 consults ~ $0.12


SOUL_KEYS = ("diary", "wants", "fears", "past_dream", "facts")


def load_profile(pid):
    """Profile soul file (spec 2): hero name and hero voice for playback. A scene
    with a hero of its own (scenes/roof.json: just a man on a roof) replaces the
    profile's hero, and its soul too -- a diary about the fryer has no place there."""
    prof = {}
    if pid is not None:  # 3.3: a seeded dream has no soul file to read
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


# --- book mode (block K): the score is played, nothing is generated -----------
BOOK_PROMPT_WAIT = 12.0  # K3: seconds the prompter waits for the human hero
# B83: the score fields a book beat hands its line (the human hero's line too)
BOOK_BEAT_META = ("stage", "gesture", "remarks", "shot", "tone", "para")


def _load_book_plan(book_dir, scene_ids=None, score=None):
    """book dir (+ optional hand-edited score file/dict/list) -> {"scenes": [...],
    "narrator_voice"}; each scene carries its beats and the dict use_scene() takes."""
    book = bookmod.load_book(book_dir)
    if not scene_ids:
        scene_ids = [book["chapters"][0]["scenes"][0]["id"]]
    scores = {}
    if score is not None:
        if isinstance(score, str):
            with open(score, encoding="utf-8") as f:
                score = json.load(f)
        scores = {sc["scene"]: sc for sc in (score if isinstance(score, list) else [score])}
        if set(scores) != set(scene_ids):
            raise ValueError("score scene mismatch")
    for sid in scene_ids:
        bookmod.find_scene(book, sid)  # a score cannot bring a scene the book lacks
    # freestyle (go_freestyle) needs what a score never does: who the actors are
    # (cast.persona), what the hero wants (cast.soul) and what can be touched (scene.objects)
    cast = book["cast"]
    scenes = []
    for sid in scene_ids:
        sc = scores.get(sid) or bookmod.score_scene(book_dir, sid)
        speaking = {b["who"] for b in sc["beats"] if b["kind"] == "line" and b.get("who")}
        cast_names = sc.get("cast") or list(cast.keys())
        actors = [{"name": n, "look": cast[n]["look"], "voice": cast[n]["voice"],
                   **({"persona": cast[n]["persona"]} if cast[n].get("persona") else {})}
                  for n in cast_names if n in speaking]
        pov = book["pov"]
        hero = {"name": pov, "voice": cast[pov]["voice"], "look": cast[pov]["look"]}
        if cast[pov].get("soul"):
            hero["soul"] = cast[pov]["soul"]
        objects = [str(o) for o in bookmod.find_scene(book, sid)[1].get("objects") or []]
        scenes.append({"scene": sid, "place": sc.get("place", ""), "beats": list(sc["beats"]),
                       "start": list(sc.get("start") or []),
                       "actors": actors,
                       "dict": {"place": sc.get("place", ""), "hero": hero,
                                "actors": actors, "objects": objects, "events": [], "soul": {}}})
    return {"scenes": scenes, "narrator_voice": book.get("narrator_voice") or "old_man"}


def _book_seconds(plan, speed):
    clock = Clock(speed=speed)
    total = sum(clock.scale(line_duration(b["text"]))
                for sc in plan["scenes"] for b in sc["beats"])
    return total * 1.5 + 30.0


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
                 max_dollars=20.0, dialogue=None, first_events=(), book=None,
                 hero_owner=None, no_build=False, build_mode="live", scene_world=None):
        self.profile = profile
        self.book = None  # K2: the score being played (see _book_step)
        self._book_hold_until = -1e9
        self._book_voicing = None  # a narrator beat in Fish TTS (see _book_narrate)
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
        self.hero_owner = "human" if hero_owner == "human" else "npc"
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
        self.place = START_PLACE
        self.transcript = []
        self._notes = {}
        # 0.3: how many of an actor's notes he has already played (spoken after),
        # and how many his prompt in flight was built with
        self._notes_seen = {}
        self._notes_shown = {}
        # 1.3: "Just now" is a queue per recipient -- the hero's is _hero_world,
        # every actor has his own, and a queue nobody owns reaches nobody
        self._hero_world = []
        # door place name ("bedroom door", what the director and the fsm say) -> the engine's door id
        # ("door1", what the engine keys doors by): a door event carries both, or it never swings
        self.door_ids = {}
        self._pending = {}
        self._schedule = []
        # book -> freestyle: the book scenes still ahead, and whether the book's
        # story is being dealt out piece by piece (go_freestyle)
        self._free_book = []
        self._free_story = False
        self._free_lines = 0  # lines said since the last piece of the book came out
        # 3.2: what the narrator still has to voice -- one entry per cause,
        # taken one at a time through the same slot a line uses
        self._narrate = []
        # 3.2 (F1): a narration is being voiced -- a queued line waits for it
        self._narrating = False
        self._fired = set()
        self._discard_reason = "human"
        self._gen_thread = None
        self._gen_taken = None  # B47: (who, role, events) the running worker took
        self._voicing = None  # B49: a line whose voice is synthesized in the background
        self._human_backlog = []  # B46: human lines behind the queued one
        self._gen_who = None
        self._gen_epoch = None
        self._gen_result = None
        self._gen_lock = threading.Lock()
        self._turn_epoch = 0
        self._last_tick = -1e9
        self._prepared_meta = None
        self._prepared_taken = None  # B50: events the prepared line's worker took
        self._inbox = queue.Queue()
        self.stopped = False
        self.clock = Clock(speed=speed)
        self.scene_start = self.clock.now()
        self.scene = dict(START_SCENE)
        self.actors = list(self.scene["actors"])
        self._load_goals(emit=False)
        self.fsm = BuildFSM(self.scene["objects"], voices=VOICES, speed=speed,
                             now=self.clock.now(), params=fsm_params,
                             actors=list(self.actors), hero=self.hero, no_build=no_build,
                             build_mode=build_mode)
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
        # D2: the operator's idea queue (wall clock: hold/retry/delivery are real seconds)
        self.ideas = IdeaQueue(wall=time.monotonic, log=self._diagnostic,
                               effect=self._idea_effect, on_fire=self._idea_fired)
        # D3: a fired steer topic per addressee (None = any NPC of the scene), and the
        # addressed npc cues each played once in the addressee's next line
        self._steer = {}
        self._npc_cues = {}
        self._npc_inflight = {}  # cues at the prompter: fail if the actor leaves pre-line
        self.cleaner = None        # raw -> {clean, intent, addressee?, scene_id?, confidence}
        self.idea_decider = None   # idea -> (fire|hold, short line); None = fake or director LLM
        # decision 6: the known scenes of the world being played (one dist each)
        # F3/F10: no silent fallback to the yard: a registry dict (the active dist's
        # metadata), a known world name, or None = no known scenes ("такого нет")
        if isinstance(scene_world, dict):
            self.scene_world, reg = "dist", scene_world
        elif scene_world is None:
            self.scene_world, reg = None, {}
        elif scene_world in self.SCENE_WORLDS:
            self.scene_world, reg = scene_world, self.SCENE_WORLDS[scene_world]
        else:
            raise ValueError("unknown scene_world %r (known: %s)"
                             % (scene_world, ", ".join(self.SCENE_WORLDS)))
        self.scene_registry = json.loads(json.dumps(reg))
        self._stall_topic = None
        self._stall_empty = 0
        # D4: the cache build an idea started {id, bridge, destination, stall_bank, i}
        self._cache_build = None
        self._silent_since = None
        self._hero_after_abort = None  # sim time until which a silence is the hero's to break
        self._abandoned_workers = []  # F19: director threads of consults given up on (20 s)
        self._clean_cache = {}     # clean text -> draft reply, so an unedited send is not cleaned twice
        self._idea_thread = None
        self._idea_result = None
        self.n_transitions = 0
        self._max_transitions = None  # set by run(); go_freestyle moves it
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
                                      "hero_owner": self.hero_owner,
                                      # which model and prompt version spoke (blind A/B)
                                      "talk": talk_model_name(),
                                      "prompt": PROMPT_VERSION})
            # 3.3: what happened before the sim existed (the seed consult) goes
            # into the log right after the snapshot, in the order it was given
            for ev in first_events or ():
                row = dict(ev)
                row.setdefault("t", self.clock.now())
                self.logger.write_event(row)
        if book is not None:
            self.book = {"scenes": book["scenes"], "i": 0, "over": False, "wait_since": None,
                         "narrator_voice": book.get("narrator_voice"),
                         "beats": [], "cursor": 0}
            self._book_open_scene()
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
        # a book plan lists the hero among the actors too: one "Just now" each
        return [n for n in dict.fromkeys(names) if n == self.hero or n in self.actors]

    def _fire_due_events(self):
        """Checked on every loop step, not only on a free tick: an event is due at
        its own second even if nobody has said a word since the scene started."""
        t_sim = (self.clock.now() - self.scene_start) * self.speed
        for i, ev in enumerate(self._schedule):
            if i in self._fired or ev["t"] > t_sim:
                continue
            piece = ev["kind"] in ("story", "exit")
            if piece and self._free_lines < self.FREE_PIECE_LINES and any(
                    e["kind"] in ("story", "exit") for j, e in enumerate(self._schedule)
                    if j in self._fired):
                # the bar waits for the players: the last piece is not played yet
                continue
            self._fired.add(i)
            if piece:
                self._free_lines = 0
                if self.fsm.state == "idle":
                    self.fsm.idle_since = self.clock.now()  # the story moves: nobody is idle
                # the director knows where the story is, at its next consult; a consult
                # per piece put two orders on every two lines and the talk jumped
                self.director.pending.append(
                    {"type": "story", "value": "STORY NOW (the cast is playing this; "
                                               "do not invent another plot): " + ev["what"]})
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
            if ev["kind"] == "exit":
                self._free_exit()
            if not who and self.dialogue is not None:
                # 3.2: an event nobody sees has no mouth to answer it -- one
                # narration per event, queued, not one per tick
                self._narrate.append({"cause": "event", "context": ev["what"]})

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
        self._join_director()
        if self._gen_thread is not None:
            self._gen_thread.join()
        self._join_judge()
        self.memory.wait()
        if self.dialogue is not None and hasattr(self.dialogue, "wait"):
            self.dialogue.wait()
        voicing = self._voicing
        if voicing is not None and voicing.get("thread") is not None:
            voicing["thread"].join()  # F3: no voice write or charge after close
        self.wait_images()
        self._drain_director()
        if self._storage is not None:
            self._storage.cleanup()
            self._storage = None

    # --- turn management (human replaces npc, spec 5a) ---------------------
    def _count_line(self):
        # 2.2: a paused dream counts nothing -- the count drives the consult cadence
        if self.safety_paused:
            return
        self.line_count += 1
        if self.book is not None:
            return
        if (self.line_count % 4 == 0
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
        if event.get("type") == "door" and "id" not in event:
            did = self.door_ids.get(event.get("object") or self.fsm.bridge)
            if did:
                event["id"] = did
        self._diagnostic(event)
        self.memory.add_event(event)
        kind = event.get("type")
        if getattr(self, "_cache_build", None) is not None and kind in ("door", "build"):
            try:
                return self._emit_world(event, kind)
            finally:
                self._on_build_event(event)
        return self._emit_world(event, kind)

    def _emit_world(self, event, kind):
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
        # 3.1b: a whisper is voiced in full but heard by one name only: the words
        # go to that recipient's "Just now", everybody else gets the fact of it
        whisper_to = line.get("whisper_to")
        if whisper_to:
            line = dict(line, text="<whisper>%s</whisper>" % line["text"],
                        said="[%s whispers to %s]" % (line.get("who") or "?", whisper_to),
                        whispered=line["text"])
        if (self._voice is not None and self.logger is not None and not self.fake
                and not self.safety_paused and self._budget_ok()):
            self._line_seq += 1
            voice_label = line.get("voice")
            if not voice_label:
                if line["owner"] == "human" or line.get("role") == "hero":
                    voice_label = self.hero_voice
                else:
                    # B62: a free line names its speaker in "who"; a book plan lists the hero
                    # first in actors, so actors[0] would lend the actor the hero's voice
                    actor_name = (line.get("actor") or line.get("who")
                                  or (self.actors[0] if self.actors else None))
                    voice_label = self._actor_voices.get(actor_name) or "man"
            path = os.path.join(self._audio_dir, "line_%03d.wav" % self._line_seq)
            # B49: Fish TTS can take 4x15 s; it runs off the loop thread and the
            # line starts (_finish_voicing) on the first tick after it is done
            job = {"line": line, "done": threading.Event(), "res": None}
            # a book line's delivery goes to drama-3 as a [direction]; the subtitle keeps the book's text
            said = "[%s] %s" % (line["tone"], line["text"]) if line.get("tone") else line["text"]

            def synth():
                try:
                    job["res"] = self._voice.synthesize(said, voice_label, path)
                except Exception as e:
                    job["res"] = {"ok": False, "pause": 0.0, "error": "%s: %s" % (type(e).__name__, e)}
                finally:
                    job["done"].set()
            self._voicing = job
            self.active_line = line
            self.playing = True
            self._line_started_at = None
            # gate test_media: the playback slot is known synchronously (tag-free
            # text pause); the voice thread only corrects it via _play_line later.
            # _line_started_at stays None, so no reader treats the line as started.
            self._line_duration = self.clock.scale(line_duration(line["text"], None))
            voice_thread = threading.Thread(target=synth, daemon=True)
            job["thread"] = voice_thread
            voice_thread.start()
            # B19: callers read ev["type"]; the line is announced when its voice is ready
            return {"type": "line_voicing", "turn_owner": line.get("owner"), "text": line["text"]}
        return self._play_line(line, audio_seconds, res, whisper_to)

    def _finish_voicing(self):
        job = self._voicing
        if job is None or not job["done"].is_set():
            return False
        self._voicing = None
        line, res = job["line"], job["res"]
        self.active_line = None
        if res["ok"]:
            line = dict(line, audio=res.get("audio"), dur=res["pause"])
            self._play_line(line, res["seconds"], res, line.get("whisper_to"))
        else:
            line = dict(line, audio=None, dur=res["pause"])
            self._play_line(line, None, res, line.get("whisper_to"))
        return True

    def _play_line(self, line, audio_seconds, res, whisper_to):
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
            for key in ("remarks", "level", "look", "touch", "impulse", "source", "para",
                        "stage", "gesture", "shot", "beat"):
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
        # 1.2b: only a spoken line moves the pressure state (a human line = the hero's).
        # 3.1b: a whisper is heard by one name only, so only that recipient can be
        # addressed by its words; the "who whispers to whom" fact addresses nobody.
        self._note_line(event.get("who") or (self.hero if line["owner"] == "human"
                                             else None),
                        event.get("role") or ("hero" if line["owner"] == "human"
                                              else "actor"),
                        line["whispered"] if whisper_to else line["text"],
                        only=None if not whisper_to else
                        ([whisper_to] if whisper_to in self._cast()
                         else []))
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
        if whisper_to:
            # the same queue a scheduled event uses (1.3), so a whisper to someone
            # who is gone after a transition is dropped, not handed on
            heard = "%s whispers to you, so only you hear it: %s" % (
                event.get("who") or "?", line["whispered"])
            if whisper_to == self.hero:
                self._hero_world.append(heard)
            elif whisper_to in self.actors:
                self._pending.setdefault(whisper_to, []).append(heard)
        # a book line has no Dialogue but is still heard, so it joins the transcript
        if self.dialogue is not None or line.get("source") == "book":
            said = line.get("said") or line["text"]
            self.transcript.append((event.get("who") or "?", said))
            self._free_lines += 1
            if hasattr(self.dialogue, "heard"):
                self.dialogue.heard(event.get("who") or "?", said)
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
        if self.book is not None:
            return self._book_human_say(clean, out)
        if self.prepared_npc is not None:
            out.append({"type": "turn_replace", "turn_owner": "human", "text": clean,
                        "replaced": self.prepared_npc})
            self.prepared_npc = None
            self._prepared_meta = None
            self._prepared_audio_seconds = None
            self._drop_prepared_taken()
        self._turn_epoch += 1
        self._discard_reason = "human"
        out.append({"type": "line_queued", "turn_owner": "human", "text": clean})
        input_ev = {"type": "input", "source": "speech", "value": clean}
        out.append(input_ev)
        if self.next_line is not None and self.next_line.get("owner") == "human":
            self._human_backlog.append({"owner": "human", "text": clean})  # B46: queue, never overwrite
        else:
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
        self._request_background(self.fsm.destination or (self.place if self.book else START_PLACE))
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
    def _new_scene_turns(self):
        """B43/B44: the turn state of the old stage does not cross a scene change --
        who spoke last, the actor streak and the line the old cast prepared. Both
        scene changes (_apply_transition and the book's _book_scene_end) call it."""
        self._spoke_last = None
        self._silent_ticks = {}
        self._addressed = {}
        self._event_hits = {}
        self._actor_streak = 0
        if self.prepared_npc is not None:
            self._emit({"type": "line_discarded", "turn_owner": "npc", "text": self.prepared_npc,
                        "who": (self._prepared_meta or {}).get("who"), "reason": "scene"})
        self.prepared_npc = None
        self._prepared_meta = None
        self._prepared_audio_seconds = None
        self._prepared_taken = None  # the old cast's events stay in the old scene

    def _apply_transition(self):
        self.n_transitions += 1
        ns = self.fsm.next_scene
        self.hero_next = self.fsm.hero_next
        self.place = self.fsm.destination or "scene %d" % self.n_transitions
        if self._free_book:
            # book -> freestyle: whoever opened the door, the book says where it leads
            nxt = self._free_book.pop(0)
            ns = self._free_scene_dict(nxt)
            self.place = nxt["place"]
        self.transcript = self.transcript[-2:]
        self._notes = {}
        self._notes_seen = {}
        self._notes_shown = {}
        self._hero_world = ["you have just arrived in %s" % self.place]
        self._new_scene_turns()
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
            if self.dialogue is not None and hasattr(self.dialogue, "new_scene"):
                self.dialogue.new_scene([self.hero] + list(self.actors))
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
            # D4 F1: a cache build has next_scene None (the room is already in the
            # dist); the FSM still has to leave `transition`, so re-open the idle
            # scene with the current objects/actors instead of staying stuck.
            for e in self.fsm.new_scene(self.clock.now(), self.scene["objects"],
                                        actors=self.actors):
                if self.logger:
                    self.logger.write_event(e)
        # a "Just now" left for someone who is not on this stage is dropped here:
        # the queue is keyed by its recipient, so it can never be handed to another
        self._pending = {k: v for k, v in self._pending.items() if k in self.actors}
        # 3.2: the new place is nobody's line to say, so the narrator says it --
        # queued here, before the schedule, so it is voiced before the first line
        if self.dialogue is not None:
            self._narrate.append({"cause": "transition",
                                  "context": "%s (%s)" % (self.place,
                                                          ", ".join(self.scene["objects"]))})
        self._start_schedule()
        self._load_goals()

    # --- book mode (block K) -----------------------------------------------
    def _book_open_scene(self):
        bk = self.book
        sc = bk["scenes"][bk["i"]]
        bk["beats"] = sc["beats"]
        bk["cursor"] = 0
        bk["wait_since"] = None
        self._diagnostic({"type": "book", "scene": sc["scene"],
                          "beats": [{"kind": b["kind"], "who": b.get("who"), "text": b["text"]}
                                    for b in sc["beats"]]})
        for st in sc.get("start") or []:
            self._emit({"type": "start", **st})

    def _book_waiting(self):
        """K3: the prompter is waiting for the human hero (inside the window)."""
        bk = self.book
        if bk is None or bk["over"] or bk["wait_since"] is None:
            return None
        if self.hero_owner != "human":
            return None
        if self.clock.now() - bk["wait_since"] >= self.clock.scale(BOOK_PROMPT_WAIT):
            return None
        return bk["beats"][bk["cursor"]] if bk["cursor"] < len(bk["beats"]) else None

    def _book_human_say(self, clean, out):
        beat = self._book_waiting()
        if beat is None:
            input_ev = {"type": "input", "source": "speech", "value": clean, "ignored": "book"}
            self._emit(input_ev)
            return out + [input_ev]
        beat_i = self.book["cursor"]
        self.book["cursor"] += 1
        self.book["wait_since"] = None
        self._diagnostic(self.status())
        # B83: the human says the hero's beat in their own words; the beat's staging and
        # delivery are still the score's, exactly as when the book plays the line itself
        self._book_beat_stage(beat)
        line = {"owner": "human", "who": self.hero, "role": "hero",
                "source": "human", "text": clean, "beat": beat_i}
        line.update({k: beat[k] for k in BOOK_BEAT_META if beat.get(k) is not None})
        return out + [self._start_line(line)]

    def _book_beat_stage(self, beat):
        """The stage items of a beat go out before its line (_book_step, _book_human_say)."""
        if not beat.get("stage"):
            return
        stage_items = beat["stage"] if isinstance(beat["stage"], list) else [beat["stage"]]
        for st in stage_items:
            if isinstance(st, dict):
                self._emit({"type": "stage", **st})
            elif isinstance(st, str):
                self._emit({"type": "stage", "action": st})

    def _book_step(self):
        bk = self.book
        if bk["over"]:
            return
        if self._book_voicing is not None:
            self._book_narrated()
            return
        if (self.active_line is not None or self.next_line is not None
                or self._gen_thread is not None or self.clock.now() < self._book_hold_until):
            return
        if bk["cursor"] >= len(bk["beats"]):
            self._book_scene_end()
            return
        now = self.clock.now()
        beat = bk["beats"][bk["cursor"]]
        if (beat["kind"] == "line" and beat.get("who") == self.hero
                and self.hero_owner == "human"):
            if bk["wait_since"] is None:
                bk["wait_since"] = now
                self._diagnostic(self.status())
            if now - bk["wait_since"] < self.clock.scale(BOOK_PROMPT_WAIT):
                return
        if bk["wait_since"] is not None:
            bk["wait_since"] = None
            self._diagnostic(self.status())
        beat_i = bk["cursor"]
        bk["cursor"] += 1
        self._book_beat_stage(beat)
        if beat["kind"] == "line" and beat.get("who"):
            self.npc_start({"who": beat["who"], "actor": beat["who"], "role": "actor",
                            "text": beat["text"], "source": "book", "para": beat.get("para"),
                            "stage": beat.get("stage"), "gesture": beat.get("gesture"),
                            "remarks": beat.get("remarks"), "tone": beat.get("tone"),
                            "shot": beat.get("shot"), "beat": beat_i})
            return
        text = beat["text"] if beat["kind"] == "narration" else '"%s"' % beat["text"]
        voice = self.book.get("narrator_voice") or "old_man"
        if (self._voice is not None and self.logger is not None and not self.fake
                and not self.safety_paused and self._budget_ok()):
            self._book_narrate(text, voice, beat=beat_i)
            return
        self._diagnostic({"type": "narrator", "cause": "book", "text": text, "voice": voice,
                          "beat": beat_i})
        self._book_hold_until = now + self.clock.scale(line_duration(text))

    def _book_narrate(self, text, voice, beat=None):
        """The book's narration is voiced like a line: Fish runs off the loop thread (B49), the
        score waits for it, the narrator event then carries the audio and the hold is its length."""
        self._line_seq += 1
        path = os.path.join(self._audio_dir, "line_%03d.wav" % self._line_seq)
        job = {"text": text, "voice": voice, "done": threading.Event(), "res": None, "beat": beat}

        def synth():
            try:
                job["res"] = self._voice.synthesize(text, voice, path)
            except Exception as e:
                job["res"] = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
            finally:
                job["done"].set()
        self._book_voicing = job
        threading.Thread(target=synth, daemon=True).start()

    def _book_narrated(self):
        job = self._book_voicing
        if not job["done"].is_set():
            return
        self._book_voicing = None
        res = job["res"] or {}
        event = {"type": "narrator", "cause": "book", "text": job["text"], "voice": job["voice"]}
        if job.get("beat") is not None:
            event["beat"] = job["beat"]
        seconds = None
        if res.get("ok") and res.get("audio"):
            seconds = res.get("seconds", res.get("pause"))
            event["audio"] = os.path.relpath(res["audio"], self.outdir)
            event["dur"] = seconds
        else:
            err = res.get("error") or {}
            self._diagnostic({"type": "tts_fail", "who": "narrator",
                              "error": str(err.get("error") if isinstance(err, dict) else err)})
        self._diagnostic(event)
        self._book_hold_until = self.clock.now() + self.clock.scale(line_duration(job["text"], seconds))

    def _book_scene_end(self):
        bk = self.book
        cur = bk["scenes"][bk["i"]]
        if bk["i"] + 1 >= len(bk["scenes"]):
            self._diagnostic({"type": "book_end", "scene": cur["scene"],
                              "beats": len(bk["beats"])})
            bk["over"] = True
            self.stop(by="book")
            return
        bk["i"] += 1
        nxt = bk["scenes"][bk["i"]]
        self._diagnostic({"type": "transition", "to": nxt["place"], "scene": nxt["scene"],
                          "cause": "book"})
        # the fields _apply_transition refreshes, minus the fsm and the Spark memory merge
        self.n_transitions += 1
        self.place = nxt["place"]
        self.transcript = self.transcript[-2:]
        self._notes = {}
        self._notes_seen = {}
        self._notes_shown = {}
        self._hero_world = []
        self._pending = {}
        self._new_scene_turns()
        self._said_count = {}
        self.scene = {"objects": list(nxt["dict"]["objects"]),
                      "actors": [a["name"] for a in nxt["actors"]], "events": [], "goals": []}
        self.actors = [a["name"] for a in nxt["actors"]]
        self._actor_voices = {a["name"]: a["voice"] for a in nxt["actors"]}
        self._looks.update({a["name"]: a["look"] for a in nxt["actors"]})
        self._personas = {a["name"]: a["persona"] for a in nxt["actors"] if a.get("persona")}
        self.director.actors = self.actors
        self.director.notes_given = []
        self.memory.set_scene(self.place, list(self.scene["objects"]))
        if self._media_live():
            self._request_background(self.place)
            self._start_scene_portraits()
        self._diagnostic(self.status())
        self._book_open_scene()

    # --- book -> freestyle: one button, in the middle of a scene ---------------
    FREESTYLE_STORY_MAX = 1200

    def _book_story(self):
        """What the book still had to tell, as one English note: the narration
        beats left in this scene, then where the later scenes take place."""
        try:
            from voice import strip_tags
        except ImportError:  # pragma: no cover
            from .voice import strip_tags
        bk = self.book
        said = [strip_tags(b["text"]) for b in bk["beats"][bk["cursor"]:] if b["kind"] == "narration"]
        later = [sc["place"] for sc in bk["scenes"][bk["i"] + 1:]]
        story = " ".join(said)
        if later:
            story += " Then the story moves on to: " + "; ".join(later) + "."
        story = story.strip()[:self.FREESTYLE_STORY_MAX]
        if not story:
            return ""
        return ("The book this dream comes from goes on like this. Head toward it in your own words, "
                "in your own time, never recite it: " + story)

    FREE_PIECE_SECONDS = 45.0  # simulated seconds between two pieces of the book
    FREE_DOOR_SECONDS = 45.0   # an open door the story waits at, then carries them through
    FREE_PIECE_MAX = 600
    FREE_PIECE_LINES = 6       # lines the players say on a piece before the next comes out

    def _free_pieces_left(self):
        return any(e["kind"] in ("story", "exit") for i, e in enumerate(self._schedule)
                   if i not in self._fired)

    def _free_pieces(self, beats):
        """The book cut where its narrator speaks: each piece is what happens there
        and roughly what is said, for the cast to play in their own words."""
        try:
            from voice import strip_tags
        except ImportError:  # pragma: no cover
            from .voice import strip_tags
        pieces = []
        for b in beats:
            if b["kind"] == "narration" or not pieces:
                pieces.append({"what": "", "said": []})
            if b["kind"] == "narration":
                pieces[-1]["what"] = strip_tags(b["text"])
            elif b.get("who"):
                pieces[-1]["said"].append('%s: "%s"' % (b["who"], strip_tags(b["text"])))
        out = []
        for p in pieces:
            text = "The story moves on" + (": " + p["what"] if p["what"] else ".")
            if p["said"]:
                text += " In the book it goes roughly like this: " + " ".join(p["said"])
            text += " Play this moment your own way, in your own words; never recite it."
            out.append(text[:self.FREE_PIECE_MAX])
        return out

    def _free_events(self, beats, t0):
        """Schedule rows for a scene's pieces from simulated second t0; when a book
        scene follows, a last `exit` row opens the way to it."""
        evs = [{"t": t0 + k * self.FREE_PIECE_SECONDS, "what": w, "who": "all", "kind": "story"}
               for k, w in enumerate(self._free_pieces(beats))]
        if self._free_book:
            evs.append({"t": t0 + len(evs) * self.FREE_PIECE_SECONDS, "who": "all", "kind": "exit",
                        "what": "This part of the story is told: it is time to go on to %s."
                                % self._free_book[0]["place"]})
        return evs

    def _free_scene_dict(self, nxt):
        """A book scene as the next_scene a transition applies, its pieces as events."""
        return {"objects": list(nxt["dict"]["objects"]), "actors": [dict(a) for a in nxt["actors"]],
                "events": self._free_events(nxt["beats"], 0.0), "goals": [], "hero_reason": None}

    def _free_exit(self):
        """A book scene is told: a door toward the next one opens (unless the
        director already built a way out). The book's places are already built,
        so the build is over at once and the door opens on the next tick."""
        if not self._free_book or self.fsm.state != "idle":
            return
        objs = list(self.scene["objects"])
        door = next((o for o in objs if "door" in o), objs[0] if objs else None)
        if door is None:
            return
        now = self.clock.now()
        for e in self.fsm.start_build(now, door, self._free_book[0]["place"]):
            self._emit(e)
        self.fsm.build_start = now - self.fsm.p["build"]

    def go_freestyle(self, dialogue=None):
        """The score stops at the next beat and the same cast improvises on from
        the same moment: place, transcript, the line now playing and the stage
        stay. The rest of the book is not handed over at once: it is cut where
        its narrator speaks and dealt out on the scene's schedule, one piece every
        FREE_PIECE_SECONDS, like a loading bar; the director hears the whole arc.
        When a scene's pieces are told its door opens, and the next book scene is
        where any door leads. From here lines are Dialogue's and the director
        consults; one dream transition past the book ends it, as in a free run."""
        bk = self.book
        if bk is None or bk["over"]:
            ev = {"type": "input", "source": "freestyle", "value": "", "ignored": "not a book"}
            self._emit(ev)
            return [ev]
        cur = bk["scenes"][bk["i"]]
        at, total = bk["cursor"], len(bk["beats"])
        story = self._book_story()
        self.book = None
        self._book_hold_until = -1e9
        if dialogue is not None:
            self.dialogue = dialogue
        if self.dialogue is None:
            self.dialogue = Dialogue(load_profile(None))
        if hasattr(self.dialogue, "heard"):
            self.dialogue.on_memory = self._on_memory
        if getattr(self.dialogue, "event_sink", None) is None:
            self.dialogue.event_sink = self._diagnostic
        # the book's fsm was built for the first scene and never ticked: it now
        # touches what is in this scene
        self.fsm.objects = list(self.scene["objects"])
        self._free_book = list(bk["scenes"][bk["i"] + 1:])
        self._free_story = True
        self._max_transitions = self.n_transitions + len(self._free_book) + 1
        t0 = (self.clock.now() - self.scene_start) * self.speed
        pieces = self._free_events(bk["beats"][at:], t0)
        self._schedule += pieces
        ev = {"type": "mode", "mode": "freestyle", "scene": cur["scene"],
              "at_beat": at, "of": total, "story": story, "pieces": len(pieces)}
        self._diagnostic(ev)
        self._diagnostic({"type": "schedule", "events": pieces})
        self._last_tick = -1e9  # the first improvised line starts on the next free tick
        self._diagnostic(self.status())
        self.director.consult_async(self.clock.now(), events=[ev])
        return [ev]

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
        if self._voicing is not None:
            self._finish_voicing()
            return
        if self.active_line is not None:
            if self._line_started_at is not None and now - self._line_started_at < self._line_duration:
                return
            self.active_line = None
            # 1.2a: the step that ends a line is itself a free tick
            self._last_tick = now - self.clock.scale(TICK)
        queued = None
        audio_seconds = None
        if self._narrate or self._narrating:
            # F1: the narrator speaks before the first line -- a queued line
            # (human or prepared NPC) waits for the pending/in-flight narration
            return
        if self.next_line is not None:
            queued, self.next_line = self.next_line, None
            if self._human_backlog:
                self.next_line = self._human_backlog.pop(0)
        elif self.prepared_npc is not None:
            meta = dict(self._prepared_meta or {})
            who = meta.get("who")
            if (who is not None and who != getattr(self, "hero", None)
                    and who not in self.actors):
                # F3: prepared while present, gone before voicing -- no line
                # from a missing actor; his cues fail explicitly
                text, self.prepared_npc = self.prepared_npc, None
                self._prepared_meta = None
                self._prepared_audio_seconds = None
                self._drop_prepared_taken()
                self._recycle_npc_cues(who)
                self._emit({"type": "line_discarded", "turn_owner": "npc",
                            "text": text, "who": who, "reason": "addressee_gone"})
                queued = None
            else:
                queued = dict(meta, owner="npc", text=self.prepared_npc)
                self.prepared_npc = None
                self._prepared_meta = None
                self._prepared_taken = None
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

    def _note_line(self, who, role, text, only=None):
        """A line really spoken moves the pressure state: its author stops being
        silent and becomes `spoke_last`, everyone it names by name is addressed.
        A human line arrives here as the hero's line (owner/role set in _start_line).
        `only`: restrict who may be addressed by this line (a whisper's recipient);
        nobody else is marked, even if named in the words only one ear heard."""
        if not who:
            return
        self._spoke_last = who
        self._silent_ticks[who] = 0
        self._addressed.pop(who, None)
        self._event_hits.pop(who, None)
        self._actor_streak = self._actor_streak + 1 if role == "actor" else 0
        self._said_count[who] = self._said_count.get(who, 0) + 1
        steers = getattr(self, "_steer", {})  # tests build a bare Sim without __init__
        for key in (who, None):
            s = steers.get(key)
            if s is not None and (key == who or role == "actor"):
                s["left"] -= 1
                if s["left"] <= 0:
                    steers.pop(key)
        inflight = getattr(self, "_npc_inflight", None)  # 2в: his line played the cue
        if inflight is not None:
            inflight.pop(who, None)
        if role == "actor":
            # 0.3: the notes his prompt was built with are now played; a note that
            # landed while the line was being written stays for his next prompt
            self._notes_seen[who] = self._notes_shown.pop(who, len(self._notes.get(who, [])))
        targets = self._cast() if only is None else [n for n in only if n in self._cast()]
        # 0.1: a part of a name ("Ashley" of "Ashley Wilkes") addresses too, see names_in
        for other in names_in(text, targets):
            if other != who:
                self._addressed[other] = ADDRESS_HOLD
        # a duo has nobody else to talk to: every line is the other one's cue, or he
        # waits out the silence pressure (8 s of dead air on the live duo runs)
        pair = list(dict.fromkeys(targets))
        if len(pair) == 2 and who in pair:
            self._addressed[pair[1 - pair.index(who)]] = ADDRESS_HOLD

    def _notes_for(self, who):
        """The director's notes an actor still has to play: the last one not yet
        followed by a line of his (0.3: played notes left the prompt, and the
        prompt holds one note, not the whole history)."""
        notes = self._notes.get(who, [])
        return list(notes[self._notes_seen.get(who, 0):][-1:])

    def _line_notes(self, who, consume=False):
        """D3: the notes an actor's next line is built with -- the operator's addressed
        npc cue first (decision 7), then the steer topic, then the director's note,
        in the one notes slot actor_system shows. `consume`: the npc cue is played
        by this line (once). TRIED is never touched: the topic is its own field."""
        cues = [c["text"] for c in getattr(self, "_npc_cues", {}).get(who, [])]
        self._expire_steer()
        steer = self._steer.get(who) or self._steer.get(None)
        parts = []
        # D4 F11: the stall lives to `ready` beside the steer, which keeps its own K / TTL
        topic = "; ".join(t for t in (steer["topic"] if steer is not None else None,
                                      getattr(self, "_stall_topic", None)) if t)
        if cues:
            parts.append("do this in this very line: %s" % "; ".join(cues))
            if topic:  # decision 7: the addressed cue outranks the common topic
                parts.append("after that, not in this line, steer the talk to this: %s" % topic)
        elif topic:
            parts.append("steer the talk to this: %s" % topic)
        notes = self._notes_for(who)
        if consume:
            taken = getattr(self, "_npc_cues", {}).pop(who, None)
            if taken:
                inflight = getattr(self, "_npc_inflight", None)
                if inflight is None:
                    self._npc_inflight = inflight = {}
                inflight.setdefault(who, []).extend(taken)
        if not parts:
            return notes
        return ["; ".join(parts + notes)]

    def _expire_steer(self):
        now = self.ideas.wall()
        for key in [k for k, v in self._steer.items() if now >= v["until"]]:
            self._steer.pop(key)

    def _recycle_npc_cues(self, who):
        """F3/F4: an npc cue is lost only with a played line of its addressee. A
        failed generation or a discarded result gives the cue back for his next
        line; a gone addressee fails the idea instead (2в: addressee_gone)."""
        inflight = getattr(self, "_npc_inflight", None)
        if not inflight:
            return
        cues = inflight.pop(who, None)
        if not cues:
            return
        actors = getattr(self, "actors", None)
        if actors is not None and who in actors:
            self._npc_cues.setdefault(who, [])
            self._npc_cues[who][:] = list(cues) + self._npc_cues[who]
        elif getattr(self, "ideas", None) is not None:
            for cue in cues:
                self.ideas.fail(cue["id"], "addressee_gone")

    def _idea_fired(self, idea):
        """D3: a fired steer/npc goes into the dialogue (the queue already logged op:fire)."""
        if idea["intent"] == "steer":
            # decision 7: a new steer for the same NPC replaces the old one
            self._steer[idea.get("addressee")] = {
                "id": idea["id"], "topic": idea["clean"], "left": self.STEER_LINES,
                "until": self.ideas.wall() + self.STEER_TTL_S}
        elif idea["intent"] == "npc" and idea.get("addressee"):
            self._npc_cues.setdefault(idea["addressee"], []).append(
                {"id": idea["id"], "text": idea["clean"]})

    def _pick_speaker(self):
        """One free tick: silence grows for everyone, pressure is logged, and the
        loudest above THRESHOLD speaks. After ACTOR_STREAK_MAX actor lines in a row
        no actor is picked -- their pressure is still counted and written, but only
        the hero (or, from 1.3, an event) breaks through; the hero gets there on the
        silence term alone. Nobody above the threshold -> (None, None) and `silence`."""
        # 2.1: while the player owns the hero he is not in the cast at all --
        # neither picked nor written into `pressure`
        human = self.hero_owner == "human"
        # an empty scene (check_scene keeps 1-5 actors, so only a broken transition
        # gets here) is no exception: the NPC hero goes through the same formula
        if not self.actors and human:
            return None, None
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
        # 7.4: the table is written on every free tick, also when it repeats
        # (silent saturates at SILENT_CAP and the table stops changing)
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

    def _drop_prepared_taken(self):
        """B50: a prepared line thrown away gives its events back, as B47 does."""
        taken, self._prepared_taken = self._prepared_taken, None
        if taken is not None:
            self._return_taken(taken)

    def _return_taken(self, taken):
        who, role, events = taken
        if not events:
            return
        if role == "hero":
            self._hero_world = list(events) + self._hero_world
        elif who in self.actors:
            self._pending[who] = list(events) + self._pending.get(who, [])

    def _start_narration(self, req):
        """3.2: the narrator takes the generation slot a line takes, so he is never
        in flight beside a line and is voiced before the first line of a new scene."""
        cause, context = req["cause"], req["context"]
        scene_no, epoch = self.n_transitions, self._turn_epoch
        self._narrating = True

        def work():
            text = ""
            try:
                text = self.dialogue.narrate(cause, context)
            except Exception as e:
                self._diagnostic({"type": "line_fail", "who": "narrator",
                                  "error": "%s: %s" % (type(e).__name__, e)})
            with self._gen_lock:
                self._gen_result = ({"role": "narrator", "cause": cause,
                                     "text": text}, scene_no, epoch, None)

        # no _gen_who: an event must not bump the turn because of a narration
        self._gen_who = None
        self._gen_epoch = None
        self._gen_taken = None
        self._gen_thread = threading.Thread(target=work, daemon=True)
        self._gen_thread.start()

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
            taken, self._gen_taken = self._gen_taken, None
            accepted = (isinstance(line, dict) and line.get("role") != "narrator"
                        and scene_no == self.n_transitions and epoch == self._turn_epoch)
            if taken is not None and not accepted:
                self._return_taken(taken)  # B47: a dropped turn gives its events back
            self._gen_who = None
            self._gen_epoch = None
            if isinstance(line, dict) and line.get("role") == "narrator":
                # 3.2: a narration is not a line -- no npc_start, no _note_line,
                # no _count_line: it moves neither pressure nor the consult count.
                # No turn to lose either: a human line that moved the epoch while
                # the narration was in flight waits for it in _cycle_line (F1),
                # so the narration is still voiced before the first line.
                self._narrating = False
                if line.get("text"):
                    self._diagnostic({"type": "narrator", "text": line["text"],
                                      "cause": line["cause"]})
            elif line is not None and scene_no == self.n_transitions and epoch == self._turn_epoch:
                actors = getattr(self, "actors", None)
                if (who is not None and who != getattr(self, "hero", None)
                        and actors is not None and who not in actors):
                    # F3: the addressee left while his line was in flight -- no
                    # line from a missing actor; his cues fail explicitly
                    self._recycle_npc_cues(who)
                    self._return_taken(taken)
                    self._emit({"type": "line_discarded", "turn_owner": "npc",
                                "text": line["text"] if isinstance(line, dict) else line,
                                "who": who, "reason": "addressee_gone"})
                else:
                    ev = (self.npc_start(line) or [None])[0] or {}  # B19: a voicing line has no event yet
                    if ev.get("type") == "line_prepared":
                        self._prepared_taken = taken
                    elif ev.get("type") == "line_discarded" and taken is not None:
                        self._return_taken(taken)
                        self._recycle_npc_cues(who)  # F4: not played, try again next line
            elif line is not None and epoch != self._turn_epoch:
                # 1.2a: the turn moved on while this line was in flight -- a human
                # line took it, or an event this speaker never saw changed the world
                self._emit({"type": "line_discarded", "turn_owner": "npc",
                            "text": line["text"] if isinstance(line, dict) else line,
                            "who": who, "reason": self._discard_reason})
                self._recycle_npc_cues(who)  # F4: the turn moved on, the cue waits
                self._discard_reason = "human"
            elif line is None:
                self._diagnostic({"type": "turn_skip", "who": who})
                self._recycle_npc_cues(who)  # F4: the generation failed, the cue waits
                self._gen_not_before = self.clock.now() + self.clock.scale(TICK)
                self._skip_once = who
        busy = self._gen_thread is not None and self._gen_thread.is_alive()
        # 1.2a: a free tick -- nothing queued, no worker running. B50: a playing line
        # does not block it, so the next line is ready when this one ends
        # B43/B39: any queued line -- the human's next_line or a prepared NPC line --
        # waits for pending narration (_cycle_line), so the narration must still be
        # allowed to start here or both wait forever
        queued = self.next_line is not None or self.prepared_npc is not None
        if busy or (queued and not self._narrate):
            return
        if self.fsm.awake or self.stopped or not self._budget_ok():
            return
        now = self.clock.now()
        if now - self._last_tick < self.clock.scale(TICK):
            return
        self._last_tick = now
        if now < self._gen_not_before:
            return
        if self._narrate:
            self._start_narration(self._narrate.pop(0))
            return
        who, role = self._pick_speaker()
        if who is None:
            return
        world = {"place": self.place, "objects": list(self.scene["objects"]),
                 "actors": list(self.actors)}
        transcript = list(self.transcript)
        taken = None
        if role == "hero":
            world_events, self._hero_world = self._hero_world, []
            taken = (who, role, list(world_events))
            args = (world, transcript, world_events)
            fn = self.dialogue.hero_line
        else:
            locked = self.fsm.state in ("building", "ready")
            state = {"build_pct": self.fsm.build_pct(now),
                     "bridge": self.fsm.bridge if locked else None}
            events = self._pending.pop(who, [])
            taken = (who, role, list(events))
            self._notes_shown[who] = len(self._notes.get(who, []))
            args = (who, world, transcript, state, self._line_notes(who, consume=True), events,
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
        self._gen_taken = taken
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
        if owner != "human" and self.book is not None:
            self.book["wait_since"] = None
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
                self._drop_prepared_taken()
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
            elif kind == "freestyle":
                self.go_freestyle()

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
        if self.book is not None:
            ev = {"type": "input", "source": "click", "value": clean}
            self._emit(ev)
            return [ev]
        obj, evs = resolve_touch(clean, self.fsm.objects)
        for e in evs:
            self._emit(e)
        if obj is not None:
            # the engine's stage walks the hero to what was clicked (its `touch` handler had no sender:
            # a hero's line carries `touch` itself, a click did not reach the engine at all)
            self._emit({"type": "touch", "who": self.hero, "object": obj, "source": "click"})
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
        if source == "click" and self.book is None:
            return self.click(value)
        ev = {"type": "input", "source": source, "value": value}
        if outcome_raw is not None:
            ev["outcome"] = outcome
        for e in rejected:
            self._emit(e)
        self._emit(ev)
        if self.book is None:
            self.director.consult_async(self.clock.now(), events=[ev])
        return [ev]

    # --- D2: operator ideas (POST /event kind draft|idea|idea_drop|effect_ack) ----
    CLEAN_TIMEOUT_S = 8.0
    # D4 (decision 6): scene_id -> {bridge, destination, build_s, next_scene, aliases,
    # stall_bank}. koshakan = the test world (bedroom -> bathroom door plays the shop);
    # kozb7_yard waits for D0: its door and room ids are placeholders until the dist exists
    SCENE_WORLDS = {
        "koshakan": {"koshakan_shop": {
            "bridge": "door", "destination": "bathroom", "build_s": 45, "next_scene": None,
            "aliases": ["внутри магазина", "в магазин", "в магазине"],
            "stall_bank": ["Погоди, дверь что-то заело. Расскажи пока, как ты сюда добрался?",
                           "Слышишь? За дверью кто-то возится. Давай подождём, поболтаем.",
                           "Пока не открыли, скажи: ты сам-то что хотел там купить?"]}},
        "kozb7_yard": {"kozb7_yard_shop": {
            "bridge": "shop_door", "destination": "shop", "build_s": 45, "next_scene": None,
            "aliases": ["внутри магазина", "в магазин", "в магазине"],
            "stall_bank": ["Магазин ещё закрыт, сейчас откроют. Как там у тебя дома?",
                           "Глянь, продавщица уже гремит ключами. Подождём чуток.",
                           "Пока ждём, расскажи, во что вы тут во дворе играли?"]}},
    }
    STALL_TOPIC = ("keep the hero busy talking right here until the door opens; "
                   "small talk about this place, never about waiting")
    STALL_SILENCE_S = 4.5  # D4: silence step; consult, consult, bank = 13.5 s < 15 s
    CONSULT_GIVE_UP_S = 20.0
    HERO_AFTER_ABORT_S = 20.0
    HERO_LINE_LEAD_S = 2.0  # F18: the hero's line starts this long before the 20 s run out
    HERO_AFTER_ABORT_TEXT = "Ладно, не открывается. Ну и пусть, давай тут."
    STEER_LINES = 6     # D3: K lines of the addressee (any NPC without one)
    STEER_TTL_S = 60.0  # wall seconds; a steer not used up by then expires
    IDEA_CONSULT_S = 20.0
    _FILLERS = re.compile(r"\b(э+-?э*|эм+|ну|короче|типа)\b[,]?\s*", re.I)
    _STEER_WORDS = ("поговори", "обсуди", "расскажи", "уведи", "говорите", "тема")
    _SCENE_WORDS = ("магазин", "сцен", "внутри", "строить")

    def _fake_clean(self, raw):
        text = raw
        low = text.lower()
        for mark in ("я имел в виду", "то есть", "нет,"):
            i = low.rfind(mark)
            if i >= 0:
                text = text[i + len(mark):]
                low = text.lower()
        text = self._FILLERS.sub("", text).strip(" ,.-")
        low = text.lower()
        if any(w in low for w in self._SCENE_WORDS):
            intent = "scene"
        elif any(w in low for w in self._STEER_WORDS):
            intent = "steer"
        else:
            intent = "unknown"
        return {"clean": text, "intent": intent,
                "confidence": 0.9 if intent != "unknown" else 0.0}

    def _llm_clean(self, raw):
        import llm
        scenes = {k: v.get("aliases", []) for k, v in self.scene_registry.items()}
        system = ("Ты чистишь черновик команды режиссёру сна. Убери оговорки и самоисправления "
                  "(«я имел в виду» = главное то, что после). Ответь только JSON: "
                  '{"clean": "одна команда", "intent": "steer|scene|spawn|npc|unknown", '
                  '"addressee": "имя или null", "scene_id": "id или null", "confidence": 0..1}. '
                  "Актёры: %s. Сцены и алиасы: %s." % (", ".join(self.actors),
                                                      json.dumps(scenes, ensure_ascii=False)))
        res = llm.call("idea", system, [{"role": "user", "content": raw}], max_tokens=300)
        m = re.search(r"\{.*\}", res.text or "", re.S)
        return json.loads(m.group(0)) if m else {}

    def _scene_for(self, out, raw):
        """Decision 6: scene_id only from known scenes, by alias; 0 or 2+ matches -> unclear."""
        low = (str(out.get("clean") or "") + " " + raw).lower()
        hits = [k for k, v in self.scene_registry.items()
                if any(str(a).lower() in low for a in v.get("aliases", []))]
        return hits[0] if len(hits) == 1 else None  # the model's own scene_id is never trusted

    def clean_draft(self, payload):
        rev = payload.get("draft_revision")
        raw = sanitize(str(payload.get("value") or ""), "human")[0]
        if raw and self._safety_check(raw):
            # decision 9: a visible dropped/safety idea, not a bare clean error
            iid = str(payload.get("id") or "draft-%s-%d" % (rev, int(time.time() * 1000)))[:80]
            self.ideas.add({"id": iid, "source": payload.get("source"), "value": raw,
                            "intent": "unknown"}, unsafe=True)
            return {"draft_revision": rev, "error": "safety", "reason": "safety"}
        reply = self._clean_text(raw, rev)
        if "clean" in reply:
            if len(self._clean_cache) > 50:
                self._clean_cache.clear()
            self._clean_cache[reply["clean"]] = reply
        return reply

    def _clean_text(self, raw, rev=None):
        cleaner = self.cleaner or (self._fake_clean if self.fake else self._llm_clean)
        box = {}

        def work():
            try:
                box["out"] = cleaner(raw)
            except Exception as e:  # the panel shows the error, the text stays
                box["error"] = str(e)[:200]
        th = threading.Thread(target=work, daemon=True)
        th.start()
        th.join(self.CLEAN_TIMEOUT_S)
        out = box.get("out")
        if th.is_alive() or not isinstance(out, dict) or not out.get("clean"):
            self._diagnostic({"type": "idea", "op": "clean_failed", "draft_revision": rev,
                              "error": box.get("error") or ("timeout" if th.is_alive() else "empty")})
            return {"draft_revision": rev, "error": "clean_failed"}
        clean = sanitize(str(out.get("clean")), "human")[0]
        if not clean or self._safety_check(clean):
            self._diagnostic({"type": "idea", "op": "clean_failed", "draft_revision": rev,
                              "error": "safety"})
            return {"draft_revision": rev, "error": "clean_failed"}
        intent = out.get("intent") if out.get("intent") in ("steer", "scene", "spawn", "npc") else "unknown"
        try:
            conf = max(0.0, min(1.0, float(out.get("confidence", 0.0))))
        except (TypeError, ValueError):
            conf = 0.0
        reply = {"draft_revision": rev, "clean": clean, "intent": intent, "confidence": conf}
        if out.get("addressee"):
            reply["addressee"] = sanitize(str(out["addressee"]), "human")[0][:80]
            if reply["addressee"] and self._safety_check(reply["addressee"]):
                return {"draft_revision": rev, "error": "clean_failed"}
        if intent == "scene":
            sid = self._scene_for(out, raw)
            if sid is None:
                reply.update(confidence=0.0, reason="scene")
            else:
                reply["scene_id"] = sid
        return reply

    def post_idea(self, payload):
        value = sanitize(str(payload.get("value") or ""), "human")[0]
        raw = sanitize(str(payload.get("raw") or value), "human")[0]
        addr = sanitize(str(payload.get("addressee") or ""), "human")[0]
        unsafe = any(t and self._safety_check(t) for t in (raw, value, addr))
        # D2 debt: a repeat of a known id gets its first answer, even after the clean cache was
        # cleared or a re-clean would fail now (idempotency was only inside ideas.add)
        prior = self.ideas.reply_of(payload.get("id"))
        if prior is not None:
            return prior
        p = {k: payload.get(k) for k in ("id", "source", "now") if payload.get(k) is not None}
        p.update(value=value, raw=raw)
        if unsafe or not value:
            p["intent"] = "unknown"
            return self.ideas.add(p, unsafe=unsafe)
        # the meaning is the server's: the client may have edited the cleaned text after the
        # draft, so use the cached draft answer for this exact text or clean it again
        res = self._clean_cache.get(value) or self._clean_text(value)
        if "clean" not in res:
            return {"ok": False, "id": str(payload.get("id") or ""), "error": "clean_failed"}
        p["value"] = res["clean"]  # the re-clean result, not the client's text
        for k in ("intent", "confidence", "addressee", "scene_id"):
            if res.get(k) is not None:
                p[k] = res[k]
        if res.get("reason") == "scene":
            p["unclear_text"] = "не понял, какую сцену"
        return self.ideas.add(p, unsafe=False)

    def drop_idea(self, payload):
        return self.ideas.drop(str(payload.get("id") or ""))

    def effect_ack(self, payload):
        return self.ideas.effect_ack(str(payload.get("id") or ""))

    def ideas_state(self):
        keep = ("id", "source", "raw", "clean", "status", "retry_at", "drop_requested", "intent",
                "addressee", "scene_id", "created_t", "fired_t", "reason", "wait", "now")
        return {"ideas": [{k: v for k, v in it.items() if k in keep} for it in self.ideas.list()]}

    def _idea_effect(self, idea):
        # scene = D4 (cache build + placard); spawn is D5; the engine answers with effect_ack
        self._diagnostic({"type": "idea_effect", "id": idea["id"], "intent": idea["intent"],
                          "scene_id": idea.get("scene_id")})
        if idea["intent"] == "scene":
            self._start_scene_build(idea)

    # --- D4: the next scene as a cache build on the FSM ---------------------
    def _start_scene_build(self, idea):
        entry = self.scene_registry.get(idea.get("scene_id")) or {}
        if not entry.get("bridge") or not entry.get("destination"):
            self._diagnostic({"type": "idea_effect", "id": idea["id"], "intent": "scene",
                              "reason": "no_destination"})
            self.ideas.fail(idea["id"], "build_refused", ACK_NOT_DELIVERED)
            return
        now = self.clock.now()
        ns = entry.get("next_scene")
        if not ns:
            # F1/F8: the room is already in the dist; the scene context after the walk is
            # the destination room, the cast comes along
            ns = {"objects": [entry["destination"]], "events": [], "goals": []}
        if ns.get("actors") is None:
            # F15: a registry from the dist (make.play scene_registry) names the room's things;
            # the cast walks in with the hero
            ns = dict(ns, actors=list(self.scene.get("actors") or []))
        ev = self.fsm.start_build(now, entry.get("bridge"), entry.get("destination"), ns)
        if ev[0]["type"] == "invalid":
            for e in ev:
                self._emit(e)
            self.ideas.fail(idea["id"], "build_refused", ACK_NOT_DELIVERED)
            return
        self._cache_build = {"id": idea["id"], "bridge": entry["bridge"],
                             "destination": entry["destination"],
                             "stall_bank": list(entry.get("stall_bank") or []), "i": 0}
        for e in ev:
            self._emit(e)
        # decision 5: the placard hangs on the door from start_build; its id is what the
        # engine confirms with effect_ack
        self._emit({"type": "placard", "door": entry["bridge"], "text": "загрузка",
                    "id": idea["id"]})
        # 2а: the stall is a topic for any NPC with no K, living until ready (FSM TTL);
        # F11: it is NOT written into _steer, so a sister-steer keeps its K / TTL
        self._stall_topic = self.STALL_TOPIC
        self._stall_empty = 0
        self._diagnostic({"type": "stall", "id": idea["id"], "seconds": self.stall_seconds()})

    def stall_seconds(self):
        """How long the NPCs still keep the hero talking: what build_pct says is left."""
        if self._cache_build is None:
            return 0.0
        return self.fsm.build_left(self.clock.now())

    def _end_stall(self):
        self._stall_topic = None

    def send_goto(self, place):
        """2а: the hero walks to the destination (the engine knows come/goto/enter)."""
        self._emit({"type": "stage", "who": self.hero, "action": "goto", "place": place})

    def abort_build(self, reason):
        for e in self.fsm.abort(self.clock.now(), reason):
            self._emit(e)

    def _on_build_event(self, event):
        """_emit hook for a cache build: door open -> placard off, goto, walk through;
        abort -> placard off, door stays locked, the operator hears it did not work."""
        cb = self._cache_build
        if cb is None:
            return
        kind = event.get("type")
        if kind == "door" and event.get("state") == "open":
            self._cache_build = None
            self._end_stall()
            self._emit({"type": "placard", "door": cb["bridge"], "clear": True})
            self.send_goto(cb["destination"])
            ev = self.fsm.walk_through(self.clock.now())
            for e in ev:
                self._emit(e)
            if any(e["type"] == "transition" for e in ev):
                self._apply_transition()
        elif kind == "build" and event.get("phase") == "abort":
            self._cache_build = None
            self._end_stall()
            self._emit({"type": "placard", "door": cb["bridge"], "clear": True})
            self._emit({"type": "door", "state": "locked", "object": cb["bridge"]})
            self.ideas.ack(cb["id"], ACK_NOT_DELIVERED)
            # F5: wall-clock wait, untouched by sim speed (Clock.now is real seconds)
            self._hero_after_abort = self.clock.now() + self.HERO_AFTER_ABORT_S

    ABANDONED_JOIN_S = 2.0

    def _join_director(self):
        """Wait for the director's worker: unbounded for a live consult (its cost row must land
        before the journal closes), bounded for one the sim already gave up on (F19: a director
        hung forever would hang the shutdown too); a late charge from it is logged, not awaited."""
        t = getattr(self.director, "_thread", None)
        if t is not None and t in self._abandoned_workers:
            self.director.wait(timeout=self.ABANDONED_JOIN_S)
            if t.is_alive():
                self._emit({"type": "consult_unjoined", "reason": "abandoned"})
        else:
            self.director.wait(timeout=None)

    def _stall_step(self, now):
        """2а: wall-clock safety of a cache build, independent of the director: a consult
        over 20 s is given up, a silence near 15 s gets a stall_bank line (after an
        abort the hero breaks it). Book mode ticks the build here too."""
        if self.book is not None and self.fsm.state == "building":
            for e in self.fsm.tick(now):
                self._emit(e)
        building = self._cache_build is not None and self.fsm.state == "building"
        after_abort = self._hero_after_abort is not None and now < self._hero_after_abort
        if not (building or after_abort):
            self._silent_since = None
            return
        if (building and self.director.in_flight and self.fsm.last_call is not None
                and now - self.fsm.last_call > self.CONSULT_GIVE_UP_S):
            for e in self.fsm.abandon_consult(now):
                self._emit(e)
            self._abandoned_workers.append(getattr(self.director, "_thread", None))
            self.director.in_flight = False
        if (after_abort and not building and self.active_line is not None
                and self.active_line.get("role") != "hero" and self._line_started_at is not None
                and self.next_line is None):
            # F18: a long NPC line playing at the abort would outlast the hero's 20 s: it is cut
            # short of the deadline and the hero's line goes first in the queue
            cut_at = self._hero_after_abort - self.HERO_LINE_LEAD_S
            if self._line_started_at + self._line_duration > cut_at:
                self._line_duration = max(0.0, min(self._line_duration, cut_at - self._line_started_at))
                self._hero_after_abort = None
                self.next_line = {"owner": "npc", "who": self.hero, "role": "hero",
                                  "text": self.HERO_AFTER_ABORT_TEXT, "stall": True}
                return
        if self.active_line is not None or self.next_line is not None:
            self._silent_since = None
            line = self.active_line if self.active_line is not None else self.next_line
            if not (isinstance(line, dict) and line.get("stall")):
                self._stall_empty = 0  # a real line resets the run of empty consults
            return
        if self._silent_since is None:
            self._silent_since = now
            return
        if now - self._silent_since < self.STALL_SILENCE_S:
            return
        self._silent_since = None
        if building and not self.director.in_flight and self._stall_empty < 2:
            # F7/F12: the director gets the first say -- an out-of-turn consult; the bank
            # is the fallback after two empty ones in a row or a consult that is stuck
            self._stall_empty += 1
            self.director.consult_async(now, events=[{"t": now, "type": "consult_due",
                                                      "reason": "silence"}])
            return
        if building:
            bank = self._cache_build["stall_bank"] or ["Подожди, сейчас откроют."]
            text = bank[self._cache_build["i"] % len(bank)]
            self._cache_build["i"] += 1
            who = self.actors[self._cache_build["i"] % len(self.actors)] if self.actors else self.hero
            role = "actor" if who != self.hero else "hero"
        else:
            self._hero_after_abort = None
            who, role, text = self.hero, "hero", self.HERO_AFTER_ABORT_TEXT
        self._start_line({"owner": "npc", "who": who, "role": role, "text": text,
                          "stall": True})

    def _scene_ok(self, idea):
        entry = self.scene_registry.get(idea.get("scene_id"))
        return bool(entry and entry.get("bridge") and entry.get("destination")) and self.fsm.state == "idle"

    def _decide_idea(self, idea):
        if self.idea_decider is not None:
            return self.idea_decider(idea)
        if self.fake:
            return "fire", "понял: %s" % idea.get("clean", "")
        import llm
        system = ("Ты режиссёр сна. Оператор прислал идею. Уместно ли исполнить её прямо сейчас? "
                  'Ответь только JSON {"decision": "fire|hold", "text": "одна короткая фраза оператору: '
                  'что понял и когда сделаешь"}. Если не понял идею: hold и «не понял, повтори».')
        ctx = "Место: %s. Актёры: %s. Идея (%s): %s" % (self.place, ", ".join(self.actors),
                                                       idea.get("intent"), idea.get("clean"))
        res = llm.call("director", system, [{"role": "user", "content": ctx}], max_tokens=200)
        m = re.search(r"\{.*\}", res.text or "", re.S)
        out = json.loads(m.group(0)) if m else {}
        decision = "fire" if out.get("decision") == "fire" else "hold"
        return decision, str(out.get("text") or "не понял, повтори")

    def _safe_ack(self, text):
        """The director's answer goes to the operator panel: same sanitize + safety as input."""
        t = sanitize(str(text or ""), "human")[0]
        return "не могу ответить на это" if not t or self._safety_check(t) else t

    def _present(self, name):
        return name in self.actors

    def _line_busy(self):
        """F7: a line is playing, being generated, or generated and unplayed -- its prompt
        was built without a topic fired now, so a steer/npc fire waits for it."""
        return (self.active_line is not None
                or (self._gen_thread is not None and self._gen_thread.is_alive())
                or self._gen_result is not None)

    def _idea_step(self):
        """Every tick: code conditions, one idea per consult, the answer applied here."""
        self.ideas.tick()
        self._expire_steer()
        for store in (self._npc_cues, getattr(self, "_npc_inflight", {})):
            for who in [w for w in store if w not in self.actors]:
                for cue in store.pop(who):  # 2в: gone between fire and his line
                    self.ideas.fail(cue["id"], "addressee_gone")
        if self.director.in_flight:
            return  # a running director consult finishes first; the idea goes to the next one
        if self._idea_thread is not None:
            th, started, id_ = self._idea_thread
            if self._idea_result is not None:
                dec, text = self._idea_result
                if dec == "fire" and self._line_busy():
                    # F7: a line began generating (or playing) while the director thought;
                    # it was built without the topic, so the fire waits for it to be played
                    return
                self._idea_thread = self._idea_result = None
                self.ideas.resolve(id_, dec, self._safe_ack(text), present=self._present)
            elif time.monotonic() - started > self.IDEA_CONSULT_S:
                self._idea_thread = None  # a late answer finds no consult and is dropped
                self.ideas.resolve(id_, "hold", "думаю дольше обычного, вернусь к идее")
            return
        idea = self.ideas.select(speaking=self._line_busy(),
                                 scene_ok=self._scene_ok, present=self._present)
        if idea is None:
            return
        if self.fake or self.idea_decider is not None:
            try:
                dec, text = self._decide_idea(idea)
            except Exception:
                dec, text = "hold", "не вышло, вернусь к идее"
            self.ideas.resolve(idea["id"], dec, self._safe_ack(text), present=self._present)
            return
        token = object()

        def work():
            try:
                res = self._decide_idea(idea)
            except Exception:
                res = ("hold", "не вышло, вернусь к идее")
            if self._idea_thread is not None and self._idea_thread[0] is token:
                self._idea_result = res
        self._idea_thread = (token, time.monotonic(), idea["id"])
        threading.Thread(target=work, daemon=True).start()

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
        waiting = self._book_waiting()
        return {"type": "snapshot", "t": now, "live": True,
                "scene": list(self.scene["objects"]), "actors": list(self.scene["actors"]),
                "place": self.place, "hero": self.hero, "speed": self.speed,
                "build_state": self.fsm.state, "bridge": self.fsm.bridge,
                "destination": self.fsm.destination,
                "build_start": self.fsm.build_start,
                "build_pct": self.fsm.build_pct(now), "dollars": get_spent(),
                "max_dollars": self.max_dollars,
                "hero_owner": owner,
                "mode": "book" if self.book is not None else "free",
                "waiting_for": "hero" if waiting is not None else None,
                "prompt_text": waiting["text"] if waiting is not None else "",
                "seq": seq}

    def _tick(self):
        now = self.clock.now()
        self._drain_inbox()
        # 2.2: everything below is the dream running -- lines, fsm timers, scene
        # events, pictures. Only the inbox above keeps working, or "continue" could
        # never arrive.
        if self.safety_paused:
            return []
        # D2: the idea queue runs in both modes (make.play plays the test world as a book)
        self._idea_step()
        self._stall_step(now)
        if self.book is not None:
            self._maybe_start_scene_background()
            self._cycle_line()
            self._book_step()
            return []
        self._apply_judge()
        self._fire_due_events()
        self._maybe_start_scene_background()
        self._cycle_line()
        events = self.fsm.tick(now)
        if (self._free_story and self.fsm.state == "ready" and not self._free_pieces_left()
                and now - self.fsm.ready_at >= self.clock.scale(self.FREE_DOOR_SECONDS)):
            # the story does not wait at an open door: it carries them through
            events += self.fsm.touch(now, self.fsm.bridge)
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
        if self.safety_paused or self.director.in_flight or self._idea_thread is not None:
            return last_consult
        if not self.fake and not self._budget_ok():
            return last_consult
        due = self.fsm.due(now)
        # while the book still deals out pieces, the pieces are the director's rhythm
        idle_ok = not (self._free_story and self._free_pieces_left())
        if due or (idle_ok and self.fsm.state == "idle"
                   and now - last_consult > self.fsm.p["min_interval"]):
            self.director.consult_async(now)
            return now
        return last_consult

    def run(self, max_transitions=2, max_seconds=90.0):
        start = self.clock.now()
        if getattr(self, "_max_transitions", None) is None:
            self._max_transitions = max_transitions  # go_freestyle moves it
        last_consult = -1e9
        last_cost = -1e9
        while ((self.book is not None or self.n_transitions < self._max_transitions)
               and self.clock.now() - start < max_seconds):
            self._tick()
            if ((self.book is None and self.n_transitions >= self._max_transitions)
                    or self.clock.now() - start >= max_seconds):
                break
            if self.stopped or self.fsm.awake:
                break
            if not self._budget_ok():
                break
            if self.clock.now() - last_cost >= self.clock.scale(60.0):
                last_cost = self.clock.now()
                if self.logger:
                    self.logger.write_event({"t": self.clock.now(), "type": "cost",
                                             "dollars": get_spent(),
                                             "max_dollars": self.max_dollars})
            if self.book is None:
                self._maybe_generate_line()
                last_consult = self._maybe_consult(last_consult)
            self.clock.real_sleep(0.01)
        # F7: name why the loop ended while the clock is still at the loop end;
        # a `timeout` row in the log is the only proof the limit was reached.
        if self.book is None and self.n_transitions >= self._max_transitions:
            self.stop_reason = "transitions"
        elif self.clock.now() - start >= max_seconds:
            self.stop_reason = "timeout"
            if self.logger:
                self.logger.write_event({"t": self.clock.now(), "type": "timeout",
                                         "reason": "max_seconds"})
        elif self.stopped:
            self.stop_reason = "stopped"
        elif self.fsm.awake:
            self.stop_reason = "awake"
        elif not self._budget_ok():
            self.stop_reason = "budget"
        else:
            self.stop_reason = "done"
        # spec 13 / Д7: the last cost row comes after every worker that can still
        # charge, with no timeout. On Ф1 a 23 s Wonder consult outlived the old 5 s
        # wait, charged after the row and verify_run killed the run ("actual spent
        # != journal cost"); the goal judge and a line in flight were never joined
        self._join_director()
        self._drain_director()
        self._join_judge(timeout=None)
        if self._gen_thread is not None:
            self._gen_thread.join()
        if self.dialogue is not None and hasattr(self.dialogue, "wait"):
            self.dialogue.wait()  # B51: the Dialogue fold threads charge too
        voicing = self._voicing
        if voicing is not None and voicing.get("thread") is not None:
            voicing["thread"].join()  # F2: background Fish TTS charges too
        self.memory.wait(timeout=None)
        self.wait_images()
        if self.logger:
            self.logger.write_event({"t": self.clock.now(), "type": "cost",
                                     "dollars": get_spent(),
                                     "max_dollars": self.max_dollars})
        return self.n_transitions


def run(profile="A", fake=True, speed=1.0, max_transitions=2, seed=0, max_seconds=None,
        media=None, max_dollars=20.0, dialogue=None, serve=None, on_sim=None,
        label=None, first_events=(), book=None, scenes=None, score=None, hero_owner=None,
        freestyle=False, plan=None, no_build=False, on_outdir=None, door_ids=None, build_mode="live",
        fsm_params=None, scene_world=None):
    """door_ids: door place name -> engine door id (make/play.py from stage/places.json);
    plan: a ready book plan (make/play.py), run() does not load the book itself;
    no_build: the world is one, the director may not send the dream anywhere else.
    serve=port (0 = any) starts the comic viewer on the live run (spec 11);
    the dream then goes on until "stop", the budget or a wake_up.
    max_seconds=None: 90 s, or long enough for one full build (420/speed + 120);
    an explicit value is kept as given (the bench passes 67.5)."""
    random.seed(seed)
    if plan is None and book is not None:
        plan = _load_book_plan(book, scenes, score)
    if plan is not None:
        use_scene(plan["scenes"][0]["dict"])
        profile, label = None, label or "book"
    # 3.3: a seeded dream has no profile, so the run folder is named by `label`
    base = os.path.join(os.path.dirname(__file__), "..", "out", "dream",
                        str(label or profile))
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
    if on_outdir is not None:
        on_outdir(outdir)  # bank: a run killed by its timeout is still found and charged
    if serve is not None:
        max_seconds = float("inf")
    elif max_seconds is None and plan is not None:
        max_seconds = _book_seconds(plan, speed)
    elif max_seconds is None:
        # one full build alone takes 420/speed sim-seconds (spec 5); fake or
        # live, the run must at least outlive it plus line playback.
        max_seconds = 90.0
        if max_transitions > 0:
            max_seconds = max(max_seconds, 420.0 / max(speed, 0.01) + 120.0)
    with Sim(profile=profile, fake=fake, speed=speed, outdir=outdir, media=media,
             max_dollars=max_dollars, dialogue=dialogue,
             first_events=first_events, book=plan, hero_owner=hero_owner,
             no_build=no_build, script=[] if plan is not None else None,
             build_mode=build_mode, fsm_params=fsm_params, scene_world=scene_world) as sim:
        viewer = None
        if serve is not None:
            from server import Viewer
            viewer = Viewer(sim=sim, run="%s/%s" % (label or profile, os.path.basename(outdir)))
            port = viewer.start(serve)
            print("dream viewer: http://localhost:%d/?run=%s" % (port, viewer.run), flush=True)
            sim.viewer = viewer
        sim.door_ids = dict(door_ids or {})
        if on_sim is not None:
            on_sim(sim)
        if freestyle and plan is not None:
            sim.go_freestyle()  # the book sets the stage, the cast improvises from beat 0
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
    issues.extend(_verify_book_rows(rows))
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


def _verify_book_rows(rows):
    """K2: every `book` row is the score of its scene; the rows played after it
    (up to the next `book` row) must be exactly that score."""
    issues = []
    marks = [i for i, r in enumerate(rows) if r.get("type") == "book"]
    for k, i in enumerate(marks):
        end = marks[k + 1] if k + 1 < len(marks) else len(rows)
        part = rows[i + 1:end]
        beats = rows[i].get("beats") or []
        want = [(b.get("who"), b["text"]) for b in beats if b["kind"] == "line" and b.get("who")]
        # walk the played rows in log order against the expected beats: a book
        # row must match the next beat exactly; a human row (K3: the hero
        # answers the prompter instead of the book playing their beat) fulfills
        # the next beat when its who is that beat's who -- text may differ.
        idx, n_book = 0, 0
        ok = True
        for h in part:
            if h.get("type") != "line" or h.get("source") not in ("book", "human"):
                continue
            if idx >= len(want):
                ok = False
                break
            if h.get("source") == "book":
                if (h.get("who"), h.get("text")) != want[idx]:
                    ok = False
                    break
                n_book += 1
            elif h.get("who") != want[idx][0]:
                ok = False
                break
            idx += 1
        got = n_book
        scene = rows[i].get("scene")
        if not ok or idx != len(want):
            issues.append("book %s: %d spoken lines played, score has %d (or text/who differ)"
                          % (scene, got, len(want)))
        want_n = sum(1 for b in beats if b["kind"] == "narration"
                     or (b["kind"] == "line" and not b.get("who")))
        got_n = sum(1 for r in part if r.get("type") == "narrator" and r.get("cause") == "book")
        if got_n != want_n:
            issues.append("book %s: %d narrator rows, score has %d" % (scene, got_n, want_n))
    return issues


SEED_TRANSPORT = None  # 3.3: tests patch this; None means the real transport


def seed_start(text, transport, objects=None):
    """3.3: ask the director for the opening scene and make it the start scene.
    -> (scene_dict, [the row that goes first into the log]); ValueError when the director
    failed. `objects` (make/play.py: the places of the built world) replace the director's."""
    decision = seed_scene(text, transport)
    if decision is None:
        raise ValueError("seed: director failed")
    ns = decision["next_scene"]
    place = str(decision.get("destination") or "").strip()
    if not place:  # guarded by seed_scene, never silently "somewhere"
        raise ValueError("seed: director gave no place")
    # a seeded scene starts bare: no schedule, the director fills it on the first
    # consult (3.1a/1.3), so `events` stays empty here
    scene = {"place": place, "objects": list(ns["objects"] if objects is None else objects),
             "actors": list(ns["actors"]), "events": [],
             "goals": list(ns.get("goals") or [])}
    use_scene(scene)
    return scene, [{"type": "consult", "label": "seed", "text": text, "place": place,
                    "why": decision.get("why")}]


def _seed_first_scene(text, transport):
    """-> the row that goes first into the log, or None when the director failed."""
    try:
        return seed_start(text, transport)[1][0]
    except ValueError:
        return None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=None,
                    help="soul profile A|B|C (default A); not with --seed")
    ap.add_argument("--seed", default=None,
                    help="one line of text: the director builds the first scene (3.3)")
    ap.add_argument("--fake", action="store_true")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--max-transitions", type=int, default=None,
                    help="default 2; with --serve unlimited (until stop)")
    ap.add_argument("--max-dollars", type=float, default=20.0)
    ap.add_argument("--serve", action="store_true", help="live comic viewer (spec 11)")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--scene", default=None,
                    help="opening scene: scenes/<name>.json (default start); with --book: scene ids")
    ap.add_argument("--text", action="store_true",
                    help="dialogue only: no Fish voice, no Muse images (scene bank runs)")
    ap.add_argument("--talk", default="spark-open",
                    help="model for hero/actors/compress: spark-open (free) | spark | wonder")
    ap.add_argument("--max-seconds", type=float, default=None,
                    help="stop after this many real seconds (bench: 67.5); "
                         "default 420/speed + 120, i.e. one full build")
    ap.add_argument("--book", default=None, help="K2: play a book dir (books/gwtw); nothing is generated")
    ap.add_argument("--score", default=None, help="K2: hand-edited score json from book.py --out")
    ap.add_argument("--hero", default=None, choices=["npc", "human"],
                    help="K3: human plays the hero, the book prompts")
    ap.add_argument("--lang", default="en", choices=lang.LANGS,
                    help="spike 1.5: ru plays the dream in Russian (7.2 row 1.5)")
    args = ap.parse_args(argv)
    lang.set_lang(args.lang)  # spike 1.5: before any prompt is built
    set_talk_model(args.talk)
    set_cap(args.max_dollars)  # the seed consult is a paid call: cap it first
    first_events = ()
    label = profile = args.profile if args.profile is not None else "A"
    book_scenes = plan = None
    if args.book is not None:
        if args.seed is not None:
            print("book: --seed is ignored with --book", file=sys.stderr)
            args.seed = None
        book_scenes = None if args.scene is None else [x for x in args.scene.split(",") if x]
        try:
            plan = _load_book_plan(args.book, book_scenes, args.score)
        except ValueError as e:
            print(str(e), file=sys.stderr)
            sys.exit(2)
        book_scenes = [sc["scene"] for sc in plan["scenes"]]
        use_scene(plan["scenes"][0]["dict"])
        profile, label = None, "book"
    elif args.seed is not None:
        if args.profile is not None:
            print("seed: --seed builds its own scene, drop --profile", file=sys.stderr)
            sys.exit(2)
        if args.fake and SEED_TRANSPORT is None:
            print("seed: --fake needs a transport", file=sys.stderr)
            sys.exit(2)
        row = _seed_first_scene(args.seed, SEED_TRANSPORT)
        if row is None:
            print("seed: director failed", file=sys.stderr)
            sys.exit(2)
        first_events = [row]
        profile, label = None, "seed"
    else:
        use_scene(args.scene or "start")
    if args.max_transitions is None:
        args.max_transitions = 10 ** 6 if args.serve else 2
    media = None
    dialogue = None
    if plan is not None:
        # book mode: no Spark, no director, no judge, no Muse Image; only Fish may be paid
        if not args.fake and not args.text:
            from voice import Voice, load_pool
            media = {"voice": Voice(pool={**load_pool(), **START_VOICE_IDS})}
    elif not args.fake:
        from dialogue import Dialogue
        dialogue = Dialogue(load_profile(profile))
        # live run: real Fish voice (wav, spec 6) and real Muse Image (spec 9);
        # media failures fall back per module, never stop the dream.
        from voice import Voice, load_pool
        from images import Images
        media = {} if args.text else {
            "voice": Voice(pool={**load_pool(), **START_VOICE_IDS}), "images": Images()}
    outdir, logpath = run(profile=profile, label=label, first_events=first_events,
                           fake=args.fake, speed=args.speed,
                           max_transitions=args.max_transitions, media=media,
                           max_dollars=args.max_dollars, dialogue=dialogue,
                           serve=args.port if args.serve else None,
                           max_seconds=args.max_seconds,
                           book=args.book, scenes=book_scenes, score=args.score,
                           hero_owner=args.hero,
                           on_outdir=lambda d: print("rundir=%s" % d, flush=True))
    with open(logpath, encoding="utf-8") as f:
        rows = [json.loads(l) for l in f]
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
    if plan is not None:
        last = plan["scenes"][-1]["scene"]
        done = any(r.get("type") == "book_end" and r.get("scene") == last for r in rows)
    sys.exit(0 if done and report["ok"] else 1)


if __name__ == "__main__":
    main()
