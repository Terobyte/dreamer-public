"""Async director: one call in flight, queued events, checks (spec 4, 6, 8).
usage: cd h0/dream && python3 -m unittest -q
"""

import os
import re
import threading

from clock import Clock
from fsm import LOCKED_STATES, check_messages, check_target
from inputs import sanitize


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
                 script=(), outdir=None, clock=None):
        self.fsm = fsm
        self.memory = memory
        self.actors = list(actors)
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
        self._thread = None
        self._cur = 0

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
        base = "DIRECTOR consult: decide the next bridge or wait."
        meta = ""
        if ticket is not None:
            meta = "\n[CONSULT state=%s label=%s hint=%s]" % (
                ticket.get("state"), ticket.get("label"), ticket.get("hint"))
            if ticket.get("state") in LOCKED_STATES:
                meta += "\n[LOCKED bridge=%s destination=%s]" % (
                    getattr(self.fsm, "bridge", None), getattr(self.fsm, "destination", None))
            if ticket.get("pending_wakeup"):
                meta += "\n[PENDING_WAKEUP %s]" % ticket["pending_wakeup"]
        return "%s%s\nEVENTS\n%s" % (base, meta, tail)

    def _next_decision(self, ticket):
        """Next scripted reply. While the build is locked a director may only send notes
        (spec 4), so the script's next bridge waits for the next idle consult."""
        if ticket["state"] in LOCKED_STATES:
            return {"messages": []}
        if self._cur < len(self.script):
            d = self.script[self._cur]
            self._cur += 1
            return d
        return {"bridge": None, "messages": []}

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
                self.completed_events.append({"type": "memory_fail", "t": now, "error": repr(e)})
        self.prompts.append(prompt)
        path = self._write_prompt(prompt)
        decision = self._next_decision(ticket)
        self.in_flight = True
        self.max_in_flight = max(self.max_in_flight, 1)
        t = threading.Thread(target=self._finish, args=(ticket, decision, path, mem_sizes),
                             daemon=True)
        self._thread = t
        t.start()
        return ticket

    def _finish(self, ticket, decision, prompt_path=None, mem_sizes=None):
        # The FSM alone validates and reports bridge/next_scene/voice problems
        # (fields + reason on an "invalid" event); this call must not quietly
        # rewrite an out-of-scene bridge to None before the FSM ever sees it,
        # or the failure is lost (F28).
        try:
            if self.delay > 0:
                self.clock.real_sleep(self.delay)
            now = self.clock.now()
            ev = self.fsm.finish_consult(now, ticket, decision)
            for e in ev:
                if e.get("type") == "consult":
                    e["decision"] = decision if isinstance(decision, dict) else None
                    e["prompt_path"] = prompt_path
                    if mem_sizes is not None:
                        e["mem_sizes"] = mem_sizes
            self.completed_events.extend(ev)
        except Exception as e:
            self.errors.append(e)
            # finish_consult may have raised before resetting fsm.in_flight
            # (e.g. a fake that raises outright); without this the FSM would
            # refuse every later begin_consult() (F31).
            self.fsm.in_flight = False
        finally:
            self.in_flight = False

    def wait(self, timeout=5.0):
        t = self._thread
        if t is not None:
            t.join(timeout)
