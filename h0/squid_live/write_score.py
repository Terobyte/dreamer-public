"""A/B/C of the book scene (test-only, SpongeBob never ships): another model writes the same story from the owner's own
prompt, in the score format duo.py --book plays, and directs it too: who walks where, gestures, camera shots.
A = book/score.json (Opus, by hand); B = Wonder; C = Spark Open.
usage: python3 h0/squid_live/write_score.py wonder|spark-open   -> book/score_<model>.json   then duo.py --book --score <model>
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "dream"))
import llm  # noqa: E402

# the owner's prompt, word for word (Oct 30)
OWNER = ("можешь написать простенький сюжет где они в доми сквида занимаются активностями а потом снанч его зовет "
         "на улице тот немного ломается но все же идет и они же теперь могут идти в другуб локацию?")

SYSTEM = """You write and direct a short animated scene for a 3D puppet engine. Two characters: SpongeBob (cheerful sponge)
and Squidward (grumpy octopus neighbour). The owner's request is below, in Russian; write the story it asks for.

The stage:
- Scene 1 "squid_house": Squidward's round living room in his tiki-head house. Places: easel (he paints), clarinet
  (he plays), window (a porthole), sofa (naps), portraits (his self-portraits), coral (a coral in a pot), table,
  door (the front door).
- Scene 2 "conch_street": Conch Street outside his house: his tiki head, SpongeBob's pineapple next door, a rock,
  tube corals, sand. Places: door (in front of his house), pineapple, rock, and walk_off (both leave down the
  street toward another location; use it for the ending).
The engine plays the story beat by beat: lines are voiced by an expressive TTS, narration is shown as a caption.

Answer ONLY with JSON: a list of exactly two scenes, in this order:
[{"scene": "squid_house", "beats": [...]}, {"scene": "conch_street", "beats": [...]}]
Each beat is one of:
- {"kind": "narration", "text": "...", "stage": [{"who": "SpongeBob"|"Squidward", "place": "<a place of this scene>"}]}
  narration describes what happens; "stage" moves the bodies (may be empty).
- {"kind": "line", "who": "SpongeBob"|"Squidward", "text": "...", "gesture": "...", "shot": "..."}
  text: 1-2 short spoken English sentences, with a delivery direction in square brackets before the words, e.g.
  [flat, exhausted] [squeal, bouncy] [long sigh]; no *asterisks*.
  gesture: Squidward: none, wave, shrug, facepalm, armscross, react, clarinet, doze;
           SpongeBob: none, wave, jump, droop.
  shot (the camera for this line): ots (over the listener's shoulder), close (close-up of the speaker), two (two
  shot), wide (whole room / street), orbit (slow circle around them), dolly (slow push in), low (from the floor up
  at the speaker), follow (behind someone walking).
Length: scene 1 about 18-22 beats, scene 2 about 6-10 beats. Scene 1 ends with them going out of the door."""


def write(model):
    llm.set_talk_model(model)
    llm.set_cap(1.0)
    r = llm.call("actor", SYSTEM, [{"role": "user", "content": OWNER}], max_tokens=8000)
    text = r.text if hasattr(r, "text") else r[0]
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        sys.exit("no JSON in the reply:\n" + text[:800])
    score = json.loads(m.group(0))
    house = json.load(open(HERE / "book" / "score.json"))  # place and cast come from A, the stage is the same
    for sc, ref in zip(score, house):
        sc["place"], sc["cast"] = ref["place"], ref["cast"]
    assert [s["scene"] for s in score] == ["squid_house", "conch_street"], [s.get("scene") for s in score]
    out = HERE / "book" / f"score_{model}.json"
    json.dump(score, open(out, "w"), ensure_ascii=False, indent=1)
    n = [len(s["beats"]) for s in score]
    print(f"{out.name}: beats {n}, ${llm.get_spent():.4f}")


if __name__ == "__main__":
    write(sys.argv[1])
