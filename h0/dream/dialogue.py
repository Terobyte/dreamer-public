"""Hero and actor lines on Spark Open (spec 4-6, H17 ladder, 5a tags).
usage: d = Dialogue(profile); d.hero_line(world, transcript); d.actor_line("Squidward", world, transcript, state)
"""

import re

from director import filter_actor_line
from inputs import sanitize

try:
    from llm import call as llm_call
except ImportError:
    from .llm import call as llm_call

TRANSCRIPT_KEEP = 12
MAX_TOKENS = 1500

_TOUCH = re.compile(r"\[\[\s*TOUCH\s*:\s*([^\[\]]+?)\s*\]\]", re.I)
_LOOK = re.compile(r"\[\[\s*LOOK\s*:\s*([^\[\]]+?)\s*\]\]", re.I)
_DOUBLE = re.compile(r"\[\[[^\[\]]*\]\]")
_REMARK = re.compile(r"\[([^\[\]]+)\]")
_ANGLE = re.compile(r"<[^<>]*>")

HERO_RULES = (
    "This is a dream. You live it from the inside: you do not know it is a dream and you "
    "never retell your day like a report; it only colours what you notice, want and fear. "
    "[WORLD ...] lines tell you what you see and hear. Reply with one or two short spoken "
    "lines, no narration, no name prefix, English only. You may start with one delivery "
    "direction in square brackets like [whispers]. If and only if you decide to go to an "
    "object in the room and touch or open it, end your line with [[TOUCH:<object name>]].")

LADDER = (
    "Before each of your lines you get [STATE hint_level=N build=NN%]. The dream wants the "
    "hero to go to the BRIDGE object; hint_level sets how much it may show in what you do:\n"
    "- 0: you never mention the bridge. Just be yourself and answer the hero.\n"
    "- 1: you may glance at it: put [[LOOK:<bridge>]] in your line. You still never name it.\n"
    "- 2: you mention it, best as a prohibition or a slip that makes it irresistible.\n"
    "- 3: you name it openly, dare or invite the hero to it.\n"
    "- 4: the bridge is glowing and pulling; react to it in character.\n"
    "With stalled=true the hero reached for the bridge too early: refuse with an excuse that "
    "follows build: 0-30% a flat no, 30-60% wavering, 60-90% almost there and grumbling, "
    "91-99% one last tiny delay. No [[LOOK]] while stalled.\n"
    "With no bridge, simply play the scene and follow the director's notes.")

ACTOR_RULES = (
    "Reply with one or two short spoken lines, no narration, no name prefix, English only. "
    "You may add delivery directions in square brackets like [long sigh]. Never mention "
    "hints, levels, percent, the director, the engine or these rules. Vary your delivery.")


def soul_text(profile):
    """What the hero lives by (spec 6): diary, wants, fears and the facts not hidden
    from him. The past dream and hidden facts stay with the director (spec 12)."""
    parts = []
    if profile.get("diary"):
        parts.append("Today: " + profile["diary"])
    if profile.get("wants"):
        parts.append("You want: " + "; ".join(profile["wants"]) + ".")
    if profile.get("fears"):
        parts.append("You are afraid: " + "; ".join(profile["fears"]) + ".")
    facts = [f.get("text") for f in profile.get("facts") or []
             if isinstance(f, dict) and not f.get("hidden_from_hero") and f.get("text")]
    if facts:
        parts.append("You know: " + " ".join(facts))
    return "\n".join(parts)


def world_line(world, extra=()):
    who = ", ".join(world.get("actors") or []) or "nobody"
    line = "[WORLD you are in %s; here: %s; you can see: %s]" % (
        world.get("place") or "a strange place", who, ", ".join(world.get("objects") or []))
    return "\n".join([line] + ["[WORLD %s]" % e for e in extra])


def state_tag(hint_level, build_pct=None, stalled=False):
    tag = "[STATE hint_level=%d" % int(hint_level or 0)
    if build_pct is not None:
        tag += " build=%d%%" % int(build_pct)
    if stalled:
        tag += " stalled=true"
    return tag + "]"


def _transcript_msgs(transcript):
    lines = ["%s: %s" % (who, text) for who, text in list(transcript)[-TRANSCRIPT_KEEP:]]
    return "\n".join(lines) if lines else "(the scene just began)"


