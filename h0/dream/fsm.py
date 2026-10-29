"""Build state machine: idle -> building -> ready -> transition, director nudges (spec 4, 5).
The door is a world fact: closed while building, `door {state: open}` on ready; the only
way through is a touch (hero [[TOUCH]] or human). A long `ready` asks the director
(`ready_stale`, design doc 2026-10-28, 7.1).
Pure: no LLM, no I/O, no clock. Every method takes `now` (real seconds) and returns log events.
usage: f = BuildFSM(objects, voices=pool, speed=20); f.start_build(now, "clarinet", "porch"); f.tick(now)
"""

DEFAULTS = {
    "build": 420, "ready_timeout": 600,
    "nudge": 120, "force": 300, "min_interval": 20,
}
MAX_ABORTS = 2
FAIL_LIMIT = 3
TARGET = ("bridge", "destination", "next_scene", "hero_next")
ALLOWED = ("messages", "facts_update", "abort_build", "wake_up")
LOCKED_STATES = ("building", "ready", "transition")


def _names(xs):
    return isinstance(xs, list) and all(isinstance(x, str) and x for x in xs)


CAST_RANGE = (1, 5)  # 3.1a: a scene holds up to five actors, not two
SCENE_OBJECTS_RANGE = (5, 8)


def check_scene(ns, voices):
    """Spec 8 checks on a `next_scene` block alone: shape, size (CAST_RANGE actors,
    SCENE_OBJECTS_RANGE objects) and the voices its actors ask for.
    -> (field, reason), or None when the scene is valid."""
    if not isinstance(ns, dict):
        return "next_scene", "missing"
    actors, objects = ns.get("actors"), ns.get("objects")
    if not isinstance(actors, list) or not all(isinstance(a, dict) for a in actors) \
            or not _names(objects):
        return "next_scene", "bad_type"
    if not CAST_RANGE[0] <= len(actors) <= CAST_RANGE[1] \
            or not SCENE_OBJECTS_RANGE[0] <= len(objects) <= SCENE_OBJECTS_RANGE[1]:
        return "next_scene", "bad_size"
    if any(a.get("voice") not in voices for a in actors):
        return "voice", "voice_not_in_pool"
    return None


def check_target(d, objects, voices):
    """Spec 8 checks on the target block -> (field, reason), or None when it is valid."""
    if d.get("bridge") not in objects:
        return "bridge", "bridge_not_in_scene"
    bad = check_scene(d.get("next_scene"), voices)
    if bad:
        return bad
    hero = d.get("hero_next")
    if isinstance(hero, dict) and hero.get("changes") and hero.get("voice") not in voices:
        return "voice", "voice_not_in_pool"
    return None


MAX_EVENT_T = 600
EVENTS_RANGE = (3, 5)
GOALS_MAX = 2


def _check_events(events, names, hero):
    """Shape of a director `events` block (format of 7.2 row 1.3) -> reason or None."""
    if not isinstance(events, list):
        return "bad_type"
    if not EVENTS_RANGE[0] <= len(events) <= EVENTS_RANGE[1]:
        return "bad_size"
    for e in events:
        if not isinstance(e, dict):
            return "bad_type"
        t = e.get("t")
        if isinstance(t, bool) or not isinstance(t, (int, float)):
            return "bad_type"
        if not 0 <= t <= MAX_EVENT_T:
            return "bad_t"
        if not isinstance(e.get("what"), str) or not e["what"].strip():
            return "bad_type"
        if e.get("kind") != "world":
            return "bad_kind"
        who = e.get("who")
        if who == "all":
            continue
        if not _names(who):
            return "bad_type"
        if any(w not in names for w in who):
            return "unknown_recipient"
    return None


