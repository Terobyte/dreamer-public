"""Hero and actor lines on Spark Open (spec 4-6, H17 ladder, 5a tags).
usage: d = Dialogue(profile); d.hero_line(world, transcript); d.actor_line("Squidward", world, transcript, state)
"""

import random
import re
import threading

import lang
from inputs import sanitize

try:
    from llm import call as llm_call, _prompt_text, _tokens
except ImportError:
    from .llm import call as llm_call, _prompt_text, _tokens

# Memory per character (Letta-style block + recursive summary, Oct 28): the last
# TRANSCRIPT_KEEP lines go verbatim, older ones are folded every COMPACT_EVERY lines
# into what this character remembers. A 12-line window with nothing behind it made
# actors forget the sister after a minute and loop on the window's own mood.
# 1.2c: 4, not 8 -- one window equals one fold (COMPACT_EVERY), so a line is
# summarised as soon as it leaves the window and an actor reads a short present
# plus everything older through memory.
TRANSCRIPT_KEEP = 4
TICK = 4  # sim-seconds between free ticks (design doc 2026-10-28, 1.2a)
# 1.2b: pressure to speak, p = W_ADDRESSED*addressed + W_EVENT_HIT*event_hit
# + W_GOAL_OPEN*goal_open + W_SILENT*min(ticks_silent, SILENT_CAP)
# + W_SPOKE_LAST*spoke_last (weights from design doc 2026-10-28, 7.4)
W_ADDRESSED = 3
W_EVENT_HIT = 2
W_GOAL_OPEN = 1
W_SILENT = 0.5
W_SPOKE_LAST = -2
THRESHOLD = 2.0  # below it in everyone -> a tick of silence, a legal turn
ADDRESS_HOLD = 2  # free ticks an addressed / event_hit mark survives
SILENT_CAP = 6  # ticks_silent stops paying off here
# the silence term saturates at SILENT_CAP, so past it the formula cannot say
# "waiting even longer"; ties on p are broken in sim._pick_speaker by the raw
# silent ticks (7.2 row 1.3: longest-silent, then actors in order, hero last).
ACTOR_STREAK_MAX = 2  # after this many actor lines in a row no actor is picked
COMPACT_EVERY = 4
# 3.1a: a scene of three or more actors folds one shared memory (see scene_mind), so
# the window may be twice as wide -- a fold costs one call for the whole cast, and a
# wider window keeps the prompt of five actors inside the token budget. With one or
# two actors each of them still folds his own memory every COMPACT_EVERY lines.
COMPACT_EVERY_CAST = 8
SHARED_MIND_FROM = 3  # actors in the scene
SCENE_MIND = "everyone here"  # the name the shared memory is folded under
MAX_TOKENS = 1500
# 3.2: a narration is one sentence; longer is cut, it is not a speech
NARRATOR_MAX_CHARS = 220


def compact_every(n_actors):
    """Lines that have to leave the window before a fold (7.2 row 3.1a)."""
    return COMPACT_EVERY if n_actors < SHARED_MIND_FROM else COMPACT_EVERY_CAST

_TOUCH = re.compile(r"\[\[\s*TOUCH\s*:\s*([^\[\]]+?)\s*\]\]", re.I)
_LOOK = re.compile(r"\[\[\s*LOOK\s*:\s*([^\[\]]+?)\s*\]\]", re.I)
# 3.1b: the whisper tag is read from the raw reply, before sanitize cuts every
# [[...]] that is not an ACTOR_TAG; <whisper> stays the drama-3 voice tag
_WHISPER = re.compile(r"\[\[\s*whisper\s+([^\[\]]+?)\s*\]\]", re.I)
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
    "<forceful>...</forceful>. Only what is heard -- never what your hands or eyes do. "
    "Hard limit: no more than %d spoken words and three brackets in a line; a longer "
    "line is thrown away unheard, so say one thing and stop." % 15)
HERO_RULES = (
    "Your day only colours what you notice, want and fear; you never retell it like a "
    "report. You speak only as yourself, in first person, to whoever is here with you -- "
    "never as a narrator, helper or counsellor. Reply with one or two short spoken lines, "
    "no narration, no name prefix, English only. " + VOICE_RULES + " Never repeat "
    "a wish, worry or phrase you have already said. Most of your lines are not questions: "
    "you answer, react, claim, want or refuse. "
    "Most of your lines are just talk. Rarely, when one thing truly pulls at you, you go "
    "to it and touch or open it: then end your line with [[TOUCH:<its name>]].")
TOUCH_EVERY = 4  # hero turns between two touches; more is spam, not a choice

