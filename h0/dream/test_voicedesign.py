"""Designed voices (voicedesign.py, L177). Offline: fake judge, fake Modal, fake ears, fake Fish.
usage: cd h0/dream && python3 -m unittest -q test_voicedesign
"""
import json
import os
import tempfile
import unittest

import voicecast as vc
import voicedesign as vd
from test_voicecast import BRIEF, facts

BOY = dict(BRIEF, age=14, pitch="low", pace="slow")
JOHN = {"name": "John Reed", "look": "male, about 14; stout, spoiled",
        "lines": ["Boo!", "What were you doing behind the curtain? You have no business to take our books; "
                          "you are a dependent, mamma says; you have no money."]}


def judge(system_seen):
    def call(role, system, user):
        system_seen.append(system)
        return json.dumps({"instructs": ["Male. A boy of 14, take %d." % k for k in range(3)],
                           "sample": "Get out of my way."})
    return call


def fake_modal(spec, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    out = []
    for k in range(len(spec["instructs"])):
        for s in range(spec["seeds"]):
            p = os.path.join(out_dir, "d%d_s%d.wav" % (k, s))
            with open(p, "wb") as f:
                f.write(("%s %d %d" % (spec["name"], k, s)).encode())
            out.append(p)
    return out


def fake_ears(path, text):
    name = os.path.basename(path)
    if name == "d0_s0.wav":
        return facts("x" * 32, age=60, f0=100)                       # an old man: gated by age
    if name == "d1_s0.wav":                                           # the unbroken boy the user picked
        return dict(facts("x" * 32, sex="female", age=34, f0=239, cy=3e-4), title="design " + name)
    return facts("x" * 32, age=24, f0=180, cy=1e-4)


class Design(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old_taste, vd.TASTE_PATH = vd.TASTE_PATH, os.path.join(self.tmp.name, "taste.json")
        self.addCleanup(setattr, vd, "TASTE_PATH", self.old_taste)
        import ears                                                    # clones write their facts: not into out/
        self.addCleanup(setattr, ears, "CACHE", ears.CACHE)
        ears.CACHE = os.path.join(self.tmp.name, "ears")

    def test_the_ear_s_taste_is_shown_to_the_judge(self):
        vd.remember({"book": "Jane Eyre", "name": "John Reed", "brief": BOY, "picked": "wavering boy",
                     "passed_over": ["deep thick boy"], "facts": {"f0": 165, "cy_share": 0.05}})
        asks = []

        def call(role, system, user):
            asks.append(user)
            return json.dumps({"instructs": ["Male. take"], "sample": ""})
        vd.instructs(JOHN, BOY, "Jane Eyre", call)
        self.assertIn("LIKED 'wavering boy' -> it came out at f0 165 Hz", asks[0])
        self.assertIn("not for stronger versions of their words", asks[0])
        self.assertIn("passed over: 'deep thick boy'", asks[0])

    def test_a_real_line_of_the_right_length_is_read(self):
        self.assertTrue(vd.line_of(JOHN).startswith("What were you doing"))
        self.assertEqual(vd.line_of({"lines": ["Boo!"]}, "Get out of my way, Jane."), "Get out of my way, Jane.")
        scots = {"lines": ["Haw, mister, gonnae no dae that? Ma maw says ye cannae play fitba on the stair, so we're no daein it."]}
        self.assertEqual(vd.line_of(scots, "Hey mister, will you not do that?", "scottish"), "Hey mister, will you not do that?")

    def test_designs_are_gated_like_library_voices(self):
        with tempfile.TemporaryDirectory() as d:
            dv = vd.design_voice(JOHN, BOY, "Jane Eyre", d, call=judge([]), generate=fake_modal,
                                 measure=fake_ears, seeds=2)
        rows = {r["id"]: r for r in dv["rows"]}
        self.assertEqual(len(rows), 6)
        self.assertIn("age", rows["d0_s0.wav"]["gate"])
        self.assertIsNone(rows["d1_s0.wav"]["gate"])                 # the ears' "female" boy survives
        self.assertEqual(dv["pick"], dv["ok"][0])
        self.assertEqual(rows["d1_s0.wav"]["instruct"], "Male. A boy of 14, take 1.")

    def test_only_the_voiceless_are_designed_and_the_best_is_cloned_once(self):
        res = {"John Reed": {"brief": BOY, "pick": []}, "Jane": {"brief": BRIEF, "pick": ["a" * 32]}}
        made = []

        def make(wav, title, text):
            made.append(title)
            return "f" * 32
        with tempfile.TemporaryDirectory() as d:
            cl = os.path.join(d, "clones.json")
            kw = dict(call=judge([]), generate=fake_modal, measure=fake_ears, make=make, log=lambda *_: None,
                      clones=cl)
            ids = vd.design_missing([JOHN, {"name": "Jane"}], res, "Jane Eyre", d, **kw)
            again = vd.design_missing([JOHN, {"name": "Jane"}], res, "Jane Eyre", d, **kw)
            self.assertTrue(os.path.exists(os.path.join(d, "design.html")))
            self.assertTrue(os.path.isdir(os.path.join(d, "design", "john_reed")))
        self.assertEqual(ids, {"John Reed": "f" * 32})
        self.assertEqual(again, ids)
        self.assertEqual(made, ["John Reed (Jane Eyre)"])            # same wav, same Fish voice: no twin models

    def test_a_pick_by_ear_lands_in_pool_and_heard(self):
        res = {"John Reed": {"brief": BOY, "pick": []}}
        with tempfile.TemporaryDirectory() as d:
            pool_p, heard_p, cl = (os.path.join(d, n) for n in ("voices.json", "heard.json", "clones.json"))
            with open(pool_p, "w") as f:
                json.dump({"man": "m" * 32}, f)
            vd.design_missing([JOHN], res, "Jane Eyre", d, call=judge([]), generate=fake_modal, measure=fake_ears,
                              make=lambda *a: "a" * 32, log=lambda *_: None, clones=cl)
            dv = vd._load(os.path.join(d, "design.json"))["John Reed"]
            last = len(vd.order(dv))                                   # the last row is a rejected design
            labels = vd.pick(d, "John Reed", last, "Jane Eyre", make=lambda *a: "b" * 32, clones=cl,
                             pool_path=pool_p, heard_path=heard_p)
            pool = vd._load(pool_p)
            self.assertEqual(labels, {"John Reed": "vc_jane_eyre_john_reed"})
            self.assertEqual(pool["vc_jane_eyre_john_reed"], "b" * 32)
            self.assertEqual(vc.heard("Jane Eyre", heard_p), labels)
            t = vd.taste()[-1]
            self.assertEqual(t["picked"], {r["id"]: r for r in dv["rows"]}[vd.order(dv)[-1]]["instruct"])
            self.assertEqual(len(t["passed_over"]), 2)


    def test_a_voice_the_ear_rejected_is_designed_on_demand_without_a_clone(self):
        # John Reed's library voice passed the ears, the user said "не то": every Jane Eyre character had 8 passes
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "book.json"), "w") as f:
                json.dump({"cast": {"John Reed": {"sex": "man", "age": 14, "look": "stout", "lines": JOHN["lines"]},
                                    "Jane Eyre": {"sex": "woman", "age": 10}}}, f)
            with open(os.path.join(d, "voicecast.json"), "w") as f:
                json.dump({"John Reed": {"brief": BOY, "pick": ["a" * 32]}, "Jane Eyre": {"brief": BRIEF, "pick": []}}, f)
            with open(os.path.join(d, "design.json"), "w") as f:
                json.dump({"Jane Eyre": {"rows": [], "ok": [], "dir": d, "text": "x", "pick": None}}, f)
            made = []
            ids = vd.redesign(d, ["John Reed"], "Jane Eyre", call=judge([]), generate=fake_modal, measure=fake_ears,
                              make=lambda *a: made.append(a) or "z" * 32, log=lambda *_: None)
            got = vd._load(os.path.join(d, "design.json"))
        self.assertEqual((ids, made), ({}, []))                       # the ear picks, then --pick clones
        self.assertEqual(set(got), {"John Reed", "Jane Eyre"})        # an earlier design is kept
        self.assertEqual(len(got["John Reed"]["rows"]), 9)
        with self.assertRaises(ValueError):
            vd.redesign("/nonexistent", ["Nobody"], "Jane Eyre")

    def test_a_clone_carries_its_design_s_facts_to_the_ears(self):
        # the ears cannot fetch a private Fish model (HTTPError): a re-cast lost John and Georgiana
        import ears
        with tempfile.TemporaryDirectory() as d:
            wav = os.path.join(d, "a.wav")
            with open(wav, "wb") as f:
                f.write(b"x")
            row = dict(facts("x" * 32, age=12, f0=239), id="a.wav", instruct="Male. A boy", gate=None, score=1.0)
            rid = vd.clone(wav, "John Reed (Jane Eyre)", "t", lambda *a: "c" * 32, os.path.join(d, "cl.json"),
                           facts=row, ears_cache=d)
            got = ears.measure(rid, cache=d)
        self.assertEqual((got["id"], got["title"], got["f0"], got["v"]), (rid, "John Reed (Jane Eyre)", 239, ears.VERSION))
        self.assertNotIn("gate", got)


