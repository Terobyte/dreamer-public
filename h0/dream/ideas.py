"""Operator idea queue (specs/2026-11-02-director-prompt.md, D2).

One queue per session, in memory. Ideas wait here until the code-side
conditions pass, then one at a time go to the director (pending -> consulting),
whose fire/hold answer moves them on. Every queue event goes to `log`
(the run journal, which the SSE stream replays); the director's short answer
is a `director_ack` event. Time is the wall clock passed in (fake in tests)."""

import threading

HOLD_RETRY_S = 10.0
MAX_HOLDS = 5
DELIVERY_S = 3.0
CONFIDENCE_MIN = 0.5
INTENTS = ("steer", "scene", "spawn", "npc")
SOURCES = ("operator", "headset")
# effects the engine confirms with effect_ack; steer/npc live in the dialogue
ENGINE_EFFECT = ("scene", "spawn")
TERMINAL = ("done", "failed", "dropped")
NO_ADDRESSEE_S = 60.0  # 2в: an addressed npc idea waits this long for its NPC

ACK_UNCLEAR = "не понял, повтори"
ACK_DONE_ALREADY = "уже исполнено"
ACK_DELETED = "идея удалена"
ACK_EXPIRED = "не нашёл момента, идея снята"
ACK_SAFETY = "эту идею исполнить нельзя"
ACK_NOT_DELIVERED = "не вышло, повтори идею"
ACK_NO_ADDRESSEE = "этого персонажа нет в сцене, идея снята"
ACK_ADDRESSEE_GONE = "персонаж ушёл из сцены, идея не исполнена"