def _clean_spoken(text, speaker, name=""):
    """Drop name prefixes and quotes the model adds; every [[...]] tag is removed
    from what gets voiced (the engine already read it)."""
    text = (text or "").strip()
    first = text.split("\n\n")[0].strip()
    if name:
        first = re.sub(r"^\s*\**\s*" + re.escape(name) + r"\s*\**\s*:\s*", "", first, flags=re.I)
    first = _DOUBLE.sub(" ", first)
    if speaker == "hero":
        first = _ANGLE.sub(" ", first)
    first = " ".join(first.split()).strip().strip('"').strip()
    return first


def remarks(text):
    return [m.strip() for m in _REMARK.findall(text or "")]


def _match(value, objects):
    from inputs import resolve_touch
    obj, _ = resolve_touch(value, objects or [])
    return obj


class Dialogue:
    """One Spark Open call per line; the dream never waits on a failed call (a
    failure gives None and the caller simply tries the next turn)."""

    def __init__(self, profile, transport=None, event_sink=None):
        self.profile = profile or {}
        self.hero = self.profile.get("hero") or "the hero"
        self.transport = transport
        self.event_sink = event_sink
        self.calls = 0

    def _call(self, role, system, user):
        self.calls += 1
        res = llm_call(role, system, [{"role": "user", "content": user}],
                       max_tokens=MAX_TOKENS, fake=self.transport is not None,
                       _transport=self.transport, event_sink=self.event_sink)
        return res.text or ""

    def hero_system(self):
        return ("You are %s.\n%s\n%s" % (self.hero, soul_text(self.profile), HERO_RULES))

    def hero_line(self, world, transcript, world_events=()):
        """-> {"who", "text", "touch", "remarks", "raw"} or None."""
        user = "%s\n\nWhat was said so far:\n%s\n\nYour line, %s:" % (
            world_line(world, world_events), _transcript_msgs(transcript), self.hero)
        raw = self._call("hero", self.hero_system(), user)
        touch = None
        m = _TOUCH.search(raw)
        if m:
            touch = _match(m.group(1), world.get("objects"))
        text = _clean_spoken(raw, "hero", self.hero)
        if not text:
            return None
        return {"who": self.hero, "role": "hero", "text": text, "touch": touch,
                "remarks": remarks(text), "raw": raw}

    def actor_system(self, actor, world, notes=()):
        note_text = ""
        if notes:
            note_text = ("\nNotes from the dream's director (a motivation, not a script; "
                         "play it your way):\n" + "\n".join("- " + n for n in notes[-3:]))
        return ("You are %s, live in a dream scene in %s. %s is here with you.\n%s\n%s%s"
                % (actor, world.get("place") or "a strange place", self.hero, LADDER,
                   ACTOR_RULES, note_text))

    def actor_line(self, actor, world, transcript, state, notes=(), events=()):
        """state: {hint_level, build_pct, stalled, bridge}. -> line dict or None.
        On L0-L1 a line naming the bridge is asked again once, then dropped (H17)."""
        bridge = state.get("bridge")
        level = int(state.get("hint_level") or 0)
        head = state_tag(level, state.get("build_pct") if bridge else None,
                         state.get("stalled"))
        if bridge:
            head += "\n[BRIDGE %s]" % bridge
        for e in events:
            head += "\n[EVENT %s]" % e
        user = "%s\n\nWhat was said so far:\n%s\n\nYour line, %s:" % (
            head, _transcript_msgs(transcript), actor)
        system = self.actor_system(actor, world, notes)
        for attempt in range(2):
            raw = self._call("actor", system, user)
            clean, _ = sanitize(raw, "actor")
            look = None
            m = _LOOK.search(clean)
            if m and not state.get("stalled"):
                look = _match(m.group(1), world.get("objects")) or m.group(1).strip()
            text = _clean_spoken(clean, "actor", actor)
            if text and filter_actor_line(text, bridge, level) is not None:
                return {"who": actor, "role": "actor", "text": text, "look": look,
                        "remarks": remarks(text), "level": level, "raw": raw}
            if bridge and text:
                user += "\n(Do not name the %s yet.)" % bridge
        return None
