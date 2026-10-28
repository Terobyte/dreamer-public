"""Async director: one call in flight, queued events, checks (spec 4, 6, 8).
usage: cd h0/dream && python3 -m unittest -q
"""

import json
import os
import re
import threading

from clock import Clock
from fsm import LOCKED_STATES, check_messages, check_target
from inputs import sanitize
from diagnostics import report

try:
    from llm import call as llm_call
except ImportError:
    from .llm import call as llm_call

NOTE_RULE = (
    "Notes are your only way to steer the scene, and you know what nobody on stage knows: "
    "the hero's diary, fears, past dream and hidden facts. A good note hands ONE actor ONE "
    "concrete playable action with subtext that secretly echoes a soul fact without naming "
    "it -- something the actor would never think of alone. 12-30 words, an action, not a mood. "
    "Good: \"Hum two bars of an old lullaby off-key while you tune, then deny it was you.\" "
    "\"You lost your door key in the fog; ask him to help you find a way in.\" "
    "Bad: \"You want your quiet evening back; steer him toward the radio.\" (a mood the "
    "actor already has plus a direction he already follows). Send a note only when it adds "
    "a new twist, otherwise messages: []. Never ask an actor to calm, comfort, soothe or keep "
    "things quiet, never mirror the hero's mood back at him, never repeat an earlier note.")
NOTES_SHOWN = 5

DIRECTOR_SCHEMA = (
    "Reply with JSON only: {\"bridge\": an object name from the scene or null, "
    "\"destination\": a short place name or null, "
    "\"why\": one sentence naming the diary fact or memory that decided it, "
    "\"next_scene\": {\"objects\": 5 to 8 object names of the destination, "
    "\"actors\": 1 or 2 [{\"name\": who waits there, \"voice\": one of "
    "old_woman|old_man|woman|man|child|creature, \"persona\": who they are and what "
    "they want or are busy doing there, a want of their own}]}, "
    "\"hero_next\": {\"changes\": false} or {\"changes\": true, "
    "\"description\": the hero's new look, \"voice\": one of "
    "old_woman|old_man|woman|man|child|creature}, "
    "\"messages\": [{\"to\": an actor on stage, \"note\": a motivation}] (0 to 2), "
    "\"facts_update\": [], \"abort_build\": null, "
    "\"wake_up\": null}. A bridge without next_scene is rejected: send both "
    "or neither (bridge null means wait). " + NOTE_RULE + " English.")


LOCKED_SCHEMA = (
    "The build is locked: bridge, destination, next_scene and hero_next can not "
    "change now. Reply with JSON only: {\"messages\": [{\"to\": an actor on stage, "
    "\"note\": a motivation for that actor, not a script}] (0 to 2 notes), "
    "\"facts_update\": [], \"abort_build\": null or {\"reason\": why}, "
    "\"wake_up\": null}. Notes help the actor lead the hero toward the locked "
    "bridge in character. " + NOTE_RULE + " English.")


def validate_decision(decision, objects, actors, pool):
    """Check a director decision (spec 8) with the same rules the FSM applies. Returns (ok, errs)."""
    if not isinstance(decision, dict):
        return False, ["json"]
    err = check_messages(decision, actors or [])
    if err is None and decision.get("bridge") is not None:
        err = check_target(decision, objects or [], pool or set())
    return (False, [err[0]]) if err else (True, [])


def filter_actor_line(line, bridge, hint_level):
    """H17: on L0-L1 the actor must not name the bridge (whole word); blocked -> None."""
    if hint_level in (0, 1) and bridge:
        pattern = r"\b" + re.escape(bridge.lower()) + r"\b"
        if re.search(pattern, line.lower()):
            return None
    return line


def _sanitize_human(text):
    return sanitize(text, "human")[0]


def _sanitize_event(ev):
    if isinstance(ev, dict):
        out = dict(ev)
        for k in ("value", "note", "text", "outcome"):
            if isinstance(out.get(k), str):
                out[k] = _sanitize_human(out[k])
        return out
    if isinstance(ev, str):
        return _sanitize_human(ev)
    return ev


