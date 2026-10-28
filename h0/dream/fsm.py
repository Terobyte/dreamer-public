"""Build state machine: idle -> building -> ready -> transition, hint ladder, director nudges (spec 4, 5).
Pure: no LLM, no I/O, no clock. Every method takes `now` (real seconds) and returns log events.
usage: f = BuildFSM(objects, voices=pool, speed=20); f.start_build(now, "clarinet", "porch"); f.tick(now)
"""

DEFAULTS = {
    "build": 420, "ladder": (0, 120, 240, 360), "l4": 20, "auto_touch": 40,
    "nudge": 120, "force": 300, "cooldown": 60, "min_interval": 20,
}
MAX_ABORTS = 2
FAIL_LIMIT = 3
TARGET = ("bridge", "destination", "next_scene", "hero_next")
ALLOWED = ("messages", "facts_update", "abort_build", "wake_up")
LOCKED_STATES = ("building", "ready", "transition")


def _names(xs):
    return isinstance(xs, list) and all(isinstance(x, str) and x for x in xs)


def check_target(d, objects, voices):
    """Spec 8 checks on the target block -> (field, reason), or None when it is valid."""
    if d.get("bridge") not in objects:
        return "bridge", "bridge_not_in_scene"
    ns = d.get("next_scene")
    if not isinstance(ns, dict):
        return "next_scene", "missing"
    actors, objects = ns.get("actors"), ns.get("objects")
    if not isinstance(actors, list) or not all(isinstance(a, dict) for a in actors) \
            or not _names(objects):
        return "next_scene", "bad_type"
    if not 1 <= len(actors) <= 2 or not 5 <= len(objects) <= 8:
        return "next_scene", "bad_size"
    voices_used = [a.get("voice") for a in actors]
    hero = d.get("hero_next")
    if isinstance(hero, dict) and hero.get("changes"):
        voices_used.append(hero.get("voice"))
    if any(v not in voices for v in voices_used):
        return "voice", "voice_not_in_pool"
    return None


def check_messages(d, actors):
    """Notes go only to actors of the current scene (spec 8) -> (field, reason) or None."""
    msgs = d.get("messages") or []
    if not isinstance(msgs, list):
        return "messages", "bad_type"
    for m in msgs:
        if not isinstance(m, dict) or m.get("to") not in actors:
            return "messages", "unknown_recipient"
    return None


class BuildFSM:
    def __init__(self, objects, voices=(), speed=1.0, now=0.0, params=None, actors=()):
        p = dict(DEFAULTS, **(params or {}))
        self.p = {k: (tuple(x / speed for x in v) if isinstance(v, tuple) else v / speed)
                  for k, v in p.items()}
        self.voices = set(voices)
        self.actors = list(actors)
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
        self.build_start = self.ready_at = self.ready_deadline = self.l4_at = None
        self.l4_fired = False
        self.frozen_level = None
        self.last_stall = None
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
        self.ready_deadline = self.l4_at = None
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
            self.l4_at = now + self.p["l4"]
            self.ready_deadline = now + self.p["auto_touch"]
            ev.append(self._e(now, "ready", epoch=self.build_epoch))
        if self.state == "ready":
            if self.l4_at is not None and now >= self.l4_at and not self.l4_fired:
                self.l4_fired = True
                ev.append(self._e(now, "hint", level=4))
            if self.ready_deadline is not None and now >= self.ready_deadline:
                ev.append(self._e(now, "auto_touch"))
                ev += self._transition(now, "auto_touch")
        return ev

    def build_pct(self, now):
        if self.state != "building":
            return 100 if self.state in ("ready", "transition") else 0
        return min(99, int(100 * (now - self.build_start) / self.p["build"]))

    def _clock_level(self, now):
        el = now - self.build_start
        return max(i for i, th in enumerate(self.p["ladder"]) if el >= th)

    def hint_level(self, now):
        """[STATE hint_level=N]: ladder by build clock, frozen by an early TOUCH."""
        if self.state == "building":
            return self.frozen_level if self.frozen_level is not None else self._clock_level(now)
        if self.state == "ready":
            if self.l4_fired:
                return 4
            return max(self.frozen_level or 0, self._clock_level(now))
        return 0

    # --- hero input ------------------------------------------------------
    def touch(self, now, obj):
        # only the bridge is the build's business: another object touched during a
        # build is plain input for the director -- it neither freezes the ladder
        # (stall) nor carries the hero through the bridge (ready)
        if self.state in ("building", "ready") and self.bridge and obj != self.bridge:
            return [self._e(now, "input", source="touch", value=obj)]
        if self.state == "building":
            if self.last_stall is not None and now - self.last_stall <= self.p["cooldown"]:
                return [self._e(now, "touch_ignored", object=obj)]
            if self.frozen_level is None:
                self.frozen_level = self._clock_level(now)
            self.last_stall = now
            return [self._e(now, "stall", object=obj, stalled=True,
                            build_pct=self.build_pct(now), level=self.frozen_level)]
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
        if self.nudge_pending and self._interval_ok(now):
            return "nudge"
        return None

    def _interval_ok(self, now):
        return self.last_call is None or now - self.last_call >= self.p["min_interval"]

    def begin_consult(self, now):
        if self.in_flight or self.awake:
            return None
        hint = None
        if self.force_active:
            label, hint = "forced", "force"
            self.force_pending = False
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
        return [self._e(now, "message", to=m["to"], note=m.get("note"))
                for m in decision.get("messages") or []]

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
        self.ready_deadline = self.l4_at = None
        return [self._e(now, "wake_up", reason=reason)]

    def _consult(self, now, ticket, verdict):
        return self._e(now, "consult", label=ticket["label"],
                       nudged_before=ticket["nudged_before"], t_call=ticket["t_call"],
                       t_applied=now, epoch=ticket["epoch"], verdict=verdict,
                       fail_streak=self.fail_streak)

    @staticmethod
    def _e(now, kind, **kw):
        return dict({"type": kind, "t": now}, **kw)
