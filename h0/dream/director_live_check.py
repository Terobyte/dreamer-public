"""Live director check on 3 frozen slices: valid JSON, bridge from scene, soul in why,
needle used, trap rejected, token coefficient verified (spec 6-8, 13, 15 step 2).
Paid: runs real Wonder calls. usage: python3 director_live_check.py --max-dollars 1
"""

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import llm
from llm import get_spent

CHECK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                         "out", "dream", "checks")
OBJECTS = ["clarinet", "old radio", "music stand", "framed photo of a friend",
           "photo album", "suitcase", "postcard with an airplane", "armchair"]
DESTINATIONS = {"A": "grandma's front porch at dusk",
                "B": "the pier where the boat never leaves",
                "C": "the coral festival gate at dawn"}
# concrete soul facts only: "diary" or "past dream" alone names no fact
SOUL_WORDS = {"A": ["lullaby", "grandma", "krabs", "yelled", "shouted", "fryer",
                     "hummed", "porch", "fog", "fault"],
              "B": ["patrick", "friend", "moved", "alone", "jellyfishing",
                    "plates", "waving", "boat", "pier", "first call"],
              "C": ["flight", "plane", "festival", "suitcase", "trip",
                    "floating", "ticket", "lights", "falling"]}
# the needle is an event of the dream's first minutes, absent from the soul
# file: only memory of that episode can lead to the expected destination
NEEDLE = {"A": "the old radio crackled grandma's lullaby, then a lighthouse bell rang three times",
          "B": "a red kite with Patrick's drawing on its tail floated past the window",
          "C": "the music stand played a carousel tune from the festival poster by itself"}
NEEDLE_KEY = {"A": "lighthouse", "B": "kite", "C": "carousel"}
# the 3rd-transition candidates: only one matches the early NEEDLE fact
CANDIDATES = {"A": ["the lighthouse on the reef", "the bus stop", "the factory floor"],
              "B": ["the hill where the red kite flies", "the empty dinner table",
                    "the jellyfish fields"],
              "C": ["the carousel under the sea", "the festival gate",
                    "the packed suitcase"]}
EXPECT_DEST = {"A": "the lighthouse on the reef",
               "B": "the hill where the red kite flies",
               "C": "the carousel under the sea"}
STOP_WORDS = {"the", "a", "an", "in", "on", "of", "at", "with", "where", "under",
              "above", "to", "and"}
SCHEMA = ("Reply with JSON only: {\"bridge\": one of the scene objects, "
          "\"destination\": exactly one of the CANDIDATES, "
          "\"why\": one sentence naming both the soul fact (diary, wants, fears, past dream) "
          "and the dream memory that decided it, "
          "\"messages\": [], \"facts_update\": [], \"abort_build\": null, "
          "\"wake_up\": null}. English.")

POOL = ["old_woman", "old_man", "woman", "man", "child", "creature"]


def load_profile(pid):
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "profiles", pid + ".json"), encoding="utf-8") as f:
        return json.load(f)


def slice_prompt(profile):
    soul = ("DIARY: %s\nWANTS: %s\nFEARS: %s\nPAST DREAM: %s"
            % (profile["diary"], ", ".join(profile["wants"]),
               ", ".join(profile["fears"]), profile["past_dream"]))
    mem = ("EPISODES (frozen summaries)\n"
           "minute 2: the hero entered the room; %s.\n" % NEEDLE[profile["id"]]
           + "minute 9: 1st transition, the hero talked with Squidward.\n"
             "minute 16: 2nd transition, the hero sat quietly.\n"
             "TAIL: this is the 3rd transition. Pick the destination the dream's "
             "own earlier events point to.")
    scene = "SCENE objects: %s" % ", ".join(OBJECTS)
    cands = ("CANDIDATES: %s" % " | ".join(CANDIDATES[profile["id"]]))
    return "DIRECTOR. %s\n%s\n%s\n%s\n%s" % (soul, mem, scene, cands, SCHEMA)


def ask(prompt, max_dollars):
    if get_spent() >= max_dollars:
        raise RuntimeError("budget reached before director call")
    res = llm.call("director", "You are the dream director.", [
        {"role": "user", "content": prompt}], max_tokens=1500)
    if get_spent() > max_dollars:
        raise RuntimeError("budget exceeded: spent %.4f > %.2f"
                           % (get_spent(), max_dollars))
    return res


