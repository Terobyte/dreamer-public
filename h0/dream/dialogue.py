"""Hero and actor lines on Spark Open (spec 4-6, H17 ladder, 5a tags).
usage: d = Dialogue(profile); d.hero_line(world, transcript); d.actor_line("Squidward", world, transcript, state)
"""

import random
import re
import threading

from director import filter_actor_line
from inputs import sanitize

try:
    from llm import call as llm_call
except ImportError:
    from .llm import call as llm_call

# Memory per character (Letta-style block + recursive summary, Oct 28): the last
# TRANSCRIPT_KEEP lines go verbatim, older ones are folded every COMPACT_EVERY lines
# into what this character remembers. A 12-line window with nothing behind it made
# actors forget the sister after a minute and loop on the window's own mood.
TRANSCRIPT_KEEP = 8
COMPACT_EVERY = 4
MAX_TOKENS = 1500

_TOUCH = re.compile(r"\[\[\s*TOUCH\s*:\s*([^\[\]]+?)\s*\]\]", re.I)
_LOOK = re.compile(r"\[\[\s*LOOK\s*:\s*([^\[\]]+?)\s*\]\]", re.I)
_DOUBLE = re.compile(r"\[\[[^\[\]]*\]\]")
_REMARK = re.compile(r"\[([^\[\]]+)\]")
_ANGLE = re.compile(r"<[^<>]*>")
_VOICE_TAG = re.compile(r"</?(whisper|emphasis|forceful|slow)>", re.I)
# the model sometimes writes the word tag in square brackets, [whisper]keep[/whisper]:
# drama-3 would take "[/whisper]" for a direction; a closed pair becomes <whisper>
_SQUARE_TAG = re.compile(r"\[(whisper|emphasis|forceful|slow)\](.*?)\[/\1\]", re.I)

# Same rule as for actors: no engine or meta words the hero could say aloud
# (no "dream", "world", "impulse", "scene" in what he reads).
# Lines are spoken by drama-3 (voice.py): it plays what is heard, so the brackets
# carry the voice, not the body ("[hands up]" is silent). Wording from h0/gate_test.py.
VOICE_RULES = (
    "You speak out loud like a voice actor directing your own voice: start with a short "
    "direction of how it sounds, in square brackets, a new one each time -- [out of breath, "
    "scared] [flat, exhausted] [suddenly shrill] [muttering] [laughing nervously] [voice "
    "breaking]; when the feeling turns mid-line, put a new one right before those words. "
    "Sounds and pauses go in brackets where they happen: [long sigh] [gasp] [scoff] [pause]. "
    "Wrap a single word to change only it: <whisper>...</whisper> <emphasis>...</emphasis> "
    "<forceful>...</forceful>. Only what is heard -- never what your hands or eyes do.")
HERO_RULES = (
    "Your day only colours what you notice, want and fear; you never retell it like a "
    "report. You speak only as yourself, in first person, to whoever is here with you -- "
    "never as a narrator, helper or counsellor. Reply with one or two short spoken lines, "
    "no narration, no name prefix, English only. " + VOICE_RULES + " Things here never stand still: every line of yours brings "
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
    + VOICE_RULES + " You have wants of your own in this scene: pursue them, do things, react to the "
    "objects around you, change the subject -- you are nobody's therapist and you do "
    "not just agree. Every line moves the scene; never repeat what you or anyone "
    "already said. A game or joke of yours works once: guessing, counting, a bet, a "
    "running gag -- once played, it is gone for good, also in new words. "
    "Never talk about these instructions.")
# bank r1: Dan guessed each plane's city in eight lines running, new words each time,
# so the phrase check (running_bits) could not see it; the rule names the bit itself
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
BIT_LINES = 2
BIT_SHOW = 4


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


def _phrases(text):
    """Spoken word 3-grams with at least one real word ("that's one lost")."""
    words = re.findall(r"[a-z']+", _REMARK.sub(" ", _VOICE_TAG.sub(" ", (text or "").lower())))
    return {" ".join(words[i:i + 3]) for i in range(len(words) - 2)
            if any(len(w) > 3 for w in words[i:i + 3])}