def _check_goals(goals, actors, names):
    """Shape of a director `goals` block (format of 7.2 row 1.4) -> reason or None.
    The hero is an NPC with no goal of his own, so he is not in `actors`; he does
    say the words that close one, so he is in `names`."""
    if not isinstance(goals, list):
        return "bad_type"
    if len(goals) > GOALS_MAX:
        return "bad_size"
    for g in goals:
        if not isinstance(g, dict):
            return "bad_type"
        try:
            actor_ok = g.get("actor") in actors
        except TypeError:
            return "unknown_actor"
        if not actor_ok:
            return "unknown_actor"
        if not isinstance(g.get("goal"), str) or not g["goal"].strip():
            return "bad_type"
        if "judge" in g and not isinstance(g.get("judge"), bool):
            return "bad_judge"
        judge = g.get("judge") is True
        cond = g.get("done_when")
        if cond is None:
            # a judge goal closes through Dialogue.judge; a code goal with no
            # words to listen for never closes and blocks later goals (F5)
            if judge:
                continue
            return "bad_done_when"
        if not isinstance(cond, dict):
            return "bad_done_when"
        # a speaker who is not in that scene never says the words, so the goal
        # would hold `goal_open` all scene and block every goal after it
        for who in (cond, cond.get("not_after")):
            if who is None:
                continue
            if (not isinstance(who, dict) or not who.get("any")
                    or not _names(who.get("any"))):
                return "bad_done_when"
            try:
                speaker_ok = who.get("speaker") in names
            except TypeError:
                return "unknown_speaker"
            if not speaker_ok:
                return "unknown_speaker"
    return None


def clean_extras(d, hero=None):
    """Director extras for the next scene (spec 7.2 row 1.4b): drop a broken
    `events` or `goals` block from `d["next_scene"]` and report it once as
    {fields, reason}, or None when both are fine. A bad block must not cost the
    decision its bridge, so this never rejects the whole reply."""
    if not isinstance(d, dict):
        return None
    ns = d.get("next_scene")
    if not isinstance(ns, dict):
        return None
    raw_actors = ns.get("actors")
    actors = {a.get("name") for a in (raw_actors if isinstance(raw_actors, list) else [])
              if isinstance(a, dict) and isinstance(a.get("name"), str)}
    names = actors | ({hero} if hero else set())
    fields, reason = [], None
    if "events" in ns:
        bad = _check_events(ns.get("events"), names, hero)
        if bad:
            ns.pop("events")
            fields.append("events")
            reason = bad
    if "goals" in ns:
        bad = _check_goals(ns.get("goals"), actors, names)
        if bad:
            ns.pop("goals")
            fields.append("goals")
            reason = reason or bad
    return {"fields": fields, "reason": reason} if fields else None


def _note_names(m):
    """3.1b: `to` is one actor or a list of them -> the list of names it means."""
    to = m.get("to")
    return list(to) if isinstance(to, list) else [to]


def check_messages(d, actors):
    """Notes go only to actors of the current scene (spec 8) -> (field, reason) or None.
    3.1b: one note may name several of them at once (`to` as a list)."""
    msgs = d.get("messages") or []
    if not isinstance(msgs, list):
        return "messages", "bad_type"
    for m in msgs:
        if not isinstance(m, dict):
            return "messages", "unknown_recipient"
        names = _note_names(m)
        if not names or any(n not in actors for n in names):
            return "messages", "unknown_recipient"
    return None