def parse(text):
    stripped = (text or "").strip()
    try:
        obj = json.loads(stripped)
    except json.JSONDecodeError:
        raise ValueError("reply is not strict JSON")
    if not isinstance(obj, dict):
        raise ValueError("reply JSON is not an object")
    return obj


def _words(text):
    return {w.strip(".,;:!?\"'()").lower() for w in str(text).split()} - STOP_WORDS - {""}


def why_ok(pid, why, bridge, destination):
    """`why` must name a concrete soul fact and tie it to this choice: it
    mentions the bridge or a word of the destination. (ok, reason)."""
    low = str(why or "").lower()
    facts = [w for w in SOUL_WORDS[pid] if w in low]
    if not facts:
        return False, "why names no concrete soul fact"
    tie = {w.lower() for w in _words(bridge)} | _words(destination)
    if not (str(bridge).lower() in low or tie & _words(low)):
        return False, "soul fact %s is not tied to bridge or destination" % facts[0]
    return True, "soul fact %s tied to the choice" % facts[0]


def check_profile(pid, max_dollars):
    profile = load_profile(pid)
    prompt = slice_prompt(profile)
    res = ask(prompt, max_dollars)
    try:
        decision = parse(res.text)
    except ValueError as e:
        decision = {"_error": str(e)}
    est = math.ceil(len(("You are the dream director.\n" + prompt)) / 3.5)
    got = (res.usage or {}).get("prompt_tokens", 0)
    rep = {"profile": pid, "ok": True, "issues": [],
           "bridge": decision.get("bridge"), "destination": decision.get("destination"),
           "why": decision.get("why"),
           "est_prompt_tokens": est, "real_prompt_tokens": got,
           "coefficient": (got / est) if est else 0.0}
    if "_error" in decision:
        rep["ok"] = False
        rep["issues"].append("json: %s" % decision["_error"])
    if decision.get("bridge") not in OBJECTS:
        rep["ok"] = False
        rep["issues"].append("bridge_not_from_scene")
    ok_why, rep["why_reason"] = why_ok(pid, decision.get("why", ""),
                                       decision.get("bridge", ""),
                                       decision.get("destination", ""))
    if not ok_why:
        rep["ok"] = False
        rep["issues"].append("why_ignores_soul")
    if not isinstance(decision.get("destination"), str) or not decision.get("destination"):
        rep["ok"] = False
        rep["issues"].append("destination_missing")
    # needle: director must remember the frozen early fact on the 3rd transition
    needle_hit = (decision.get("destination") == EXPECT_DEST[pid]
                  and NEEDLE_KEY[pid] in str(decision.get("why", "")).lower())
    rep["needle_used"] = bool(needle_hit)
    if not needle_hit:
        rep["ok"] = False
        rep["issues"].append("needle_unused")
    # trap: offering the same bridge again must not be repeated
    trap_prompt = (prompt + "\nNOTE: the previous transition already used "
                   "bridge '%s'. Pick a different bridge." % decision.get("bridge"))
    res2 = ask(trap_prompt, max_dollars)
    try:
        decision2 = parse(res2.text)
    except ValueError as e:
        rep["ok"] = False
        rep["issues"].append("trap_json: %s" % e)
        decision2 = {}
    rep["trap_bridge"] = decision2.get("bridge")
    trap_ok_json = (isinstance(decision2, dict)
                    and decision2.get("bridge") in OBJECTS)
    rep["trap_rejected"] = bool(trap_ok_json
                                and decision2.get("bridge") != decision.get("bridge"))
    if not rep["trap_rejected"]:
        rep["ok"] = False
        rep["issues"].append("trap_repeated_bridge")
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-dollars", type=float, default=1.0)
    args = ap.parse_args()
    llm.reset_spent()
    out = {"profiles": {}, "spent": 0.0, "ok": True}
    for pid in ("A", "B", "C"):
        rep = check_profile(pid, args.max_dollars)
        out["profiles"][pid] = rep
        if not rep["ok"]:
            out["ok"] = False
    out["spent"] = get_spent()
    os.makedirs(CHECK_DIR, exist_ok=True)
    path = os.path.join(CHECK_DIR, "director.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("wrote %s ok=%s spent=%.4f" % (path, out["ok"], out["spent"]))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
