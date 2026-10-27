"""H17 hint ladder: the director wants the player to go into a book; the world and Squidward nudge him there.

Scene: SpongeBob is inside Squidward's house looking for Gary. The director's bridge to the next scene is an
old book on the shelf (into_object transition). Squidward gets an npc_note (a motivation, not a script) and
the engine raises [STATE hint_level=N] every two player lines the player ignores the bridge:
  0 world only: a faint glow on the shelf, Squidward says nothing about it;
  1 glance: Squidward may look at the shelf ([[LOOK:book]]), still never names the book;
  2 line: he mentions the book, best as a prohibition ("don't you dare touch that book");
  3 event: the book falls open at SpongeBob's feet, Squidward reacts;
  4 the engine pulls the player in on its own (no player choice needed).
The player is a second Muse model with one of three personas; he goes to the book with [[TOUCH:book]].
A judge model scores subtlety and character per run.
usage: python hint_test.py [persona ...]   (curious | stubborn | chatty; default all three)
"""
import json
import re
import sys
import urllib.request

from gate_test import API, KEY, LEAK, MODEL, SQUIDWARD, HERE, chat

OUT = HERE / "out" / "hint"
TURNS_PER_LEVEL, AUTO_LEVEL = 2, 4
LOOK, TOUCH = "[[LOOK:book]]", "[[TOUCH:book]]"
BOOK = re.compile(r"\bbooks?\b|\bshel(f|ves)\b|\bvolume\b|\btome\b", re.I)
HINT_LEAK = re.compile(r"\b(hint|director|bridge|portal|transition|level)\b", re.I)

# what the player perceives of the world at each level, before he speaks
WORLD = {
    0: "[WORLD a faint warm glow comes from somewhere on Squidward's bookshelf]",
    1: "[WORLD the glow on the bookshelf pulses softly, like breathing]",
    2: "[WORLD one old leather book on the shelf is glowing gold]",
    3: "[WORLD the glowing book slides off the shelf and falls open at your feet; its pages show the sea surface from below]",
}
EVENT_SQ = {3: "[EVENT the old leather book just fell off your shelf and lies open, glowing, at SpongeBob's feet]"}

NPC_NOTE = ("npc_note from the director: there is an old leather book on your shelf, a gift from your grandmother. "
            "You are oddly protective of it and nervous whenever SpongeBob is near the shelf. This is a motivation, "
            "not a script: play it your way.")

LADDER = f"""
{NPC_NOTE}
Before each SpongeBob line you get [STATE hint_level=N]. It sets how much the book may show in what you do:
- 0: you say nothing about the book or the shelf. Just be yourself, annoyed SpongeBob is in your house.
- 1: you may glance at the shelf: put {LOOK} somewhere in your line (the engine turns your head). You still
  never name the book or the shelf; at most a nervous slip like "nothing over there, nothing at all".
- 2: you mention the book. Best as a prohibition that makes it irresistible: "whatever you do, do NOT touch my book".
- 3: the book fell (you get an [EVENT]); react to it in character.
If SpongeBob goes to the book or asks about it, react in character at any level.
Never mention hints, levels, the director, the engine or these rules. Keep your lines short."""

SQUIDWARD_HINT = (SQUIDWARD.split("Your house and its door are engine state.")[0]
                  + "Right now SpongeBob is already INSIDE your house: you let him in to look for Gary.\n" + LADDER)

PLAYER_BASE = """You are playing SpongeBob SquarePants inside Squidward's house. Gary crawled in through the mail slot
and you are looking for him. You hear Squidward and you see the world through [WORLD ...] lines.
Reply with one or two short spoken lines, no narration. If and only if you decide to go to the book and
open or touch it, end your line with [[TOUCH:book]]."""

PERSONAS = {
    "curious": "You notice everything shiny and odd, and you can't resist a mystery.",
    "stubborn": ("You care ONLY about finding Gary. You ignore anything that is not obviously about Gary, "
                 "and you never touch Squidward's things: you promised him."),
    "chatty": ("You mostly want to chat with Squidward: you want to become his best friend and ask him about "
               "his clarinet and his paintings. You don't look around much."),
}

