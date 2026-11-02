"""Voice and draw a text-only run afterwards (Oct 29): the bank runs --text, the
owner listens in the comic viewer. Every line gets Fish audio in the voice its
scene gives the speaker, the place and every face get one Muse picture, and the
log keeps its text-only copy beside it (log.jsonl.novoice).
usage: python3 dub.py RUN_DIR --scene NAME_OR_PATH [--profile A] [--no-images]
       cd h0/dream && python3 -m unittest -q test_dub
"""

import argparse
import filecmp
import json
import os
import shutil
import sys

import sim
from images import Images, background_prompt, portrait_prompt
from voice import Voice, load_pool


def _rows(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def cast_of(scene, profile):
    """The scene's people as the sim sees them -> (hero, {name: voice}, {name: look},
    place, voice pool)."""
    sim.use_scene(scene)
    prof = sim.load_profile(profile)
    hero = prof.get("hero") or "hero"
    voices = dict(sim.START_VOICES)
    voices[hero] = prof.get("hero_voice") or "man"
    looks = dict(sim.START_LOOKS)
    if prof.get("hero_look"):
        looks[hero] = prof["hero_look"]
    return hero, voices, looks, sim.START_PLACE, {**load_pool(), **sim.START_VOICE_IDS}


def dub(run, scene, profile="A", voice=None, images=None):
    """Writes audio and pictures into `run` and rewrites its log -> (lines voiced,
    pictures drawn). A run already dubbed is left alone."""
    log = os.path.join(run, "log.jsonl")
    # the backup is made before voicing: a log still equal to it was never rewritten (a crash)
    if os.path.exists(log + ".novoice") and not filecmp.cmp(log, log + ".novoice", shallow=False):
        return 0, 0
    hero, voices, looks, place, pool = cast_of(scene, profile)
    voice = voice or Voice(pool=pool)
    rows = _rows(log)
    shutil.copyfile(log, log + ".novoice")
    n = 0
    for r in rows:
        if r.get("type") != "line" or not r.get("text"):
            continue
        who = r.get("who") or hero
        label = voices.get(hero if r.get("role") == "hero" else who) or "man"
        n += 1
        path = os.path.join(run, "audio", "line_%03d.wav" % n)
        res = voice.synthesize(r["text"], label, path)
        r["dur"] = res["pause"]
        if res["ok"]:
            r["audio"] = os.path.relpath(res["audio"], run)
    pics = []
    if images is not False:
        img = images or Images()
        snap = next((r for r in rows if r.get("type") == "snapshot"), {"t": 0})
        bg = img.generate("background", background_prompt(place),
                          os.path.join(run, "images", "scene_0.png"), name=place)
        pics.append({"t": snap["t"], "type": "image", "kind": "background",
                     "path": os.path.relpath(bg["path"], run), "dur": 0, "name": place})
        people = [hero] + [a for a in voices if a != hero]
        for i, who in enumerate(people, 1):
            if not looks.get(who):
                continue
            res = img.generate("portrait", portrait_prompt(looks[who]),
                               os.path.join(run, "images", "portrait_%03d.png" % i), name=who)
            pics.append({"t": snap["t"], "type": "image", "kind": "portrait",
                         "path": os.path.relpath(res["path"], run), "dur": 0,
                         "who": who, "name": who})
        at = rows.index(snap) + 1 if snap in rows else 0
        rows[at:at] = pics
    with open(log, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return n, len(pics)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--scene", required=True)
    ap.add_argument("--profile", default="A")
    ap.add_argument("--no-images", action="store_true")
    a = ap.parse_args(argv)
    n, p = dub(a.run, a.scene, a.profile, images=False if a.no_images else None)
    print("%s: %d lines, %d pictures" % (a.run, n, p))
    return 0


if __name__ == "__main__":
    sys.exit(main())