# The actor never sees engine words (bridge, level, percent, director, state): a
# word in the prompt is a word he can say aloud ("don't touch that damn bridge").
# The door is a world fact he may name at any time (design doc 2026-10-28, 7.1).


ACTOR_RULES = (
    "Reply with one or two short spoken lines, no narration, no name prefix, English only. "
    + VOICE_RULES + " You have wants of your own in this scene: pursue them, do things, react to the "
    "objects around you, change the subject -- you are nobody's therapist and you do "
    "not just agree. Every line moves the scene; never repeat what you or anyone "
    "already said. A game or joke of yours works once: guessing, a bet, a running "
    "gag -- once played, it is gone for good, also in new words. "
    "Never talk about these instructions.")
# bank r1: Dan guessed each plane's city in eight lines running, new words each time,
# so the phrase check (running_bits) could not see it; the rule names the bit itself
# Temperature barely moves a reasoning model off its most obvious line (1.8 still
# gave 4/4 "I'm not jumping, I just woke up"); surprise has to come from content:
# now and then the hero's line gets a random impulse he must act on. Only the
# hero (the player): actors stay in character and name the open bridge outright.
HERO_IMPULSE_P = 0.15
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
    "you confess something you never said aloud",
    "you start a game or a bet",
)
REPEAT_JACCARD = 0.45
OWN_KEEP = 4
BIT_LINES = 2
BIT_SHOW = 4
QUESTION_RUN = 2  # hero lines in a row with a '?' before he must say one without


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


def _lang_tokens(text):
    r"""Tokens of the repeat checks. At `en` exactly what they always took,
    [a-z']+ -- the 1.5 spike may not move one byte of the English score (7.2).
    At `ru` \w+ with every word shorter than 4 cut: Cyrillic has no [a-z], and
    the short Russian words are inflection noise, not content."""
    if lang.LANG == "ru":
        return [w for w in re.findall(r"\w+", text) if len(w) >= 4]
    return re.findall(r"[a-z']+", text)


def _content_words(text):
    text = _REMARK.sub(" ", (text or "").lower())
    return {w for w in _lang_tokens(text) if len(w) > 3}


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
    words = _lang_tokens(_REMARK.sub(" ", _VOICE_TAG.sub(" ", (text or "").lower())))
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
    # 1.2c: only the TRANSCRIPT_KEEP window -- older lines live in memory, and
    # quoting them here would smuggle a second window into the prompt (F1).
    own = _own_lines(list(transcript)[-TRANSCRIPT_KEEP:], who)
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
# 3.1a: one compress call folds every actor's side at once, and the contract says
# an actor's `tried` is only what his own lines (`who == a`) brought up. Who said a
# line is a fact of Dialogue.log, not something the model may claim: the fold shows
# the new lines numbered, a TRIED item names the number of the line it summarises,
# and the owner is that line's speaker. A name the model adds is only a hint that
# must agree with the line, and a line no valid item covers still counts for its
# speaker as its own words (_scene_tried). So an untagged item, a wrong tag or the
# same idea from two people can never move or drop an actor's own line (F2-F9).
SCENE_MEMORY_RULES = (
    "You keep the whole scene's shared memory of tonight: everyone's side of what "
    "was heard and said, folded into one. Rewrite the whole memory: fold the new "
    "lines in, keep what still matters, drop what no longer does, fix anything the "
    "new lines changed. The new lines are numbered. Reply with exactly four lines:\n"
    "SO FAR: what has happened tonight, at most 4 short sentences\n"
    "KNOW: what the scene learned about the people here, separated by ;\n"
    "PROMISED: what was promised or asked for, separated by ; or none\n"
    "TRIED: for the new lines only, what the speaker of a line tried, asked or "
    "brought up in that very line, as \"[number] Name: short idea\" with the "
    "number and speaker of that line, separated by ; or none")
TRIED_KEEP = 6  # items per actor (scene_mind) or per personal Mind
TRIED_GIST_WORDS = 12
_TRIED_ITEM = re.compile(r"^\[?\s*(\d+)\s*\]?\s*[:.)\-]?\s*(.*)$", re.S)


def _gist(text):
    """An actor's own line as a TRIED item, when no valid item covers it."""
    return _words(" ".join(_spoken(text).split()), TRIED_GIST_WORDS).strip(" .,;:!?-")