class Director:
    """Single-flight async director on fakes; events queue into next call."""

    def __init__(self, fsm, memory=None, actors=(), delay=0.0, speed=1.0,
                 script=(), outdir=None, clock=None, fake=True):
        self.fsm = fsm
        self.memory = memory
        self.actors = list(actors)
        self.fake = fake
        self.delay = float(delay)
        self.speed = float(speed or 1.0)
        self.script = list(script)
        self.outdir = outdir
        self.clock = clock if clock is not None else Clock(speed=self.speed)
        self.prompts = []
        self.pending = []
        self.in_flight = False
        self.max_in_flight = 0
        self.out_of_turn = False
        self.n_consults = 0
        self.completed_events = []
        self.errors = []
        self.notes_given = []  # (to, note) of this scene; the sim clears it on transition
        self._thread = None
        self._cur = 0
        self._events_lock = threading.Lock()

    def _publish(self, events):
        with self._events_lock:
            self.completed_events.extend(events)

    def drain_events(self):
        with self._events_lock:
            events, self.completed_events = self.completed_events, []
            return events

    def actor_prompt(self, line, hint_level, bridge, build_pct=None, stalled=False):
        """Actor-side prompt text; human injections are stripped first."""
        clean, _ = sanitize(line, "actor")
        kept = filter_actor_line(clean, bridge, hint_level)
        state = "[STATE hint_level=%d" % hint_level
        if build_pct is not None:
            state += " build=%d%%" % build_pct
        if stalled:
            state += " stalled=true"
        state += "]"
        return "%s %s" % (state, kept if kept is not None else "...")

    def _prompt_text(self, events, ticket=None):
        parts = []
        for e in events:
            c = _sanitize_event(e)
            if isinstance(c, dict):
                if c.get("type") == "input" and c.get("source") == "speech":
                    parts.append("[HUMAN_SAYS: %s]" % c.get("value", ""))
                else:
                    parts.append(" ".join(str(v) for v in c.values() if v))
            else:
                parts.append(str(c))
        tail = "\n".join(parts) if parts else "(no new events)"
        if self.notes_given:
            tail += "\nNOTES ALREADY GIVEN THIS SCENE (do not repeat or rephrase):\n" + "\n".join(
                "- to %s: %s" % n for n in self.notes_given[-NOTES_SHOWN:])
        base = "DIRECTOR consult: decide the next bridge or wait."
        meta = ""
        if ticket is not None:
            meta = "\n[CONSULT state=%s label=%s hint=%s]" % (
                ticket.get("state"), ticket.get("label"), ticket.get("hint"))
            if ticket.get("state") in LOCKED_STATES:
                meta += "\n[LOCKED bridge=%s destination=%s actors=%s]" % (
                    getattr(self.fsm, "bridge", None), getattr(self.fsm, "destination", None),
                    ", ".join(self.actors))
            if ticket.get("pending_wakeup"):
                meta += "\n[PENDING_WAKEUP %s]" % ticket["pending_wakeup"]
        return "%s%s\nEVENTS\n%s" % (base, meta, tail)

    def _next_decision(self, ticket, prompt):
        """Scripted reply offline; a real Wonder call live. While the build is
        locked a director may only send notes (spec 4), so the next bridge
        waits for the next idle consult either way."""
        if ticket["state"] in LOCKED_STATES:
            if not self.fake:
                return self._live_decision(prompt, LOCKED_SCHEMA)
            return {"messages": []}
        if not self.fake:
            return self._live_decision(prompt)
        if self._cur < len(self.script):
            d = self.script[self._cur]
            self._cur += 1
            return d
        return {"bridge": None, "messages": []}

    def _live_decision(self, prompt, schema=DIRECTOR_SCHEMA):
        """Real director consult (spec 15 step 2/4): a malformed or failed reply
        falls back to a no-op so a bad response never stalls the dream."""
        try:
            res = llm_call("director", "You are the dream director.",
                           [{"role": "user", "content": prompt + "\n" + schema}],
                           max_tokens=800)
            decision = json.loads((res.text or "").strip())
            if not isinstance(decision, dict):
                raise ValueError("director reply is not a JSON object")
            return decision
        except Exception as e:
            self.errors.append(e)
            self._publish([dict(report("director", "director_fail", e), t=self.clock.now())])
            return {"messages": []}

    def _write_prompt(self, text):
        if not self.outdir:
            return None
        d = os.path.join(self.outdir, "consults")
        os.makedirs(d, exist_ok=True)
        self.n_consults += 1
        path = os.path.join(d, "%03d.txt" % self.n_consults)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        files = sorted((f for f in os.listdir(d) if f.endswith(".txt")),
                       key=lambda f: int(f[:-4]))
        while len(files) > 50:
            try:
                os.remove(os.path.join(d, files.pop(0)))
            except OSError:
                break
        return path

    def consult_async(self, now, events=()):
        """Start a consult unless one is in flight (then queue events)."""
        evs = [_sanitize_event(e) for e in (events or [])]
        if self.in_flight:
            self.pending.extend(evs)
            return None
        ticket = self.fsm.begin_consult(now)
        if ticket is None:
            self.pending.extend(evs)
            return None
        queued = list(self.pending) + list(evs)
        self.pending = []
        if evs:
            self.out_of_turn = True
        prompt = self._prompt_text(queued, ticket)
        mem_sizes = None
        if self.memory is not None:
            try:
                mem_text, mem_sizes = self.memory.build_prompt({"events": queued})
                prompt = mem_text + "\n" + prompt
            except Exception as e:  # the consult still goes out, but the log must say it ran blind
                self.errors.append(e)
                self._publish([dict(report("director", "memory_fail", e), t=now)])
        self.prompts.append(prompt)
        path = self._write_prompt(prompt)
        self.in_flight = True
        self.max_in_flight = max(self.max_in_flight, 1)
        t = threading.Thread(target=self._finish, args=(ticket, prompt, path, mem_sizes),
                             daemon=True)
        self._thread = t
        t.start()
        return ticket

    def _finish(self, ticket, prompt, prompt_path=None, mem_sizes=None):
        # The FSM alone validates and reports bridge/next_scene/voice problems
        # (fields + reason on an "invalid" event); this call must not quietly
        # rewrite an out-of-scene bridge to None before the FSM ever sees it,
        # or the failure is lost (F28). The real director call also happens
        # here, off the main loop thread, so a slow Wonder reply never blocks
        # ticks, timers or playback (F15).
        try:
            if self.delay > 0:
                self.clock.real_sleep(self.delay)
            decision = self._next_decision(ticket, prompt)
            now = self.clock.now()
            ev = self.fsm.finish_consult(now, ticket, decision)
            self.notes_given += [(e.get("to"), e.get("note")) for e in ev
                                 if e.get("type") == "message"]
            for e in ev:
                if e.get("type") == "consult":
                    e["decision"] = decision if isinstance(decision, dict) else None
                    e["prompt_path"] = prompt_path
                    if mem_sizes is not None:
                        e["mem_sizes"] = mem_sizes
            if self.memory is not None:
                self._remember(ev, decision, now)
            self._publish(ev)
        except Exception as e:
            self.errors.append(e)
            self._publish([dict(report("director", "director_fail", e), t=self.clock.now())])
            # finish_consult may have raised before resetting fsm.in_flight
            # (e.g. a fake that raises outright); without this the FSM would
            # refuse every later begin_consult() (F31).
            self.fsm.in_flight = False
        finally:
            self.in_flight = False

    def _remember(self, events, decision, now):
        """Only accepted replies may change persistent facts and decisions."""
        verdicts = [e.get("verdict") for e in events if e["type"] == "consult"]
        if not isinstance(decision, dict) or not verdicts or verdicts[-1] in ("invalid", "stale"):
            return
        try:
            if decision.get("facts_update"):
                self.memory.apply_facts(decision["facts_update"])
            if verdicts[-1] == "build":
                self.memory.record_decision(decision)
                self.memory.set_bridge(decision.get("bridge"))
            self.memory.merge_background()
            self.memory.select_facts_background()
        except Exception as error:
            self.errors.append(error)
            self._publish([dict(report("director", "memory_fail", error), t=now)])

    def wait(self, timeout=5.0):
        t = self._thread
        if t is not None:
            t.join(timeout)
