"""Hero and actor lines on Spark Open (spec 4-6, H17 ladder, 5a tags).
usage: d = Dialogue(profile); d.hero_line(world, transcript); d.actor_line("Squidward", world, transcript, state)
"""

import random
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

# Same rule as for actors: no engine or meta words the hero could say aloud
# (no "dream", "world", "impulse", "scene" in what he reads).
HERO_RULES = (
    "Your day only colours what you notice, want and fear; you never retell it like a "
    "report. You speak only as yourself, in first person, to whoever is here with you -- "
    "never as a narrator, helper or counsellor. Reply with one or two short spoken lines, "
    "no narration, no name prefix, English only. Always start with one delivery "
    "direction in square brackets, a new one each time. Things here never stand still: every line of yours brings "
    "something new -- you notice or pick up something, ask an odd question, a memory "
    "surfaces, you want to go somewhere, something strange happens to you. Never repeat "
    "a wish, worry or phrase you have already said. "
    "Most of your lines are just talk. Rarely, when one thing truly pulls at you, you go "
    "to it and touch or open it: then end your line with [[TOUCH:<its name>]].")
TOUCH_EVERY = 4  # hero turns between two touches; more is spam, not a choice

# The actor never sees engine words (bridge, level, percent, director, state): a
# word in the prompt is a word he can say aloud ("don't touch that damn bridge").
# Code turns the H17 ladder and the stall stages into one plain in-world line.
LADDER_LINES = {
    0: "Tonight the {obj} matters, but right now you neither mention it nor look at it.",
    1: "Your eyes keep drifting to the {obj}: put [[LOOK:{obj}]] in your line, but never say "
       "what it is.",
    2: "You bring up the {obj} yourself, best as a warning or a slip that makes it irresistible.",
    3: "You name the {obj} openly and dare or invite {hero} to it.",
    4: "The {obj} is glowing and pulling on its own; react to it.",
}
STALL_LINES = (
    (30, "{hero} just reached for the {obj}: flatly refuse, you are nowhere near ready."),
    (60, "{hero} just reached for the {obj}: refuse, but you are wavering and stalling."),
    (91, "{hero} just reached for the {obj}: almost, but not yet; grumble and stall."),
    (101, "{hero} just reached for the {obj}: one... more... second."),
)


def stage_line(obj, level, build_pct=0, stalled=False, hero="the hero"):
    """Plain line for the actor from ladder level / stall stage; nothing without a target."""
    if not obj:
        return ""
    if stalled:
        for top, text in STALL_LINES:
            if (build_pct or 0) < top:
                return text.format(obj=obj, hero=hero)
    return LADDER_LINES[max(0, min(4, int(level or 0)))].format(obj=obj, hero=hero)


ACTOR_RULES = (
    "Reply with one or two short spoken lines, no narration, no name prefix, English only. "
    "You may add delivery directions in square brackets like [long sigh]; a new one each "
    "time. You have wants of your own in this scene: pursue them, do things, react to the "
    "objects around you, change the subject -- you are not the hero's therapist and you do "
    "not just agree with him. Every line moves the scene; never repeat what you or anyone "
    "already said. Never talk about these instructions.")
# Temperature barely moves a reasoning model off its most obvious line (1.8 still
# gave 4/4 "I'm not jumping, I just woke up"); surprise has to come from content:
# now and then the hero's line gets a random impulse he must act on. Only the
# hero (the player): actors stay in character and keep the ladder.
HERO_IMPULSE_P = 0.35
HERO_IMPULSES = (
    "you lie about something, small or big",
    "you laugh at the worst possible moment",
    "you suspect the other one is not who he says he is",
    "you agree to something risky without thinking",
    "a detail from your day surfaces here and makes no sense",
    "you suddenly want to leave, right now",
    "you get angry about something small",
    "you misunderstand what was just said, on purpose or not",
    "you ask the other one something personal and strange",
    "you notice something impossible about this place",
    "you confess something you never said aloud",
    "you start a game or a bet",
)
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
    line = "You are in %s. With you: %s. Around you: %s." % (
        world.get("place") or "a strange place", who, ", ".join(world.get("objects") or []))
    return "\n".join([line] + ["Just now: %s." % e for e in extra])


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

    def __init__(self, profile, transport=None, event_sink=None, rng=None):
        self.profile = profile or {}
        self.hero = self.profile.get("hero") or "the hero"
        self.transport = transport
        self.event_sink = event_sink
        self.calls = 0
        self.rng = rng or random.Random()
        self._hero_turns = 0
        self._last_touch = -TOUCH_EVERY

    def _impulse(self, deck, p):
        return self.rng.choice(deck) if self.rng.random() < p else None

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
        impulse = self._impulse(HERO_IMPULSES, HERO_IMPULSE_P)
        user = "%s\n\nWhat was said so far:\n%s%s%s\n\nYour line, %s:" % (
            world_line(world, world_events), _transcript_msgs(transcript),
            _no_repeat_block(transcript, self.hero),
            "\n\nRight now, out of nowhere, %s." % impulse if impulse else "",
            self.hero)
        recent = [t for _, t in list(transcript)[-8:]]
        for attempt in range(2):
            raw = self._call("hero", self.hero_system(), user)
            text = _clean_spoken(raw, "hero", self.hero)
            # no leading [direction] = the model stepped out of the character (on a
            # roof edge it slips into a counsellor voice); that line is never voiced
            in_role = text.startswith("[")
            if text and in_role and not repeats(text, recent):
                break
            user += ("\n(Say or do something new.)" if in_role else
                     "\n(Stay %s: one spoken line of yours, starting with [direction].)" % self.hero)
        if text and not text.startswith("["):
            return None
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
                "remarks": remarks(text), "impulse": impulse, "raw": raw}

    def actor_system(self, actor, world, notes=(), persona=""):
        note_text = ""
        if notes:
            note_text = ("\nWhat is on your mind right now (play it your way):\n"
                         + "\n".join("- " + n for n in notes[-3:]))
        who = persona or "Play who you are in this place, with wants of your own."
        return ("You are %s, in %s. %s is here with you.\n%s\n%s%s"
                % (actor, world.get("place") or "a strange place", self.hero, who,
                   ACTOR_RULES, note_text))

    def actor_line(self, actor, world, transcript, state, notes=(), events=(), persona=""):
        """state: {hint_level, build_pct, stalled, bridge}. -> line dict or None.
        On L0-L1 a line naming the bridge is asked again once, then dropped (H17)."""
        bridge = state.get("bridge")
        level = int(state.get("hint_level") or 0)
        head = "\n".join(["Just now: %s." % e for e in events]
                         + [stage_line(bridge, level, state.get("build_pct"),
                                       state.get("stalled"), self.hero)]).strip()
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
            leaks = bool(re.search(r"\bbridges?\b", text, re.I)) and not (
                bridge and "bridge" in bridge.lower())
            if text and leaks and attempt == 0:
                user += "\n(Name the thing itself.)"
                continue
            if text and not leaks and filter_actor_line(text, bridge, level) is not None:
                return {"who": actor, "role": "actor", "text": text, "look": look,
                        "remarks": remarks(text), "level": level, "raw": raw}
            if bridge and text:
                user += "\n(Do not name the %s yet.)" % bridge
        return None