def _scene_tried(tried_raw, lines, actors, names):
    """TRIED items of a scene fold -> {actor: [items]}, every item grounded in one
    of `lines` (the folded (who, text) pairs) whose speaker is that actor.
    tried_raw: the reply's items. An item counts only with the number of a folded
    line; the owner is the speaker of that line. A name before the idea must be
    that speaker (any other known name -> the item is dropped, a tag is a hint, not
    evidence). Lines of an actor that no valid item covers give their own gist, so
    an actor never loses what he said because the reply skipped or mislabelled it.
    names: every name the reply could tag with (speakers, cast, hero)."""
    actors = set(actors or ())
    known = {n.lower() for n in names if n}
    per_line = {}
    for item in tried_raw:
        m = _TRIED_ITEM.match(item)
        if not m:
            continue
        n, rest = int(m.group(1)), m.group(2).strip()
        if not 1 <= n <= len(lines):
            continue
        who = lines[n - 1][0]
        tag, sep, idea = rest.partition(":")
        if sep and tag.strip().lower() in known:
            if tag.strip().lower() != who.lower():
                continue  # the hint disagrees with the log: nobody gets it
            rest = idea.strip()
        rest = _words(rest.strip(" ."), 25)
        if rest and rest.lower() not in ("none", "nothing"):
            per_line.setdefault(n, []).append(rest)
    out = {}
    for i, (who, text) in enumerate(lines, 1):
        if who not in actors:
            continue  # the hero folds his own Mind
        for x in per_line.get(i) or [_gist(text)]:
            mine = out.setdefault(who, [])
            if x and x.lower() not in {y.lower() for y in mine}:
                mine.append(x)
    return out


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
        # 3.1a: the shared scene_mind keeps TRIED per actor, each item grounded
        # in one of that actor's own lines (_scene_tried); `tried` is then their
        # union, for the log. Personal Minds leave it empty.
        self.tried_by = {}
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

    def fold_input(self):
        """What a fold's compress call is shown of memory so far (F5): so_far/knows/
        promised plus tried. For the scene_mind the old items are listed with their
        actor -- shown for context only: they are kept by _scene_tried's merge, not
        by the reply repeating them."""
        base = self.text()
        if self.tried_by:
            tagged = "; ".join("%s: %s" % (who, x) for who, items in self.tried_by.items()
                               for x in items)
        else:
            tagged = "; ".join(self.tried)
        if tagged:
            base = (base + "\n" if base else "") + "Already tried: " + tagged
        return base or "(nothing yet)"

    def update(self, reply, lines=None, actors=(), names=()):
        """Parse the four MEMORY_RULES lines; False (memory kept) if SO FAR is missing.
        lines: for the scene_mind fold (3.1a), the folded (who, text) lines -- TRIED
        is then grounded per line (_scene_tried) and merged per actor into tried_by,
        so an old item stays until TRIED_KEEP newer ones of the same actor push it."""
        got = {}
        for raw in (reply or "").splitlines():
            line = raw.strip().lstrip("-*# ").strip()
            for label, key in _MEM_KEYS:
                if line.upper().startswith(label + ":"):
                    got[key] = line[len(label) + 1:].strip()
        if not got.get("so_far"):
            return False
        self.so_far = _words(got["so_far"], 90)
        for key in ("knows", "promised"):
            items = [_words(x.strip(" ."), 25) for x in (got.get(key) or "").split(";")]
            setattr(self, key, [x for x in items if x and x.lower() not in ("none", "nothing")][:6])
        tried_raw = [x.strip(" .") for x in (got.get("tried") or "").split(";")]
        tried_raw = [x for x in tried_raw if x and x.lower() not in ("none", "nothing")]
        if lines is None:
            self.tried = [_words(x, 25) for x in tried_raw][:TRIED_KEEP]
            return True
        new = _scene_tried(tried_raw, lines, actors, names)
        merged = {who: list(items) for who, items in self.tried_by.items()}
        for who, items in new.items():
            mine = merged.setdefault(who, [])
            for x in items:
                if x.lower() in {y.lower() for y in mine}:
                    mine.remove(next(y for y in mine if y.lower() == x.lower()))
                mine.append(x)
            merged[who] = mine[-TRIED_KEEP:]
        self.tried_by = merged
        flat = []
        for items in merged.values():
            flat += [x for x in items if x not in flat]
        self.tried = flat
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


# --- the lock on a line and the action-loop detector (design doc 2026-10-28, 7.2
# row 1.1). Code decides before a line reaches the scene; bank.score imports the
# same functions, so the bench and the sim read one definition. ----------------
LOCK_MAX_WORDS = 25
LOCK_KEEP_REMARKS = 3   # more than this: the first three stay
LOCK_MAX_REMARKS = 5    # more than this: the line is refused
LOOP_WINDOW = 4         # last lines of one speaker, the current one included
LOOP_HITS = 3           # an item in this many lines of the window = a loop
LOOP_BAN_TURNS = 4      # the item leaves the speaker's objects for this many of his turns
LOCK_HINTS = {"len": "\n(Thrown away unheard: %d words. Under 12 words this time, one bracket.)",
              "remarks": "\n(Too many brackets: a few sounds at most.)",
              "objects": "\n(One thing at a time: name at most one object.)",
              "name": "\n(No new names: only people you actually know.)"}