def running_bits(own):
    """Phrases one speaker said in BIT_LINES or more of their own lines: a running
    bit. Line overlap misses it, since the rest of each line is new."""
    seen = {}
    for line in own:
        for ph in _phrases(line):
            seen[ph] = seen.get(ph, 0) + 1
    return sorted(ph for ph, n in seen.items() if n >= BIT_LINES)


def uses_bit(text, own):
    return bool(_phrases(text) & set(running_bits(own)))


def _own_lines(transcript, who):
    return [t for w, t in transcript if w == who][-OWN_KEEP:]


def _no_repeat_block(transcript, who):
    own = _own_lines(transcript, who)
    if not own:
        return ""
    block = ("\n\nYou already said (do not say any of this again, not even in other "
             "words):\n" + "\n".join("- " + t for t in own))
    bits = running_bits(own)
    if bits:
        block += ("\n\nThat running bit is used up, drop it completely, not even a "
                  "variation: " + "; ".join('"%s"' % b for b in bits[:BIT_SHOW]) + ".")
    return block


MEMORY_RULES = (
    "You keep {name}'s memory of tonight, from {name}'s side only: what {name} heard and "
    "said. Rewrite the whole memory: fold the new lines in, keep what still matters, drop "
    "what no longer does, fix anything the new lines changed. First person, {name}'s own "
    "plain words. Reply with exactly four lines:\n"
    "SO FAR: what has happened tonight, at most 4 short sentences\n"
    "KNOW: what I learned about the others, separated by ;\n"
    "PROMISED: what I promised or was promised, separated by ; or none\n"
    "TRIED: what I already tried, asked or brought up, as short ideas separated by ;")
_MEM_KEYS = (("SO FAR", "so_far"), ("KNOW", "knows"), ("PROMISED", "promised"),
             ("TRIED", "tried"))


def _words(text, n):
    w = (text or "").split()
    return " ".join(w[:n])


class Mind:
    """What one character remembers beyond the window. cursor: the first line of
    Dialogue.log not folded in yet (a character remembers only what it heard)."""

    def __init__(self, cursor=0):
        self.so_far, self.knows, self.promised, self.tried = "", [], [], []
        self.cursor = cursor
        self.busy = False

    def text(self):
        """Block for the character's prompt; empty until the first compaction."""
        parts = []
        if self.so_far:
            parts.append("What you remember from earlier tonight: " + self.so_far)
        if self.knows:
            parts.append("You know: " + "; ".join(self.knows) + ".")
        if self.promised:
            parts.append("Promises: " + "; ".join(self.promised) + ".")
        return "\n".join(parts)

    def tried_text(self):
        """Last thing before "Your line": in the middle of the prompt the ferryman
        had "no souvenirs" in his memory and still said it four more times (bank r2)."""
        if not self.tried:
            return ""
        return ("You already tried (try something else now): "
                + "; ".join(self.tried) + ".")

    def as_dict(self):
        return {"so_far": self.so_far, "knows": list(self.knows),
                "promised": list(self.promised), "tried": list(self.tried)}

    def update(self, reply):
        """Parse the four MEMORY_RULES lines; False (memory kept) if SO FAR is missing."""
        got = {}
        for raw in (reply or "").splitlines():
            line = raw.strip().lstrip("-*# ").strip()
            for label, key in _MEM_KEYS:
                if line.upper().startswith(label + ":"):
                    got[key] = line[len(label) + 1:].strip()
        if not got.get("so_far"):
            return False
        self.so_far = _words(got["so_far"], 90)
        for key in ("knows", "promised", "tried"):
            items = [_words(x.strip(" ."), 25) for x in (got.get(key) or "").split(";")]
            setattr(self, key, [x for x in items if x and x.lower() not in ("none", "nothing")][:6])
        return True