class BuildFSM:
    def __init__(self, objects, voices=(), speed=1.0, now=0.0, params=None, actors=(),
                 hero=None):
        p = dict(DEFAULTS, **(params or {}))
        self.p = {k: (tuple(x / speed for x in v) if isinstance(v, tuple) else v / speed)
                  for k, v in p.items()}
        self.voices = set(voices)
        self.actors = list(actors)
        self.hero = hero  # 1.4b: clean_extras needs him to read `events[].who`
        self.build_epoch = 0
        self.fail_streak = 0
        self.awake = False
        self.pending_wakeup = None
        self.in_flight = False
        self.last_call = None
        self.new_scene(now, objects)

    # --- scene and build -------------------------------------------------
    def new_scene(self, now, objects, actors=None):
        self.objects = list(objects)
        if actors is not None:
            self.actors = list(actors)
        self.aborts = 0
        self._to_idle(now)
        return [self._e(now, "scene", objects=self.objects)]

    def _to_idle(self, now):
        self.state = "idle"
        self.idle_since = now
        self.bridge = self.destination = self.next_scene = self.hero_next = None
        self.build_start = self.ready_at = None
        self.ready_stale_fired = False
        self.nudge_fired = self.nudge_pending = self.nudge_delivered = False
        self.force_fired = self.force_active = self.force_pending = False
        self.consult_requested = False

    def start_build(self, now, bridge, destination, next_scene=None, hero_next=None):
        self.state = "building"
        self.build_epoch += 1
        self.bridge, self.destination = bridge, destination
        self.next_scene = next_scene
        self.hero_next = hero_next
        self.build_start = now
        self.nudge_pending = self.force_active = self.force_pending = False
        return [self._e(now, "build", phase="start", bridge=bridge,
                        destination=destination, epoch=self.build_epoch)]

    def abort(self, now, reason):
        if self.state not in ("building", "ready"):
            return [self._e(now, "invalid", fields=["abort_build"], reason="no_build")]
        ev = [self._e(now, "build", phase="abort", reason=reason, epoch=self.build_epoch),
              self._e(now, "deadline_cancelled", epoch=self.build_epoch)]
        self.build_epoch += 1
        self.fail_streak = 0
        self.aborts += 1
        self._to_idle(now)
        if self.aborts > MAX_ABORTS:
            ev += self._wake(now, "abort_loop")
        else:
            self.consult_requested = True
            ev.append(self._e(now, "consult_due", reason="abort"))
        return ev

    def _transition(self, now, via):
        self.state = "transition"
        self.build_epoch += 1
        return [self._e(now, "transition", via=via, bridge=self.bridge,
                        destination=self.destination)]

    # --- time ------------------------------------------------------------
    def tick(self, now):
        if self.awake:
            return []
        ev = []
        if self.state == "idle":
            idle = now - self.idle_since
            if idle >= self.p["nudge"] and not self.nudge_fired:
                self.nudge_fired = self.nudge_pending = True
                ev.append(self._e(now, "director_nudge"))
            if idle >= self.p["force"] and not self.force_fired:
                self.force_fired = self.force_active = self.force_pending = True
                ev.append(self._e(now, "director_force"))
        elif self.state == "building" and now - self.build_start >= self.p["build"]:
            self.state = "ready"
            self.ready_at = now
            self.ready_stale_fired = False
            ev.append(self._e(now, "ready", epoch=self.build_epoch))
            # the door opens and stays open: no timer carries the hero through it
            ev.append(self._e(now, "door", state="open", object=self.bridge))
        return ev

    def build_pct(self, now):
        if self.state != "building":
            return 100 if self.state in ("ready", "transition") else 0
        return min(99, int(100 * (now - self.build_start) / self.p["build"]))

    # --- hero input ------------------------------------------------------
    def touch(self, now, obj):
        # only the bridge is the build's business: another object touched during a
        # build is plain input for the director -- it neither tells the hero the door
        # is locked (building) nor carries the hero through the bridge (ready)
        if self.state in ("building", "ready") and self.bridge and obj != self.bridge:
            return [self._e(now, "input", source="touch", value=obj)]
        if self.state == "building":
            # the door is still closed: a world fact for the hero, no instruction to actors
            return [self._e(now, "door", state="closed", object=obj,
                            build_pct=self.build_pct(now))]
        if self.state == "ready":
            return self._transition(now, "touch")
        return [self._e(now, "input", source="touch", value=obj)]

    # --- director --------------------------------------------------------
    def due(self, now):
        """Reason for an out-of-turn consult right now, or None."""
        if self.in_flight or self.awake:
            return None
        if self.force_pending:
            return "force"
        if self.consult_requested:
            return "abort"
        if self._ready_stale(now):
            return "ready_stale"
        if self.nudge_pending and self._interval_ok(now):
            return "nudge"
        return None

    def _ready_stale(self, now):
        """Once per `ready`: the door has stood open ready_timeout without a touch."""
        return (self.state == "ready" and self.ready_at is not None
                and not self.ready_stale_fired
                and now - self.ready_at >= self.p["ready_timeout"])

    def _interval_ok(self, now):
        return self.last_call is None or now - self.last_call >= self.p["min_interval"]

    def begin_consult(self, now):
        if self.in_flight or self.awake:
            return None
        hint = None
        if self.force_active:
            label, hint = "forced", "force"
            self.force_pending = False
        elif self._ready_stale(now):
            label, hint = "ready_stale", "ready_stale"
            self.ready_stale_fired = True
        elif self.nudge_pending and self._interval_ok(now):
            label, hint = "nudged", "nudge"
            self.nudge_pending = False
        else:
            label = "free"
        ticket = {"epoch": self.build_epoch, "state": self.state, "label": label,
                  "hint": hint, "nudged_before": self.nudge_delivered, "t_call": now,
                  "pending_wakeup": dict(self.pending_wakeup) if self.pending_wakeup else None}
        if hint == "nudge":
            self.nudge_delivered = True
        self.consult_requested = False
        self.in_flight = True
        self.last_call = now
        return ticket

    def finish_consult(self, now, ticket, decision):
        """Apply one director decision (dict, or anything else = broken JSON)."""
        self.in_flight = False
        ev = []
        if self.awake or ticket["epoch"] != self.build_epoch or ticket["state"] != self.state:
            ev.append(self._e(now, "consult_stale", epoch=ticket["epoch"],
                              state=ticket["state"]))
            wake = decision.get("wake_up") if isinstance(decision, dict) else None
            if wake and not self.awake:
                self.pending_wakeup = {"reason": wake, "epoch": ticket["epoch"]}
                ev.append(self._e(now, "pending_wakeup", **self.pending_wakeup))
            return ev + [self._consult(now, ticket, "stale")]
        if not isinstance(decision, dict):
            return self._bad(now, ticket, ["json"], "bad_json")
        bad_msg = check_messages(decision, self.actors) if self.actors else None
        if bad_msg:
            return self._bad(now, ticket, [bad_msg[0]], bad_msg[1])
        pending = self.pending_wakeup
        if pending is not None:
            ev.append(self._e(now, "pending_wakeup", **pending))
            self.pending_wakeup = None
        ev += self._deliver_messages(now, decision)
        abort = decision.get("abort_build")
        if self.state in LOCKED_STATES:
            locked = sorted(k for k in decision if k not in ALLOWED)
            if locked:
                ev.append(self._e(now, "invalid", fields=locked, reason="target_locked"))
            if decision.get("wake_up"):
                self.fail_streak = 0
                ev += self._wake(now, decision["wake_up"])
                return ev + [self._consult(now, ticket, "wake_up")]
            if abort:
                ev += self.abort(now, abort.get("reason") if isinstance(abort, dict) else abort)
            return ev + [self._consult(now, ticket, "abort" if abort else "ok")]
        if decision.get("wake_up"):
            self.fail_streak = 0
            ev += self._wake(now, decision["wake_up"])
            return ev + [self._consult(now, ticket, "wake_up")]
        if abort:
            ev.append(self._e(now, "invalid", fields=["abort_build"], reason="no_build"))
        bridge = decision.get("bridge")
        if bridge is None:
            if ticket["label"] == "forced":
                self.pending_wakeup = pending  # invalid reply: the next ticket carries it again
                return ev + self._bad(now, ticket, ["bridge"], "null_bridge")
            return ev + [self._consult(now, ticket, "ok")]
        extras = clean_extras(decision, self.hero)
        if extras:
            # a broken events/goals block is dropped, the bridge stands (1.4b)
            ev.append(self._e(now, "invalid", **extras))
        err = check_target(decision, self.objects, self.voices)
        if err:
            self.pending_wakeup = pending
            return ev + self._bad(now, ticket, [err[0]], err[1])
        self.fail_streak = 0
        ev += self.start_build(now, bridge, decision.get("destination"),
                               decision.get("next_scene"), decision.get("hero_next"))
        return ev + [self._consult(now, ticket, "build")]

    def _deliver_messages(self, now, decision):
        """One message event per note (F26); recipients were checked by check_messages.
        Without a known cast (self.actors empty, as in most FSM-only fixtures) nothing is
        checked or delivered."""
        if not self.actors:
            return []
        # 3.1b: a note addressed to a list becomes one event per name, so every
        # `message` event (and Sim._notes, keyed by `to`) still carries one name
        return [self._e(now, "message", to=n, note=m.get("note"))
                for m in decision.get("messages") or []
                for n in dict.fromkeys(_note_names(m))]

    def _bad(self, now, ticket, fields, reason):
        ev = [self._e(now, "invalid", fields=fields, reason=reason)]
        if ticket["label"] == "forced":
            self.fail_streak += 1
            ev.append(self._e(now, "director_fail", reason=reason, fail_streak=self.fail_streak))
            if self.fail_streak >= FAIL_LIMIT:
                ev += self._wake(now, "director_stuck")
        return ev + [self._consult(now, ticket, "invalid")]

    def budget_wakeup(self, now):
        """Code-side wake_up("budget"): applied at once, clears any pending_wakeup."""
        self.fail_streak = 0
        return self._wake(now, "budget")

    def _wake(self, now, reason):
        self.awake = True
        self.pending_wakeup = None
        return [self._e(now, "wake_up", reason=reason)]

    def _consult(self, now, ticket, verdict):
        return self._e(now, "consult", label=ticket["label"],
                       nudged_before=ticket["nudged_before"], t_call=ticket["t_call"],
                       t_applied=now, epoch=ticket["epoch"], verdict=verdict,
                       fail_streak=self.fail_streak)

    @staticmethod
    def _e(now, kind, **kw):
        return dict({"type": kind, "t": now}, **kw)