_WORD = re.compile(r"[A-Za-z][A-Za-z']*")
_NAME_STOP = {"i", "i'm", "i'll", "i've", "i'd", "ok", "god", "mom", "dad",
              "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
              "january", "february", "march", "april", "may", "june", "july", "august",
              "september", "october", "november", "december"}
# words that never count as a loop in a remark: every example of VOICE_RULES plus
# the sounds of the voice itself
_LOOP_STOP = {w for r in _REMARK.findall(VOICE_RULES) for w in re.findall(r"[a-z]+", r.lower())}
_LOOP_STOP |= set("pause gasp scoff sigh laugh laughing voice breath breathing inhale "
                  "exhale whisper quiet soft flat muttering".split())


def _spoken(text):
    """Words only: drop [remarks] and <tags> (bank.score uses the same)."""
    return re.sub(r"\[[^\]]*\]|<[^>]+>", " ", text or "")


def _object_pattern(obj):
    return re.compile(r"\b" + r"\s+".join(re.escape(w) for w in obj.split()) + r"\b", re.I)


def find_objects(text, objects):
    """Objects of the scene named in `text` as whole phrases, case-insensitive, on
    word borders, the long phrase before the short ("roof door" is one object, not
    two). -> (set of object names, text with the matches blanked)."""
    found = set()
    for obj in sorted(objects or [], key=len, reverse=True):
        pat = _object_pattern(obj)
        if pat.search(text):
            found.add(obj)
            text = pat.sub(" ", text)
    return found, text


def _aliases(objects):
    """Last word of a phrase -> the phrase, only where that word is unique."""
    last = {}
    for obj in objects or []:
        w = obj.split()[-1].lower() if obj.split() else ""
        last.setdefault(w, []).append(obj)
    return {w: objs[0] for w, objs in last.items() if w and len(objs) == 1 and objs[0].lower() != w}


def _name_words(sources):
    words = set()
    for s in sources or ():
        for w in _WORD.findall(str(s or "")):
            words.add(w.lower())
    return words


def _known(word, allowed):
    w = word.lower()
    if w in _NAME_STOP or w in allowed:
        return True
    for stem in (w[:-2] if w.endswith("'s") else None, w[:-1] if w.endswith("s") else None):
        if stem and (stem in _NAME_STOP or stem in allowed):
            return True
    return False


def _proper_nouns(text):
    """Capitalised words that are not at a sentence start and not right after `]`
    (the first word after a voice direction); words inside [..] or <..> are skipped."""
    spoken_mask = re.sub(r"\[[^\]]*\]|<[^>]+>", lambda m: " " * len(m.group(0)), text)
    out = []
    for m in _WORD.finditer(spoken_mask):
        w = m.group(0)
        if not w[0].isupper():
            continue
        before = spoken_mask[:m.start()].rstrip()
        if not before or before[-1] in '.?!"':
            continue
        if text[:m.start()].rstrip().endswith("]"):
            continue
        out.append(w)
    return out


def lock_hint(why, text):
    """The retry line for a refused candidate; `len` quotes the count the model
    overshot by (Spark Open ignores "shorter", it follows a number)."""
    hint = LOCK_HINTS[why]
    return hint % len(_spoken(text).split()) if why == "len" else hint


def lock_line(text, objects, names):
    """-> (text after trimming remarks, None) or (None, reason) with reason in
    len | remarks | objects | name. `names`: texts whose words are allowed as
    proper nouns (hero, actors, objects, soul facts, transcript, events, personas,
    director notes)."""
    text = text or ""
    if len(_spoken(text).split()) > LOCK_MAX_WORDS:
        return None, "len"
    n_rem = len(_REMARK.findall(text))
    if n_rem > LOCK_MAX_REMARKS:
        return None, "remarks"
    if n_rem > LOCK_KEEP_REMARKS:
        seen = [0]

        def keep(m):
            seen[0] += 1
            return m.group(0) if seen[0] <= LOCK_KEEP_REMARKS else " "
        text = " ".join(_REMARK.sub(keep, text).split())
    found, _ = find_objects(_spoken(text), objects)
    if len(found) > 1:
        return None, "objects"
    allowed = _name_words(list(names or ()) + list(objects or ()))
    for w in _proper_nouns(text):
        if not _known(w, allowed):
            return None, "name"
    return text, None