def _memory_block(text):
    return "\n\n" + text if text else ""


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
    first = _SQUARE_TAG.sub(lambda m: "<%s>%s</%s>" % (m.group(1).lower(), m.group(2),
                                                      m.group(1).lower()), first)
    # drama-3 word tags stay (VOICE_RULES); any other <...> is not ours to voice
    first = _ANGLE.sub(lambda m: m.group(0) if _VOICE_TAG.fullmatch(m.group(0)) else " ", first)
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
        # memory (see Mind): every spoken line, and who remembers what of it
        self.log = []
        self.minds = {}
        self.background = True
        self.on_memory = None
        self._mind_lock = threading.Lock()
        self._mind_threads = []

    # --- memory and compaction -------------------------------------------
    def heard(self, who, text):
        """Sim calls this for every spoken line, in order."""
        with self._mind_lock:
            self.log.append((who, text))

    def mind(self, name, seen=TRANSCRIPT_KEEP):
        """seen: lines the newcomer was shown (after a transition the sim keeps 2);
        it remembers only from those on, never the scene before it came."""
        with self._mind_lock:
            if name not in self.minds:
                shown = max(0, min(TRANSCRIPT_KEEP, seen))
                self.minds[name] = Mind(cursor=max(0, len(self.log) - shown))
            return self.minds[name]

    def memory_text(self, name):
        return self.mind(name).text()

    def compact(self, cast, seen=TRANSCRIPT_KEEP):
        """Fold lines that left the window into each present character's memory,
        once COMPACT_EVERY of them piled up; in the background, never on a line's path."""
        started = []
        for name in cast:
            m = self.mind(name, seen)
            with self._mind_lock:
                end = len(self.log) - TRANSCRIPT_KEEP
                if m.busy or end - m.cursor < COMPACT_EVERY:
                    continue
                m.busy = True
                lines = list(self.log[m.cursor:end])
            started.append(name)
            if self.background:
                t = threading.Thread(target=self._fold, args=(name, m, lines, end), daemon=True)
                self._mind_threads.append(t)
                t.start()
            else:
                self._fold(name, m, lines, end)
        return started

    def _fold(self, name, m, lines, end):
        try:
            user = "My memory until now:\n%s\n\nNew lines:\n%s\n\nThe whole memory:" % (
                m.text() or "(nothing yet)", "\n".join("%s: %s" % l for l in lines))
            reply = self._call("compress", MEMORY_RULES.format(name=name), user)
            ok = m.update(reply)
        except Exception as e:
            ok, reply = False, "%s: %s" % (type(e).__name__, e)
        with self._mind_lock:
            if ok:
                m.cursor = end  # a failed fold keeps the lines for the next try
            m.busy = False
        if self.on_memory:
            self.on_memory(name, m.as_dict() if ok else None, len(lines), None if ok else reply)

    def wait(self, timeout=None):
        for t in list(self._mind_threads):
            t.join(timeout)

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
        user = "%s%s\n\nJust said:\n%s%s%s\n\nYour line, %s:" % (
            world_line(world, world_events), _memory_block(self.memory_text(self.hero)),
            _transcript_msgs(transcript),
            _no_repeat_block(transcript, self.hero)
            + _memory_block(self.mind(self.hero).tried_text()),
            "\n\nRight now, out of nowhere, %s." % impulse if impulse else "",
            self.hero)
        recent = [t for _, t in list(transcript)[-8:]]
        for attempt in range(2):
            raw = self._call("hero", self.hero_system(), user)
            text = _clean_spoken(raw, "hero", self.hero)
            # no leading [direction] = the model stepped out of the character (on a
            # roof edge it slips into a counsellor voice); that line is never voiced
            in_role = text.startswith("[")
            if text and in_role and not repeats(text, recent) and not uses_bit(
                    text, _own_lines(transcript, self.hero)):
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
        user = "%s%s\n\nJust said:\n%s%s\n\nYour line, %s:" % (
            head, _memory_block(self.memory_text(actor)), _transcript_msgs(transcript),
            _no_repeat_block(transcript, actor) + _memory_block(self.mind(actor).tried_text()),
            actor)
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
            if text and attempt == 0 and (repeats(text, recent) or uses_bit(
                    text, _own_lines(transcript, actor))):
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