class IdeaQueue:
    def __init__(self, wall, log, effect=None, confidence_min=CONFIDENCE_MIN, on_fire=None):
        self.wall = wall
        self._log = log
        self._effect = effect or (lambda idea: None)
        # D3: steer/npc have no engine effect; the dialogue takes them at fire
        self._on_fire = on_fire or (lambda idea: None)
        self.confidence_min = confidence_min
        self._items = {}
        self._order = []
        self._replies = {}
        self._lock = threading.RLock()

    # --- journal -------------------------------------------------------------
    def _op(self, op, idea, **extra):
        ev = {"type": "idea", "op": op, "id": idea["id"], "source": idea.get("source"),
              "status": idea.get("status"), "intent": idea.get("intent"),
              "clean": idea.get("clean"), "raw": idea.get("raw"),
              "now": idea.get("now"), "holds": idea.get("holds"),
              "wait": idea.get("wait")}
        for k in ("addressee", "scene_id", "retry_at"):
            if idea.get(k) is not None:
                ev[k] = idea[k]
        if idea.get("reason"):
            ev["reason"] = idea["reason"]
        ev.update(extra)
        self._log(ev)

    def _ack(self, id_, text):
        text = str(text or "")[:200]
        self._log({"type": "director_ack", "id": id_, "text": text})
        it = self._items.get(id_)
        if it is not None:  # replay: the journal also holds the ack as a queue op
            self._op("ack", it, text=text)

    def ack(self, id_, text):
        """A late answer to the operator about an idea (D4: the build was aborted)."""
        with self._lock:
            self._ack(id_, text)

    # --- reads ---------------------------------------------------------------
    def get(self, id_):
        with self._lock:
            it = self._items.get(id_)
            return dict(it) if it else None

    def list(self):
        with self._lock:
            return [dict(self._items[i]) for i in self._order]

    # --- writes from the server ---------------------------------------------
    def add(self, payload, unsafe=False):
        """-> {ok, id} at once. Repeat id = no-op with the same answer."""
        id_ = str(payload.get("id") or "")
        with self._lock:
            if not id_ or len(id_) > 80:  # never truncate: two long ids must not collide
                return {"ok": False, "error": "id required (up to 80 chars)"}
            if id_ in self._replies:
                return self._replies[id_]
            intent = payload.get("intent")
            try:
                conf = float(payload.get("confidence", 1.0))
            except (TypeError, ValueError):
                conf = 0.0
            source = payload.get("source") if payload.get("source") in SOURCES else "operator"
            idea = {"id": id_, "source": source, "raw": str(payload.get("raw") or payload.get("value") or ""),
                    "clean": str(payload.get("value") or ""), "status": "pending",
                    "intent": intent, "created_t": self.wall(), "holds": 0,
                    "now": payload.get("now") is True}
            if payload.get("addressee"):
                idea["addressee"] = str(payload["addressee"])[:80]
            if payload.get("scene_id"):
                idea["scene_id"] = str(payload["scene_id"])[:80]
            if unsafe:
                idea.update(status="dropped", reason="safety")
                self._items[id_] = idea
                self._order.append(id_)
                self._op("add", idea)
                self._ack(id_, ACK_SAFETY)
                reply = {"ok": False, "id": id_, "reason": "safety"}
                self._replies[id_] = reply
                return reply
            if intent not in INTENTS or conf < self.confidence_min:
                idea.update(status="rejected", reason="unclear")
                self._op("reject", idea)
                utext = str(payload.get("unclear_text") or ACK_UNCLEAR)
                self._ack(id_, utext)
                reply = {"ok": False, "id": id_, "reason": "unclear", "text": utext}
                self._replies[id_] = reply
                return reply
            if intent == "steer":
                # decision 7: a new steer for the same addressee replaces the old one
                for oid in self._order:
                    old = self._items[oid]
                    if (old["intent"] == "steer" and old.get("addressee") == idea.get("addressee")
                            and old["status"] in ("pending", "held")):
                        old.update(status="dropped", reason="replaced")
                        self._op("drop", old)
            self._items[id_] = idea
            self._order.append(id_)
            self._op("add", idea)
            reply = {"ok": True, "id": id_}
            self._replies[id_] = reply
            return reply

    def drop(self, id_):
        with self._lock:
            idea = self._items.get(id_)
            if idea is None:
                return {"ok": False, "id": id_, "error": "unknown id"}
            st = idea["status"]
            if st == "done":
                self._ack(id_, ACK_DONE_ALREADY)
                return {"ok": True, "id": id_, "status": st, "text": ACK_DONE_ALREADY}
            if st in TERMINAL:
                return {"ok": True, "id": id_, "status": st}
            if st in ("consulting", "firing"):
                # the consult (or the engine) answers later; its fire is thrown away
                # a fired effect is already out: it cannot be taken back, so no `dropped`
                idea["drop_requested"] = True
                self._op("drop", idea)
                return {"ok": True, "id": id_, "status": idea["status"]}
            idea.update(status="dropped", reason="deleted")
            self._op("drop", idea)
            self._ack(id_, ACK_DELETED)
            return {"ok": True, "id": id_, "status": "dropped"}

    def effect_ack(self, id_):
        with self._lock:
            idea = self._items.get(id_)
            if idea is None or idea["status"] != "firing":
                return {"ok": False, "id": id_}
            idea["status"] = "done"
            self._op("done", idea)
            return {"ok": True, "id": id_}

    # --- the sim's tick ------------------------------------------------------
    def tick(self):
        now = self.wall()
        with self._lock:
            for id_ in self._order:
                idea = self._items[id_]
                if idea["status"] == "held" and now >= idea.get("retry_at", 0.0):
                    idea["status"] = "pending"
                    self._op("retry", idea)
                elif idea["status"] == "firing" and now - idea.get("fired_t", now) >= DELIVERY_S:
                    idea.update(status="failed", reason="not_delivered")
                    self._op("fail", idea)
                    self._ack(id_, ACK_NOT_DELIVERED)

    def _no_addressee(self, idea):
        """2в: the addressed NPC is not in the scene: hold (no consult), and after
        NO_ADDRESSEE_S of waiting the idea is dropped; a later NPC needs a new idea."""
        now = self.wall()
        since = idea.setdefault("no_addr_since", now)
        if now - since >= NO_ADDRESSEE_S:
            idea.update(status="dropped", reason="no_addressee")
            self._op("drop", idea)
            self._ack(idea["id"], ACK_NO_ADDRESSEE)
            return
        idea.update(status="held", retry_at=now + HOLD_RETRY_S, wait="no_addressee")
        self._op("hold", idea)

    def fail(self, id_, reason, text=""):
        """A fired steer/npc idea that could not be played after all (2в: addressee_gone)."""
        with self._lock:
            idea = self._items.get(id_)
            if idea is None or idea["status"] not in ("done", "firing"):
                return None
            idea.update(status="failed", reason=reason)
            self._op("fail", idea)
            self._ack(id_, text or ACK_ADDRESSEE_GONE)
            return dict(idea)

    def select(self, speaking=False, scene_ok=None, spawn_hidden=None, present=None):
        """Code conditions first; the one idea that passes goes pending -> consulting.
        One consult at a time: nothing is picked while another idea is consulting.
        `present(name)`: is an addressed NPC in the scene (2в)."""
        with self._lock:
            if any(self._items[i]["status"] == "consulting" for i in self._order):
                return None
            cands = [self._items[i] for i in self._order if self._items[i]["status"] == "pending"]
            cands.sort(key=lambda it: (not it["now"], it["intent"] != "npc", it["created_t"]))
            for idea in cands:
                if idea["intent"] == "npc" and (
                        idea.get("no_addr_since") is not None
                        or (present is not None and not present(idea.get("addressee")))):
                    self._no_addressee(idea)
                    continue
                why = self._waits(idea, speaking, scene_ok, spawn_hidden)
                if why:
                    if idea.get("wait") != why:
                        idea["wait"] = why
                        self._op("wait", idea)
                    continue
                idea.pop("wait", None)
                idea["status"] = "consulting"
                self._op("consult", idea)
                return dict(idea)
            return None

    @staticmethod
    def _waits(idea, speaking, scene_ok, spawn_hidden):
        if idea["intent"] == "scene" and not (scene_ok(idea) if scene_ok else False):
            return "scene"  # (c): registry + bridge + fsm idle; "now" does not skip it
        if idea["now"]:
            return None
        if speaking:
            return "speaking"  # (a)
        if idea["intent"] == "spawn" and not (spawn_hidden(idea) if spawn_hidden else False):
            return "visible"  # (b)
        return None

    def resolve(self, id_, decision, text="", present=None):
        """The director's answer for a consulting idea: fire or hold (+ one short line).
        `present(name)`: 2в, an addressed npc idea is re-checked here, before op:fire."""
        with self._lock:
            idea = self._items.get(id_)
            if idea is None or idea["status"] != "consulting":
                return None
            if idea.get("drop_requested"):
                idea.update(status="dropped", reason="deleted")
                self._op("drop", idea)
                self._ack(id_, ACK_DELETED)
                return dict(idea)
            now = self.wall()
            if (decision == "fire" and idea["intent"] == "npc" and present is not None
                    and not present(idea.get("addressee"))):
                self._no_addressee(idea)
                return dict(idea)
            if decision == "fire":
                idea["fired_t"] = now
                idea["status"] = "firing" if idea["intent"] in ENGINE_EFFECT else "done"
                self._op("fire", idea)
                self._ack(id_, text)
                if idea["status"] == "firing":
                    self._effect(dict(idea))
                else:
                    self._on_fire(dict(idea))
                return dict(idea)
            if idea["holds"] >= MAX_HOLDS:
                idea.update(status="dropped", reason="expired")
                self._op("drop", idea)
                self._ack(id_, ACK_EXPIRED)
                return dict(idea)
            idea["holds"] += 1
            idea.update(status="held", retry_at=now + HOLD_RETRY_S)
            self._op("hold", idea)
            self._ack(id_, text)
            return dict(idea)