def loop_items(text, objects):
    """The set X of a line (7.2 row 1.1): objects named as whole phrases in the
    spoken text or in any remark; in the remarks after the first (the first is
    voice direction) an alias = the unique last word of an object, and any other
    word of 4+ letters not in the stop list."""
    objects = list(objects or [])
    items, _ = find_objects(_spoken(text), objects)
    rems = _REMARK.findall(text or "")
    for i, r in enumerate(rems):
        found, rest = find_objects(r, objects)
        items |= found
        if i == 0:
            continue
        alias = _aliases(objects)
        for w in re.findall(r"[a-z']+", rest.lower()):
            if w in alias:
                items.add(alias[w])
            elif len(w) >= 4 and w not in _LOOP_STOP:
                items.add(w)
    return items


def loops_in(own_sets):
    """Items looping over one speaker's last LOOP_WINDOW line-sets (the current one
    last): present in >= LOOP_HITS of them."""
    window = list(own_sets)[-LOOP_WINDOW:]
    if not window:
        return set()
    return {x for x in window[-1] if sum(1 for s in window if x in s) >= LOOP_HITS}


def count_action_loops(rows):
    """Metric `action_loops` (7.4): `line` rows with a loop and no loop_cut {who,
    item} before the next `line` of anyone. Objects come from snapshot/transition
    rows of the log."""
    objects = []
    own = {}
    total = 0
    pending = None  # (who, looping items) of the last line, until the next line
    for r in rows:
        kind = r.get("type")
        if kind in ("snapshot", "transition") and r.get("scene"):
            objects = list(r["scene"])
        if kind == "loop_cut" and pending and r.get("who") == pending[0]:
            pending[1].discard(r.get("item"))
            continue
        if kind != "line":
            continue
        if pending and pending[1]:
            total += 1
        who = r.get("who") or "?"
        sets = own.setdefault(who, [])
        sets.append(loop_items(r.get("text") or "", objects))
        del sets[:-LOOP_WINDOW]
        pending = (who, loops_in(sets))
    if pending and pending[1]:
        total += 1
    return total


def _match(value, objects):
    from inputs import resolve_touch
    obj, _ = resolve_touch(value, objects or [])
    return obj