class Weak(unittest.TestCase):
    SCOT = dict(BRIEF, sex="child", gender="boy", age=8, accent="Scottish (Glaswegian/Glasgow)", pitch="high")

    def test_a_pass_that_is_not_a_fit_is_weak(self):
        lib = {"ok": [dict(facts("c" * 32, age=10, f0=290), title="Energetic Child")]}
        self.assertEqual(vd.accent_word(self.SCOT), "scottish")
        self.assertIsNone(vd.accent_word(dict(BRIEF, accent="British RP")))
        self.assertTrue(vd.weak(self.SCOT, lib))
        self.assertTrue(vd.weak(BOY, {"ok": [facts("a" * 32)]}))                 # a teen: the ears are weak
        self.assertFalse(vd.weak(BRIEF, {"ok": [facts("a" * 32)]}))              # a grown Brit: library is fine
        self.assertFalse(vd.weak(dict(BRIEF, accent="Scottish"), {"ok": [dict(facts("s" * 32), title="Scottish Man")]}))

    def test_the_design_wins_an_accent_only_it_was_asked_for(self):
        lib = {"ok": [dict(facts("c" * 32, age=10, f0=290, uses=10 ** 6), title="Energetic Child")]}
        dv = {"rows": [dict(facts("d" * 32, age=12, f0=300), id="d0_s0.wav")], "pick": "d0_s0.wav"}
        self.assertEqual(vd.winner(self.SCOT, lib, dv)[0], "design")
        self.assertEqual(vd.winner(self.SCOT, lib, dict(dv, pick=None))[0], "library")
        soldier = dict(facts("s" * 32, age=68, f0=276), title="Scottish soilder gnb")    # far off: never the top
        self.assertEqual(vd.winner(self.SCOT, {"ok": lib["ok"] + [soldier]}, dv)[0], "design")

    def test_otherwise_the_same_score_decides_without_the_use_count(self):
        boy = dict(BRIEF, age=14, pitch="low", pace="slow")
        lib = {"ok": [dict(facts("c" * 32, age=14, f0=200, pace=2.3, uses=10 ** 7, cy=3e-3), title="British Boy")]}
        far = {"rows": [dict(facts("d" * 32, age=14, f0=330, pace=3.5), id="d0_s0.wav")], "pick": "d0_s0.wav"}
        near = {"rows": [dict(facts("d" * 32, age=14, f0=200, pace=2.3, cy=3e-3), id="d0_s0.wav")], "pick": "d0_s0.wav"}
        self.assertEqual(vd.winner(boy, lib, far)[0], "library")
        self.assertEqual(vd.winner(boy, lib, near)[0], "design")                  # ten million uses do not count


if __name__ == "__main__":
    unittest.main()
