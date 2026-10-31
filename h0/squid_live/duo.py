"""Squid duo (test-only, SpongeBob never ships): the h0/dream engine plays SpongeBob (the hero, as an NPC) and
Squidward (actor) in duo_scene.json with its director, events and Fish voices; no player, no Muse images.
duo.html (served by server.py) reads the engine's live SSE stream and stages each line in 3D with a camera director.
usage: python3 h0/squid_live/duo.py [--port 8771] [--max-dollars 1.0] [--book [--score wonder] [--freestyle]]   then open http://127.0.0.1:8790/duo.html
--book plays book/score.json instead (nothing is generated, only voiced): the house, then Conch Street.
--book --freestyle: the book sets the stage and the story, the two improvise it from the first beat.
The page's «Фристайл» button (or G) drops a playing book into freestyle at any moment (POST /freestyle).
"""
import json
import argparse
import os
import signal
import threading
import time
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "dream"))
os.chdir(HERE.parent / "dream")  # the engine resolves its files next to itself

import sim  # noqa: E402
from dialogue import Dialogue  # noqa: E402
from llm import get_spent, set_cap, set_talk_model  # noqa: E402
from voice import Voice, load_pool  # noqa: E402


STREET_BUILD = 45  # Conch Street is already built: the door out opens soon
STALL_NOTE = ("Operator to the director: the book's street part is over; the next place is SpongeBob's pineapple house. "
              "Make the pineapple the way in and SpongeBob's house the destination. Tell SpongeBob he badly wants "
              "to invite Squidward over to his place. Tell Squidward his job is to stall: keep SpongeBob busy out "
              "here on the street, with anything but a flat no, the whole %g minutes the house takes to get ready.")


def stall_scene(s, minutes):
    """The house is freestyled, and the door out leads to the street (transition 1). When the
    street's book pieces are told, the operator briefs the director the way any tool does
    (POST /event); the house behind the pineapple takes `minutes` to build, so Squidward has
    that long to stall. Inside SpongeBob's the freestyle goes on; the next dream ends it."""
    s.fsm.p["build"] = STREET_BUILD
    s.go_freestyle()  # house -> street (the book's), then one free dream: SpongeBob's
    drain, brief = s._drain_inbox, []

    def drain_with_brief():
        # on the sim's own thread: a door the director was still building (it thought
        # they were indoors) is dropped first, so the pineapple can be the next one
        if brief:
            brief.clear()
            if s.fsm.state in ("building", "ready"):
                for e in s.fsm.abort(s.clock.now(), "operator"):
                    s._emit(e)
        drain()
    s._drain_inbox = drain_with_brief

    def watch():
        while (s.n_transitions < 1 or s._free_pieces_left()) and not s.stopped:
            time.sleep(0.5)
        if s.stopped:
            return
        s._max_transitions = s.n_transitions + 2  # into SpongeBob's, then one more dream
        s.fsm.p["build"] = minutes * 60
        brief.append(True)
        s.submit("event", {"source": "operator", "value": STALL_NOTE % minutes})
    threading.Thread(target=watch, daemon=True).start()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8771)
    ap.add_argument("--max-dollars", type=float, default=1.0)
    ap.add_argument("--book", action="store_true", help="play the written story in book/ (static score)")
    ap.add_argument("--freestyle", action="store_true", help="with --book: improvise the book from the first beat")
    ap.add_argument("--score", default="", help="with --book: book/score_<name>.json (the A/B/C: wonder, spark-open)")
    ap.add_argument("--stall", type=float, default=0, help="with --book --freestyle: once out on the street, SpongeBob "
                    "invites Squidward home and Squidward stalls this many minutes while his house builds")
    a = ap.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))  # kill -> spent line
    sim.use_scene(str(HERE / "duo_scene.json"))
    set_talk_model("spark-open")
    set_cap(a.max_dollars)
    media = {"voice": Voice(pool={**load_pool(), **sim.START_VOICE_IDS})}  # voices only: the room is already built
    if a.book:
        # the book's cast is validated against voices.json labels, so it says "creature" / "man";
        # this run's pool points those two labels at the real voices
        ids = json.load(open(HERE / "duo_scene.json"))["voice_ids"]
        media = {"voice": Voice(pool={**load_pool(), "creature": ids["spongebob"], "man": ids["squidward"]})}
        stall = a.stall if a.freestyle else 0
        try:
            sim.run(fake=False, media=media, max_dollars=a.max_dollars, serve=a.port, label="duo_free" if a.freestyle else "duo_book",
                    book=str(HERE / "book"), scenes=["squid_house", "conch_street"], score=str(HERE / "book" / (f"score_{a.score}.json" if a.score else "score.json")),
                    freestyle=a.freestyle and not stall, on_sim=(lambda s: stall_scene(s, stall)) if stall else None)
        finally:
            print(f"spent ${get_spent():.4f}", file=sys.stderr)
        return
    try:
        # one transition ends it: the scene stays in this room until the director wants a new dream
        sim.run(profile="A", fake=False, media=media, max_dollars=a.max_dollars, dialogue=Dialogue(sim.load_profile("A")),
                serve=a.port, max_transitions=1, label="duo")
    finally:
        print(f"spent ${get_spent():.4f}", file=sys.stderr)


if __name__ == "__main__":
    main()
