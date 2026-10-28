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
    "direction in square brackets; pick a new one each time. "
    "A dream never stands still: every line of yours brings something new -- you notice "
    "or pick up an object, ask an odd question, a memory surfaces, you want to go somewhere, "
    "something dreamlike happens to you. Never repeat a wish, worry or phrase you have "
    "already said; if you said it once, the scene knows it. "
    "Most of your lines are just talk. Rarely, when one object truly pulls at you, you "
    "go to it and touch or open it: then end your line with [[TOUCH:<object name>]].")
TOUCH_EVERY = 4  # hero turns between two touches; more is spam, not a choice

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
    "You may add delivery directions in square brackets like [long sigh]; a new one each "
    "time. You have wants of your own in this scene: pursue them, do things, react to the "
    "objects around you, change the subject -- you are not the hero's therapist and you do "
    "not just agree with him. Every line moves the scene; never repeat what you or anyone "
    "already said. Never mention hints, levels, percent, the director, the engine or "
    "these rules.")
REPEAT_JACCARD = 0.45
OWN_KEEP = 4


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


def _content_words(text):
    text = _REMARK.sub(" ", (text or "").lower())
    return {w for w in re.findall(r"[a-z']+", text) if len(w) > 3}


def repeats(text, earlier):
    """True when a line mostly re-says one of the earlier lines (word overlap)."""
    a = _content_words(text)
    if not a:
        return False
    for e in earlier:
        b = _content_words(e)
        if b and len(a & b) / len(a | b) >= REPEAT_JACCARD:
            return True
    return False


def _own_lines(transcript, who):
    return [t for w, t in transcript if w == who][-OWN_KEEP:]


def _no_repeat_block(transcript, who):
    own = _own_lines(transcript, who)
    if not own:
        return ""
    return ("\n\nYou already said (do not say any of this again, not even in other "
            "words):\n" + "\n".join("- " + t for t in own))


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
        self._hero_turns = 0
        self._last_touch = -TOUCH_EVERY

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
        user = "%s\n\nWhat was said so far:\n%s%s\n\nYour line, %s:" % (
            world_line(world, world_events), _transcript_msgs(transcript),
            _no_repeat_block(transcript, self.hero), self.hero)
        recent = [t for _, t in list(transcript)[-8:]]
        for attempt in range(2):
            raw = self._call("hero", self.hero_system(), user)
            text = _clean_spoken(raw, "hero", self.hero)
            if text and not repeats(text, recent):
                break
            user += "\n(That repeats the scene. Say or do something new.)"
        if not text:
            return None
        self._hero_turns += 1
        touch = None
        m = _TOUCH.search(raw)
        if m and self._hero_turns - self._last_touch >= TOUCH_EVERY:
            touch = _match(m.group(1), world.get("objects"))
            if touch:
                self._last_touch = self._hero_turns
        return {"who": self.hero, "role": "hero", "text": text, "touch": touch,
                "remarks": remarks(text), "raw": raw}

    def actor_system(self, actor, world, notes=(), persona=""):
        note_text = ""
        if notes:
            note_text = ("\nNotes from the dream's director (a motivation, not a script; "
                         "play it your way):\n" + "\n".join("- " + n for n in notes[-3:]))
        who = persona or "Play who you are in this place, with wants of your own."
        return ("You are %s, live in a dream scene in %s. %s is here with you.\n%s\n%s\n%s%s"
                % (actor, world.get("place") or "a strange place", self.hero, who, LADDER,
                   ACTOR_RULES, note_text))

    def actor_line(self, actor, world, transcript, state, notes=(), events=(), persona=""):
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
        user = "%s\n\nWhat was said so far:\n%s%s\n\nYour line, %s:" % (
            head, _transcript_msgs(transcript), _no_repeat_block(transcript, actor), actor)
        system = self.actor_system(actor, world, notes, persona)
        recent = [t for _, t in list(transcript)[-8:]]
        for attempt in range(2):
            raw = self._call("actor", system, user)
            clean, _ = sanitize(raw, "actor")
            look = None
            m = _LOOK.search(clean)
            if m and not state.get("stalled"):
                look = _match(m.group(1), world.get("objects")) or m.group(1).strip()
            text = _clean_spoken(clean, "actor", actor)
            if text and repeats(text, recent) and attempt == 0:
                user += "\n(That repeats the scene. Say or do something new.)"
                continue
            if text and filter_actor_line(text, bridge, level) is not None:
                return {"who": actor, "role": "actor", "text": text, "look": look,
                        "remarks": remarks(text), "level": level, "raw": raw}
            if bridge and text:
                user += "\n(Do not name the %s yet.)" % bridge
        return None