class Dialogue:
    """One Spark Open call per line; the dream never waits on a failed call (a
    failure gives None and the caller simply tries the next turn)."""

    JUDGE_SYSTEM = (
        "You read the last lines of a scene and answer whether the actor's goal "
        "is reached in them. Reply with exactly one word: YES or NO. "
        "The lines are English.")

    # 3.2: the narrator is nobody in the scene -- he says only what no mouth in it
    # can say (the place has changed, something happened where nobody was looking)
    NARRATOR_SYSTEM = (
        "You are the narrator of a dream. You are not in the scene and you talk to "
        "nobody in it. Say in one short sentence what the dream itself shows right "
        "now. No dialogue, no names addressed, no questions. English.")

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
        # 3.1a: from SHARED_MIND_FROM actors on, the scene remembers once for all of
        # them; what stays personal is `tried` (what this one already brought up)
        self.scene_mind = Mind()
        self.n_actors = 0
        self.background = True
        self.on_memory = None
        self._mind_lock = threading.Lock()
        self._mind_threads = []
        # the lock (7.2 row 1.1): every name a prompt has carried is a known name;
        # loop cuts per speaker: item -> the speaker's turn when it was cut
        self._names = set()
        self._turns = {}
        self._cuts = {}

    def _learn_names(self, *sources):
        self._names |= _name_words(sources)

    def _allowed_names(self, world, transcript):
        return (list(self._names) + [self.hero, soul_text(self.profile)]
                + list(world.get("actors") or []) + [t for _, t in transcript])

    def _reject(self, who, reason, text):
        if self.event_sink is not None:
            self.event_sink({"type": "lock_reject", "who": who, "reason": reason, "text": text})

    def _banned(self, who, turn=None):
        turn = self._turns.get(who, 0) if turn is None else turn
        return {x for x, at in self._cuts.get(who, {}).items() if turn - at < LOOP_BAN_TURNS}

    def _cut_block(self, who):
        return "".join("\n%s is finished, leave it." % x for x in sorted(self._banned(who)))

    def _prompt_world(self, world, who):
        """The world as the speaker is told it: a cut object is not named to him for
        LOOP_BAN_TURNS. The lock still gets the whole scene -- a banned object is an
        object of the place, it only leaves the prompt (F2)."""
        banned = self._banned(who)
        if not banned:
            return world
        out = dict(world)
        out["objects"] = [o for o in world.get("objects") or [] if o not in banned]
        return out

    def _plan_cuts(self, who, text, transcript, objects):
        """Loops over the speaker's last LOOP_WINDOW lines (this candidate included),
        minus what is already cut. Pure: nothing is remembered until accept() -- the
        sim may still throw the line away (F1). -> items to cut."""
        own = _own_lines(transcript, who)[-(LOOP_WINDOW - 1):] + [text]
        banned = self._banned(who, self._turns.get(who, 0) + 1)
        return [x for x in sorted(loops_in([loop_items(t, objects) for t in own]))
                if x not in banned]

    def accept(self, line):
        """The sim calls this for a generated line it is about to speak: only now the
        speaker's turn is counted and his cuts start their LOOP_BAN_TURNS."""
        who = line.get("who")
        if not who:
            return
        self._turns[who] = self._turns.get(who, 0) + 1
        for x in line.get("cuts") or []:
            self._cuts.setdefault(who, {})[x] = self._turns[who]

    # --- memory and compaction -------------------------------------------
    def heard(self, who, text):
        """Sim calls this for every spoken line, in order."""
        with self._mind_lock:
            self.log.append((who, text))

    @property
    def shared(self):
        """Whether the scene is folded into one memory (3.1a)."""
        return self.n_actors >= SHARED_MIND_FROM

    def _own_view(self, name):
        """An actor of a shared scene reads the scene's memory, but only the TRIED
        items his own lines brought up -- the prompt must not tell Dan that Maya
        already asked. Not stored: a view over scene_mind, rebuilt per line. Every
        item in tried_by[name] came from a line of the log whose speaker is `name`
        (_scene_tried), so nothing here depends on a tag the model wrote."""
        with self._mind_lock:
            shared = self.scene_mind
            m = Mind()
            m.so_far, m.knows = shared.so_far, list(shared.knows)
            m.promised = list(shared.promised)
            m.tried = list(shared.tried_by.get(name) or [])
            return m

    def mind(self, name, seen=TRANSCRIPT_KEEP):
        """seen: lines the newcomer was shown (after a transition the sim keeps 2);
        it remembers only from those on, never the scene before it came."""
        if self.shared and name != self.hero:
            return self._own_view(name)
        with self._mind_lock:
            if name not in self.minds:
                shown = max(0, min(TRANSCRIPT_KEEP, seen))
                self.minds[name] = Mind(cursor=max(0, len(self.log) - shown))
            return self.minds[name]

    def memory_text(self, name):
        return self.mind(name).text()

    def compact(self, cast, seen=TRANSCRIPT_KEEP):
        """Fold lines that left the window into memory, once compact_every() of them
        piled up; in the background, never on a line's path. With a cast of
        SHARED_MIND_FROM actors or more the whole scene folds in one call (3.1a);
        the hero always keeps his own memory."""
        actors = [c for c in cast if c != self.hero]
        self.n_actors = len(actors)
        if self.shared:
            names = ([self.hero] if self.hero in cast else []) + [SCENE_MIND]
        else:
            names = list(cast)
        every = compact_every(self.n_actors)
        started = []
        for name in names:
            m = self.scene_mind if name == SCENE_MIND else self.mind(name, seen)
            with self._mind_lock:
                end = len(self.log) - TRANSCRIPT_KEEP
                if m.busy or end - m.cursor < every:
                    continue
                m.busy = True
                lines = list(self.log[m.cursor:end])
            started.append(name)
            fold_args = (name, m, lines, end, actors if name == SCENE_MIND else None)
            if self.background:
                t = threading.Thread(target=self._fold, args=fold_args, daemon=True)
                self._mind_threads.append(t)
                t.start()
            else:
                self._fold(*fold_args)
        return started

    def new_scene(self, cast):
        """A transition starts a new scene: the shared memory belongs to the old
        one, so a newcomer (seen=2) must not read it. The reset happens here,
        before the first generation -- not at the first compact, which runs
        after lines were already spoken. The hero keeps his own Mind."""
        with self._mind_lock:
            self.n_actors = len([c for c in cast if c != self.hero])
            self.scene_mind = Mind(cursor=len(self.log))
            for name in list(self.minds):
                if name != self.hero and name not in cast:
                    del self.minds[name]

    def _fold(self, name, m, lines, end, cast_names=None):
        try:
            if name == SCENE_MIND:
                # the numbers are what a TRIED item has to point at (_scene_tried)
                new = "\n".join("[%d] %s: %s" % (i, who, text)
                                 for i, (who, text) in enumerate(lines, 1))
            else:
                new = "\n".join("%s: %s" % l for l in lines)
            user = "My memory until now:\n%s\n\nNew lines:\n%s\n\nThe whole memory:" % (
                m.fold_input(), new)
            if name == SCENE_MIND:
                names = ({w for w, _ in lines} | set(cast_names or ())
                         | {self.hero} | set(m.tried_by))
                reply = self._call("compress", SCENE_MEMORY_RULES, user)
                ok = m.update(reply, lines=lines, actors=cast_names or (), names=names)
            else:
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

    def _call(self, role, system, user, who=None):
        """who: the speaker a hero/actor prompt is built for -- only then the size of
        the prompt is logged (`prompt`, read by bank.score as max_prompt_tokens)."""
        self.calls += 1
        messages = [{"role": "user", "content": user}]
        if who and role in ("hero", "actor") and self.event_sink is not None:
            self.event_sink({"type": "prompt", "who": who,
                             "tokens": _tokens(_prompt_text(system, messages))})
        res = llm_call(role, system, [{"role": "user", "content": user}],
                       max_tokens=MAX_TOKENS, fake=self.transport is not None,
                       _transport=self.transport, event_sink=self.event_sink)
        return res.text or ""

    def hero_system(self):
        return ("You are %s.\n%s\n%s"
                % (self.hero, soul_text(self.profile), lang.lang_text(HERO_RULES)))

    def judge(self, goal, last4):
        """Whether the actor's goal is reached in the last lines: YES or NO,
        anything else reads as NO. The word is read after a strip (a live reply
        comes as "YES\n"), but only the bare word counts -- "Yes, definitely"
        is a sentence, not a verdict. One flat call, the count is kept by Sim."""
        user = ("Goal: %s\n\nLast lines:\n%s" %
                (goal, "\n".join("%s: %s" % (w, t) for w, t in (last4 or []))))
        try:
            reply = self._call("judge", lang.lang_text(self.JUDGE_SYSTEM), user)
        except Exception:
            return "NO"
        return "YES" if (reply or "").strip().upper() == "YES" else "NO"

    def narrate(self, cause, context):
        """3.2: one sentence of the narrator over `context` -- the new place
        (cause "transition") or an event nobody saw (cause "event"). A failed call
        gives "", and the dream simply goes on without a narration."""
        user = ("The dream has moved: %s" if cause == "transition"
                else "Nobody in the scene sees this: %s") % (context or "")
        user += "\n\nOne sentence:"
        try:
            raw = self._call("narrator", lang.lang_text(self.NARRATOR_SYSTEM), user)
        except Exception:
            return ""
        return " ".join((raw or "").split())[:NARRATOR_MAX_CHARS]

    def hero_line(self, world, transcript, world_events=()):
        """-> {"who", "text", "touch", "remarks", "raw"} or None."""
        impulse = self._impulse(HERO_IMPULSES, HERO_IMPULSE_P)
        # bank r2: 127 of 132 hero lines carried a question, the hero only interviewed
        own = _own_lines(transcript, self.hero)
        hush = len(own) >= QUESTION_RUN and all("?" in t for t in own[-QUESTION_RUN:])
        if hush and impulse and impulse.startswith("you ask"):
            impulse = None
        user = "%s%s\n\nJust said:\n%s%s%s%s\n\nYour line, %s:" % (
            world_line(self._prompt_world(world, self.hero), world_events), _memory_block(self.memory_text(self.hero)),
            _transcript_msgs(transcript),
            _no_repeat_block(transcript, self.hero)
            + _memory_block(self.mind(self.hero).tried_text()),
            "\n\nRight now, out of nowhere, %s." % impulse if impulse else "",
            "\n\nYour last lines were all questions: this time ask nothing -- answer, react, "
            "claim or want something." if hush else "",
            self.hero)
        # 1.2c: the same window the prompt shows -- a line he cannot see must not
        # cost him the one retry the repeat check shares with the lock.
        recent = [t for _, t in list(transcript)[-TRANSCRIPT_KEEP:]]
        self._learn_names(*world_events)
        user += self._cut_block(self.hero)
        names = self._allowed_names(world, transcript)
        objects = list(world.get("objects") or [])
        text = None
        for attempt in range(2):
            raw = self._call("hero", self.hero_system(), user, who=self.hero)
            cand = _clean_spoken(raw, "hero", self.hero)
            # no leading [direction] = the model stepped out of the character (on a
            # roof edge it slips into a counsellor voice); that line is never voiced
            in_role = cand.startswith("[")
            # the lock shares the one retry with the repeat check (<= 2 calls a turn)
            text, why = lock_line(cand, objects, names) if cand and in_role else (None, None)
            if text and not repeats(text, recent) and not uses_bit(
                    text, own) and not (hush and "?" in text):
                break
            if why:
                self._reject(self.hero, why, cand)
                user += lock_hint(why, cand)
                continue
            user += ("\n(No question this time.)" if in_role and hush and "?" in cand else
                     "\n(Say or do something new.)" if in_role else
                     "\n(Stay %s: one spoken line of yours, starting with [direction].)" % self.hero)
        if not text:
            return None
        cuts = self._plan_cuts(self.hero, text, transcript, objects)
        self._hero_turns += 1
        touch = None
        m = _TOUCH.search(raw)
        if m:
            touch = _match(m.group(1), world.get("objects"))
            # TOUCH_EVERY holds for the open door too: touching is a choice, not a reflex
            if self._hero_turns - self._last_touch < TOUCH_EVERY:
                touch = None
            if touch:
                self._last_touch = self._hero_turns
        return {"who": self.hero, "role": "hero", "text": text, "touch": touch,
                "remarks": remarks(text), "impulse": impulse, "raw": raw, "cuts": cuts}

    def actor_system(self, actor, world, notes=(), persona=""):
        note_text = ""
        if notes:
            note_text = ("\nWhat is on your mind right now (play it your way):\n"
                         + "\n".join("- " + n for n in notes[-3:]))
        who = persona or "Play who you are in this place, with wants of your own."
        return ("You are %s, in %s. %s is here with you.\n%s\n%s%s"
                % (actor, world.get("place") or "a strange place", self.hero, who,
                   lang.lang_text(ACTOR_RULES), note_text))

    def _whisper_to(self, raw, speaker, world):
        """3.1b: [[whisper Name]] means the whole line is for that one name. An
        addressee who is not in this scene is nobody, and the line stays ordinary."""
        m = _WHISPER.search(raw or "")
        if not m:
            return None
        want = " ".join(m.group(1).split()).lower()
        for name in [self.hero] + list(world.get("actors") or []):
            if name != speaker and name.lower() == want:
                return name
        return None

    def actor_line(self, actor, world, transcript, state, notes=(), events=(), persona=""):
        """state: {build_pct, bridge} (kept for the log; no ladder, no stall: the actor
        may name the door whenever he likes). -> line dict or None."""
        bridge = state.get("bridge")
        # the actor hears what happened, never an engine tag: a line, an outcome or a
        # human sentence can carry [[TOUCH:...]] or [WORLD ...], and the prompt is not
        # a place to pass them on (spec 7.1 keeps this lock, the ladder's filter is gone)
        head = "\n".join("Just now: %s." % sanitize(e, "human")[0] for e in events).strip()
        user = "%s%s\n\nJust said:\n%s%s\n\nYour line, %s:" % (
            head, _memory_block(self.memory_text(actor)), _transcript_msgs(transcript),
            _no_repeat_block(transcript, actor) + _memory_block(self.mind(actor).tried_text()),
            actor)
        user += self._cut_block(actor)
        self._learn_names(persona, *notes)
        self._learn_names(*(sanitize(e, "human")[0] for e in events))
        names = self._allowed_names(world, transcript)
        objects = list(world.get("objects") or [])
        system = self.actor_system(actor, self._prompt_world(world, actor), notes, persona)
        # 1.2c: the same window the prompt shows -- a line he cannot see must not
        # cost him the one retry the repeat check shares with the lock.
        recent = [t for _, t in list(transcript)[-TRANSCRIPT_KEEP:]]
        for attempt in range(2):
            raw = self._call("actor", system, user, who=actor)
            whisper_to = self._whisper_to(raw, actor, world)
            clean, _ = sanitize(raw, "actor")
            look = None
            m = _LOOK.search(clean)
            if m:
                look = _match(m.group(1), world.get("objects")) or m.group(1).strip()
            cand = _clean_spoken(clean, "actor", actor)
            # the lock shares the one retry with the repeat check (<= 2 calls a turn)
            text, why = lock_line(cand, objects, names)
            if why:
                self._reject(actor, why, cand)
                user += lock_hint(why, cand)
                continue
            if text and attempt == 0 and (repeats(text, recent) or uses_bit(
                    text, _own_lines(transcript, actor))):
                user += "\n(That repeats the scene. Say or do something new.)"
                continue
            leaks = bool(re.search(r"\bbridges?\b", text, re.I)) and not (
                bridge and "bridge" in bridge.lower())
            if text and leaks and attempt == 0:
                user += "\n(Name the thing itself.)"
                continue
            if text and not leaks:
                cuts = self._plan_cuts(actor, text, transcript, objects)
                return {"who": actor, "role": "actor", "text": text, "look": look,
                        "remarks": remarks(text), "raw": raw, "cuts": cuts,
                        "whisper_to": whisper_to}
        return None


def prompt_version():
    """Eight hex chars of the voice rules: a run logs them so prompt versions
    can be told apart later (blind A/B in the viewer, Oct 29)."""
    import hashlib
    return hashlib.sha1(VOICE_RULES.encode("utf-8")).hexdigest()[:8]


PROMPT_VERSION = prompt_version()