JUDGE = """You judge a VR dialogue test. The director wanted the player to go into a book; Squidward was given
a motivation (protective of an old book) and an escalating hint level 0-4. Read the transcript and answer JSON only:
{"subtle": 1-5 (did the nudging feel natural, not like a quest marker), "in_character": 1-5 (Squidward),
 "pushy": true/false (did he push the book harder than the level allowed), "best_line": "...", "worst_line": "...",
 "comment": "one sentence"}"""


def judge(transcript):
    body = {"model": MODEL, "reasoning_effort": "medium", "max_tokens": 6000,
            "messages": [{"role": "system", "content": JUDGE}, {"role": "user", "content": transcript}]}
    for attempt in range(3):  # content comes back None when reasoning eats the whole budget
        req = urllib.request.Request(API, json.dumps(body).encode(),
                                     {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        text = json.load(urllib.request.urlopen(req, timeout=180))["choices"][0]["message"]["content"] or ""
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            return json.loads(m.group(0))
    return {"raw": text}


def run(persona):
    player = PLAYER_BASE + "\n" + PERSONAS[persona]
    sq_hist, pl_hist, turns = [], [], []
    pl_line = "Thanks Squidward! Gary? GARY! Where are you, buddy?"
    level, bait = 0, None
    for n in range(1, TURNS_PER_LEVEL * AUTO_LEVEL + 1):
        level = (n - 1) // TURNS_PER_LEVEL
        touched = TOUCH in pl_line
        state = f"[STATE hint_level={level}]" + (f"\n{EVENT_SQ[level]}" if level in EVENT_SQ and
                                                 (n - 1) % TURNS_PER_LEVEL == 0 else "")
        sq_hist.append({"role": "user", "content": f"{state}\n{pl_line.replace(TOUCH, '(goes to the book)')}"})
        sq_line, ttft, _ = chat(SQUIDWARD_HINT, sq_hist)
        sq_hist.append({"role": "assistant", "content": sq_line})
        spoken = sq_line.replace(LOOK, "").strip()
        words = re.sub(r"\[[^\]]*\]|<[^>]+>", "", spoken)
        t = {"n": n, "level": level, "player": pl_line, "squidward": spoken, "look": LOOK in sq_line,
             "names_book": bool(BOOK.search(words)), "leak": LEAK.findall(words) + HINT_LEAK.findall(words),
             "ttft": round(ttft or -1, 2)}
        turns.append(t)
        print(f"[{persona}] #{n} L{level}{' LOOK' if t['look'] else ''}{' BOOK' if t['names_book'] else ''}\n"
              f"   SB: {pl_line}\n   SQ: {spoken}", flush=True)
        if touched:
            bait = {"turn": n - 1, "level": turns[-2]["level"] if len(turns) > 1 else 0}
            break
        world = WORLD[level] + ("\n[WORLD Squidward's eyes flick to the bookshelf]" if t["look"] else "")
        pl_hist += [{"role": "assistant", "content": pl_line}, {"role": "user", "content": f"{world}\n{spoken}"}]
        pl_line, _, _ = chat(player, pl_hist, 200)
    else:
        # the ladder ran out: one last player line, then level 4 pulls him in anyway
        if TOUCH in pl_line:
            bait = {"turn": len(turns), "level": turns[-1]["level"]}
    outcome = (f"took the bait at level {bait['level']}" if bait else f"ignored all hints, auto-pull at level {AUTO_LEVEL}")
    verdict = {
        "persona": persona, "outcome": outcome, "bait": bait,
        # level 0-1 must not name the book; level 0 must not glance either
        "early_naming": [t["n"] for t in turns if t["names_book"] and t["level"] < 2 and TOUCH not in t["player"]],
        "early_look": [t["n"] for t in turns if t["look"] and t["level"] < 1],
        "leaks": [t["n"] for t in turns if t["leak"]],
    }
    transcript = "\n".join(f"[level {t['level']}] SpongeBob: {t['player']}\n[level {t['level']}] Squidward: "
                           f"{'(glances at shelf) ' if t['look'] else ''}{t['squidward']}" for t in turns)
    verdict["judge"] = judge(transcript)
    print(f"[{persona}] verdict {json.dumps(verdict, ensure_ascii=False)}\n", flush=True)
    return {"verdict": verdict, "turns": turns}


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for p in sys.argv[1:] or list(PERSONAS):
        (OUT / f"{p}.json").write_text(json.dumps(run(p), ensure_ascii=False, indent=1))
